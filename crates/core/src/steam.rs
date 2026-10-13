//! Steam discovery, matching, and artwork resolution.
//!
//! Replaces the legacy regex-only implementation: a real Valve KeyValues
//! parser for `libraryfolders.vdf`, tolerant ACF scanning, deterministic
//! local artwork selection (root + nested `librarycache/<appid>/`), and a
//! keyless public-CDN fallback that never blocks library loading.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::types::{err, GameImage, ScanDiagnostic, SteamGame};

/// Unicode-aware name normalization: case-fold, keep only alphanumerics.
pub fn normalize_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Trim characters the legacy contract strips from display names.
pub fn clean_display_name(name: &str) -> String {
    name.chars()
        .filter(|c| !r#"[]\/:*?"<>|"#.contains(*c))
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct KeyValues {
    pub entries: Vec<(String, KValue)>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum KValue {
    String(String),
    Table(KeyValues),
}

impl KeyValues {
    /// All string values for a key that appears multiple times (duplicate
    /// libraries).
    pub fn get_all_strings(&self, key: &str) -> Vec<String> {
        self.entries
            .iter()
            .filter_map(|(k, v)| if k == key { Some(v) } else { None })
            .filter_map(|v| match v {
                KValue::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect()
    }
}

/// Parse a KeyValues (VDF) document. Handles escaped quotes/backslashes,
/// nested tables, duplicate keys, and `//` line comments.
pub fn parse_keyvalues(input: &str) -> Result<KeyValues, String> {
    let mut parser = VdfParser {
        chars: input.chars().collect(),
        pos: 0,
    };
    let table = parser.parse_table()?;
    parser.skip_ws_and_comments();
    if parser.pos < parser.chars.len() {
        return Err(err(
            "steam.vdf",
            format!("trailing content at offset {}", parser.pos),
        ));
    }
    Ok(table)
}

struct VdfParser {
    chars: Vec<char>,
    pos: usize,
}

impl VdfParser {
    fn skip_ws_and_comments(&mut self) {
        loop {
            while self.pos < self.chars.len() && self.chars[self.pos].is_whitespace() {
                self.pos += 1;
            }
            // `//` line comment.
            if self.pos + 1 < self.chars.len()
                && self.chars[self.pos] == '/'
                && self.chars[self.pos + 1] == '/'
            {
                while self.pos < self.chars.len() && self.chars[self.pos] != '\n' {
                    self.pos += 1;
                }
                continue;
            }
            break;
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    /// A quoted string with `\"` and `\\` escapes; or a bare token.
    fn parse_string(&mut self) -> Result<String, String> {
        self.skip_ws_and_comments();
        match self.peek() {
            Some('"') => {
                self.pos += 1;
                let mut out = String::new();
                loop {
                    match self.peek() {
                        None => return Err(err("steam.vdf", "unterminated string")),
                        Some('"') => {
                            self.pos += 1;
                            return Ok(out);
                        }
                        Some('\\') => {
                            self.pos += 1;
                            match self.peek() {
                                Some(c @ ('"' | '\\')) => {
                                    out.push(c);
                                    self.pos += 1;
                                }
                                Some('n') => {
                                    out.push('\n');
                                    self.pos += 1;
                                }
                                Some('t') => {
                                    out.push('\t');
                                    self.pos += 1;
                                }
                                other => {
                                    // Keep the backslash verbatim (Windows paths).
                                    out.push('\\');
                                    if let Some(c) = other {
                                        out.push(c);
                                        self.pos += 1;
                                    }
                                }
                            }
                        }
                        Some(c) => {
                            out.push(c);
                            self.pos += 1;
                        }
                    }
                }
            }
            Some(_) => {
                let start = self.pos;
                while self.pos < self.chars.len() && !self.chars[self.pos].is_whitespace() {
                    self.pos += 1;
                }
                if self.pos == start {
                    return Err(err("steam.vdf", "expected token"));
                }
                Ok(self.chars[start..self.pos].iter().collect())
            }
            None => Err(err("steam.vdf", "expected token at EOF")),
        }
    }

    fn parse_table(&mut self) -> Result<KeyValues, String> {
        let mut entries = Vec::new();
        loop {
            self.skip_ws_and_comments();
            match self.peek() {
                None => return Ok(KeyValues { entries }),
                Some('}') => {
                    self.pos += 1;
                    return Ok(KeyValues { entries });
                }
                Some(_) => {
                    let key = self.parse_string()?;
                    self.skip_ws_and_comments();
                    match self.peek() {
                        Some('{') => {
                            self.pos += 1;
                            let table = self.parse_table()?;
                            entries.push((key, KValue::Table(table)));
                        }
                        Some(_) => {
                            let value = self.parse_string()?;
                            entries.push((key, KValue::String(value)));
                        }
                        None => {
                            return Err(err("steam.vdf", format!("value missing for key `{key}`")))
                        }
                    }
                }
            }
        }
    }
}

/// Steam install locations: configured dir first, then the Windows registry,
/// then the default install path.
pub fn discover_steam_dirs(configured: Option<&str>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = configured.filter(|d| !d.trim().is_empty()) {
        dirs.push(PathBuf::from(dir));
    }
    #[cfg(windows)]
    {
        use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
            for path in [r"SOFTWARE\WOW6432Node\Valve\Steam", r"SOFTWARE\Valve\Steam"] {
                if let Ok(key) = winreg::RegKey::predef(hive).open_subkey(path) {
                    if let Ok(steam_path) = key.get_value::<String, _>("SteamPath") {
                        dirs.push(PathBuf::from(steam_path));
                    }
                }
            }
        }
    }
    dirs.push(PathBuf::from(r"C:\Program Files (x86)\Steam"));
    // Deduplicate, keep order, drop nonexistent dirs.
    let mut seen = std::collections::HashSet::new();
    dirs.into_iter()
        .filter(|d| d.is_dir() && seen.insert(d.clone()))
        .collect()
}

/// Library folders from a Steam install root: the root's own `steamapps` plus
/// every `path` in `steamapps/libraryfolders.vdf` (duplicate keys handled).
/// Never fails the whole discovery because one file is malformed.
pub fn library_folders(steam_dir: &Path) -> (Vec<PathBuf>, Vec<ScanDiagnostic>) {
    let mut folders = vec![steam_dir.join("steamapps")];
    let mut diagnostics = Vec::new();
    let vdf = steam_dir.join("steamapps").join("libraryfolders.vdf");
    match std::fs::read_to_string(&vdf) {
        Ok(text) => match parse_keyvalues(&text) {
            Ok(root) => {
                // The vdf may wrap folders in a `libraryfolders` table or
                // expose them directly; collect all `path` strings anywhere.
                fn collect(
                    table: &KeyValues,
                    depth: usize,
                    folders: &mut Vec<PathBuf>,
                    diagnostics: &mut Vec<ScanDiagnostic>,
                ) {
                    if depth > 4 {
                        return;
                    }
                    for path in table.get_all_strings("path") {
                        let lib = PathBuf::from(path.clone());
                        if lib.is_dir() {
                            folders.push(lib.join("steamapps"));
                        } else {
                            diagnostics.push(ScanDiagnostic {
                                path,
                                reason: "library folder missing".into(),
                            });
                        }
                    }
                    for (_, value) in &table.entries {
                        if let KValue::Table(t) = value {
                            collect(t, depth + 1, folders, diagnostics);
                        }
                    }
                }
                collect(&root, 0, &mut folders, &mut diagnostics);
            }
            Err(e) => diagnostics.push(ScanDiagnostic {
                path: vdf.to_string_lossy().into_owned(),
                reason: format!("unparseable libraryfolders.vdf: {e}"),
            }),
        },
        Err(e) => diagnostics.push(ScanDiagnostic {
            path: vdf.to_string_lossy().into_owned(),
            reason: format!("unreadable: {e}"),
        }),
    }
    let mut seen = std::collections::HashSet::new();
    folders.retain(|f| f.is_dir() && seen.insert(f.clone()));
    (folders, diagnostics)
}

/// Deep-find a string key in a KeyValues tree (ACF manifests wrap their keys
/// in an `AppState` table; some tools flatten differently). Depth-limited.
pub fn deep_string(root: &KeyValues, key: &str) -> Option<String> {
    fn search(table: &KeyValues, key: &str, depth: usize) -> Option<String> {
        if depth > 4 {
            return None;
        }
        for (k, v) in &table.entries {
            if k == key {
                if let KValue::String(s) = v {
                    return Some(s.clone());
                }
            }
            if let KValue::Table(t) = v {
                if let Some(found) = search(t, key, depth + 1) {
                    return Some(found);
                }
            }
        }
        None
    }
    search(root, key, 0)
}

/// Parse `appmanifest_<appid>.acf` files in one steamapps dir. Duplicate app
/// IDs keep the first (deterministic) occurrence. Never fails the whole scan
/// because one manifest is malformed.
fn scan_acf_dir(
    steamapps: &Path,
    games: &mut Vec<SteamGame>,
    diagnostics: &mut Vec<ScanDiagnostic>,
) {
    let Ok(entries) = std::fs::read_dir(steamapps) else {
        diagnostics.push(ScanDiagnostic {
            path: steamapps.to_string_lossy().into_owned(),
            reason: "unreadable steamapps directory".into(),
        });
        return;
    };
    let mut manifests: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("appmanifest_") && n.ends_with(".acf"))
        })
        .collect();
    manifests.sort();
    for manifest in manifests {
        match std::fs::read_to_string(&manifest) {
            Ok(text) => match parse_keyvalues(&text) {
                Ok(root) => {
                    let app_id = deep_string(&root, "appid");
                    let name = deep_string(&root, "name");
                    match (app_id, name) {
                        (Some(app_id), Some(name)) if !app_id.is_empty() && !name.is_empty() => {
                            if games.iter().any(|g| g.app_id == app_id) {
                                continue; // deterministic: first occurrence wins
                            }
                            games.push(SteamGame {
                                app_id,
                                display_name: clean_display_name(&name),
                                normalized_name: normalize_name(&name),
                                source: "steam".to_string(),
                                artwork: None,
                                artwork_error: None,
                                pending_roles: Vec::new(),
                            });
                        }
                        _ => diagnostics.push(ScanDiagnostic {
                            path: manifest.to_string_lossy().into_owned(),
                            reason: "manifest missing appid or name".into(),
                        }),
                    }
                }
                Err(e) => diagnostics.push(ScanDiagnostic {
                    path: manifest.to_string_lossy().into_owned(),
                    reason: format!("unparseable acf: {e}"),
                }),
            },
            Err(e) => diagnostics.push(ScanDiagnostic {
                path: manifest.to_string_lossy().into_owned(),
                reason: format!("unreadable: {e}"),
            }),
        }
    }
}

/// Scan every discovered steamapps dir. Returns games (deterministic order)
/// and per-location diagnostics.
pub fn scan_games(steam_dir: &Path) -> (Vec<SteamGame>, Vec<ScanDiagnostic>) {
    let (folders, mut diagnostics) = library_folders(steam_dir);
    let mut games: Vec<SteamGame> = Vec::new();
    for folder in folders {
        scan_acf_dir(&folder, &mut games, &mut diagnostics);
    }
    games.sort_by_key(|g| g.display_name.to_lowercase());
    (games, diagnostics)
}

const ARTWORK_ROLES: [&str; 6] = [
    "header",
    "library_600x900",
    "library_hero",
    "library_hero_blur",
    "logo",
    "icon",
];

/// Map a librarycache filename to one of the explicit roles. Unknown files
/// are ignored — never treated as icons.
fn categorize_image(filename: &str) -> Option<&'static str> {
    let lower = filename.to_lowercase();
    if lower.contains("library_hero_blur") {
        return Some("library_hero_blur");
    }
    if lower.contains("library_hero")
        || lower.contains("capsule_616x353")
        || lower.contains("capsule_467x181")
    {
        return Some("library_hero");
    }
    if lower.contains("library_600x900") || lower.contains("capsule_600x900") {
        return Some("library_600x900");
    }
    if lower.contains("logo")
        || lower.contains("capsule_184x69")
        || lower.contains("capsule_231x87")
    {
        return Some("logo");
    }
    if lower.contains("header") {
        return Some("header");
    }
    if lower.ends_with("_icon") || lower.contains("_icon.") {
        return Some("icon");
    }
    // Steam also stores the icon as a hash-named image (e.g.
    // `8dbc7195....jpg`). The legacy app treated any unknown image file as
    // the icon; match that so badges show the real icon. Only files with an
    // image extension qualify — extensionless hash blobs are skipped.
    if matches!(
        Path::new(filename)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .as_deref(),
        Some("jpg" | "jpeg" | "png" | "webp")
    ) {
        return Some("icon");
    }
    None
}

/// Collect local artwork for one app id from root and nested
/// `appcache/librarycache` directories. Deterministic: nested `{appid}/` dir
/// beats root files; jpg beats png; lexicographic within a bucket.
pub fn resolve_local_artwork(steam_dir: &Path, app_id: &str) -> GameImage {
    let mut candidates: HashMap<&'static str, Vec<PathBuf>> = HashMap::new();
    for base in [
        steam_dir.join("appcache").join("librarycache"),
        steam_dir
            .join("steamapps")
            .join("appcache")
            .join("librarycache"),
    ] {
        // Root files: `{appid}_{type}.jpg`.
        if let Ok(entries) = std::fs::read_dir(&base) {
            let mut files: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect();
            files.sort();
            for file in files {
                let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if !name.starts_with(&format!("{app_id}_")) {
                    continue;
                }
                if let Some(role) = categorize_image(name) {
                    candidates.entry(role).or_default().push(file);
                }
            }
        }
        // Nested: `{appid}/` dir (preferred).
        let nested = base.join(app_id);
        if let Ok(entries) = std::fs::read_dir(&nested) {
            let mut files: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.is_file())
                .collect();
            files.sort();
            for file in files {
                let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if let Some(role) = categorize_image(name) {
                    candidates.entry(role).or_default().push(file);
                }
            }
        }
    }

    let mut image = GameImage::default();
    for role in ARTWORK_ROLES {
        let mut pool = candidates.remove(role).unwrap_or_default();
        pool.sort_by_key(|p| {
            let is_jpg = p
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg"));
            // jpg first, then name.
            (!is_jpg, p.file_name().unwrap_or_default().to_os_string())
        });
        if let Some(path) = pool.into_iter().find(|p| readable(p)) {
            let value = path.to_string_lossy().into_owned();
            match role {
                "header" => image.header = Some(value),
                "library_600x900" => image.library_600x900 = Some(value),
                "library_hero" => image.library_hero = Some(value),
                "library_hero_blur" => image.library_hero_blur = Some(value),
                "logo" => image.logo = Some(value),
                "icon" => image.icon = Some(value),
                _ => {}
            }
        }
    }
    image
}

fn readable(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

/// Which CDN-fetchable roles are still missing from a local GameImage.
pub fn missing_cdn_roles(image: &GameImage) -> Vec<String> {
    let mut missing = Vec::new();
    if image.header.is_none() {
        missing.push("header".to_string());
    }
    if image.library_600x900.is_none() {
        missing.push("library_600x900".to_string());
    }
    missing
}

/// Best artwork for a clip's game name: alias lookup first, then normalized
/// name, then exact display name.
pub fn images_for_game(conn: &rusqlite::Connection, game_name: &str) -> Option<GameImage> {
    if game_name.trim().is_empty() || game_name == "Unknown" {
        return None;
    }
    // 1. Alias -> app id.
    if let Ok(aliases) = crate::db::get_game_aliases(conn) {
        if let Some(app_id) = aliases.get(game_name) {
            if let Some(image) = images_for_app_id(conn, app_id) {
                return Some(image);
            }
        }
    }
    // 2. Normalized name.
    let normalized = normalize_name(game_name);
    if let Ok(games) = crate::db::all_games(conn) {
        for game in games {
            if game.normalized_name == normalized {
                return game.artwork;
            }
            if game.display_name == game_name {
                return game.artwork;
            }
        }
    }
    None
}

fn images_for_app_id(conn: &rusqlite::Connection, app_id: &str) -> Option<GameImage> {
    crate::db::all_games(conn)
        .ok()?
        .into_iter()
        .find(|g| g.app_id == app_id)
        .and_then(|g| g.artwork)
}

const CDN_BASE: &str = "https://cdn.cloudflare.steamstatic.com/steam/apps";

/// Fetch one known static CDN asset (`header.jpg`, `library_600x900.jpg`)
/// into the app cache with a sidecar meta file (source URL + validator).
/// Bounded timeout/retry; 404 is a permanent miss (no retry).
pub async fn fetch_cdn_artwork(
    client: &reqwest::Client,
    cache_root: &Path,
    app_id: &str,
    role: &str,
) -> Result<PathBuf, String> {
    let file_name = match role {
        "header" => "header.jpg",
        "library_600x900" => "library_600x900.jpg",
        other => return Err(err("steam.cdn", format!("no CDN asset for role `{other}`"))),
    };
    let url = format!("{CDN_BASE}/{app_id}/{file_name}");
    let dir = cache_root.join("steam-cdn");
    std::fs::create_dir_all(&dir).map_err(|e| err("steam.cdn", e))?;
    let dst = dir.join(format!("{app_id}_{role}.jpg"));
    let meta_path = dir.join(format!("{app_id}_{role}.meta.json"));

    let mut attempts = 0;
    let outcome: Result<PathBuf, String> = loop {
        attempts += 1;
        match try_fetch_once(client, &url, &dst, &meta_path).await {
            Ok(path) => break Ok(path),
            Err((message, permanent)) => {
                if permanent || attempts >= 3 {
                    break Err(err("steam.cdn", format!("{url}: {message}")));
                }
            }
        }
    };
    outcome
}

/// One bounded fetch attempt: `(message, permanent)` on failure.
async fn try_fetch_once(
    client: &reqwest::Client,
    url: &str,
    dst: &Path,
    meta_path: &Path,
) -> Result<PathBuf, (String, bool)> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| (e.to_string(), false))?;
    let status = response.status();
    if !status.is_success() {
        // 404 is permanent; do not retry.
        return Err((
            format!("HTTP {}", status.as_u16()),
            status == reqwest::StatusCode::NOT_FOUND,
        ));
    }
    let is_image = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.starts_with("image/"));
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let last_modified = response
        .headers()
        .get(reqwest::header::LAST_MODIFIED)
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let bytes = response.bytes().await.map_err(|e| (e.to_string(), false))?;
    if !is_image {
        return Err((format!("invalid response for {url} (not an image)"), false));
    }
    std::fs::write(dst, &bytes).map_err(|e| (e.to_string(), false))?;
    let meta = serde_json::json!({
        "url": url,
        "etag": etag,
        "last_modified": last_modified,
    });
    std::fs::write(meta_path, meta.to_string()).map_err(|e| (e.to_string(), false))?;
    Ok(dst.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_escaped_quotes_and_duplicate_keys() {
        fn collect_paths(table: &KeyValues, out: &mut Vec<String>, depth: usize) {
            if depth > 4 {
                return;
            }
            out.extend(table.get_all_strings("path"));
            for (_, value) in &table.entries {
                if let KValue::Table(t) = value {
                    collect_paths(t, out, depth + 1);
                }
            }
        }
        let vdf = r#"
"libraryfolders"
{
    "0" { "path" "C:\Program Files (x86)\Steam\steamapps" }
    "1" { "path" "D:\SteamLibrary\steamapps" }
    "2" { "path" "D:\Odd \"Quotes\"\steamapps" }
}
"#;
        let root = parse_keyvalues(vdf).unwrap();
        // Duplicate keys nested two levels deep must all be found.
        let mut paths = Vec::new();
        collect_paths(&root, &mut paths, 0);
        assert_eq!(
            paths,
            vec![
                r"C:\Program Files (x86)\Steam\steamapps".to_string(),
                r"D:\SteamLibrary\steamapps".to_string(),
                r#"D:\Odd "Quotes"\steamapps"#.to_string(),
            ]
        );
    }

    #[test]
    fn parses_acf_and_normalizes_names() {
        let acf = r#"
"AppState"
{
    "appid" "1091500"
    "name" "Cyberpunk 2077"
}
"#;
        let root = parse_keyvalues(acf).unwrap();
        // ACF keys live under the AppState table; the scanner deep-finds them.
        assert_eq!(deep_string(&root, "appid").as_deref(), Some("1091500"));
        assert_eq!(
            deep_string(&root, "name").as_deref(),
            Some("Cyberpunk 2077")
        );
        assert_eq!(normalize_name("Cyberpunk 2077!"), "cyberpunk2077");
        assert_eq!(
            normalize_name("Ässault²"),
            "ässault²"
                .to_lowercase()
                .chars()
                .filter(|c| c.is_alphanumeric())
                .collect::<String>()
        );
        assert_eq!(clean_display_name("Game: [Deluxe]"), "Game Deluxe");
    }

    #[test]
    fn comments_are_skipped() {
        let vdf = "// comment\n\"a\" \"b\"\n";
        let root = parse_keyvalues(vdf).unwrap();
        assert_eq!(deep_string(&root, "a").as_deref(), Some("b"));
    }

    #[test]
    fn categorize_known_types_only() {
        assert_eq!(categorize_image("10_header.jpg"), Some("header"));
        assert_eq!(
            categorize_image("10_library_600x900.jpg"),
            Some("library_600x900")
        );
        assert_eq!(
            categorize_image("10_library_hero.jpg"),
            Some("library_hero")
        );
        assert_eq!(
            categorize_image("10_library_hero_blur.jpg"),
            Some("library_hero_blur")
        );
        assert_eq!(categorize_image("10_logo.png"), Some("logo"));
        assert_eq!(categorize_image("10_icon.jpg"), Some("icon"));
        assert_eq!(
            categorize_image("10_capsule_616x353.jpg"),
            Some("library_hero")
        );
        assert_eq!(
            categorize_image("10_library_capsule_600x900.jpg"),
            Some("library_600x900")
        );
        // Hash-named image files (Steam's icon layout) are icons; unknown
        // extensionless blobs are not.
        assert_eq!(
            categorize_image("8dbc71957312bbd3baea65848b545be9eae2a355.jpg"),
            Some("icon")
        );
        assert_eq!(
            categorize_image("0eeacc724c77e1f5abeeba4fb542f45bad894470"),
            None
        );
        assert_eq!(categorize_image("10_unknown_thing.txt"), None);
        // Any other image file in the cache is the legacy "icon" fallback.
        assert_eq!(categorize_image("10_screenshot.jpg"), Some("icon"));
    }

    #[test]
    fn missing_cdn_roles_lists_header_and_poster() {
        let image = GameImage {
            logo: Some("x".into()),
            ..Default::default()
        };
        let missing = missing_cdn_roles(&image);
        assert_eq!(missing, vec!["header", "library_600x900"]);
    }
}
