use crate::desktop::Snap;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[tauri::command]
pub fn update_snap_bounds(_x: i32, _y: i32, _width: i32, _height: i32) {}

#[tauri::command]
pub fn detach_snap_bounds() {}

pub struct AreaBuilder;

impl AreaBuilder {
    pub fn new() -> Self {
        Self
    }

    pub fn button_id(self, _: impl Into<String>) -> Self {
        self
    }
    pub fn padding_left(self, _: i32) -> Self {
        self
    }
    pub fn padding_right(self, _: i32) -> Self {
        self
    }
    pub fn padding_top(self, _: i32) -> Self {
        self
    }
    pub fn padding_bottom(self, _: i32) -> Self {
        self
    }
    pub fn padding_all(self, _: i32) -> Self {
        self
    }
    pub fn display(self, _: bool) -> Self {
        self
    }
    pub fn debug_color(self, _: impl Into<String>) -> Self {
        self
    }
    pub fn cursor(self, _: crate::SnapCursor) -> Self {
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        Builder::new("snap-layout")
            .setup(|app, _| {
                app.manage(Snap::new(app.clone()));
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                update_snap_bounds,
                detach_snap_bounds
            ])
            .build()
    }
}
