//! All IPC commands. Heavy work runs directly on the Tauri async runtime;
//! long operations emit named events so the UI never polls opaque promises.

use rusqlite::Connection;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

use parking_lot::Mutex;

use crate::media::ExportResult;
use crate::recording::RecordingHandle;
use crate::types::*;

pub struct AppState {
    pub db: Mutex<Connection>,
    pub recording: RecordingHandle,
    pub cache_root: PathBuf,
    pub steam_dir: Mutex<String>,
    pub client: reqwest::Client,
    pub watchers: Mutex<std::collections::HashMap<String, crate::watcher::RootWatcher>>,
    pub watcher_tx: std::sync::mpsc::Sender<PathBuf>,
    pub media_server_port: u16,
    /// The tray's "Start/Stop replay buffer" item, so its label can be kept in
    /// sync with the recording state.
    pub tray_toggle: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
}

/// Reflect the replay buffer's running state in the tray's toggle item label.
pub fn update_tray_recording_label(app: &tauri::AppHandle) {
    let running = app.state::<AppState>().recording.is_running();
    let text = if running {
        "Stop Replay Buffer"
    } else {
        "Start Replay Buffer"
    };
    let item = app.state::<AppState>().tray_toggle.lock().clone();
    if let Some(item) = item {
        let _ = item.set_text(text);
    }
}

/// Warm cached metadata, thumbnails, and playable remuxes in a background
/// worker pool so editor opens and card thumbnails are instant. Every `ensure`
/// is idempotent and cheap when already cached, so processing the full library
/// also heals anything that went missing (e.g. caches moved).
pub fn warm_media_artifacts(app: &tauri::AppHandle) {
    use std::collections::VecDeque;
    use std::sync::Mutex;
    let app = app.clone();
    std::thread::Builder::new()
        .name("media-warm".to_string())
        .spawn(move || {
            let pending: Vec<String> = {
                let state = app.state::<AppState>();
                let conn = state.db.lock();
                crate::db::all_clips(&conn)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|c| c.path)
                    .collect()
            };
            if pending.is_empty() {
                return;
            }
            let queue = std::sync::Arc::new(Mutex::new(VecDeque::from(pending)));
            let workers = 4;
            for _ in 0..workers {
                let app = app.clone();
                let queue = queue.clone();
                std::thread::Builder::new()
                    .name("media-warm-worker".to_string())
                    .spawn(move || loop {
                        let next = {
                            let mut q = queue.lock().unwrap();
                            q.pop_front()
                        };
                        let Some(path) = next else { break };
                        let state = app.state::<AppState>();
                        // Metadata first (cheap header probe), then the
                        // ~25-byte ThumbHash placeholder so the grid gets an
                        // instant image as soon as possible, then the full
                        // JPEG thumbnail.
                        let _ = ensure_metadata(&state, &path);
                        let _ = ensure_thumbhash(&state, &path);
                        let _ = ensure_thumbnail(&state, &path);
                    })
                    .ok();
            }
        })
        .ok();
}

/// Port of the embedded localhost media server; the frontend builds
/// `http://127.0.0.1:{port}/{encoded path}` URLs for the `<video>` element.
#[tauri::command]
pub fn get_media_server_port(state: State<'_, AppState>) -> Result<u16, String> {
    Ok(state.media_server_port)
}

/// Open a directory picker; `None` when canceled.
#[tauri::command]
pub async fn select_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Select a clips folder")
        .pick_folder(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx
        .recv()
        .map_err(|e| err("select_directory", format!("dialog: {e}")))?;
    match picked {
        Some(path) => {
            let path_buf = path
                .into_path()
                .map_err(|e| err("select_directory", format!("dialog path: {e}")))?;
            let canonical = path_buf
                .canonicalize()
                .map_err(|e| err("select_directory", format!("{}: {e}", path_buf.display())))?;
            Ok(Some(strip_extended_prefix(&canonical.to_string_lossy())))
        }
        None => Ok(None),
    }
}

/// Windows `canonicalize` returns `\\?\C:\...`; strip the prefix for display
/// and storage.
#[cfg(test)]
mod strip_tests {
    use super::strip_extended_prefix;

    #[test]
    fn strips_windows_extended_prefix() {
        assert_eq!(
            strip_extended_prefix(r"\\?\E:\clips\clip.mp4"),
            r"E:\clips\clip.mp4"
        );
        assert_eq!(
            strip_extended_prefix(r"C:\plain\path.mp4"),
            r"C:\plain\path.mp4"
        );
    }
}

fn strip_extended_prefix(path: &str) -> String {
    path.strip_prefix("\\\\?\\")
        .map(String::from)
        .unwrap_or_else(|| path.to_string())
}

/// All clip rows helper for the frontend.
#[tauri::command]
pub async fn get_library_roots(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let conn = state.db.lock();
    let roots = crate::db::list_library_roots(&conn)?;
    Ok(roots
        .into_iter()
        .filter(|(_, enabled)| *enabled)
        .map(|(path, _)| strip_extended_prefix(&path))
        .collect())
}

