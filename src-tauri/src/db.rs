//! SQLite persistence: a single baked schema (no migrations — this app has
//! only ever run locally), with typed table helpers. The database lives under
//! the Tauri app-data directory and is opened with the bundled SQLite so no
//! system database is required.

use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::types::{err, VideoFile, VideoGroup};

/// Open (creating if needed) the database and ensure the schema exists.
pub fn open(db_path: &Path) -> Result<Connection, String> {
    if let Some(dir) = db_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| err("db.open", e))?;
    }
    let conn = Connection::open(db_path).map_err(|e| err("db.open", e))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| err("db.open", e))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| err("db.open", e))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| err("db.open", e))?;
    create_schema(&conn)?;
    Ok(conn)
}

/// Create the full schema idempotently (`IF NOT EXISTS` so an existing
/// database from an earlier build — which already has the same columns — is
/// untouched).
fn create_schema(conn: &Connection) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| err("db.schema", e))?;
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS library_roots (
            path TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS clips (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            game_name TEXT NOT NULL,
            size INTEGER NOT NULL,
            modified_at TEXT NOT NULL,
            metadata_json TEXT,
            scan_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_clips_modified ON clips(modified_at);
        CREATE INDEX IF NOT EXISTS idx_clips_game ON clips(game_name);
        CREATE TABLE IF NOT EXISTS clip_media_cache (
            path TEXT PRIMARY KEY,
            size INTEGER NOT NULL,
            modified_at TEXT NOT NULL,
            thumbnail_path TEXT,
            waveform_path TEXT,
            thumbhash TEXT
        );
        CREATE TABLE IF NOT EXISTS games (
            app_id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            normalized_name TEXT NOT NULL,
            source TEXT NOT NULL,
            artwork_json TEXT,
            artwork_error TEXT
        );
        CREATE TABLE IF NOT EXISTS game_aliases (
            alias TEXT PRIMARY KEY,
            app_id TEXT NOT NULL,
            FOREIGN KEY (app_id) REFERENCES games(app_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_game_aliases_app ON game_aliases(app_id);
        CREATE TABLE IF NOT EXISTS game_artwork_overrides (
            app_id TEXT NOT NULL,
            role TEXT NOT NULL,
            path_or_url TEXT NOT NULL,
            PRIMARY KEY (app_id, role),
            FOREIGN KEY (app_id) REFERENCES games(app_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            color TEXT
        );
        CREATE TABLE IF NOT EXISTS clip_groups (
            clip_path TEXT NOT NULL,
            group_id TEXT NOT NULL,
            PRIMARY KEY (clip_path, group_id),
            FOREIGN KEY (clip_path) REFERENCES clips(path) ON DELETE CASCADE,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_clip_groups_group ON clip_groups(group_id);
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            json_value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS recording_profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            json_value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS exports (
            id INTEGER PRIMARY KEY,
            source_path TEXT NOT NULL,
            output_path TEXT NOT NULL,
            name TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            duration REAL NOT NULL,
            thumbnail_path TEXT,
            size INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_exports_source ON exports(source_path);
        "#,
    )
    .map_err(|e| err("db.schema", e))?;
    seed_defaults(&tx)?;
    tx.commit().map_err(|e| err("db.schema", e))?;
    Ok(())
}

/// First-run defaults: settings and the recording profile. Idempotent so it is
/// safe to run on every open.
fn seed_defaults(tx: &rusqlite::Transaction) -> Result<(), String> {
    let settings = crate::settings::default_settings();
    for (key, value) in settings {
        tx.execute(
            "INSERT OR IGNORE INTO settings (key, json_value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|e| err("db.seed", e))?;
    }
    let profile = serde_json::to_string(&crate::types::RecordingProfile::default())
        .map_err(|e| err("db.seed", e))?;
    tx.execute(
        "INSERT OR IGNORE INTO recording_profile (id, json_value) VALUES (1, ?1)",
        params![profile],
    )
    .map_err(|e| err("db.seed", e))?;
    Ok(())
}

pub fn list_library_roots(conn: &Connection) -> Result<Vec<(String, bool)>, String> {
    let mut stmt = conn
        .prepare("SELECT path, enabled FROM library_roots ORDER BY created_at")
        .map_err(|e| err("db.roots", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
        })
        .map_err(|e| err("db.roots", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| err("db.roots", e))?);
    }
    Ok(out)
}

pub fn add_library_root(conn: &Connection, path: &str) -> Result<(), String> {
    let now = crate::util::time_now();
    conn.execute(
        "INSERT INTO library_roots (path, enabled, created_at) VALUES (?1, 1, ?2)
         ON CONFLICT(path) DO UPDATE SET enabled = 1",
        params![path, now],
    )
    .map_err(|e| err("db.roots", e))?;
    Ok(())
}

pub fn remove_library_root(conn: &Connection, path: &str) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| err("db.roots", e))?;
    // Removing a root cascades its clips and assignments.
    tx.execute(
        "DELETE FROM clips WHERE path LIKE ?1",
        params![format!("{path}%")],
    )
    .map_err(|e| err("db.roots", e))?;
    tx.execute("DELETE FROM library_roots WHERE path = ?1", params![path])
        .map_err(|e| err("db.roots", e))?;
    tx.commit().map_err(|e| err("db.roots", e))?;
    Ok(())
}

pub fn upsert_clip(conn: &Connection, clip: &VideoFile) -> Result<(), String> {
    let metadata_json = clip
        .metadata
        .as_ref()
        .map(|m| serde_json::to_string(m).map_err(|e| err("db.clips", e)))
        .transpose()?;
    conn.execute(
        "INSERT INTO clips (path, name, game_name, size, modified_at, metadata_json, scan_error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(path) DO UPDATE SET
            name = excluded.name,
            game_name = excluded.game_name,
            size = excluded.size,
            modified_at = excluded.modified_at,
            metadata_json = excluded.metadata_json,
            scan_error = excluded.scan_error",
        params![
            clip.path,
            clip.name,
            clip.game,
            clip.size as i64,
            clip.last_modified,
            metadata_json,
            clip.scan_error,
        ],
    )
    .map_err(|e| err("db.clips", e))?;
    Ok(())
}

pub fn delete_clips(conn: &Connection, paths: &[String]) -> Result<Vec<String>, String> {
    let mut failed = Vec::new();
    for path in paths {
        if let Err(e) = delete_media_cache_rows(conn, path) {
            failed.push(format!("{path}: {e}"));
        }
        match conn.execute("DELETE FROM clips WHERE path = ?1", params![path]) {
            Ok(_) => {}
            Err(e) => {
                failed.push(format!("{path}: {e}"));
                continue;
            }
        }
        if let Err(e) = remove_file_from_disk(path) {
            failed.push(format!("{path}: {e}"));
        }
    }
    Ok(failed)
}

fn remove_file_from_disk(path: &str) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Cached metadata for a clip: (metadata, modified_at, size) when the row has
/// it.
pub fn clip_metadata(
    conn: &Connection,
    path: &str,
) -> Result<Option<(crate::types::VideoMetadata, String, u64)>, String> {
    conn.query_row(
        "SELECT metadata_json, modified_at, size FROM clips WHERE path = ?1 AND metadata_json IS NOT NULL",
        params![path],
        |row| {
            let json: String = row.get(0)?;
            let meta = serde_json::from_str(&json).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    0,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, e)),
                )
            })?;
            Ok((meta, row.get::<_, String>(1)?, row.get::<_, i64>(2)? as u64))
        },
    )
    .optional()
    .map_err(|e| err("db.clips", e))
}

