use crate::commands::clip::sync_autostart;
use crate::commands::{CommandResult, SerializedError};
use crate::settings::{SettingValue, SettingsError, SettingsSnapshot, ValuesSnapshot};
use crate::state::SharedState;

#[tauri::command]
pub fn settings_load(state: SharedState<'_>) -> CommandResult<SettingsSnapshot> {
    Ok(state.settings.snapshot())
}

#[tauri::command]
pub fn settings_set(
    app: tauri::AppHandle,
    state: SharedState<'_>,
    key: String,
    value: SettingValue,
) -> CommandResult<ValuesSnapshot> {
    let snapshot =
        state
            .settings
            .set_and_snapshot(&key, value)
            .map_err(|error: SettingsError| SerializedError {
                code: error.code(),
                message: error.to_string(),
                retryable: false,
                detail: error.detail(),
            })?;

    // Two settings reach beyond the store: the autostart registration and the
    // directory the Steam scan reads on the next refresh.
    match key.as_str() {
        seraphis_core::settings::keys::LAUNCH_ON_STARTUP => {
            let enabled = snapshot
                .values
                .get(&key)
                .and_then(|value| value.as_bool())
                .unwrap_or(true);
            sync_autostart(&app, enabled);
        }
        seraphis_core::settings::keys::STEAM_DIRECTORY => {
            if let Some(dir) = snapshot.values.get(&key).and_then(|value| value.as_str()) {
                *state.backend.steam_dir.lock() = dir.to_owned();
            }
        }
        _ => {}
    }

    Ok(snapshot)
}
