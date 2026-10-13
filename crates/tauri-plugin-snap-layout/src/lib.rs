use tauri::{plugin::TauriPlugin, Manager, Runtime};

mod desktop;
mod error;

pub use desktop::Snap;
pub use error::{Error, Result};

#[cfg(windows)]
#[path = "lib_win_impl.rs"]
mod platform;

#[cfg(windows)]
pub use platform::SnapCursor;

#[cfg(not(windows))]
#[path = "lib_dummy_impl.rs"]
mod platform;

#[cfg(not(windows))]
/// Note: This is a no-op implementation for non-Windows platforms.
/// This enum is provided to ensure your cross-platform code compiles.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SnapCursor {
    Arrow,
    Hand,
}

pub struct SnapLayoutArea {
    inner: platform::AreaBuilder,
}

impl Default for SnapLayoutArea {
    fn default() -> Self {
        Self::new()
    }
}

impl SnapLayoutArea {
    pub fn new() -> Self {
        Self {
            inner: platform::AreaBuilder::new(),
        }
    }
    pub fn button_id(mut self, id: impl Into<String>) -> Self {
        self.inner = self.inner.button_id(id);
        self
    }
    pub fn padding_left(mut self, padding_left: i32) -> Self {
        self.inner = self.inner.padding_left(padding_left);
        self
    }
    pub fn padding_right(mut self, padding_right: i32) -> Self {
        self.inner = self.inner.padding_right(padding_right);
        self
    }
    pub fn padding_top(mut self, padding_top: i32) -> Self {
        self.inner = self.inner.padding_top(padding_top);
        self
    }
    pub fn padding_bottom(mut self, padding_bottom: i32) -> Self {
        self.inner = self.inner.padding_bottom(padding_bottom);
        self
    }
    pub fn padding_all(mut self, padding_all: i32) -> Self {
        self.inner = self.inner.padding_all(padding_all);
        self
    }
    pub fn display(mut self, is_display: bool) -> Self {
        self.inner = self.inner.display(is_display);
        self
    }
    pub fn debug_color(mut self, color: impl Into<String>) -> Self {
        self.inner = self.inner.debug_color(color);
        self
    }
    pub fn cursor(mut self, cursor: SnapCursor) -> Self {
        self.inner = self.inner.cursor(cursor);
        self
    }
    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        self.inner.build()
    }
}

pub fn init() -> SnapLayoutArea {
    SnapLayoutArea::new()
}

pub trait SnapExt<R: Runtime> {
    fn snap(&self) -> &Snap<R>;
}
impl<R: Runtime, T: Manager<R>> SnapExt<R> for T {
    fn snap(&self) -> &Snap<R> {
        self.state::<Snap<R>>().inner()
    }
}