/// Scan every enabled root into SQLite and (re)start watchers. Returns
/// aggregate counts and per-file failures; one bad file never aborts the scan.
#[tauri::command]
pub async fn scan_library(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<ScanResult, String> {
    let roots = crate::db::list_library_roots(&state.db.lock())?;
    let mut result = ScanResult {
        roots: Vec::new(),
        clips: 0,
        failures: Vec::new(),
    };
    let mut watchers = state.watchers.lock();
    for (root, enabled) in roots {
        if !enabled {
            continue;
        }
        let scan = crate::library::scan_root(&state.db.lock(), &root)?;
        result.clips += scan.clips;
        result.failures.extend(scan.failures);
        result.roots.push(root.clone());
        ensure_watcher(&app, &state, &mut watchers, &root)?;
    }
    drop(watchers);
    warm_media_artifacts(&app);
    Ok(result)
}

pub fn ensure_watcher(
    app: &tauri::AppHandle,
    state: &AppState,
    watchers: &mut std::collections::HashMap<String, crate::watcher::RootWatcher>,
    root: &str,
) -> Result<(), String> {
    if watchers.contains_key(root) {
        return Ok(());
    }
    let watcher = crate::watcher::start_root_watcher(
        PathBuf::from(root),
        state.watcher_tx.clone(),
        app.clone(),
    )?;
    watchers.insert(root.to_string(), watcher);
    Ok(())
}

/// All clips, newest first, with group ids and matched game artwork attached.
#[tauri::command]
pub async fn get_clips(state: State<'_, AppState>) -> Result<Vec<VideoFile>, String> {
    let conn = state.db.lock();
    let mut clips = crate::db::all_clips(&conn)?;
    let group_map = crate::db::clip_group_map(&conn)?;
    for clip in &mut clips {
        clip.group_ids = group_map.get(&clip.path).cloned().unwrap_or_default();
        clip.game_images = crate::steam::images_for_game(&conn, &clip.game);
    }
    Ok(clips)
}

/// Metadata for one clip, cached in the clips row and refreshed when the file
/// changes (size/modified identity).
#[tauri::command]
pub async fn get_clip_metadata(
    state: State<'_, AppState>,
    path: String,
) -> Result<VideoMetadata, String> {
    ensure_metadata(&state, &path)
}

/// Load (or generate and cache) a clip's metadata. Cached copies are reused
/// when size+mtime match, so the editor opens instantly after a warm pass.
fn ensure_metadata(state: &AppState, path: &str) -> Result<VideoMetadata, String> {
    let ffprobe = crate::media::resolve_ffprobe()?;
    let source = Path::new(path);
    if !source.is_file() {
        return Err(err("get_clip_metadata", format!("{path} is not a file")));
    }
    let stat = std::fs::metadata(source).map_err(|e| err("get_clip_metadata", e))?;
    let modified = stat.modified().map_err(|e| err("get_clip_metadata", e))?;
    let modified: chrono::DateTime<chrono::Utc> = modified.into();
    let modified_str = crate::util::format_time(modified);

    let conn = state.db.lock();
    let cached = crate::db::clip_metadata(&conn, path)?;
    if let Some((meta, cached_modified, cached_size)) = cached {
        if cached_modified == modified_str && cached_size == stat.len() {
            return Ok(meta);
        }
    }
    drop(conn);

    let metadata = crate::media::get_metadata(&ffprobe, source)?;
    let conn = state.db.lock();
    crate::db::update_clip_metadata(&conn, path, &metadata, stat.len(), &modified_str)?;
    Ok(metadata)
}

/// Cached thumbnail path for a clip (generating it on first request). The
/// cache is keyed by (path, size, modified_at).
#[tauri::command]
pub async fn get_thumbnail(state: State<'_, AppState>, path: String) -> Result<String, String> {
    ensure_thumbnail(&state, &path)
}

/// Load (or generate and cache) a clip's thumbnail.
fn ensure_thumbnail(state: &AppState, path: &str) -> Result<String, String> {
    let ffmpeg = crate::media::resolve_ffmpeg()?;
    let source = Path::new(path);
    let stat =
        std::fs::metadata(source).map_err(|e| err("get_thumbnail", format!("{path}: {e}")))?;
    let modified = stat.modified().map_err(|e| err("get_thumbnail", e))?;
    let modified: chrono::DateTime<chrono::Utc> = modified.into();
    let modified_str = crate::util::format_time(modified);

    let conn = state.db.lock();
    let stale = crate::db::invalidate_stale_media_cache(&conn, path, stat.len(), &modified_str)?;
    if let Some(old) = stale.thumbnail_path {
        let _ = std::fs::remove_file(&old);
    }
    let cached = crate::db::get_media_cache(&conn, path)?;
    if let Some(thumb) = cached.and_then(|c| c.thumbnail_path) {
        if Path::new(&thumb).is_file() {
            return Ok(thumb);
        }
    }
    drop(conn);

    // Reuse the cached metadata (probed once by the warm pass) instead of
    // re-running ffprobe on every thumbnail request.
    let metadata = ensure_metadata(state, path)?;
    let at = (2.0f64).min((metadata.duration - 0.1).max(0.01));
    let hash = crate::util::short_hash(path);
    let dst = state
        .cache_root
        .join("thumbnails")
        .join(format!("{hash}.jpg"));
    crate::media::generate_thumbnail(&ffmpeg, source, at, &dst)?;

    let conn = state.db.lock();
    crate::db::put_thumbnail_cache(
        &conn,
        path,
        stat.len(),
        &modified_str,
        &dst.to_string_lossy(),
    )?;
    Ok(dst.to_string_lossy().into_owned())
}

/// Load (or generate and cache) a clip's base64 ThumbHash placeholder.
fn ensure_thumbhash(state: &AppState, path: &str) -> Result<String, String> {
    let ffmpeg = crate::media::resolve_ffmpeg()?;
    let source = Path::new(path);
    let stat =
        std::fs::metadata(source).map_err(|e| err("get_thumbhash", format!("{path}: {e}")))?;
    let modified = stat.modified().map_err(|e| err("get_thumbhash", e))?;
    let modified: chrono::DateTime<chrono::Utc> = modified.into();
    let modified_str = crate::util::format_time(modified);

    {
        let conn = state.db.lock();
        if let Some(cached) = crate::db::get_media_cache(&conn, path)? {
            if let Some(th) = cached.thumbhash {
                if !th.is_empty() {
                    return Ok(th);
                }
            }
        }
    }

    let metadata = ensure_metadata(state, path)?;
    let at = (2.0f64).min((metadata.duration - 0.1).max(0.01));
    let (width, height) = (metadata.width, metadata.height);
    let b64 = crate::media::extract_thumbhash(&ffmpeg, source, at, width, height)?;

    let conn = state.db.lock();
    crate::db::put_thumbhash_cache(&conn, path, stat.len(), &modified_str, &b64)?;
    Ok(b64)
}

/// Ensure a clip has a playable container and return its path. MP4/MOV/WebM
/// play as-is (all audio tracks included); MKV (the rolling buffer's format)
/// is copy-remuxed to MP4 once, preserving every stream. Audio tracks are
/// switched on the client via `HTMLMediaElement.audioTracks`, so there are no
/// per-track copies. Falls back to the original path when a remux fails.
#[tauri::command]
pub async fn get_playable_video(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, String> {
    ensure_playable_video(&state, &path)
}

fn ensure_playable_video(state: &AppState, path: &str) -> Result<String, String> {
    let ffmpeg = crate::media::resolve_ffmpeg()?;
    let source = Path::new(path);
    let stat =
        std::fs::metadata(source).map_err(|e| err("get_playable_video", format!("{path}: {e}")))?;
    let modified = stat.modified().map_err(|e| err("get_playable_video", e))?;
    let modified: chrono::DateTime<chrono::Utc> = modified.into();
    let modified_str = crate::util::format_time(modified);

    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase());
    if matches!(
        ext.as_deref(),
        Some("mp4") | Some("mov") | Some("webm") | Some("m4a")
    ) {
        return Ok(path.to_string());
    }

    let hash = crate::util::short_hash(&format!("{path}#{modified_str}#{}", stat.len()));
    let dst = state
        .cache_root
        .join("playable")
        .join(format!("{hash}.mp4"));
    if dst.is_file() {
        return Ok(dst.to_string_lossy().into_owned());
    }
    if let Some(dir) = dst.parent() {
        std::fs::create_dir_all(dir).map_err(|e| err("get_playable_video", e))?;
    }
    // `-map 0` keeps every stream (all audio tracks) in the playable MP4.
    let status = crate::media::run_ffmpeg_silent(
        &ffmpeg,
        &[
            "-y",
            "-i",
            path,
            "-map",
            "0",
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            &dst.to_string_lossy(),
        ],
    );
    if status.success() && dst.is_file() {
        Ok(dst.to_string_lossy().into_owned())
    } else {
        Ok(path.to_string())
    }
}

/// Cached waveform samples for one audio track of a clip. The cache key is
/// `(path, audio_track, mtime)`, so each track has its own file and a changed
/// clip invalidates itself by producing a different key.
///
/// An in-memory mirror (keyed by path/track/count, validated against the file's
/// mtime) makes repeated loads of the same clip skip the disk entirely, and the
/// on-disk cache is checked before FFmpeg is ever resolved — so a warm load
/// never spawns `ffmpeg -version`.
static WAVEFORM_CACHE: std::sync::OnceLock<
    parking_lot::Mutex<std::collections::HashMap<String, (String, Arc<Vec<f32>>)>>,
> = std::sync::OnceLock::new();

fn waveform_cache(
) -> &'static parking_lot::Mutex<std::collections::HashMap<String, (String, Arc<Vec<f32>>)>> {
    WAVEFORM_CACHE.get_or_init(|| parking_lot::Mutex::new(std::collections::HashMap::new()))
}

