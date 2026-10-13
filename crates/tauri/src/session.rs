//! App session persistence: the whole UI state (tabs and the active tab) as
//! a versioned JSON document beside settings.
//!
//! The frontend owns the document's schema; this store treats it as opaque
//! JSON with one contract: `version` must match [`SESSION_VERSION`]. That
//! keeps tab and route evolution from churning Rust types.

use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::{json, Value};

pub const SESSION_VERSION: u32 = 1;

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl SessionError {
    pub fn code(&self) -> &'static str {
        match self {
            SessionError::Io(_) => "sessionIo",
        }
    }
}

/// `--session <path>` points at an alternate session file. Used for the
/// dev workspace so a fixture session does not clobber the real one.
pub fn session_path_override() -> Option<PathBuf> {
    session_path_override_from(std::env::args_os().skip(1))
}

pub fn resolve_session_path(default: PathBuf) -> PathBuf {
    session_path_override().unwrap_or(default)
}

fn session_path_override_from(
    args: impl IntoIterator<Item = std::ffi::OsString>,
) -> Option<PathBuf> {
    let mut pargs = pico_args::Arguments::from_vec(args.into_iter().collect());
    // Unknown args (Tauri/OS-injected flags) are ignored; a malformed
    // `--session` value falls back to the default path.
    let path: Option<PathBuf> = pargs.opt_value_from_str("--session").ok()?;
    path.map(maybe_absolute)
}

fn maybe_absolute(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        return path;
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(path),
        Err(_) => path,
    }
}

pub struct SessionStore {
    path: Mutex<Option<PathBuf>>,
    doc: Mutex<Value>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self {
            path: Mutex::new(None),
            doc: Mutex::new(json!({ "version": SESSION_VERSION })),
        }
    }

    /// Points the store at its file and loads any existing document.
    /// Missing files start empty; corrupt or wrong-version files are backed
    /// up beside the original and reset, mirroring the settings store.
    pub fn initialize(&self, path: PathBuf) {
        let loaded = self.load_from(&path);
        *self.lock_doc() = loaded;
        *self.lock_path() = Some(path);
    }

    pub fn load(&self) -> Value {
        self.lock_doc().clone()
    }

    pub fn save(&self, doc: Value) -> Result<(), SessionError> {
        // Enforce the only server-side contract before persisting: the
        // document carries the current version. A missing/invalid version
        // is stamped rather than dropping the caller's data.
        let mut versioned = match doc.as_object() {
            Some(object) => Value::Object(object.clone()),
            None => json!({}),
        };
        match versioned.get("version") {
            Some(v) if v.as_u64() == Some(u64::from(SESSION_VERSION)) => {}
            _ => {
                if let Some(object) = versioned.as_object_mut() {
                    object.insert("version".to_owned(), json!(SESSION_VERSION));
                }
            }
        }
        *self.lock_doc() = versioned.clone();

        let path = self.lock_path().clone();
        let Some(path) = path else {
            return Ok(()); // not initialized yet; keep in memory only
        };

        write_document(&path, &versioned)
    }

    /// Writes the current in-memory document to disk unchanged. Used on
    /// window close so changes sitting in the frontend's debounce tail are
    /// not lost; the backend copy already includes every delivered save.
    pub fn persist_current(&self) -> Result<(), SessionError> {
        let doc = self.lock_doc().clone();
        let path = self.lock_path().clone();
        let Some(path) = path else {
            return Ok(()); // uninitialized store has nothing to flush
        };
        write_document(&path, &doc)
    }

    fn load_from(&self, path: &std::path::Path) -> Value {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return json!({ "version": SESSION_VERSION });
            }
            Err(error) => {
                log::warn!("session unreadable at {}: {error}", path.display());
                // The file exists but could not be read (sharing violation,
                // AV lock, permissions). Back it up before resetting: the
                // next save would otherwise clobber a document we never saw.
                backup(path);
                return json!({ "version": SESSION_VERSION });
            }
        };

        match serde_json::from_str::<Value>(&raw) {
            Ok(doc)
                if doc.get("version").and_then(Value::as_u64)
                    == Some(u64::from(SESSION_VERSION)) =>
            {
                doc
            }
            Ok(doc) => {
                log::warn!(
                    "session version {:?} unsupported (expected {SESSION_VERSION}); resetting",
                    doc.get("version")
                );
                backup(path);
                json!({ "version": SESSION_VERSION })
            }
            Err(error) => {
                log::warn!(
                    "session corrupt at {} ({error}); reset to defaults",
                    path.display()
                );
                backup(path);
                json!({ "version": SESSION_VERSION })
            }
        }
    }

    fn lock_path(&self) -> std::sync::MutexGuard<'_, Option<PathBuf>> {
        unwrap_poisoned(&self.path)
    }

    fn lock_doc(&self) -> std::sync::MutexGuard<'_, Value> {
        unwrap_poisoned(&self.doc)
    }
}

impl Default for SessionStore {
    fn default() -> Self {
        Self::new()
    }
}

fn backup(path: &std::path::Path) {
    let mut backup = path.as_os_str().to_owned();
    backup.push(".bak");
    if let Err(error) = std::fs::rename(path, PathBuf::from(backup)) {
        log::warn!("could not back up session {}: {error}", path.display());
    }
}

fn write_document(path: &std::path::Path, doc: &Value) -> Result<(), SessionError> {
    let json = serde_json::to_vec_pretty(doc)
        .map_err(|error| SessionError::Io(std::io::Error::other(error)))?;
    write_atomic(path, &json)
}