/// Refresh a clip's cached metadata after a probe.
pub fn update_clip_metadata(
    conn: &Connection,
    path: &str,
    metadata: &crate::types::VideoMetadata,
    size: u64,
    modified_at: &str,
) -> Result<(), String> {
    let metadata_json = serde_json::to_string(metadata).map_err(|e| err("db.clips", e))?;
    conn.execute(
        "UPDATE clips SET metadata_json = ?2, size = ?3, modified_at = ?4, scan_error = NULL WHERE path = ?1",
        params![path, metadata_json, size as i64, modified_at],
    )
    .map_err(|e| err("db.clips", e))?;
    Ok(())
}

/// All clip rows, newest first.
pub fn all_clips(conn: &Connection) -> Result<Vec<VideoFile>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.path, c.name, c.game_name, c.size, c.modified_at, c.metadata_json,
                    c.scan_error, m.thumbnail_path, m.thumbhash
             FROM clips c
             LEFT JOIN clip_media_cache m ON m.path = c.path
             ORDER BY c.modified_at DESC",
        )
        .map_err(|e| err("db.clips", e))?;
    let rows = stmt
        .query_map([], clip_from_row)
        .map_err(|e| err("db.clips", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| err("db.clips", e))?);
    }
    Ok(out)
}

fn clip_from_row(row: &rusqlite::Row) -> rusqlite::Result<VideoFile> {
    let metadata_json: Option<String> = row.get(5)?;
    let scan_error: Option<String> = row.get(6)?;
    Ok(VideoFile {
        path: row.get(0)?,
        name: row.get(1)?,
        game: row.get(2)?,
        size: row.get::<_, i64>(3)? as u64,
        last_modified: row.get(4)?,
        metadata: metadata_json
            .and_then(|j| serde_json::from_str(&j).ok())
            .or_else(|| scan_error.as_ref().map(|_| None))
            .flatten(),
        scan_error,
        game_images: None,
        group_ids: Vec::new(),
        thumbnail: row.get(7)?,
        thumbhash: row.get(8)?,
    })
}

