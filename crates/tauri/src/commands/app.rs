use seraphis_core::api::{EchoRequest, EchoResult};
use serde::Serialize;
use tauri::AppHandle;

use crate::commands::{to_serialized, CommandResult};
use crate::state::SharedState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub identifier: String,
    pub os: String,
    pub arch: String,
    pub tauri_version: String,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> CommandResult<AppInfo> {
    let package = app.package_info();
    Ok(AppInfo {
        name: package.name.clone(),
        version: package.version.to_string(),
        identifier: app.config().identifier.clone(),
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        tauri_version: tauri::VERSION.to_owned(),
    })
}

#[tauri::command]
pub fn app_ping(state: SharedState<'_>) -> CommandResult<String> {
    state.backend.ping().map_err(to_serialized)
}

#[tauri::command]
pub async fn app_echo(state: SharedState<'_>, request: EchoRequest) -> CommandResult<EchoResult> {
    state.backend.echo(request).await.map_err(to_serialized)
}
