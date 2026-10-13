//! Library scanning: stat clips in a root directory into SQLite with the
//! legacy filename -> game convention. Unreadable files stay visible with an
//! error state; a duplicate path refreshes stat data instead of duplicating.

use rusqlite::Connection;
use std::path::{Path, PathBuf};

use crate::types::{err, ScanResult, VideoFile};

/// Scan one root (flat, matching the legacy browser) and upsert/delete clip
/// rows. Returns the number of clips found plus per-file failures.
pub fn scan_root(conn: &Connection, root: &str) -> Result<ScanResult, String> {
    let root_path = PathBuf::from(root);
    let mut result = ScanResult {
        roots: vec![root.to_string()],
        clips: 0,
        failures: Vec::new(),
    };
    let entries = std::fs::read_dir(&root_path).map_err(|e| err("scan", format!("{root}: {e}")))?;
    let mut seen: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                result.failures.push(format!("read_dir: {e}"));
                continue;
            }
        };
        let path = entry.path();
        let is_video = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(crate::util::is_video_file);
        if !is_video {
            continue;
        }
        seen.push(path.clone());
        match stat_clip(&path) {
            Ok(clip) => {
                if let Err(e) = crate::db::upsert_clip(conn, &clip) {
                    result.failures.push(e);
                }
            }
            Err(e) => {
                // Unreadable file: keep a row with the error state.
                let name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();
                let clip = VideoFile {
                    name,
                    game: "Unknown".to_string(),
                    path: path.to_string_lossy().into_owned(),
                    size: 0,
                    last_modified: crate::util::time_now(),
                    metadata: None,
                    scan_error: Some(e.clone()),
                    game_images: None,
                    group_ids: Vec::new(),
                    thumbnail: None,
                    thumbhash: None,
                };
                let _ = crate::db::upsert_clip(conn, &clip);
                result.failures.push(format!("{}: {e}", path.display()));
            }
        }
    }
    // Drop rows whose files are gone (and their cache entries).
    let existing = crate::db::all_clips(conn)?;
    let mut stale = Vec::new();
    for clip in existing {
        let clip_path = Path::new(&clip.path);
        if clip_path.starts_with(&root_path) && !seen.iter().any(|p| p == clip_path) {
            stale.push(clip.path);
        }
    }
    if !stale.is_empty() {
        let _ = crate::db::delete_clips(conn, &stale);
    }
    result.clips = seen.len();
    Ok(result)
}

/// Stat one file into a VideoFile row (metadata is loaded lazily).
pub fn stat_clip(path: &Path) -> Result<VideoFile, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("{e}"))?;
    if !metadata.is_file() {
        return Err("not a file".to_string());
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "non-UTF-8 filename".to_string())?
        .to_string();
    let modified = metadata
        .modified()
        .map_err(|e| format!("unreadable modified time: {e}"))?;
    let modified: chrono::DateTime<chrono::Utc> = modified.into();
    let game = crate::util::game_from_filename(&name);
    Ok(VideoFile {
        name,
        game,
        path: path.to_string_lossy().into_owned(),
        size: metadata.len(),
        last_modified: crate::util::format_time(modified),
        metadata: None,
        scan_error: None,
        game_images: None,
        group_ids: Vec::new(),
        thumbnail: None,
        thumbhash: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_clip_extracts_game_and_time() {
        let dir = std::env::temp_dir().join(format!("clip-scan-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Replay 2026-01-01 00-00-00_Hades.mkv");
        std::fs::write(&file, b"fake video bytes").unwrap();
        let clip = stat_clip(&file).unwrap();
        assert_eq!(clip.game, "Hades");
        assert_eq!(clip.name, "Replay 2026-01-01 00-00-00_Hades.mkv");
        assert!(clip.size > 0);
        assert!(clip.last_modified.starts_with("20"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_root_upserts_and_prunes() {
        let dir = std::env::temp_dir().join(format!("clip-scan-root-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_dir = std::env::temp_dir().join(format!("clip-scan-db-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&db_dir).unwrap();
        let conn = crate::db::open(&db_dir.join("t.db")).unwrap();
        let root = dir.to_string_lossy().into_owned();

        let a = dir.join("Replay 2026-01-01 00-00-00_Game.mkv");
        let b = dir.join("clip2.mp4");
        std::fs::write(&a, b"v").unwrap();
        std::fs::write(&b, b"v").unwrap();
        let result = scan_root(&conn, &root).unwrap();
        assert_eq!(result.clips, 2);
        assert_eq!(crate::db::all_clips(&conn).unwrap().len(), 2);

        // A stale row from a previous run is pruned when its file is gone.
        crate::db::upsert_clip(
            &conn,
            &VideoFile {
                name: "gone.mkv".into(),
                game: "Gone".into(),
                path: format!("{root}/gone.mkv"),
                size: 1,
                last_modified: crate::util::time_now(),
                metadata: None,
                scan_error: None,
                game_images: None,
                group_ids: vec![],
                thumbnail: None,
                thumbhash: None,
            },
        )
        .unwrap();
        let result = scan_root(&conn, &root).unwrap();
        assert_eq!(result.clips, 2);
        assert_eq!(crate::db::all_clips(&conn).unwrap().len(), 2);
        // Unsupported extension is ignored.
        std::fs::write(dir.join("note.txt"), b"x").unwrap();
        let result = scan_root(&conn, &root).unwrap();
        assert_eq!(result.clips, 2);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&db_dir);
    }
}
