use crate::desktop::Snap;
use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub(crate) mod snap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub enum SnapCursor {
    Arrow,
    Hand,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SnapConfig {
    pub button_id: String,
    pub padding_left: i32,
    pub padding_right: i32,
    pub padding_top: i32,
    pub padding_bottom: i32,
    pub padding_all: i32,
    pub display: bool,
    pub debug_color: String,
    pub cursor: SnapCursor,
}

pub struct AreaBuilder {
    config: SnapConfig,
}

#[tauri::command(rename_all = "snake_case", name = "update_snap_bounds")]
fn fallback_update_snap_bounds(_x: i32, _y: i32, _width: i32, _height: i32) {}

#[tauri::command(rename_all = "snake_case", name = "detach_snap_bounds")]
fn fallback_detach_snap_bounds() {}

impl AreaBuilder {
    pub fn new() -> Self {
        Self {
            config: SnapConfig {
                button_id: "".into(),
                padding_left: 0,
                padding_right: 0,
                padding_top: 0,
                padding_bottom: 0,
                padding_all: 0,
                display: false,
                debug_color: "rgba(196, 42, 28, 0.42)".into(),
                cursor: SnapCursor::Arrow,
            },
        }
    }

    pub fn button_id(mut self, id: impl Into<String>) -> Self {
        self.config.button_id = id.into();
        self
    }

    pub fn padding_left(mut self, padding_left: i32) -> Self {
        self.config.padding_left = padding_left;
        self
    }

    pub fn padding_right(mut self, padding_right: i32) -> Self {
        self.config.padding_right = padding_right;
        self
    }

    pub fn padding_top(mut self, padding_top: i32) -> Self {
        self.config.padding_top = padding_top;
        self
    }

    pub fn padding_bottom(mut self, padding_bottom: i32) -> Self {
        self.config.padding_bottom = padding_bottom;
        self
    }

    pub fn padding_all(mut self, padding_all: i32) -> Self {
        self.config.padding_all = padding_all;
        self
    }

    pub fn display(mut self, is_display: bool) -> Self {
        self.config.display = is_display;
        self
    }

    pub fn debug_color(mut self, color: impl Into<String>) -> Self {
        self.config.debug_color = color.into();
        self
    }

    pub fn cursor(mut self, cursor: SnapCursor) -> Self {
        self.config.cursor = cursor;
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let version = windows_version::OsVersion::current();
        if version.build < crate::desktop::WIN11_MIN_BUILD {
            return Builder::new("snap-layout")
                .setup(|app, _| {
                    app.manage(Snap::new(app.clone()));
                    Ok(())
                })
                .invoke_handler(tauri::generate_handler![
                    fallback_update_snap_bounds,
                    fallback_detach_snap_bounds
                ])
                .build();
        }

        let base_script = include_str!("../dist-js/inline-injection.js");

        let injection_script = base_script
            .replace(
                "__SNAP_BUTTON_ID__",
                &serde_json::to_string(&self.config.button_id)
                    .unwrap_or_else(|_| "\"\"".to_string()),
            )
            .replace("__SNAP_DISPLAY__", &self.config.display.to_string())
            .replace(
                "__SNAP_DEBUG_COLOR__",
                &serde_json::to_string(&self.config.debug_color)
                    .unwrap_or_else(|_| "\"\"".to_string()),
            )
            .replace(
                "__SNAP_PADDING_LEFT__",
                &format!("{}", self.config.padding_left),
            )
            .replace(
                "__SNAP_PADDING_RIGHT__",
                &format!("{}", self.config.padding_right),
            )
            .replace(
                "__SNAP_PADDING_TOP__",
                &format!("{}", self.config.padding_top),
            )
            .replace(
                "__SNAP_PADDING_BOTTOM__",
                &format!("{}", self.config.padding_bottom),
            )
            .replace(
                "__SNAP_PADDING_ALL__",
                &format!("{}", self.config.padding_all),
            );

        let plugin_config = self.config.clone();

        Builder::new("snap-layout")
            .setup(move |app, _| {
                app.manage(Snap::new(app.clone()));
                app.manage(plugin_config);
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                snap::update_snap_bounds,
                snap::detach_snap_bounds
            ])
            .js_init_script(injection_script)
            .build()
    }
}