#[tauri::command]
pub async fn get_waveform(
    state: State<'_, AppState>,
    path: String,
    sample_count: Option<usize>,
    audio_track: Option<u32>,
) -> Result<Vec<f32>, String> {
    let sample_count = sample_count.unwrap_or(1000).clamp(100, 20000);
    let audio_track = audio_track.unwrap_or(0);
    let source = Path::new(&path);
    let stat =
        std::fs::metadata(source).map_err(|e| err("get_waveform", format!("{path}: {e}")))?;
    let modified = stat.modified().map_err(|e| err("get_waveform", e))?;
    let modified: chrono::DateTime<chrono::Utc> = modified.into();
    let modified_str = crate::util::format_time(modified);

    let mem_key = format!("{path}#{audio_track}#{sample_count}");
    let cached = {
        let cache = waveform_cache().lock();
        cache
            .get(&mem_key)
            .and_then(|(mtime, data)| (*mtime == modified_str).then(|| data.clone()))
    };
    if let Some(data) = cached {
        return Ok(data.as_ref().clone());
    }

    let hash = crate::util::short_hash(&format!(
        "{path}#{audio_track}#{modified_str}#{sample_count}"
    ));
    let dst = state
        .cache_root
        .join("waveforms")
        .join(format!("{hash}.bin"));
    if let Ok(bytes) = std::fs::read(&dst) {
        if bytes.len() % 4 == 0 && !bytes.is_empty() {
            let samples: Vec<f32> = bytes
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect();
            waveform_cache()
                .lock()
                .insert(mem_key, (modified_str, Arc::new(samples.clone())));
            return Ok(samples);
        }
    }

    let ffmpeg = crate::media::resolve_ffmpeg()?;
    let samples =
        crate::media::extract_waveform(&ffmpeg, source, 22050, audio_track, sample_count)?;
    if let Some(dir) = dst.parent() {
        std::fs::create_dir_all(dir).map_err(|e| err("get_waveform", e))?;
    }
    let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    std::fs::write(&dst, bytes).map_err(|e| err("get_waveform", e))?;
    waveform_cache()
        .lock()
        .insert(mem_key, (modified_str, Arc::new(samples.clone())));
    Ok(samples)
}

