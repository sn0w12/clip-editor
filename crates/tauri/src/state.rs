use std::sync::Arc;

use parking_lot::Mutex;
use seraphis_core::Backend;

use crate::session::SessionStore;
use crate::settings::SettingsStore;

pub struct AppState {
    pub backend: Arc<Backend>,
    pub settings: Arc<SettingsStore>,
    pub session: Arc<SessionStore>,
    /// The tray's "Start/Stop replay buffer" item, so its label can be kept in
    /// sync with the recording state.
    pub tray_toggle: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
}

pub type SharedState<'a> = tauri::State<'a, AppState>;