fn write_atomic(path: &std::path::Path, bytes: &[u8]) -> Result<(), SessionError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let directory = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let temp = tempfile::Builder::new()
        .prefix(".session")
        .suffix(".tmp")
        .tempfile_in(directory)?;
    {
        let mut file = temp.as_file();
        std::io::Write::write_all(&mut file, bytes)?;
        // Flush to disk before the rename: without this a crash right
        // after persist() can leave a truncated file behind.
        file.sync_all()?;
    }
    temp.persist(path)
        .map_err(|error| SessionError::Io(error.error))?;
    Ok(())
}

fn unwrap_poisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_documents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");

        let store = SessionStore::new();
        store.initialize(path.clone());
        store
            .save(json!({
                "version": 1,
                "tabs": [
                    { "tabId": "t1", "title": "Settings", "href": "/settings" },
                    { "tabId": "t2", "title": "Home", "href": "/" }
                ],
                "activeTabId": "t1"
            }))
            .unwrap();
        drop(store);

        let reloaded = SessionStore::new();
        reloaded.initialize(path);
        let doc = reloaded.load();
        assert_eq!(doc["tabs"].as_array().unwrap().len(), 2);
        assert_eq!(doc["tabs"][0]["href"], "/settings");
        assert_eq!(doc["activeTabId"], "t1");
    }

    #[test]
    fn missing_file_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new();
        store.initialize(dir.path().join("nested/session.json"));
        assert_eq!(store.load()["version"], SESSION_VERSION);
    }

    #[test]
    fn corrupt_files_are_backed_up_and_reset() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        std::fs::write(&path, "{ broken").unwrap();

        let store = SessionStore::new();
        store.initialize(path.clone());

        assert_eq!(store.load()["version"], SESSION_VERSION);
        assert!(dir.path().join("session.json.bak").exists());
    }

    #[test]
    fn wrong_versions_are_rejected_and_backed_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");
        std::fs::write(&path, r#"{ "version": 99 }"#).unwrap();

        let store = SessionStore::new();
        store.initialize(path);

        assert_eq!(store.load()["version"], SESSION_VERSION);
        assert!(dir.path().join("session.json.bak").exists());
    }

    #[test]
    fn saves_without_version_get_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionStore::new();
        store.initialize(dir.path().join("session.json"));

        store.save(json!({ "tabs": [] })).unwrap();
        assert_eq!(store.load()["version"], SESSION_VERSION);
        assert!(store.load().get("tabs").is_some());
    }

    #[test]
    fn uninitialized_saves_stay_in_memory() {
        let store = SessionStore::new();
        store
            .save(json!({ "version": 1, "tabs": [{ "a": 1 }] }))
            .unwrap();
        assert_eq!(store.load()["tabs"][0]["a"], 1);
    }

    #[test]
    fn unreadable_files_are_backed_up_and_reset() {
        let dir = tempfile::tempdir().unwrap();
        // A directory at the file path makes read_to_string fail with a
        // non-NotFound IO error on every platform, standing in for a
        // sharing violation / AV lock.
        let path = dir.path().join("session.json");
        std::fs::create_dir(&path).unwrap();

        let store = SessionStore::new();
        store.initialize(path.clone());

        assert_eq!(store.load()["version"], SESSION_VERSION);
        // The unreadable entry must be preserved somewhere: a later save
        // replaces the original path, so the only recovery point is .bak.
        assert!(dir.path().join("session.json.bak").exists());
    }

    #[test]
    fn persist_current_writes_the_in_memory_document() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.json");

        let store = SessionStore::new();
        store.initialize(path.clone());
        store
            .save(json!({ "version": 1, "tabs": [{ "tabId": "t1" }] }))
            .unwrap();

        // Simulate the debounce tail: disk copy lost after the save was
        // delivered, in-memory copy still holds the document.
        std::fs::remove_file(&path).unwrap();
        store.persist_current().unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        let doc: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(doc["tabs"][0]["tabId"], "t1");
    }

    #[test]
    fn persist_current_without_path_is_a_noop() {
        let store = SessionStore::new();
        store.save(json!({ "version": 1, "tabs": [] })).unwrap();
        store.persist_current().unwrap();
    }

    fn args(values: &[&str]) -> Vec<std::ffi::OsString> {
        values
            .iter()
            .map(|value| std::ffi::OsString::from(*value))
            .collect()
    }

    #[test]
    fn parses_separated_session_flag() {
        let parsed = session_path_override_from(args(&["--session", "custom.json"]));
        assert!(parsed.is_some());
        assert!(parsed.unwrap().ends_with("custom.json"));
    }

    #[test]
    fn ignores_unknown_args() {
        let parsed = session_path_override_from(args(&["--devtools", "--session", "custom.json"]));
        assert!(parsed.unwrap().ends_with("custom.json"));
        assert!(session_path_override_from(args(&["--other", "value"])).is_none());
        assert!(session_path_override_from(Vec::<std::ffi::OsString>::new()).is_none());
    }

    #[test]
    fn keeps_absolute_paths() {
        #[cfg(windows)]
        let flag = "C:\\dev\\session.json";
        #[cfg(not(windows))]
        let flag = "/tmp/session.json";
        let parsed = session_path_override_from(args(&["--session", flag])).unwrap();
        assert!(parsed.is_absolute());
    }
}
