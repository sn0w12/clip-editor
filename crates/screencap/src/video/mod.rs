//! Video capture seam: [`VideoBackend`] implemented by Windows Graphics
//! Capture and by a non-Windows stub returning `PlatformUnsupported`. Frames
//! are plain BGRA with a monotonic PTS, so the encoder never sees a platform
//! type.

use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::{Receiver, Sender};

use crate::error::RunError;

/// One captured frame, tightly packed BGRA8 (`width * height * 4` bytes).
///
/// The payload is behind an `Arc` so the FPS pacer can re-send the latest
/// frame (maintaining stream cadence on a static screen) without copying the
/// buffer.
#[derive(Debug, Clone)]
pub struct VideoFrame {
    /// Elapsed time since capture start.
    pub pts: Duration,
    #[allow(dead_code)] // self-describing contract; consumed by future consumers
    pub width: u32,
    #[allow(dead_code)]
    pub height: u32,
    pub bgra: Arc<Vec<u8>>,
}

impl VideoFrame {
    pub fn new(pts: Duration, width: u32, height: u32, bgra: Vec<u8>) -> Self {
        debug_assert_eq!(bgra.len() as u64, width as u64 * height as u64 * 4);
        VideoFrame { pts, width, height, bgra: Arc::new(bgra) }
    }
}

/// Resolved capture geometry, validated before any worker is started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VideoInfo {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
}

/// How the configured monitor string selects a display.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonitorSpec {
    Primary,
    /// One-based monitor index.
    Index(u32),
}

impl MonitorSpec {
    /// Parse `"primary"` or `"index:<one-based-index>"`.
    pub fn parse(s: &str) -> Result<Self, String> {
        let s = s.trim();
        if s.eq_ignore_ascii_case("primary") {
            return Ok(MonitorSpec::Primary);
        }
        if let Some(rest) = s.strip_prefix("index:") {
            let idx: u32 = rest
                .trim()
                .parse()
                .map_err(|_| format!("monitor index must be a positive integer, got `{rest}`"))?;
            if idx == 0 {
                return Err("monitor index is one-based; `index:0` is invalid".into());
            }
            return Ok(MonitorSpec::Index(idx));
        }
        Err(format!(
            "invalid monitor spec `{s}`; expected `primary` or `index:<one-based-index>`"
        ))
    }

    pub fn describe(&self) -> String {
        match self {
            MonitorSpec::Primary => "primary".to_string(),
            MonitorSpec::Index(i) => format!("index:{i}"),
        }
    }
}

/// Capture settings built from the validated config.
#[derive(Debug, Clone)]
pub struct VideoSettings {
    pub monitor: MonitorSpec,
    pub fps: u32,
    pub cursor: bool,
}

/// Errors produced by the video backend.
#[derive(Debug, thiserror::Error)]
pub enum VideoError {
    #[error("monitor not found: {0}")]
    Monitor(String),
    #[error("capture failed: {0}")]
    Capture(String),
    #[allow(dead_code)] // constructed by the non-Windows backend stub
    #[error("unsupported on this platform: {0}")]
    PlatformUnsupported(String),
}

/// A platform capture producer.
///
/// `spawn` starts the capture on its own thread and returns once the session
/// is live. The thread sends frames on `tx` and publishes terminal failures on
/// `err_tx` (a capture-session close or frame-read failure is terminal: the
/// supervisor shuts everything down rather than letting fabricated timestamps
/// fill the buffer). `shutdown` is polled by the producer so the supervisor
/// can stop it without blocking.
pub trait VideoBackend: Send {
    /// Resolve monitor existence and dimensions without opening a capture.
    fn resolve(&self) -> Result<VideoInfo, VideoError>;

    /// Start the capture thread. Both ends of the frame channel are provided
    /// so the producer can drop the oldest frame when the bounded channel is
    /// full instead of blocking the real-time callback. `origin` is the
    /// supervisor-wide start instant: all producers stamp PTS on the same
    /// timeline so the mixer never sees a source as late merely because it
    /// started a moment later.
    fn spawn(
        self: Box<Self>,
        info: VideoInfo,
        origin: std::time::Instant,
        tx: Sender<VideoFrame>,
        rx: Receiver<VideoFrame>,
        err_tx: Sender<RunError>,
        shutdown: Receiver<()>,
    ) -> Result<(), VideoError>;
}

/// Construct the platform backend. On non-Windows this returns
/// [`VideoError::PlatformUnsupported`] — the same trait remains the insertion
/// point for future ScreenCaptureKit/PipeWire backends, and no fake captured
/// output is ever produced.
pub fn create_backend(settings: &VideoSettings) -> Result<Box<dyn VideoBackend>, VideoError> {
    #[cfg(windows)]
    {
        windows::WindowsVideoBackend::new(settings.clone())
    }
    #[cfg(not(windows))]
    {
        let _ = settings;
        Err(VideoError::PlatformUnsupported(
            "video capture requires Windows (Windows.Graphics.Capture)".to_string(),
        ))
    }
}

#[cfg(windows)]
pub mod windows;