/// Delete clip files (row + cache + disk) and return per-file failures.
#[tauri::command]
pub async fn delete_clips(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<OpResult, String> {
    let conn = state.db.lock();
    let mut failed: Vec<String> = Vec::new();
    let mut success: Vec<String> = Vec::new();
    // Collect cache files before rows vanish.
    for path in &paths {
        if let Ok(Some(cache)) = crate::db::get_media_cache(&conn, path) {
            if let Some(t) = cache.thumbnail_path {
                let _ = std::fs::remove_file(&t);
            }
            if let Some(w) = cache.waveform_path {
                let _ = std::fs::remove_file(&w);
            }
        }
    }
    let delete_failures = crate::db::delete_clips(&conn, &paths)?;
    for path in paths {
        let file_missing = delete_failures
            .iter()
            .any(|f| f.starts_with(&format!("{path}:")));
        if file_missing {
            failed.push(path);
        } else {
            success.push(path);
        }
    }
    Ok(OpResult {
        success,
        failed,
        error: None,
    })
}

/// Rename the game segment of a clip filename (legacy contract
/// `^(.+?)_(.+?)(\..+)$`), moving cache files and rewriting rows
/// transactionally.
#[tauri::command]
pub async fn rename_clip(
    state: State<'_, AppState>,
    path: String,
    new_game_name: String,
) -> Result<RenameResult, String> {
    let source = Path::new(&path);
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| err("rename_clip", format!("{path}: invalid filename")))?;
    let ext = source
        .extension()
        .and_then(|e| e.to_str())
        .ok_or_else(|| err("rename_clip", format!("{name}: no extension")))?;
    let (prefix, _old_game) = name.split_once('_').ok_or_else(|| {
        err(
            "rename_clip",
            format!("{name}: does not match the `<prefix>_<game>.<ext>` convention"),
        )
    })?;
    let new_name = format!("{prefix}_{new_game_name}.{ext}");
    let new_path = source.with_file_name(&new_name);
    if new_path == source {
        return Ok(RenameResult {
            old_path: path.clone(),
            new_path: path,
        });
    }
    if new_path.exists() {
        return Err(err(
            "rename_clip",
            format!("{} already exists", new_path.display()),
        ));
    }
    std::fs::rename(source, &new_path).map_err(|e| err("rename_clip", format!("{path}: {e}")))?;

    let conn = state.db.lock();
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| err("rename_clip", e))?;
    let new_path_str = new_path.to_string_lossy().into_owned();
    tx.execute(
        "UPDATE clip_groups SET clip_path = ?2 WHERE clip_path = ?1",
        rusqlite::params![path, new_path_str],
    )
    .map_err(|e| err("rename_clip", e))?;
    tx.execute(
        "UPDATE clip_media_cache SET path = ?2 WHERE path = ?1",
        rusqlite::params![path, new_path_str],
    )
    .map_err(|e| err("rename_clip", e))?;
    tx.execute(
        "UPDATE exports SET source_path = ?2 WHERE source_path = ?1",
        rusqlite::params![path, new_path_str],
    )
    .map_err(|e| err("rename_clip", e))?;
    tx.execute(
        "UPDATE clips SET path = ?2, name = ?3, game_name = ?4 WHERE path = ?1",
        rusqlite::params![path, new_path_str, new_name, new_game_name],
    )
    .map_err(|e| err("rename_clip", e))?;
    tx.commit().map_err(|e| err("rename_clip", e))?;
    Ok(RenameResult {
        old_path: path,
        new_path: new_path_str,
    })
}

