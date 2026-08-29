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
    #[error(
        "Windows build too old: application-loopback capture requires Windows 10 build 20348 or newer (found {0})"
    )]
    WindowsTooOld(String),
    #[error("audio capture failed: {0}")]
    Capture(String),
    #[error("microphone capture failed: {0}")]
    Microphone(String),
}

/// Stamp the PTS of a burst of audio blocks drained at wall time `wall`.
///
/// Every live source must sit on the *same* wall-clock timeline as the
/// mixer windows and the video ticks (all derived from the capture
/// `origin`), or the sources drift apart: an independent per-source data
/// timeline advances at its own rate and re-anchors at its own moments,
/// shifting that source's content relative to everything else. A burst
/// read (a loopback poll or a device callback) returns audio that spans
/// the preceding `audio_back` of wall time, so the burst's oldest block is
/// stamped `grid(wall - audio_back)` and each following block `block_dur`
/// later. Steady reads land one block per mixer window; burst reads spread
/// across their real span; a silent stretch leaves a genuine gap; and a
/// stalled worker's buffered audio keeps its true position — the mixer
/// drops only what is genuinely late, and nothing is ever shifted.
pub fn burst_base_pts(wall: Duration, audio_back: Duration, grid_ms: u64) -> Duration {
    let start = wall.saturating_sub(audio_back);
    Duration::from_millis(((start.as_millis() / grid_ms as u128) * grid_ms as u128) as u64)
}

pub use router::AudioRouter;

pub mod microphone;
pub mod resample;
pub mod router;

#[cfg(windows)]
pub mod windows;

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK: Duration = Duration::from_millis(20);

    #[test]
    fn steady_reads_stamp_on_the_wall_grid() {
        // A steady 20 ms read at wall=1.0s covers the preceding 20 ms: the
        // burst's base PTS is one block back, grid-aligned.
        let base = burst_base_pts(Duration::from_millis(1000), BLOCK, 20);
        assert_eq!(base, Duration::from_millis(980));
    }

    #[test]
    fn burst_reads_spread_across_their_wall_span() {
        // A 100 ms burst drained at wall=1.0s covers 900..1000 ms: the
        // blocks keep their true positions instead of collapsing onto the
        // drain moment.
        let base = burst_base_pts(Duration::from_millis(1000), Duration::from_millis(100), 20);
        assert_eq!(base, Duration::from_millis(900));
    }

    #[test]
    fn resumed_audio_after_silence_keeps_true_position() {
        // Silence leaves no data, so the first block after a 4 s pause is
        // stamped at the resume moment — never pre-gap.
        let wall = Duration::from_millis(4000);
        let base = burst_base_pts(wall, BLOCK, 20);
        assert_eq!(base, Duration::from_millis(3980));
    }

    #[test]
    fn stalled_worker_burst_keeps_buffered_audio_in_place() {
        // A worker preempted for 300 ms drains the accumulated audio at the
        // resume moment; the burst still spans the stall window, so the
        // content is not shifted forward on the track.
        let wall = Duration::from_millis(2000);
        let base = burst_base_pts(wall, Duration::from_millis(300), 20);
        assert_eq!(base, Duration::from_millis(1700));
    }

    #[test]
    fn grid_alignment_never_goes_negative() {
        // A burst spanning more wall than has elapsed (startup) clamps at
        // the origin instead of going negative.
        let base = burst_base_pts(Duration::from_millis(5), Duration::from_millis(20), 20);
        assert_eq!(base, Duration::ZERO);
    }
}
