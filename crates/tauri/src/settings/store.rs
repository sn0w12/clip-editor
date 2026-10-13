//! Settings persistence: versioned JSON document at the platform config
//! dir, merged over schema defaults, validated per definition, and written
//! atomically.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::model::{
    SettingValue, SettingsSchema, SettingsSnapshot, SettingsValues, ValuesSnapshot,
};

#[derive(Debug, thiserror::Error)]
pub enum SettingsError {
    #[error("unknown setting `{0}`")]
    UnknownKey(String),
    #[error("invalid value for setting `{key}`: {reason}")]
    InvalidValue { key: String, reason: String },
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl SettingsError {
    pub fn code(&self) -> &'static str {
        match self {
            SettingsError::UnknownKey(_) => "unknownSetting",
            SettingsError::InvalidValue { .. } => "invalidSettingValue",
            SettingsError::Io(_) => "settingsIo",
        }
    }

    pub fn detail(&self) -> Option<String> {
        match self {
            SettingsError::InvalidValue { reason, .. } => Some(reason.clone()),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsFile {
    version: u32,
    values: serde_json::Map<String, serde_json::Value>,
}

struct StoredState {
    values: HashMap<String, SettingValue>,
    /// Keys explicitly persisted (vs falling back to defaults).
    saved_keys: HashSet<String>,
    /// Unknown keys from newer app versions, preserved on rewrite.
    unknown_values: serde_json::Map<String, serde_json::Value>,
}

pub struct SettingsStore {
    schema: SettingsSchema,
    path: Mutex<Option<PathBuf>>,
    state: Mutex<StoredState>,
}

impl SettingsStore {
    pub fn new(schema: SettingsSchema) -> Self {
        Self {
            state: Mutex::new(StoredState {
                values: HashMap::new(),
                saved_keys: HashSet::new(),
                unknown_values: serde_json::Map::new(),
            }),
            schema,
            path: Mutex::new(None),
        }
    }

    /// Loads (or reloads) settings from `path`. Missing files start from
    /// defaults; corrupt or unsupported files are backed up beside the
    /// original and reset.
    pub fn initialize(&self, path: PathBuf) {
        let loaded = self.load_from(&path);
        *self.lock_state() = loaded;
        *self.lock_path() = Some(path);
    }

    pub fn snapshot(&self) -> SettingsSnapshot {
        let state = self.lock_state();
        SettingsSnapshot {
            schema: self.schema.clone(),
            values: merged_values(&self.schema, &state),
            saved_keys: sorted_saved_keys(&state),
        }
    }

    /// Reads the stored-or-default value for a schema key.
    pub fn get(&self, key: &str) -> Option<SettingValue> {
        let state = self.lock_state();
        self.schema.find(key).map(|definition| {
            state
                .values
                .get(key)
                .cloned()
                .unwrap_or_else(|| definition.default_value.clone())
        })
    }

    /// Validates, applies, persists, and returns the resulting snapshot in
    /// one atomic step.
    pub fn set_and_snapshot(
        &self,
        key: &str,
        value: SettingValue,
    ) -> Result<ValuesSnapshot, SettingsError> {
        let definition = self
            .schema
            .find(key)
            .ok_or_else(|| SettingsError::UnknownKey(key.to_owned()))?;
        let normalized =
            definition
                .validate(value)
                .map_err(|reason| SettingsError::InvalidValue {
                    key: key.to_owned(),
                    reason,
                })?;

        let mut state = self.lock_state();
        state.values.insert(key.to_owned(), normalized);
        state.saved_keys.insert(key.to_owned());

        if let Some(path) = self.lock_path().clone() {
            write_settings_file(&path, &state)?;
        }

        Ok(ValuesSnapshot {
            values: merged_values(&self.schema, &state),
            saved_keys: sorted_saved_keys(&state),
        })
    }

    fn load_from(&self, path: &std::path::Path) -> StoredState {
        let mut state = StoredState {
            values: HashMap::new(),
            saved_keys: HashSet::new(),
            unknown_values: serde_json::Map::new(),
        };

        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return state,
            Err(error) => {
                log::warn!("settings unreadable at {}: {error}", path.display());
                // The file exists but could not be read (sharing violation,
                // AV lock, permissions). Back it up before resetting so the
                // next write cannot destroy values we never saw.
                backup_corrupt_file(path);
                return state;
            }
        };

        let file = match serde_json::from_str::<SettingsFile>(&raw) {
            Ok(file) => file,
            Err(error) => {
                backup_corrupt_file(path);
                log::warn!(
                    "settings corrupt at {} ({error}); reset to defaults",
                    path.display()
                );
                return state;
            }
        };

        if file.version != super::model::SETTINGS_VERSION {
            backup_corrupt_file(path);
            log::warn!(
                "settings version {} unsupported (expected {}); reset to defaults",
                file.version,
                super::model::SETTINGS_VERSION
            );
            return state;
        }

        for (key, raw_value) in file.values {
            match serde_json::from_value::<SettingValue>(raw_value.clone()) {
                Ok(value) => match self.schema.find(&key) {
                    Some(definition) => match definition.validate(value) {
                        Ok(normalized) => {
                            state.values.insert(key.clone(), normalized);
                            state.saved_keys.insert(key);
                        }
                        Err(reason) => {
                            log::warn!("dropping invalid stored value for `{key}`: {reason}");
                        }
                    },
                    None => {
                        // Unknown key from a future version: keep raw so a
                        // downgrade/upgrade roundtrip preserves it.
                        state.unknown_values.insert(key, raw_value);
                    }
                },
                Err(_) => {
                    state.unknown_values.insert(key, raw_value);
                }
            }
        }

        state
    }

    fn lock_state(&self) -> std::sync::MutexGuard<'_, StoredState> {
        unwrap_poisoned(&self.state)
    }

    fn lock_path(&self) -> std::sync::MutexGuard<'_, Option<PathBuf>> {
        unwrap_poisoned(&self.path)
    }
}