/// Reveal a file in the OS file manager.
#[tauri::command]
pub async fn show_in_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| err("show_in_folder", e))
}

/// Open a file with the default application.
#[tauri::command]
pub async fn open_file(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(&path, None::<&str>)
        .map_err(|e| err("open_file", e))
}

/// Previous exports for a source clip, newest first.
#[tauri::command]
pub async fn get_previous_exports(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<ExportedClip>, String> {
    let conn = state.db.lock();
    crate::db::exports_for_source(&conn, &path)
}

/// Copy a file to the Windows clipboard as a file drop.
#[tauri::command]
pub async fn copy_file_to_clipboard(path: String) -> Result<(), String> {
    crate::clipboard::copy_file_to_clipboard(&path)
}

#[tauri::command]
pub async fn list_groups(state: State<'_, AppState>) -> Result<Vec<VideoGroup>, String> {
    let conn = state.db.lock();
    crate::db::list_groups(&conn)
}

#[tauri::command]
pub async fn create_group(
    state: State<'_, AppState>,
    name: String,
    color: Option<String>,
) -> Result<VideoGroup, String> {
    let id = format!("g-{}", uuid::Uuid::new_v4());
    let color = color.or_else(|| {
        let hue = (rand_hue()) as u32;
        Some(format!("hsl({hue}, 70%, 50%)"))
    });
    let conn = state.db.lock();
    crate::db::create_group(&conn, &id, &name, color.as_deref())?;
    Ok(VideoGroup { id, name, color })
}

fn rand_hue() -> u16 {
    // Cheap deterministic-ish hue from the clock; no RNG dependency.
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.subsec_nanos() % 360) as u16)
        .unwrap_or(200)
}

#[tauri::command]
pub async fn delete_group(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock();
    crate::db::delete_group(&conn, &id)
}

#[tauri::command]
pub async fn assign_clips_to_group(
    state: State<'_, AppState>,
    clip_paths: Vec<String>,
    group_id: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    crate::db::assign_clips_to_group(&conn, &clip_paths, &group_id)
}

#[tauri::command]
pub async fn remove_clips_from_group(
    state: State<'_, AppState>,
    clip_paths: Vec<String>,
    group_id: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    crate::db::remove_clips_from_group(&conn, &clip_paths, &group_id)
}

/// Export a clip with the legacy option semantics. Emits `export-progress`,
/// `export-complete`, `export-error`; records the result in the exports table
/// with a generated thumbnail.
#[tauri::command]
pub async fn export_clip(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    options: ExportOptions,
) -> Result<ExportResult, String> {
    let result = crate::media::export_clip(&app, &path, &options)?;
    if !result.file_already_exists {
        let output_path = PathBuf::from(&result.output_path);
        // Thumbnail for the previous-exports list.
        let thumb = generate_export_thumbnail(&state, &output_path);
        let timestamp = crate::util::time_now();
        let name = output_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("export")
            .to_string();
        let size = std::fs::metadata(&output_path)
            .map(|m| m.len())
            .unwrap_or(0);
        let duration = crate::media::export_duration(&options);
        let conn = state.db.lock();
        crate::db::insert_export(
            &conn,
            &path,
            &result.output_path,
            &name,
            &timestamp,
            duration,
            thumb.as_deref(),
            size,
        )?;
    }
    Ok(result)
}

fn generate_export_thumbnail(state: &AppState, output: &Path) -> Option<String> {
    let ffmpeg = crate::media::resolve_ffmpeg().ok()?;
    let hash = crate::util::short_hash(&output.to_string_lossy());
    let dst = state
        .cache_root
        .join("export-thumbs")
        .join(format!("{hash}.jpg"));
    if crate::media::generate_thumbnail(&ffmpeg, output, 0.1, &dst).is_ok() {
        Some(dst.to_string_lossy().into_owned())
    } else {
        None
    }
}

/// Remove an exports-table row (the file itself is deleted via delete_clips).
#[tauri::command]
pub async fn remove_export(state: State<'_, AppState>, output_path: String) -> Result<(), String> {
    let conn = state.db.lock();
    crate::db::delete_export(&conn, &output_path)
}

/// Remove a library root (rows, cache, watcher) without touching the files.
#[tauri::command]
pub async fn remove_library_root(state: State<'_, AppState>, path: String) -> Result<(), String> {
    {
        let conn = state.db.lock();
        crate::db::remove_library_root(&conn, &path)?;
        crate::db::sync_recording_output_dir(&conn)?;
    }
    state.watchers.lock().remove(&path);
    Ok(())
}