#[derive(Debug, Clone, Default)]
pub struct MediaCacheRow {
    pub thumbnail_path: Option<String>,
    pub waveform_path: Option<String>,
    pub thumbhash: Option<String>,
}

pub fn get_media_cache(conn: &Connection, path: &str) -> Result<Option<MediaCacheRow>, String> {
    conn.query_row(
        "SELECT thumbnail_path, waveform_path, thumbhash FROM clip_media_cache WHERE path = ?1",
        params![path],
        |row| {
            Ok(MediaCacheRow {
                thumbnail_path: row.get(0)?,
                waveform_path: row.get(1)?,
                thumbhash: row.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| err("db.cache", e))
}

pub fn put_thumbnail_cache(
    conn: &Connection,
    path: &str,
    size: u64,
    modified_at: &str,
    thumbnail_path: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO clip_media_cache (path, size, modified_at, thumbnail_path, waveform_path)
         VALUES (?1, ?2, ?3, ?4, NULL)
         ON CONFLICT(path) DO UPDATE SET
            size = excluded.size,
            modified_at = excluded.modified_at,
            thumbnail_path = excluded.thumbnail_path",
        params![path, size as i64, modified_at, thumbnail_path],
    )
    .map_err(|e| err("db.cache", e))?;
    Ok(())
}

/// Store a clip's base64 ThumbHash placeholder (kept even if a later thumbnail
/// or waveform write replaces the row's other fields).
pub fn put_thumbhash_cache(
    conn: &Connection,
    path: &str,
    size: u64,
    modified_at: &str,
    thumbhash: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO clip_media_cache (path, size, modified_at, thumbhash)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET
            size = excluded.size,
            modified_at = excluded.modified_at,
            thumbhash = excluded.thumbhash",
        params![path, size as i64, modified_at, thumbhash],
    )
    .map_err(|e| err("db.cache", e))?;
    Ok(())
}

pub fn put_waveform_cache(
    conn: &Connection,
    path: &str,
    size: u64,
    modified_at: &str,
    waveform_path: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO clip_media_cache (path, size, modified_at, thumbnail_path, waveform_path)
         VALUES (?1, ?2, ?3, NULL, ?4)
         ON CONFLICT(path) DO UPDATE SET
            size = excluded.size,
            modified_at = excluded.modified_at,
            waveform_path = excluded.waveform_path",
        params![path, size as i64, modified_at, waveform_path],
    )
    .map_err(|e| err("db.cache", e))?;
    Ok(())
}

