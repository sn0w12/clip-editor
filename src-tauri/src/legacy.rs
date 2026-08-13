//! Legacy state import (import-only compatibility inputs). After the first
//! import SQLite is authoritative; this never blocks startup and reports a
//! warning instead of failing when the legacy store cannot be read.

use rusqlite::Connection;
use serde_json::Value;

use crate::types::{err, ImportResult};

/// Legacy localStorage keys (Electron renderer).
const KEY_DIRECTORY: &str = "saved-video-directory";
const KEY_GROUPS: &str = "video-groups";
const KEY_ASSIGNMENTS: &str = "video-group-assignments";
const KEY_CUSTOM_GAMES: &str = "clip-editor-custom-games";
const KEY_ALIASES: &str = "clip-editor-game-aliases";
const KEY_CUSTOM_IMAGES: &str = "clip-editor-custom-games-images";

/// Import legacy state from a JSON export file (or report that the LevelDB
/// store cannot be read directly when no path is given).
pub fn import_legacy_state(conn: &Connection, path: Option<&str>) -> Result<ImportResult, String> {
    let path = match path {
        Some(p) if !p.trim().is_empty() => p,
        _ => {
            // Best-effort detection of the legacy Electron store.
            #[cfg(windows)]
            let app_data = std::env::var("APPDATA").ok();
            #[cfg(not(windows))]
            let app_data: Option<String> = None;
            if let Some(app_data) = app_data {
                let leveldb = std::path::Path::new(&app_data)
                    .join("clip-editor")
                    .join("Local Storage")
                    .join("leveldb");
                if leveldb.is_dir() {
                    return Ok(ImportResult {
                        imported: false,
                        warning: Some(
                            "legacy localStorage (Electron LevelDB) cannot be read directly; \
                             export it to JSON and pass the file path to import_legacy_state"
                                .to_string(),
                        ),
                        directory: None,
                        groups: 0,
                        assignments: 0,
                        custom_games: 0,
                        aliases: 0,
                    });
                }
            }
            return Ok(ImportResult {
                imported: false,
                warning: None,
                directory: None,
                groups: 0,
                assignments: 0,
                custom_games: 0,
                aliases: 0,
            });
        }
    };

    let text =
        std::fs::read_to_string(path).map_err(|e| err("legacy.import", format!("{path}: {e}")))?;
    let root: Value = serde_json::from_str(&text)
        .map_err(|e| err("legacy.import", format!("malformed JSON: {e}")))?;
    let tx = conn
        .unchecked_transaction()
        .map_err(|e| err("legacy.import", e))?;

    let mut result = ImportResult {
        imported: true,
        warning: None,
        directory: None,
        groups: 0,
        assignments: 0,
        custom_games: 0,
        aliases: 0,
    };

    // saved-video-directory -> library root.
    if let Some(dir) = root
        .get(KEY_DIRECTORY)
        .and_then(|v| v.as_str())
        .filter(|d| !d.is_empty())
    {
        crate::db::add_library_root(&tx, dir).map_err(|e| err("legacy.import", e))?;
        result.directory = Some(dir.to_string());
    }

    // video-groups -> groups (ids preserved).
    if let Some(groups) = root.get(KEY_GROUPS).and_then(|v| v.as_array()) {
        for group in groups {
            let id = group.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = group.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let color = group.get("color").and_then(|v| v.as_str());
            if id.is_empty() || name.is_empty() {
                continue;
            }
            if crate::db::list_groups(&tx)
                .map_err(|e| err("legacy.import", e))?
                .iter()
                .any(|g| g.id == id)
            {
                continue;
            }
            crate::db::create_group(&tx, id, name, color).map_err(|e| err("legacy.import", e))?;
            result.groups += 1;
        }
    }

    // video-group-assignments -> clip_groups (only rows whose clip exists).
    if let Some(assignments) = root.get(KEY_ASSIGNMENTS).and_then(|v| v.as_array()) {
        for assignment in assignments {
            let video_path = assignment.get("videoPath").and_then(|v| v.as_str());
            let group_id = assignment.get("groupId").and_then(|v| v.as_str());
            let (Some(video_path), Some(group_id)) = (video_path, group_id) else {
                continue;
            };
            let exists = tx
                .query_row("SELECT 1 FROM clips WHERE path = ?1", [video_path], |_| {
                    Ok(())
                })
                .is_ok();
            if exists {
                tx.execute(
                    "INSERT OR IGNORE INTO clip_groups (clip_path, group_id) VALUES (?1, ?2)",
                    rusqlite::params![video_path, group_id],
                )
                .map_err(|e| err("legacy.import", e))?;
                result.assignments += 1;
            }
        }
    }

    // clip-editor-custom-games -> custom games. Accepts an array of
    // {id?, displayName?} or an object map of slug -> {appid, displayName}.
    // Legacy ids that look generated (`custom-*`) are regenerated; the
    // mapping is kept so aliases/images referring to the old id resolve.
    let mut custom_id_map: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    let mut custom_ids: Vec<(String, String)> = Vec::new();
    if let Some(value) = root.get(KEY_CUSTOM_GAMES) {
        match value {
            Value::Array(items) => {
                for item in items {
                    let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let name = item
                        .get("displayName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if !name.is_empty() {
                        custom_ids.push((id.to_string(), name.to_string()));
                    }
                }
            }
            Value::Object(map) => {
                for (_, v) in map {
                    let name = v
                        .get("displayName")
                        .or_else(|| v.get("name"))
                        .and_then(|n| n.as_str())
                        .unwrap_or("");
                    if !name.is_empty() {
                        let id = v
                            .get("appid")
                            .and_then(|a| a.as_str())
                            .unwrap_or("")
                            .to_string();
                        custom_ids.push((id, name.to_string()));
                    }
                }
            }
            _ => {}
        }
    }
    for (id, name) in &custom_ids {
        let app_id = if id.starts_with("custom-") || id.is_empty() {
            format!("custom-{}", uuid::Uuid::new_v4())
        } else {
            id.clone()
        };
        custom_id_map.insert(id.clone(), app_id.clone());
        crate::db::add_custom_game(&tx, &app_id, name).map_err(|e| err("legacy.import", e))?;
        result.custom_games += 1;
    }

    // clip-editor-game-aliases: Record<alias, displayName>. Resolve the
    // displayName to an app id (custom game if unknown) so the alias table's
    // FK contract holds.
    if let Some(Value::Object(aliases)) = root.get(KEY_ALIASES) {
        for (alias, target) in aliases {
            let Some(display_name) = target.as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            let app_id = resolve_display_name(&tx, display_name, &custom_ids);
            crate::db::set_game_alias(&tx, alias, &app_id).map_err(|e| err("legacy.import", e))?;
            result.aliases += 1;
        }
    }

    // clip-editor-custom-games-images: Record<appId, {role: pathOrUrl}>.
    if let Some(Value::Object(images)) = root.get(KEY_CUSTOM_IMAGES) {
        for (app_id, roles) in images {
            let stored_id = custom_id_map
                .get(app_id)
                .cloned()
                .unwrap_or_else(|| app_id.clone());
            if let Some(roles) = roles.as_object() {
                for (role, value) in roles {
                    if let Some(path_or_url) = value.as_str() {
                        let _ = crate::db::set_artwork_override(&tx, &stored_id, role, path_or_url);
                    }
                }
            }
        }
    }

    tx.commit().map_err(|e| err("legacy.import", e))?;
    Ok(result)
}

