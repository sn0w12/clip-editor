mod bridge;
mod commands;
pub mod session;
pub mod settings;
mod state;

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use seraphis_core::{Backend, BackendConfig};
use state::AppState;
use tauri::{Emitter, Manager};

const AUTOSTART_ARG: &str = "--autostart";

fn prevent_default() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    use tauri_plugin_prevent_default::Flags;
    #[cfg(debug_assertions)]
    {
        tauri_plugin_prevent_default::Builder::new()
            .with_flags(Flags::empty())
            .build()
    }
    #[cfg(not(debug_assertions))]
    {
        tauri_plugin_prevent_default::Builder::new()
            .with_flags(Flags::CONTEXT_MENU)
            .build()
    }
}

fn is_autostart_launch() -> bool {
    std::env::args().any(|a| a == AUTOSTART_ARG)
}

/// Record panics to `dir/logs/panic.log`. The release profile aborts on panic
/// and a windowed app has no stderr, so this hook is the only record of why
/// the process died.
fn install_panic_log(dir: &std::path::Path) {
    use std::io::Write as _;

    let path = dir.join("logs").join("panic.log");
    let _ = std::fs::create_dir_all(dir.join("logs"));
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>").to_string();
        let location = match info.location() {
            Some(l) => format!("{}:{}:{}", l.file(), l.line(), l.column()),
            None => "<unknown location>".to_string(),
        };
        let payload = info.payload();
        let message = if let Some(s) = payload.downcast_ref::<&'static str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let record = format!(
            "=== panic {} thread={name}\n{location}\n{message}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        );
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = file.write_all(record.as_bytes());
            let _ = file.flush();
        }
        previous(info);
    }));
}