/// Drop cache rows whose recorded identity no longer matches the file.
/// Returns the stale cache file paths so the caller can delete them.
pub fn invalidate_stale_media_cache(
    conn: &Connection,
    path: &str,
    size: u64,
    modified_at: &str,
) -> Result<MediaCacheRow, String> {
    let row = get_media_cache(conn, path)?;
    if let Some(row) = &row {
        let stale = conn
            .query_row(
                "SELECT 1 FROM clip_media_cache WHERE path = ?1 AND size = ?2 AND modified_at = ?3",
                params![path, size as i64, modified_at],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| err("db.cache", e))?
            .is_none();
        if stale {
            conn.execute(
                "DELETE FROM clip_media_cache WHERE path = ?1",
                params![path],
            )
            .map_err(|e| err("db.cache", e))?;
            return Ok(row.clone());
        }
    }
    Ok(MediaCacheRow::default())
}

fn delete_media_cache_rows(conn: &Connection, path: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM clip_media_cache WHERE path = ?1",
        params![path],
    )
    .map_err(|e| err("db.cache", e))?;
    Ok(())
}

pub fn upsert_game(
    conn: &Connection,
    app_id: &str,
    display_name: &str,
    normalized_name: &str,
    source: &str,
    artwork_json: Option<&str>,
    artwork_error: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO games (app_id, display_name, normalized_name, source, artwork_json, artwork_error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(app_id) DO UPDATE SET
            display_name = excluded.display_name,
            normalized_name = excluded.normalized_name,
            source = excluded.source,
            artwork_json = COALESCE(excluded.artwork_json, games.artwork_json),
            artwork_error = COALESCE(excluded.artwork_error, games.artwork_error)",
        params![app_id, display_name, normalized_name, source, artwork_json, artwork_error],
    )
    .map_err(|e| err("db.games", e))?;
    Ok(())
}

pub fn set_game_artwork(
    conn: &Connection,
    app_id: &str,
    artwork_json: Option<&str>,
    artwork_error: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE games SET artwork_json = ?2, artwork_error = ?3 WHERE app_id = ?1",
        params![app_id, artwork_json, artwork_error],
    )
    .map_err(|e| err("db.games", e))?;
    Ok(())
}

pub fn set_game_alias(conn: &Connection, alias: &str, app_id: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO game_aliases (alias, app_id) VALUES (?1, ?2)
         ON CONFLICT(alias) DO UPDATE SET app_id = excluded.app_id",
        params![alias, app_id],
    )
    .map_err(|e| err("db.games", e))?;
    Ok(())
}

pub fn remove_game_alias(conn: &Connection, alias: &str) -> Result<(), String> {
    conn.execute("DELETE FROM game_aliases WHERE alias = ?1", params![alias])
        .map_err(|e| err("db.games", e))?;
    Ok(())
}

pub fn get_game_aliases(conn: &Connection) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT alias, app_id FROM game_aliases")
        .map_err(|e| err("db.games", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| err("db.games", e))?;
    let mut out = HashMap::new();
    for row in rows {
        let (alias, app_id) = row.map_err(|e| err("db.games", e))?;
        out.insert(alias, app_id);
    }
    Ok(out)
}

pub fn set_artwork_override(
    conn: &Connection,
    app_id: &str,
    role: &str,
    path_or_url: &str,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO game_artwork_overrides (app_id, role, path_or_url) VALUES (?1, ?2, ?3)
         ON CONFLICT(app_id, role) DO UPDATE SET path_or_url = excluded.path_or_url",
        params![app_id, role, path_or_url],
    )
    .map_err(|e| err("db.games", e))?;
    Ok(())
}

pub fn get_artwork_overrides(
    conn: &Connection,
    app_id: &str,
) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT role, path_or_url FROM game_artwork_overrides WHERE app_id = ?1")
        .map_err(|e| err("db.games", e))?;
    let rows = stmt
        .query_map(params![app_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| err("db.games", e))?;
    let mut out = HashMap::new();
    for row in rows {
        let (role, path) = row.map_err(|e| err("db.games", e))?;
        out.insert(role, path);
    }
    Ok(out)
}

pub fn add_custom_game(conn: &Connection, app_id: &str, display_name: &str) -> Result<(), String> {
    let normalized = crate::steam::normalize_name(display_name);
    upsert_game(
        conn,
        app_id,
        display_name,
        &normalized,
        "custom",
        None,
        None,
    )
}

pub fn remove_custom_game(conn: &Connection, app_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM games WHERE app_id = ?1 AND source = 'custom'",
        params![app_id],
    )
    .map_err(|e| err("db.games", e))?;
    Ok(())
}

