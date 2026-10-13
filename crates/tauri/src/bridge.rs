//! Shell-side implementations of the domain's abstractions: the event sink
//! over the Tauri event bus and the native save dialog.

use std::path::PathBuf;
use std::sync::Arc;

use seraphis_core::events::EventSink;
use seraphis_core::media::SaveTarget;
use tauri::Emitter;

pub struct TauriEventSink {
    app: tauri::AppHandle,
}

impl TauriEventSink {
    pub fn new(app: tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self { app })
    }
}

impl EventSink for TauriEventSink {
    fn emit_json(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }
}

pub struct TauriSaveTarget {
    app: tauri::AppHandle,
}

impl TauriSaveTarget {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

impl SaveTarget for TauriSaveTarget {
    fn pick_save_path(&self, suggested_name: &str, extension: &str) -> Result<PathBuf, String> {
        use tauri_plugin_dialog::DialogExt;
        let picked = self
            .app
            .dialog()
            .file()
            .set_file_name(suggested_name)
            .add_filter("Media", &[extension])
            .blocking_save_file();
        match picked {
            Some(path) => path
                .into_path()
                .map_err(|e| format!("media.export: save dialog: {e}")),
            None => Err("media.export: export canceled".to_string()),
        }
    }
}