/// Install a file-backed `tracing` subscriber writing capture measurements
/// into `dir/logs/capture.log`, capped at 8 MiB with one rotated generation.
fn install_file_logging(dir: &std::path::Path) {
    use std::io::Write as _;

    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("screencap=info,warn"));

    let log_dir = dir.join("logs");
    if std::fs::create_dir_all(&log_dir).is_err() {
        return;
    }
    let path = log_dir.join("capture.log");
    const MAX_BYTES: u64 = 8 * 1024 * 1024;
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = std::fs::remove_file(log_dir.join("capture.log.1"));
        let _ = std::fs::rename(&path, log_dir.join("capture.log.1"));
    }
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    else {
        return;
    };
    let _ = writeln!(
        file,
        "=== session start {} ===",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    );
    let _ = file.flush();

    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(move || file.try_clone().expect("log file handle is valid"))
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let started_at = std::time::Instant::now();
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch must never start a second controller: restore
            // the existing window and let the UI refresh its state.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            let _ = app.emit("app-activate", ());
        }))
        // Must match the id on the maximize button in
        // src/components/window-controls/WindowControls.tsx.
        .plugin(
            tauri_plugin_snap_layout::init()
                .button_id("seraphis-snap-maximize")
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(external_navigation_plugin())
        .plugin(prevent_default());

    // Autostart is release-only: dev builds must never register a Run key.
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(
        tauri_plugin_autostart::Builder::new()
            .args([AUTOSTART_ARG])
            .app_name("Seraphis")
            .build(),
    );

    builder
        .setup(move |app| {
            let handle = app.handle().clone();

            // Everything lives under the app data dir: the database and all
            // caches (thumbnails, waveforms, playable remuxes, artwork).
            #[cfg(windows)]
            let data_dir = std::env::var("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    handle
                        .path()
                        .app_data_dir()
                        .unwrap_or_else(|_| PathBuf::from("."))
                })
                .join("seraphis");
            #[cfg(not(windows))]
            let data_dir = handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("app data dir: {e}"))?;

            install_panic_log(&data_dir);
            install_file_logging(&data_dir);

            let settings = Arc::new(crate::settings::SettingsStore::new(
                crate::settings::schema::builtin(),
            ));
            let session = Arc::new(crate::session::SessionStore::new());
            match handle.path().app_config_dir() {
                Ok(config_dir) => {
                    settings.initialize(config_dir.join("settings.json"));
                    let session_path =
                        session::resolve_session_path(config_dir.join("session.json"));
                    session.initialize(session_path);
                }
                Err(error) => {
                    log::warn!(
                        "app config dir unavailable; settings and session stay in memory: {error}"
                    );
                }
            }

            let steam_dir = settings
                .snapshot()
                .values
                .get(seraphis_core::settings::keys::STEAM_DIRECTORY)
                .and_then(|value| value.as_str())
                .unwrap_or("C:\\Program Files (x86)\\Steam")
                .to_owned();

            let backend = Arc::new(
                Backend::open(BackendConfig::default(), data_dir.clone(), steam_dir)
                    .map_err(|e| format!("backend: {e}"))?,
            );
            backend.set_events(bridge::TauriEventSink::new(handle.clone()));

            app.manage(AppState {
                backend: backend.clone(),
                settings,
                session,
                tray_toggle: Mutex::new(None),
            });

            // Library watcher loop: debounces per-root changes into rescans.
            if let Some(watcher_rx) = backend.take_watcher_rx() {
                let app_handle = app.handle().clone();
                let sink = backend.events();
                let scan = move |root: &str| -> Result<seraphis_core::types::ScanResult, String> {
                    let state = app_handle.state::<AppState>();
                    let conn = state.backend.db.lock();
                    let result = seraphis_core::library::scan_root(&conn, root);
                    drop(conn);
                    commands::clip::warm_media_artifacts(&app_handle);
                    result
                };
                seraphis_core::watcher::spawn_debounce_loop(watcher_rx, sink, scan);
            }

            // Watchers for persisted roots.
            {
                let state = app.state::<AppState>();
                let roots = seraphis_core::db::list_library_roots(&state.backend.db.lock())?;
                let mut watchers = state.backend.watchers.lock();
                for (root, enabled) in roots {
                    if enabled {
                        let _ =
                            commands::clip::ensure_watcher(&handle, &state, &mut watchers, &root);
                    }
                }
            }

            // Refresh Steam games + artwork in the background so badges and
            // cards reflect the current librarycache on every launch.
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<AppState>();
                    let steam_dir = state.backend.steam_dir.lock().clone();
                    let dirs = seraphis_core::steam::discover_steam_dirs(Some(&steam_dir));
                    let conn = state.backend.db.lock();
                    for dir in dirs {
                        let (games, _diags) = seraphis_core::steam::scan_games(&dir);
                        for game in games {
                            let artwork =
                                seraphis_core::steam::resolve_local_artwork(&dir, &game.app_id);
                            if let Ok(artwork_json) = serde_json::to_string(&artwork) {
                                let _ = seraphis_core::db::upsert_game(
                                    &conn,
                                    &game.app_id,
                                    &game.display_name,
                                    &game.normalized_name,
                                    &game.source,
                                    Some(&artwork_json),
                                    None,
                                );
                            }
                        }
                    }
                    drop(conn);
                    let _ = app_handle.emit("steam-scan-done", serde_json::json!({ "scanned": 0 }));
                });
            }

            // System tray: the app lives in the notification area; closing the
            // window hides it while the buffer keeps recording.
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};

                let show = MenuItem::with_id(app, "show", "Show Seraphis", true, None::<&str>)?;
                let toggle = MenuItem::with_id(
                    app,
                    "toggle-recording",
                    "Start Replay Buffer",
                    true,
                    None::<&str>,
                )?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &toggle, &quit])?;
                let tray = TrayIconBuilder::with_id("seraphis-tray")
                    .icon(
                        app.default_window_icon()
                            .cloned()
                            .ok_or_else(|| "no default window icon".to_string())?,
                    )
                    .tooltip("Seraphis")
                    .menu(&menu)
                    .show_menu_on_left_click(true)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "toggle-recording" => {
                            let state = app.state::<AppState>();
                            if state.backend.recording.is_running() {
                                let _ = state.backend.recording.stop();
                            } else {
                                let profile = seraphis_core::db::get_recording_profile(
                                    &state.backend.db.lock(),
                                )
                                .ok();
                                if let Some(profile) = profile {
                                    if let Err(e) = state
                                        .backend
                                        .recording
                                        .start(&profile, &state.backend.events())
                                    {
                                        eprintln!("[tray] start replay buffer failed: {e}");
                                    }
                                }
                            }
                            commands::clip::update_tray_recording_label(app);
                        }
                        "quit" => {
                            let state = app.state::<AppState>();
                            let _ = state.backend.recording.stop();
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
                let state = app.state::<AppState>();
                *state.tray_toggle.lock() = Some(toggle);
                app.manage(tray);
            }

            // Apply the persisted autostart setting to the plugin.
            let launch_on_startup = get_bool_setting(
                app.handle(),
                seraphis_core::settings::keys::LAUNCH_ON_STARTUP,
            )
            .unwrap_or(true);
            commands::clip::sync_autostart(app.handle(), launch_on_startup);

            // Pre-generate metadata + thumbnails in the background.
            commands::clip::warm_media_artifacts(app.handle());

            // Startup buffer behavior: on an OS-startup launch (or a normal
            // launch with the default enabled) start the replay buffer.
            let start_buffer = get_bool_setting(
                app.handle(),
                seraphis_core::settings::keys::START_REPLAY_BUFFER_ON_STARTUP,
            )
            .unwrap_or(true);
            if start_buffer {
                let state = app.state::<AppState>();
                let mut profile =
                    seraphis_core::db::get_recording_profile(&state.backend.db.lock()).ok();
                if let Some(profile) = profile.as_mut() {
                    let mut changed = false;
                    if profile.output_dir.trim().is_empty() {
                        profile.output_dir = seraphis_core::db::default_output_dir()
                            .to_string_lossy()
                            .into_owned();
                        changed = true;
                    }
                    if profile.tracks.is_empty() {
                        profile.tracks = vec![seraphis_core::types::AudioTrackConfig {
                            number: 1,
                            name: "all".into(),
                            include: vec!["all_processes".into()],
                            exclude: vec![],
                        }];
                        changed = true;
                    }
                    if changed {
                        let _ = seraphis_core::db::set_recording_profile(
                            &state.backend.db.lock(),
                            profile,
                        );
                    }
                }
                if let Some(profile) = profile {
                    if let Err(e) = state
                        .backend
                        .recording
                        .start(&profile, &state.backend.events())
                    {
                        eprintln!("[recording] startup buffer failed: {e}");
                    }
                }
                commands::clip::update_tray_recording_label(app.handle());
            }

            log::info!("setup complete in {:?}", started_at.elapsed());
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Closing hides to the system tray; the replay buffer keeps
                    // recording in the background.
                    api.prevent_close();
                    let _ = window.hide();
                    let state = window.app_handle().state::<AppState>();
                    if let Err(error) = state.session.persist_current() {
                        log::error!("could not flush session on close: {error}");
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    let state = window.app_handle().state::<AppState>();
                    if let Err(error) = state.session.persist_current() {
                        log::error!("could not flush session on close: {error}");
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::app::app_info,
            commands::app::app_ping,
            commands::app::app_echo,
            commands::settings::settings_load,
            commands::settings::settings_set,
            commands::session::session_load,
            commands::session::session_save,
            commands::clip::get_media_server_port,
            commands::clip::select_directory,
            commands::clip::scan_library,
            commands::clip::add_library_root,
            commands::clip::get_library_roots,
            commands::clip::get_clips,
            commands::clip::get_clip_metadata,
            commands::clip::get_thumbnail,
            commands::clip::get_waveform,
            commands::clip::get_playable_video,
            commands::clip::delete_clips,
            commands::clip::rename_clip,
            commands::clip::show_in_folder,
            commands::clip::open_file,
            commands::clip::get_previous_exports,
            commands::clip::copy_file_to_clipboard,
            commands::clip::export_clip,
            commands::clip::remove_export,
            commands::clip::remove_library_root,
            commands::clip::list_groups,
            commands::clip::create_group,
            commands::clip::delete_group,
            commands::clip::get_group_clips,
            commands::clip::assign_clips_to_group,
            commands::clip::remove_clips_from_group,
            commands::clip::import_legacy_state,
            commands::clip::start_replay_buffer,
            commands::clip::save_replay,
            commands::clip::stop_replay_buffer,
            commands::clip::get_recording_state,
            commands::clip::get_recording_profile,
            commands::clip::set_recording_profile,
            commands::clip::refresh_steam_data,
            commands::clip::get_games,
            commands::clip::refresh_steam_artwork,
            commands::clip::add_custom_game,
            commands::clip::remove_custom_game,
            commands::clip::set_custom_game_image,
            commands::clip::set_game_alias,
            commands::clip::remove_game_alias,
        ])
        .on_page_load(move |webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                log::info!(
                    "main webview finished loading in {:?}",
                    started_at.elapsed()
                );
                let window = webview.window();
                if is_autostart_launch() {
                    // Autostart runs in the background (tray only).
                    let _ = window.hide();
                } else {
                    // Fallback reveal for a frontend that never gets that far:
                    // the frontend reveals the window itself once the first
                    // frame has committed, so this only fires on a failure.
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        if !matches!(window.is_visible(), Ok(true)) {
                            let _ = window.show();
                        }
                    });
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Seraphis");
}