pub fn all_games(conn: &Connection) -> Result<Vec<crate::types::SteamGame>, String> {
    let mut stmt = conn
        .prepare("SELECT app_id, display_name, normalized_name, source, artwork_json, artwork_error FROM games ORDER BY display_name")
        .map_err(|e| err("db.games", e))?;
    let rows = stmt
        .query_map([], |row| {
            let artwork_json: Option<String> = row.get(4)?;
            let artwork_error: Option<String> = row.get(5)?;
            Ok(crate::types::SteamGame {
                app_id: row.get(0)?,
                display_name: row.get(1)?,
                normalized_name: row.get(2)?,
                source: row.get(3)?,
                artwork: artwork_json.and_then(|j| serde_json::from_str(&j).ok()),
                artwork_error,
                pending_roles: Vec::new(),
            })
        })
        .map_err(|e| err("db.games", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| err("db.games", e))?);
    }
    Ok(out)
}

pub fn list_groups(conn: &Connection) -> Result<Vec<VideoGroup>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, color FROM groups ORDER BY name")
        .map_err(|e| err("db.groups", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(VideoGroup {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .map_err(|e| err("db.groups", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| err("db.groups", e))?);
    }
    Ok(out)
}

pub fn create_group(
    conn: &Connection,
    id: &str,
    name: &str,
    color: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO groups (id, name, color) VALUES (?1, ?2, ?3)",
        params![id, name, color],
    )
    .map_err(|e| err("db.groups", e))?;
    Ok(())
}

pub fn delete_group(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM groups WHERE id = ?1", params![id])
        .map_err(|e| err("db.groups", e))?;
    Ok(())
}

/// Map of clip path -> group ids.
pub fn clip_group_map(conn: &Connection) -> Result<HashMap<String, Vec<String>>, String> {
    let mut stmt = conn
        .prepare("SELECT clip_path, group_id FROM clip_groups")
        .map_err(|e| err("db.groups", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| err("db.groups", e))?;
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let (clip, group) = row.map_err(|e| err("db.groups", e))?;
        out.entry(clip).or_default().push(group);
    }
    Ok(out)
}

pub fn group_clips(conn: &Connection, group_id: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT clip_path FROM clip_groups WHERE group_id = ?1")
        .map_err(|e| err("db.groups", e))?;
    let rows = stmt
        .query_map(params![group_id], |row| row.get::<_, String>(0))
        .map_err(|e| err("db.groups", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| err("db.groups", e))?);
    }
    Ok(out)
}

pub fn assign_clips_to_group(
    conn: &Connection,
    clip_paths: &[String],
    group_id: &str,
) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| err("db.groups", e))?;
    {
        let mut stmt = tx
            .prepare("INSERT OR IGNORE INTO clip_groups (clip_path, group_id) VALUES (?1, ?2)")
            .map_err(|e| err("db.groups", e))?;
        for path in clip_paths {
            stmt.execute(params![path, group_id])
                .map_err(|e| err("db.groups", format!("{path}: {e}")))?;
        }
    }
    tx.commit().map_err(|e| err("db.groups", e))?;
    Ok(())
}

pub fn remove_clips_from_group(
    conn: &Connection,
    clip_paths: &[String],
    group_id: &str,
) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| err("db.groups", e))?;
    {
        let mut stmt = tx
            .prepare("DELETE FROM clip_groups WHERE clip_path = ?1 AND group_id = ?2")
            .map_err(|e| err("db.groups", e))?;
        for path in clip_paths {
            stmt.execute(params![path, group_id])
                .map_err(|e| err("db.groups", format!("{path}: {e}")))?;
        }
    }
    tx.commit().map_err(|e| err("db.groups", e))?;
    Ok(())
}

pub fn get_all_settings(
    conn: &Connection,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let mut stmt = conn
        .prepare("SELECT key, json_value FROM settings")
        .map_err(|e| err("db.settings", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| err("db.settings", e))?;
    let mut out = serde_json::Map::new();
    for row in rows {
        let (key, json) = row.map_err(|e| err("db.settings", e))?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) {
            out.insert(key, value);
        }
    }
    Ok(out)
}

