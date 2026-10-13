use tauri::{Runtime, WebviewWindow};

#[cfg(windows)]
use tauri::Emitter;

/// Minimum Windows build number required for Snap Layouts support (Windows 11 21H2).
#[cfg(windows)]
pub(crate) const WIN11_MIN_BUILD: u32 = 22000;

pub struct Snap<R: Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: Runtime> Snap<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }

    pub fn app_handle(&self) -> &tauri::AppHandle<R> {
        &self.app
    }

    pub fn attach(&self, _window: &WebviewWindow<R>) -> crate::Result<()> {
        #[cfg(windows)]
        {
            let version = windows_version::OsVersion::current();
            if version.build >= WIN11_MIN_BUILD {
                _window.emit("tauri-snap://frontend-attach", ())?;
            }
        }
        Ok(())
    }

    pub fn detach(&self, _window: &WebviewWindow<R>) -> crate::Result<()> {
        #[cfg(windows)]
        {
            let version = windows_version::OsVersion::current();
            if version.build >= WIN11_MIN_BUILD {
                _window.emit("tauri-snap://frontend-detach", ())?;
                return crate::platform::snap::uninstall(_window);
            }
        }
        Ok(())
    }
}
