//! Typed errors. [`RunError`] is the top level returned by the CLI and
//! published by workers on the supervisor's error channel.

use crate::audio::AudioError;
use crate::video::VideoError;

/// Configuration loading and semantic validation errors.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// A Figment extraction error; `Display` names the offending key and source.
    #[error("configuration error: {0}")]
    Figment(#[from] figment::Error),
    /// A semantic validation failure (ranges, selector grammar, duplicates).
    #[error("invalid configuration: {0}")]
    Validation(String),
}

/// Terminal capture errors produced by the video and audio producers.
#[derive(Debug, thiserror::Error)]
pub enum CaptureError {
    #[error(transparent)]
    Video(#[from] VideoError),
    #[error(transparent)]
    Audio(#[from] AudioError),
}

/// Global hotkey registration / event loop errors.
#[derive(Debug, thiserror::Error)]
pub enum HotkeyError {
    #[error("hotkey error: {0}")]
    General(String),
}

/// Media pipeline errors: FFmpeg resolution, encoder checks, the rolling
/// segment store, and replay saves.
#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("failed to obtain ffmpeg: {0}")]
    FfmpegObtain(String),
    #[error("ffmpeg error: {0}")]
    Ffmpeg(String),
    #[error("ffmpeg encoder unavailable: {0}")]
    EncoderUnavailable(String),
    #[error("media pipeline error: {0}")]
    General(String),
}

/// Errors for platform-gated features that have no implementation on the
/// current OS. Only constructed on non-Windows builds (the Windows `run` path
/// never reaches these).
#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[allow(dead_code)]
    #[error("screencap is not supported on this platform: {0}")]
    Unsupported(String),
}

/// Top-level error type returned by the CLI commands and published by workers.
#[derive(Debug, thiserror::Error)]
pub enum RunError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Capture(#[from] CaptureError),
    #[error(transparent)]
    Hotkey(#[from] HotkeyError),
    #[error(transparent)]
    Media(#[from] MediaError),
    #[error(transparent)]
    Platform(#[from] PlatformError),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl RunError {
    /// Convenience constructor for plain-message media failures.
    pub fn media(msg: impl Into<String>) -> Self {
        RunError::Media(MediaError::General(msg.into()))
    }
}

impl From<VideoError> for RunError {
    fn from(e: VideoError) -> Self {
        RunError::Capture(CaptureError::Video(e))
    }
}

impl From<AudioError> for RunError {
    fn from(e: AudioError) -> Self {
        RunError::Capture(CaptureError::Audio(e))
    }
}