pub fn set_setting(conn: &Connection, key: &str, value: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string(value).map_err(|e| err("db.settings", e))?;
    conn.execute(
        "INSERT INTO settings (key, json_value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET json_value = excluded.json_value",
        params![key, json],
    )
    .map_err(|e| err("db.settings", e))?;
    Ok(())
}

pub fn reset_settings(conn: &Connection) -> Result<(), String> {
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| err("db.settings", e))?;
    tx.execute("DELETE FROM settings", [])
        .map_err(|e| err("db.settings", e))?;
    for (key, value) in crate::settings::default_settings() {
        tx.execute(
            "INSERT INTO settings (key, json_value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|e| err("db.settings", e))?;
    }
    tx.commit().map_err(|e| err("db.settings", e))?;
    Ok(())
}

/// A sensible default capture directory: the user's Videos folder, falling
/// back to the home directory, then the app data dir.
pub fn default_output_dir() -> PathBuf {
    #[cfg(windows)]
    {
        use windows::Win32::UI::Shell::{SHGetKnownFolderPath, KNOWN_FOLDER_FLAG};
        let path = unsafe {
            SHGetKnownFolderPath(
                &windows::core::GUID::from_u128(0x18989AB1_7A1D_41A0_86D4_0405A845B5E5), // FOLDERID_Videos
                KNOWN_FOLDER_FLAG(0),
                None,
            )
        }
        .ok();
        if let Some(path) = path {
            let videos = unsafe { path.to_string().ok() };
            unsafe { windows::Win32::System::Com::CoTaskMemFree(Some(path.0 as *const _)) };
            if let Some(videos) = videos {
                return PathBuf::from(videos).join("Clip Editor");
            }
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let candidate = PathBuf::from(home).join("Videos").join("Clip Editor");
        if candidate.parent().is_some() {
            return candidate;
        }
    }
    PathBuf::from("captures")
}

pub fn get_recording_profile(conn: &Connection) -> Result<crate::types::RecordingProfile, String> {
    let mut profile = conn
        .query_row(
            "SELECT json_value FROM recording_profile WHERE id = 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| err("db.recording", e))?
        .map(|json| serde_json::from_str::<crate::types::RecordingProfile>(&json))
        .transpose()
        .map_err(|e| err("db.recording", e))?
        .unwrap_or_default();
    // Saved clips always land in the directory being viewed (the first
    // library root). A fresh install has no output dir yet; seed it so the
    // buffer can start without an explicit "save location" setting.
    if profile.output_dir.trim().is_empty() {
        if let Some(root) = first_library_root(conn)? {
            profile.output_dir = root;
        }
    }
    Ok(profile)
}

/// First library root (the directory the library UI shows), if any.
pub fn first_library_root(conn: &Connection) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT path FROM library_roots ORDER BY created_at LIMIT 1",
        [],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|e| err("db.roots", e))
}

/// Point the stored recording profile's output directory at the first library
/// root so saved clips land in the currently viewed directory. Leaves the
/// profile untouched when no library root exists yet.
pub fn sync_recording_output_dir(conn: &Connection) -> Result<(), String> {
    let Some(root) = first_library_root(conn)? else {
        return Ok(());
    };
    let mut profile = get_recording_profile(conn)?;
    // Always write: `get_recording_profile` seeds an empty dir from the root,
    // so a "different" check would never fire for a freshly-created profile.
    profile.output_dir = root;
    set_recording_profile(conn, &profile)
}

pub fn set_recording_profile(
    conn: &Connection,
    profile: &crate::types::RecordingProfile,
) -> Result<(), String> {
    let json = serde_json::to_string(profile).map_err(|e| err("db.recording", e))?;
    conn.execute(
        "INSERT INTO recording_profile (id, json_value) VALUES (1, ?1)
         ON CONFLICT(id) DO UPDATE SET json_value = excluded.json_value",
        params![json],
    )
    .map_err(|e| err("db.recording", e))?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn insert_export(
    conn: &Connection,
    source_path: &str,
    output_path: &str,
    name: &str,
    timestamp: &str,
    duration: f64,
    thumbnail_path: Option<&str>,
    size: u64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO exports (source_path, output_path, name, timestamp, duration, thumbnail_path, size)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            source_path,
            output_path,
            name,
            timestamp,
            duration,
            thumbnail_path,
            size as i64,
        ],
    )
    .map_err(|e| err("db.exports", e))?;
    Ok(())
}

