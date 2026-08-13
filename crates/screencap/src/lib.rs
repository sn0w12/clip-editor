//! Screencap library: the capture, mixing, media, and lifecycle machinery.
//! The binary (`src/main.rs`) is a thin CLI over this library so benches and
//! tests can exercise the hot paths directly.

pub mod audio;
pub mod config;
pub mod error;
pub mod hotkey;
pub mod media;
pub mod naming;
pub mod replay;
pub mod schema;
pub mod sound;
pub mod util;
pub mod video;

/// Re-export of the FFmpeg sidecar machinery so hosts (e.g. the Clip Editor
/// Tauri app) resolve and download FFmpeg through this crate's pinned version
/// without adding their own `ffmpeg-sidecar` dependency.
pub use ffmpeg_sidecar;
