use serde_json::Value;

use crate::commands::{CommandResult, SerializedError};
use crate::state::SharedState;

#[tauri::command]
pub fn session_load(state: SharedState<'_>) -> CommandResult<Value> {
    Ok(state.session.load())
}

/// Persists the whole session document. The frontend owns its schema; the
/// backend only enforces the version field.
#[tauri::command]
pub fn session_save(state: SharedState<'_>, doc: Value) -> CommandResult<()> {
    state.session.save(doc).map_err(|error| SerializedError {
        code: error.code(),
        message: error.to_string(),
        retryable: true,
        detail: None,
    })
}
