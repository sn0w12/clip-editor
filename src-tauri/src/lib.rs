//! Clip Editor Tauri backend: managed state, plugins, commands, and windows.
//! streaming protocol, and the startup flow (autostart handling included).

pub mod clipboard;
pub mod commands;
pub mod db;
pub mod legacy;
pub mod library;
pub mod media;
mod media_server;
pub mod recording;
pub mod settings;
pub mod steam;
pub mod types;
pub mod util;
pub mod watcher;

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::channel;

use tauri::{Emitter, Manager};

const AUTOSTART_ARG: &str = "--autostart";

/// Disable WebView2's default right-click context menu in release builds (the
/// app has its own custom context menus). Dev keeps it for debugging.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(prevent_default())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args([AUTOSTART_ARG])
                .app_name("Clip Editor")
                .build(),
        )
        .setup(|app| {
            // Everything lives under `%APPDATA%\clip-editor`: the database and
            // all caches (thumbnails, waveforms, playable remuxes, artwork).
            // `app_data_dir()` resolves to the bare Roaming dir on this setup,
            // so pin the folder explicitly.
            #[cfg(windows)]
            let data_dir = std::env::var("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    app.path()
                        .app_data_dir()
                        .unwrap_or_else(|_| PathBuf::from("."))
                })
                .join("clip-editor");
            #[cfg(not(windows))]
            let data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app data dir: {e}"))?;
            let cache_root = data_dir.join("cache");
            std::fs::create_dir_all(&data_dir).map_err(|e| format!("app data dir: {e}"))?;
            std::fs::create_dir_all(&cache_root).map_err(|e| format!("app cache dir: {e}"))?;
            // The FFmpeg fallback downloads next to the db/caches: the data
            // dir is writable under both per-user NSIS and per-machine MSI
            // installs, unlike the exe dir under Program Files.
            crate::media::set_ffmpeg_dir(data_dir.clone());
            let db = db::open(&data_dir.join("clip-editor.db"))?;

            let steam_dir = crate::db::get_all_settings(&db)
                .map_err(|e| format!("settings: {e}"))?
                .get(settings::keys::STEAM_DIRECTORY)
                .and_then(|v| v.as_str())
                .unwrap_or("C:\\Program Files (x86)\\Steam")
                .to_string();

            let (watcher_tx, watcher_rx) = channel::<PathBuf>();
            let media_server_port =
                media_server::start().map_err(|e| format!("media server: {e}"))?;
            app.manage(commands::AppState {
                db: Mutex::new(db),
                recording: recording::RecordingHandle::new(),
                cache_root,
                steam_dir: Mutex::new(steam_dir),
                client: reqwest::Client::builder()
                    .timeout(std::time::Duration::from_secs(15))
                    .connect_timeout(std::time::Duration::from_secs(10))
                    .build()
                    .map_err(|e| format!("http client: {e}"))?,
                watchers: Mutex::new(HashMap::new()),
                watcher_tx,
                media_server_port,
                tray_toggle: Mutex::new(None),
            });

            // Library watcher loop: debounces per-root changes into rescans.
            let app_handle = app.handle().clone();
            let scan = move |root: &str| -> Result<types::ScanResult, String> {
                let app_state = app_handle.state::<commands::AppState>();
                let conn = app_state.db.lock();
                let result = library::scan_root(&conn, root);
                drop(conn);
                // Newly-discovered clips get their metadata/thumbnails
                // precomputed in the background so the grid and editor never
                // wait on ffprobe/ffmpeg.
                commands::warm_media_artifacts(&app_handle);
                result
            };
            watcher::spawn_debounce_loop(watcher_rx, app.handle().clone(), scan);

            // Watchers for persisted roots.
            {
                let state = app.state::<commands::AppState>();
                let roots = db_list_roots(&state)?;
                let mut watchers = state.watchers.lock();
                for (root, enabled) in roots {
                    if enabled {
                        let _ =
                            commands::ensure_watcher(app.handle(), &state, &mut watchers, &root);
                    }
                }
            }

            // Refresh Steam games + artwork in the background so the DB
            // (and badges/cards) reflect the current librarycache on every
            // launch; the icon resolution picks up hash-named image files.
            {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app_handle.state::<commands::AppState>();
                    let steam_dir = state.steam_dir.lock().clone();
                    let dirs = crate::steam::discover_steam_dirs(Some(&steam_dir));
                    let conn = state.db.lock();
                    for dir in dirs {
                        let (games, _diags) = crate::steam::scan_games(&dir);
                        for game in games {
                            let artwork = crate::steam::resolve_local_artwork(&dir, &game.app_id);
                            if let Ok(artwork_json) = serde_json::to_string(&artwork) {
                                let _ = crate::db::upsert_game(
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

                let show = MenuItem::with_id(app, "show", "Show Clip Editor", true, None::<&str>)?;
                let toggle = MenuItem::with_id(
                    app,
                    "toggle-recording",
                    "Start Replay Buffer",
                    true,
                    None::<&str>,
                )?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &toggle, &quit])?;
                let tray = TrayIconBuilder::with_id("clip-editor-tray")
                    .icon(
                        app.default_window_icon()
                            .cloned()
                            .ok_or_else(|| "no default window icon".to_string())?,
                    )
                    .tooltip("Clip Editor")
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
                            let state = app.state::<commands::AppState>();
                            if state.recording.is_running() {
                                let _ = state.recording.stop();
                            } else {
                                let profile =
                                    crate::db::get_recording_profile(&state.db.lock()).ok();
                                if let Some(profile) = profile {
                                    if let Err(e) = state.recording.start(&profile, app) {
                                        eprintln!("[tray] start replay buffer failed: {e}");
                                    }
                                }
                            }
                            commands::update_tray_recording_label(app);
                        }
                        "quit" => {
                            let state = app.state::<commands::AppState>();
                            let _ = state.recording.stop();
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
                // Keep the tray alive for the app lifetime, and remember the
                // toggle item so its label can be kept in sync.
                let state = app.state::<commands::AppState>();
                *state.tray_toggle.lock() = Some(toggle);
                app.manage(tray);
            }

            // Apply the persisted autostart setting to the plugin.
            let launch_on_startup =
                get_bool_setting(app.handle(), settings::keys::LAUNCH_ON_STARTUP).unwrap_or(true);
            commands::sync_autostart(app.handle(), launch_on_startup);

            // Pre-generate metadata + thumbnails in the background so the
            // editor and cards never wait on ffprobe/ffmpeg.
            commands::warm_media_artifacts(app.handle());

            // Startup buffer behavior: on an OS-startup launch (or a normal
            // launch with the default enabled) start the replay buffer before
            // the window is exposed. Failures are surfaced as recording events
            // when the UI opens, never claimed as active.
            let start_buffer =
                get_bool_setting(app.handle(), settings::keys::START_REPLAY_BUFFER_ON_STARTUP)
                    .unwrap_or(true);
            if start_buffer {
                let state = app.state::<commands::AppState>();
                let mut profile = db::get_recording_profile(&state.db.lock()).ok();
                // First run: default the capture directory to the Videos
                // folder before the buffer starts.
                if let Some(profile) = profile.as_mut() {
                    let mut changed = false;
                    if profile.output_dir.trim().is_empty() {
                        profile.output_dir =
                            db::default_output_dir().to_string_lossy().into_owned();
                        changed = true;
                    }
                    if profile.tracks.is_empty() {
                        profile.tracks = vec![types::AudioTrackConfig {
                            number: 1,
                            name: "all".into(),
                            include: vec!["all_processes".into()],
                            exclude: vec![],
                        }];
                        changed = true;
                    }
                    if changed {
                        let _ = db::set_recording_profile(&state.db.lock(), profile);
                    }
                }
                if let Some(profile) = profile {
                    if let Err(e) = state.recording.start(&profile, app.handle()) {
                        eprintln!("[recording] startup buffer failed: {e}");
                    }
                }
                commands::update_tray_recording_label(app.handle());
            }

            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
            {
                let window = webview.window();
                if is_autostart_launch() {
                    // Autostart runs in the background (tray only): the window
                    // stays hidden so nothing flashes at login. The tray icon
                    // is the way back in.
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Closing hides to the system tray; the replay buffer keeps
                // recording in the background. Use Quit from the tray (or
                // Task Manager) to actually exit.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_media_server_port,
            commands::select_directory,
            commands::scan_library,
            commands::add_library_root,
            commands::get_library_roots,
            commands::get_clips,
            commands::get_clip_metadata,
            commands::get_thumbnail,
            commands::get_waveform,
            commands::get_playable_video,
            commands::delete_clips,
            commands::rename_clip,
            commands::show_in_folder,
            commands::open_file,
            commands::get_previous_exports,
            commands::copy_file_to_clipboard,
            commands::export_clip,
            commands::remove_export,
            commands::remove_library_root,
            commands::list_groups,
            commands::create_group,
            commands::delete_group,
            commands::get_group_clips,
            commands::assign_clips_to_group,
            commands::remove_clips_from_group,
            commands::get_settings,
            commands::set_setting,
            commands::reset_settings,
            commands::import_legacy_state,
            commands::start_replay_buffer,
            commands::save_replay,
            commands::stop_replay_buffer,
            commands::get_recording_state,
            commands::get_recording_profile,
            commands::set_recording_profile,
            commands::refresh_steam_data,
            commands::get_games,
            commands::refresh_steam_artwork,
            commands::add_custom_game,
            commands::remove_custom_game,
            commands::set_custom_game_image,
            commands::set_game_alias,
            commands::remove_game_alias,
        ]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running Clip Editor");
}

fn db_list_roots(state: &commands::AppState) -> Result<Vec<(String, bool)>, String> {
    db::list_library_roots(&state.db.lock())
}

fn get_bool_setting(app: &tauri::AppHandle, key: &str) -> Option<bool> {
    let state = app.state::<commands::AppState>();
    let settings = db::get_all_settings(&state.db.lock()).ok()?;
    settings.get(key).and_then(|v| v.as_bool())
}