/// Add a library root, scan it, and start watching it.
#[tauri::command]
pub async fn add_library_root(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    path: String,
) -> Result<ScanResult, String> {
    let canonical = {
        let path_buf = PathBuf::from(&path);
        let canonical = path_buf
            .canonicalize()
            .map_err(|e| err("add_library_root", format!("{path}: {e}")))?;
        strip_extended_prefix(&canonical.to_string_lossy())
    };
    {
        let conn = state.db.lock();
        crate::db::add_library_root(&conn, &canonical)?;
        // The viewed directory is also where clips are saved.
        crate::db::sync_recording_output_dir(&conn)?;
    }
    let mut watchers = state.watchers.lock();
    ensure_watcher(&app, &state, &mut watchers, &canonical)?;
    drop(watchers);
    crate::library::scan_root(&state.db.lock(), &canonical)
}

/// Clips assigned to a group (for the group detail page).
#[tauri::command]
pub async fn get_group_clips(
    state: State<'_, AppState>,
    group_id: String,
) -> Result<Vec<VideoFile>, String> {
    let conn = state.db.lock();
    let paths = crate::db::group_clips(&conn, &group_id)?;
    let group_map = crate::db::clip_group_map(&conn)?;
    let all = crate::db::all_clips(&conn)?;
    let mut clips: Vec<VideoFile> = all
        .into_iter()
        .filter(|c| paths.contains(&c.path))
        .collect();
    for clip in &mut clips {
        clip.group_ids = group_map.get(&clip.path).cloned().unwrap_or_default();
        clip.game_images = crate::steam::images_for_game(&conn, &clip.game);
    }
    Ok(clips)
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Map<String, Value>, String> {
    let conn = state.db.lock();
    crate::db::get_all_settings(&conn)
}

/// Persist one setting. `launchOnStartup` changes are applied to the
/// autostart plugin so SQLite stays authoritative.
#[tauri::command]
pub async fn set_setting(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> Result<(), String> {
    {
        let conn = state.db.lock();
        crate::db::set_setting(&conn, &key, &value)?;
    }
    if key == crate::settings::keys::LAUNCH_ON_STARTUP {
        sync_autostart(&app, value.as_bool().unwrap_or(true));
    }
    Ok(())
}

#[tauri::command]
pub async fn reset_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock();
    crate::db::reset_settings(&conn)?;
    drop(conn);
    sync_autostart(&app, true);
    Ok(())
}

pub fn sync_autostart(_app: &tauri::AppHandle, _enabled: bool) {
    // Dev builds never register autostart (the plugin is release-only), so
    // this is intentionally a no-op there.
    #[cfg(not(debug_assertions))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = _app.autolaunch();
        let result = if _enabled {
            manager.enable()
        } else {
            manager.disable()
        };
        if let Err(e) = result {
            eprintln!("[autostart] sync failed: {e}");
        }
    }
}

/// Import legacy localStorage state from a JSON export (import-only).
#[tauri::command]
pub async fn import_legacy_state(
    state: State<'_, AppState>,
    path: Option<String>,
) -> Result<ImportResult, String> {
    let conn = state.db.lock();
    crate::legacy::import_legacy_state(&conn, path.as_deref())
}

#[tauri::command]
pub async fn start_replay_buffer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let profile = crate::db::get_recording_profile(&state.db.lock())?;
    state.recording.start(&profile, &app)?;
    update_tray_recording_label(&app);
    Ok(())
}

#[tauri::command]
pub async fn save_replay(state: State<'_, AppState>) -> Result<(), String> {
    state.recording.save_now()
}

#[tauri::command]
pub async fn stop_replay_buffer(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.recording.stop()?;
    update_tray_recording_label(&app);
    Ok(())
}

#[tauri::command]
pub async fn get_recording_state(
    state: State<'_, AppState>,
) -> Result<RecordingStatePayload, String> {
    Ok(state.recording.state())
}

#[tauri::command]
pub async fn get_recording_profile(state: State<'_, AppState>) -> Result<RecordingProfile, String> {
    crate::db::get_recording_profile(&state.db.lock())
}

#[tauri::command]
pub async fn set_recording_profile(
    state: State<'_, AppState>,
    profile: RecordingProfile,
) -> Result<(), String> {
    let mut profile = profile;
    {
        // Saves always land in the directory being viewed; seed an empty
        // output dir from the library root before validating so a profile
        // loaded before any root existed can still be saved.
        let conn = state.db.lock();
        if let Some(root) = crate::db::first_library_root(&conn)? {
            profile.output_dir = root;
        }
    }
    crate::recording::config_from_profile(&profile)?;
    {
        let conn = state.db.lock();
        crate::db::set_recording_profile(&conn, &profile)?;
        // Keep the stored profile's output directory in step with the viewed
        // directory even when the UI no longer sets one.
        crate::db::sync_recording_output_dir(&conn)?;
    }
    Ok(())
}

