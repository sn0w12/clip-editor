//! Audio seam: producers emit timestamped [`AudioBlock`]s keyed by
//! [`SourceKey`]; the router re-orders, zero-fills, and mixes them into
//! per-track blocks. No platform types cross this boundary.

use std::time::Duration;

/// Canonical source identity.
///
/// Canonical forms:
/// - `source:<configured-process-id>` — a configured process rule;
/// - `input:<configured-input-id>` — a configured input (microphone);
/// - `process:<pid>` — an unknown render-process root (stable while alive).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct SourceKey(pub String);

impl SourceKey {
    pub fn process(id: &str) -> Self {
        SourceKey(format!("source:{id}"))
    }

    pub fn input(id: &str) -> Self {
        SourceKey(format!("input:{id}"))
    }

    pub fn unknown_process(pid: u32) -> Self {
        SourceKey(format!("process:{pid}"))
    }
}

/// Broad category of a source, used by the `all_processes` selectors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Process,
    Input,
}

/// Routing metadata for a source. Configured process rules contribute their
/// tags; unknown roots and inputs carry none. Tags are routing metadata only —
/// nothing in this module ever touches Windows volume/mute state.
#[derive(Debug, Clone)]
pub struct SourceInfo {
    pub key: SourceKey,
    pub kind: SourceKind,
    pub tags: Vec<String>,
    /// Executable name for diagnostics only.
    pub executable: Option<String>,
}

impl SourceInfo {
    pub fn is_muted(&self) -> bool {
        self.tags.iter().any(|t| t == "muted")
    }
}

/// A contiguous chunk of interleaved `f32` audio from one source.
#[derive(Debug, Clone)]
pub struct AudioBlock {
    pub source: SourceKey,
    /// Start time of the block relative to the producer's start.
    pub pts: Duration,
    pub sample_rate: u32,
    pub channels: u16,
    /// Interleaved samples; length is a multiple of `channels`.
    pub samples: Vec<f32>,
}

impl AudioBlock {
    pub fn duration(&self) -> Duration {
        let frames = (self.samples.len() / self.channels.max(1) as usize) as u64;
        Duration::from_secs_f64(frames as f64 / self.sample_rate as f64)
    }
}

/// Events the audio workers publish to the mixer thread.
#[derive(Debug, Clone)]
pub enum AudioEvent {
    Block(AudioBlock),
    SourceAdded(SourceInfo),
    SourceRemoved(SourceKey),
}

/// A mixed block for one output track, in the track's configured order.
/// The fields are the self-describing contract consumed by the integration
/// test and by future consumers (logging, per-track diagnostics).
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct TrackAudioBlock {
    pub number: u16,
    pub name: String,
    pub pts: Duration,
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: Vec<f32>,
}

/// Errors produced by the audio subsystem.
#[derive(Debug, thiserror::Error)]
pub enum AudioError {
    #[error("Windows build too old: application-loopback capture requires Windows 10 build 20348 or newer (found {0})")]
    WindowsTooOld(String),
    #[error("audio capture failed: {0}")]
    Capture(String),
    #[error("microphone capture failed: {0}")]
    Microphone(String),
}

pub use router::AudioRouter;

pub mod microphone;
pub mod resample;
pub mod router;

#[cfg(windows)]
pub mod windows;