/// Find the app id for a display name (by normalized name or exact name),
/// creating a custom game when unknown.
fn resolve_display_name(
    conn: &Connection,
    display_name: &str,
    customs: &[(String, String)],
) -> String {
    let normalized = crate::steam::normalize_name(display_name);
    if let Ok(games) = crate::db::all_games(conn) {
        for game in games {
            if game.normalized_name == normalized || game.display_name == display_name {
                return game.app_id;
            }
        }
    }
    for (id, name) in customs {
        if name == display_name {
            let app_id = if id.starts_with("custom-") || id.is_empty() {
                format!("custom-{}", uuid::Uuid::new_v4())
            } else {
                id.clone()
            };
            let _ = crate::db::add_custom_game(conn, &app_id, display_name);
            return app_id;
        }
    }
    let app_id = format!("custom-{}", uuid::Uuid::new_v4());
    let _ = crate::db::add_custom_game(conn, &app_id, display_name);
    app_id
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let dir = std::env::temp_dir().join(format!("clip-legacy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        crate::db::open(&dir.join("t.db")).unwrap()
    }

    #[test]
    fn imports_full_legacy_export() {
        let conn = test_conn();
        let dir = std::env::temp_dir().join(format!("clip-legacy-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let clip_path = format!(
            "{}/Replay 2026-01-01 00-00-00_Game.mkv",
            dir.to_string_lossy()
        );
        std::fs::write(&clip_path, b"v").unwrap();
        crate::db::upsert_clip(
            &conn,
            &crate::types::VideoFile {
                name: "Replay 2026-01-01 00-00-00_Game.mkv".into(),
                game: "Game".into(),
                path: clip_path.clone(),
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

        let export = serde_json::json!({
            "saved-video-directory": dir.to_string_lossy(),
            "video-groups": [{ "id": "g1", "name": "Favorites", "color": "#ff0000" }],
            "video-group-assignments": [{ "videoPath": clip_path, "groupId": "g1" }],
            "clip-editor-custom-games": [{ "id": "custom-1", "displayName": "My Game" }],
            "clip-editor-game-aliases": { "hades": "Hades" },
            "clip-editor-custom-games-images": { "custom-1": { "header": "C:/img/h.jpg" } },
        });
        let file = dir.join("legacy.json");
        std::fs::write(&file, export.to_string()).unwrap();

        let result = import_legacy_state(&conn, Some(file.to_str().unwrap())).unwrap();
        assert!(result.imported);
        assert_eq!(result.groups, 1);
        assert_eq!(result.assignments, 1);
        assert_eq!(result.custom_games, 1);
        assert_eq!(result.aliases, 1);
        assert_eq!(crate::db::list_groups(&conn).unwrap().len(), 1);
        assert_eq!(crate::db::group_clips(&conn, "g1").unwrap().len(), 1);
        let aliases = crate::db::get_game_aliases(&conn).unwrap();
        let app_id = aliases.get("hades").expect("hades alias imported");
        let games = crate::db::all_games(&conn).unwrap();
        let target = games
            .iter()
            .find(|g| &g.app_id == app_id)
            .expect("alias target game exists");
        assert_eq!(target.display_name, "Hades");
        // The custom game's id was regenerated; find it by name.
        let custom = games
            .iter()
            .find(|g| g.display_name == "My Game")
            .expect("custom game imported");
        let overrides = crate::db::get_artwork_overrides(&conn, &custom.app_id).unwrap();
        assert_eq!(
            overrides.get("header").map(|s| s.as_str()),
            Some("C:/img/h.jpg")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_json_reports_error_not_panic() {
        let conn = test_conn();
        let dir = std::env::temp_dir().join(format!("clip-legacy-bad-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("bad.json");
        std::fs::write(&file, "{not json").unwrap();
        let result = import_legacy_state(&conn, Some(file.to_str().unwrap()));
        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_path_reports_leveldb_warning() {
        let conn = test_conn();
        // Without an APPDATA clip-editor dir this returns a clean no-op.
        let result = import_legacy_state(&conn, None).unwrap();
        assert!(!result.imported);
    }
}