fn get_bool_setting(app: &tauri::AppHandle, key: &str) -> Option<bool> {
    let state = app.state::<AppState>();
    state
        .settings
        .snapshot()
        .values
        .get(key)
        .and_then(|value| value.as_bool())
}

/// Keeps the webview on the app's own routes. Anything the user clicks that
/// leaves the app opens in the system browser instead.
fn external_navigation_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_opener::OpenerExt;

    tauri::plugin::Builder::<R>::new("external-navigation")
        .on_navigation(|webview, url| {
            let is_internal_host = matches!(
                url.host_str(),
                Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost") | Some("::1")
            );

            let is_internal = url.scheme() == "tauri" || is_internal_host;

            if is_internal {
                return true;
            }

            let is_external_link = matches!(url.scheme(), "http" | "https" | "mailto" | "tel");

            if is_external_link {
                log::info!("opening external link in system browser: {}", url);
                let _ = webview.opener().open_url(url.as_str(), None::<&str>);
                return false;
            }

            true
        })
        .build()
}

#[cfg(test)]
mod panic_log_tests {
    use super::install_panic_log;

    #[test]
    fn panic_hook_records_message_location_and_thread_name() {
        let dir = std::env::temp_dir().join(format!("seraphis-panic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        install_panic_log(&dir);

        let worker = std::thread::Builder::new()
            .name("segmenter-video".to_string())
            .spawn(|| {
                panic!("boom from a worker thread");
            })
            .expect("spawn worker");
        let _ = worker.join();

        let log =
            std::fs::read_to_string(dir.join("logs").join("panic.log")).expect("panic log written");
        assert!(log.contains("boom from a worker thread"), "got: {log}");
        assert!(log.contains("lib.rs"), "source file missing: {log}");
        assert!(
            log.contains("thread=segmenter-video"),
            "thread name missing: {log}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