/// Scan Steam libraries, refresh games/artwork in SQLite, and return the
/// full game + alias state plus per-location diagnostics.
#[tauri::command]
pub async fn refresh_steam_data(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<SteamDataResult, String> {
    let steam_dir = state.steam_dir.lock().clone();
    let dirs = crate::steam::discover_steam_dirs(Some(&steam_dir));
    let conn = state.db.lock();
    let mut diagnostics = Vec::new();
    let mut scanned = 0usize;
    for dir in dirs {
        let (games, diags) = crate::steam::scan_games(&dir);
        diagnostics.extend(diags);
        for game in games {
            scanned += 1;
            let artwork = crate::steam::resolve_local_artwork(&dir, &game.app_id);
            let artwork_json = serde_json::to_string(&artwork).map_err(|e| err("steam", e))?;
            crate::db::upsert_game(
                &conn,
                &game.app_id,
                &game.display_name,
                &game.normalized_name,
                &game.source,
                Some(&artwork_json),
                None,
            )?;
        }
    }
    drop(conn);
    let _ = app.emit("steam-scan-done", serde_json::json!({ "scanned": scanned }));
    let list = build_games_result(&state)?;
    // Background CDN fill for missing header/poster roles so cards update
    // without blocking the scan.
    spawn_artwork_fill(&app, &state);
    Ok(SteamDataResult {
        games: list.games,
        diagnostics,
        aliases: list.aliases,
    })
}

/// Fetch missing header/poster artwork for every game whose local assets are
/// incomplete, skipping roles already cached on disk. Runs on the async
/// runtime; emits `steam-artwork-updated` per game.
fn spawn_artwork_fill(app: &tauri::AppHandle, state: &AppState) {
    let app = app.clone();
    let cache_root = state.cache_root.clone();
    let client = state.client.clone();
    tauri::async_runtime::spawn(async move {
        let pending: Vec<(String, Vec<String>)> = {
            let state = app.state::<AppState>();
            let conn = state.db.lock();
            let games = match crate::db::all_games(&conn) {
                Ok(games) => games,
                Err(_) => return,
            };
            games
                .into_iter()
                .map(|game| {
                    let roles = crate::steam::missing_cdn_roles(
                        game.artwork.as_ref().unwrap_or(&GameImage::default()),
                    );
                    (game.app_id, roles)
                })
                .filter(|(_, roles)| !roles.is_empty())
                .collect()
        };
        for (app_id, roles) in pending {
            let mut fetched: Vec<String> = Vec::new();
            let mut error: Option<String> = None;
            for role in roles {
                let cached = cache_root
                    .join("steam-cdn")
                    .join(format!("{app_id}_{role}.jpg"));
                if cached.is_file() {
                    continue;
                }
                match crate::steam::fetch_cdn_artwork(&client, &cache_root, &app_id, &role).await {
                    Ok(path) => {
                        let state = app.state::<AppState>();
                        let conn = state.db.lock();
                        let game_row = crate::db::all_games(&conn)
                            .ok()
                            .and_then(|games| games.into_iter().find(|g| g.app_id == app_id));
                        if let Some(game) = game_row {
                            let mut image = game.artwork.clone().unwrap_or_default();
                            set_image_role(
                                &mut image,
                                &role,
                                Some(path.to_string_lossy().into_owned()),
                            );
                            if let Ok(json) = serde_json::to_string(&image) {
                                let _ =
                                    crate::db::set_game_artwork(&conn, &app_id, Some(&json), None);
                            }
                        }
                        drop(conn);
                        fetched.push(role);
                    }
                    Err(e) => {
                        error = Some(e);
                        break;
                    }
                }
            }
            if !fetched.is_empty() || error.is_some() {
                let _ = app.emit(
                    "steam-artwork-updated",
                    SteamArtworkUpdatedPayload {
                        app_id,
                        roles: fetched,
                        error,
                    },
                );
            }
        }
    });
}

/// All games with artwork overrides applied and local assets validated.
#[tauri::command]
pub async fn get_games(state: State<'_, AppState>) -> Result<ListGamesResult, String> {
    build_games_result(&state)
}

fn build_games_result(state: &AppState) -> Result<ListGamesResult, String> {
    let conn = state.db.lock();
    let games = crate::db::all_games(&conn)?;
    let aliases = crate::db::get_game_aliases(&conn)?;
    let mut games_out = Vec::new();
    for mut game in games {
        apply_artwork_overrides(&conn, &mut game);
        game.pending_roles = game
            .artwork
            .as_ref()
            .map(crate::steam::missing_cdn_roles)
            .unwrap_or_else(|| vec!["header".into(), "library_600x900".into()]);
        games_out.push(game);
    }
    Ok(ListGamesResult {
        games: games_out,
        aliases: aliases
            .into_iter()
            .map(|(alias, app_id)| GameAlias { alias, app_id })
            .collect(),
    })
}

/// Apply custom overrides (never replaced by CDN) and drop local asset paths
/// that no longer exist so stale artwork is invalidated.
fn apply_artwork_overrides(conn: &Connection, game: &mut SteamGame) {
    let overrides = match crate::db::get_artwork_overrides(conn, &game.app_id) {
        Ok(o) => o,
        Err(_) => return,
    };
    let mut image = game.artwork.clone().unwrap_or_default();
    for role in [
        "header",
        "library_600x900",
        "library_hero",
        "library_hero_blur",
        "logo",
        "icon",
    ] {
        if let Some(value) = overrides.get(role) {
            let is_url = value.starts_with("http://") || value.starts_with("https://");
            if is_url || Path::new(value).is_file() {
                set_image_role(&mut image, role, Some(value.clone()));
            }
            continue;
        }
        // Local scanned asset that vanished: invalidate.
        let current = get_image_role(&image, role);
        if let Some(path) = current {
            if !path.starts_with("http") && !Path::new(&path).is_file() {
                set_image_role(&mut image, role, None);
            }
        }
    }
    game.artwork = Some(image);
}

fn get_image_role(image: &GameImage, role: &str) -> Option<String> {
    match role {
        "header" => image.header.clone(),
        "library_600x900" => image.library_600x900.clone(),
        "library_hero" => image.library_hero.clone(),
        "library_hero_blur" => image.library_hero_blur.clone(),
        "logo" => image.logo.clone(),
        "icon" => image.icon.clone(),
        _ => None,
    }
}

fn set_image_role(image: &mut GameImage, role: &str, value: Option<String>) {
    match role {
        "header" => image.header = value,
        "library_600x900" => image.library_600x900 = value,
        "library_hero" => image.library_hero = value,
        "library_hero_blur" => image.library_hero_blur = value,
        "logo" => image.logo = value,
        "icon" => image.icon = value,
        _ => {}
    }
}

/// CDN fallback for the missing header/poster roles of one game. Never blocks
/// the library: failures leave the placeholder state and emit the error.
#[tauri::command]
pub async fn refresh_steam_artwork(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    app_id: String,
) -> Result<(), String> {
    let cache_root = state.cache_root.clone();
    let client = state.client.clone();
    let (game, overrides) = {
        let conn = state.db.lock();
        let mut game = crate::db::all_games(&conn)?
            .into_iter()
            .find(|g| g.app_id == app_id)
            .ok_or_else(|| err("steam.artwork", format!("unknown game {app_id}")))?;
        apply_artwork_overrides(&conn, &mut game);
        let overrides = crate::db::get_artwork_overrides(&conn, &app_id)?;
        (game, overrides)
    };

    let mut image = game.artwork.clone().unwrap_or_default();
    let mut fetched: Vec<String> = Vec::new();
    let mut error: Option<String> = None;
    for role in crate::steam::missing_cdn_roles(&image) {
        if overrides.contains_key(&role) {
            continue; // never replace a custom override
        }
        match crate::steam::fetch_cdn_artwork(&client, &cache_root, &app_id, &role).await {
            Ok(path) => {
                set_image_role(&mut image, &role, Some(path.to_string_lossy().into_owned()));
                fetched.push(role);
            }
            Err(e) => {
                error = Some(e);
                break;
            }
        }
    }
    let artwork_json = serde_json::to_string(&image).map_err(|e| err("steam.artwork", e))?;
    let conn = state.db.lock();
    crate::db::set_game_artwork(&conn, &app_id, Some(&artwork_json), error.as_deref())?;
    drop(conn);
    let _ = app.emit(
        "steam-artwork-updated",
        SteamArtworkUpdatedPayload {
            app_id,
            roles: fetched,
            error,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn add_custom_game(
    state: State<'_, AppState>,
    name: String,
) -> Result<SteamGame, String> {
    let app_id = format!("custom-{}", uuid::Uuid::new_v4());
    let conn = state.db.lock();
    crate::db::add_custom_game(&conn, &app_id, &name)?;
    Ok(SteamGame {
        app_id,
        display_name: name.clone(),
        normalized_name: crate::steam::normalize_name(&name),
        source: "custom".into(),
        artwork: None,
        artwork_error: None,
        pending_roles: Vec::new(),
    })
}

#[tauri::command]
pub async fn remove_custom_game(state: State<'_, AppState>, app_id: String) -> Result<(), String> {
    let conn = state.db.lock();
    crate::db::remove_custom_game(&conn, &app_id)
}

#[tauri::command]
pub async fn set_custom_game_image(
    state: State<'_, AppState>,
    app_id: String,
    role: String,
    path_or_url: String,
) -> Result<(), String> {
    if !["header", "library_600x900", "library_hero", "logo", "icon"].contains(&role.as_str()) {
        return Err(err(
            "set_custom_game_image",
            format!("unknown role `{role}`"),
        ));
    }
    let conn = state.db.lock();
    crate::db::set_artwork_override(&conn, &app_id, &role, &path_or_url)
}

#[tauri::command]
pub async fn set_game_alias(
    state: State<'_, AppState>,
    alias: String,
    app_id: String,
) -> Result<(), String> {
    let conn = state.db.lock();
    crate::db::set_game_alias(&conn, &alias, &app_id)
}

#[tauri::command]
pub async fn remove_game_alias(state: State<'_, AppState>, alias: String) -> Result<(), String> {
    let conn = state.db.lock();
    crate::db::remove_game_alias(&conn, &alias)
}