pub fn exports_for_source(
    conn: &Connection,
    source_path: &str,
) -> Result<Vec<crate::types::ExportedClip>, String> {
    // Windows canonical paths carry a `\\?\` prefix; some rows were recorded
    // without it, so match either form.
    let stripped = source_path.strip_prefix(r"\\?\").unwrap_or(source_path);
    let mut stmt = conn
        .prepare("SELECT output_path, name, timestamp, duration, thumbnail_path, size FROM exports WHERE source_path = ?1 OR source_path = ?2 ORDER BY timestamp DESC")
        .map_err(|e| err("db.exports", e))?;
    let rows = stmt
        .query_map(params![source_path, stripped], |row| {
            Ok(crate::types::ExportedClip {
                path: row.get(0)?,
                name: row.get(1)?,
                timestamp: row.get::<_, String>(2)?,
                duration: row.get(3)?,
                thumbnail: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                size: row.get::<_, i64>(5)? as u64,
            })
        })
        .map_err(|e| err("db.exports", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| err("db.exports", e))?);
    }
    Ok(out)
}

pub fn delete_export(conn: &Connection, output_path: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM exports WHERE output_path = ?1",
        params![output_path],
    )
    .map_err(|e| err("db.exports", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Connection {
        let dir =
            std::env::temp_dir().join(format!("clip-editor-db-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        open(&dir.join("test.db")).unwrap()
    }

    #[test]
    fn schema_creates_all_tables_idempotently() {
        let conn = test_db();
        // Opening twice on the same file must not fail (schema is `IF NOT
        // EXISTS`), so an existing database is never altered.
        drop(conn);
        let _ = test_db();
        let conn = test_db();
        // Tables exist.
        for table in [
            "library_roots",
            "clips",
            "clip_media_cache",
            "games",
            "game_aliases",
            "game_artwork_overrides",
            "groups",
            "clip_groups",
            "settings",
            "recording_profile",
            "exports",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    params![table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "table {table} exists");
        }
        // The baked schema includes the ThumbHash cache column.
        let cols: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('clip_media_cache') WHERE name = 'thumbhash'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cols, 1, "clip_media_cache.thumbhash column exists");
    }

    #[test]
    fn settings_seeded_with_defaults() {
        let conn = test_db();
        let settings = get_all_settings(&conn).unwrap();
        assert_eq!(
            settings.get("launchOnStartup").unwrap(),
            &serde_json::json!(true)
        );
        assert_eq!(
            settings.get("steamDirectory").unwrap(),
            &serde_json::json!("C:\\Program Files (x86)\\Steam")
        );
        let profile = get_recording_profile(&conn).unwrap();
        assert_eq!(profile.duration_seconds, 30);
    }

    #[test]
    fn recording_output_dir_tracks_library_root() {
        let conn = test_db();
        // No library root yet: an empty output dir stays untouched.
        assert_eq!(get_recording_profile(&conn).unwrap().output_dir, "");
        sync_recording_output_dir(&conn).unwrap();
        assert_eq!(get_recording_profile(&conn).unwrap().output_dir, "");

        // Adding a root points the profile's output dir at it.
        add_library_root(&conn, "C:/clips").unwrap();
        sync_recording_output_dir(&conn).unwrap();
        assert_eq!(get_recording_profile(&conn).unwrap().output_dir, "C:/clips");

        // A fresh profile with an empty output dir is seeded from the root.
        set_recording_profile(&conn, &crate::types::RecordingProfile::default()).unwrap();
        // The command layer syncs the profile after saving; mirror it here.
        sync_recording_output_dir(&conn).unwrap();
        let profile = get_recording_profile(&conn).unwrap();
        assert_eq!(profile.output_dir, "C:/clips");

        // Removing all roots leaves the last output dir in place.
        remove_library_root(&conn, "C:/clips").unwrap();
        sync_recording_output_dir(&conn).unwrap();
        assert_eq!(get_recording_profile(&conn).unwrap().output_dir, "C:/clips");
    }

    #[test]
    fn duplicate_clip_upsert_refreshes_row() {
        let conn = test_db();
        let mut clip = VideoFile {
            name: "a.mkv".into(),
            game: "Game".into(),
            path: "C:/clips/a.mkv".into(),
            size: 10,
            last_modified: "2026-01-01T00:00:00Z".into(),
            metadata: None,
            scan_error: None,
            game_images: None,
            group_ids: vec![],
            thumbnail: None,
            thumbhash: None,
        };
        upsert_clip(&conn, &clip).unwrap();
        clip.size = 99;
        clip.last_modified = "2026-02-02T00:00:00Z".into();
        upsert_clip(&conn, &clip).unwrap();
        let rows = all_clips(&conn).unwrap();
        assert_eq!(
            rows.len(),
            1,
            "duplicate path refreshes instead of duplicating"
        );
        assert_eq!(rows[0].size, 99);
    }

    #[test]
    fn group_operations_are_transactional_and_cascade() {
        let conn = test_db();
        let group_id = "g1";
        create_group(&conn, group_id, "Favorites", Some("#ff0000")).unwrap();
        let clip = VideoFile {
            name: "a.mkv".into(),
            game: "Game".into(),
            path: "C:/clips/a.mkv".into(),
            size: 10,
            last_modified: "2026-01-01T00:00:00Z".into(),
            metadata: None,
            scan_error: None,
            game_images: None,
            group_ids: vec![],
            thumbnail: None,
            thumbhash: None,
        };
        upsert_clip(&conn, &clip).unwrap();
        assign_clips_to_group(&conn, std::slice::from_ref(&clip.path), group_id).unwrap();
        assert_eq!(group_clips(&conn, group_id).unwrap().len(), 1);
        // Deleting the group cascades assignments.
        delete_group(&conn, group_id).unwrap();
        assert_eq!(group_clips(&conn, group_id).unwrap().len(), 0);
        // Deleting the clip cascades too.
        create_group(&conn, "g2", "Other", None).unwrap();
        assign_clips_to_group(&conn, std::slice::from_ref(&clip.path), "g2").unwrap();
        delete_clips(&conn, &[clip.path]).unwrap();
        assert_eq!(group_clips(&conn, "g2").unwrap().len(), 0);
    }

    #[test]
    fn aliases_cascade_with_game_delete() {
        let conn = test_db();
        upsert_game(&conn, "10", "Game", "game", "steam", None, None).unwrap();
        set_game_alias(&conn, "g a m e", "10").unwrap();
        assert_eq!(get_game_aliases(&conn).unwrap().len(), 1);
        conn.execute("DELETE FROM games WHERE app_id = '10'", [])
            .unwrap();
        assert_eq!(get_game_aliases(&conn).unwrap().len(), 0, "alias cascades");
    }

    #[test]
    fn stale_media_cache_invalidates() {
        let conn = test_db();
        put_thumbnail_cache(
            &conn,
            "C:/clips/a.mkv",
            100,
            "2026-01-01T00:00:00Z",
            "C:/cache/t.jpg",
        )
        .unwrap();
        // Same identity -> valid.
        let stale =
            invalidate_stale_media_cache(&conn, "C:/clips/a.mkv", 100, "2026-01-01T00:00:00Z")
                .unwrap();
        assert!(
            stale.thumbnail_path.is_none(),
            "no invalidation when identity matches"
        );
        // Changed size -> invalidates and returns the stale path.
        let stale =
            invalidate_stale_media_cache(&conn, "C:/clips/a.mkv", 101, "2026-01-01T00:00:00Z")
                .unwrap();
        assert_eq!(stale.thumbnail_path.as_deref(), Some("C:/cache/t.jpg"));
        assert!(get_media_cache(&conn, "C:/clips/a.mkv").unwrap().is_none());
    }

    #[test]
    fn reset_settings_restores_defaults() {
        let conn = test_db();
        set_setting(&conn, "theme", &serde_json::json!("dark")).unwrap();
        reset_settings(&conn).unwrap();
        let settings = get_all_settings(&conn).unwrap();
        assert_eq!(settings.get("theme").unwrap(), &serde_json::json!("system"));
    }
}