fn unwrap_poisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn sorted_saved_keys(state: &StoredState) -> Vec<String> {
    let mut keys: Vec<String> = state.saved_keys.iter().cloned().collect();
    keys.sort();
    keys
}

fn backup_corrupt_file(path: &std::path::Path) {
    let mut backup = path.as_os_str().to_owned();
    backup.push(".bak");
    let backup = PathBuf::from(backup);
    if let Err(error) = std::fs::rename(path, &backup) {
        log::warn!("could not back up settings {}: {error}", path.display());
    }
}

fn write_settings_file(path: &std::path::Path, state: &StoredState) -> Result<(), SettingsError> {
    let mut values = serde_json::Map::new();
    for (key, value) in &state.values {
        values.insert(
            key.clone(),
            serde_json::to_value(value).map_err(|error| {
                SettingsError::Io(std::io::Error::other(format!("serialize `{key}`: {error}")))
            })?,
        );
    }
    for (key, value) in &state.unknown_values {
        values.insert(key.clone(), value.clone());
    }

    let payload = SettingsFile {
        version: super::model::SETTINGS_VERSION,
        values,
    };
    let json = serde_json::to_string_pretty(&payload).map_err(|error| {
        SettingsError::Io(std::io::Error::other(format!(
            "serialize settings: {error}"
        )))
    })?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    // Atomic replace via temp file + persist (handles Windows semantics).
    let directory = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    let temp = tempfile::Builder::new()
        .prefix(".settings")
        .suffix(".tmp")
        .tempfile_in(directory)?;
    {
        let mut file = temp.as_file();
        std::io::Write::write_all(&mut file, json.as_bytes())?;
        // Flush to disk before the rename: without this a crash right
        // after persist() can leave a truncated file behind.
        file.sync_all()?;
    }
    temp.persist(path)
        .map_err(|error| SettingsError::Io(error.error))?;

    Ok(())
}

/// Merges stored values over schema defaults. Every schema key is present
/// in the result, so the frontend always receives a complete value object.
fn merged_values(schema: &SettingsSchema, state: &StoredState) -> SettingsValues {
    let mut merged = SettingsValues::new();
    for definition in schema.definitions() {
        let value = state
            .values
            .get(definition.key)
            .cloned()
            .unwrap_or_else(|| definition.default_value.clone());
        merged.insert(definition.key.to_owned(), value);
    }
    merged
}
