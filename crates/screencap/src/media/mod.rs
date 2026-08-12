//! Media layer: FFmpeg resolution, the rolling multi-track segment store, and
//! replay saves. All platform types stop at the module boundary.

use std::path::PathBuf;
use std::time::Duration;

/// A closed, indexed segment ready for concatenation.
#[derive(Debug, Clone)]
pub struct SegmentInfo {
    /// File name inside the buffer directory (e.g. `segment_00001.mkv`).
    pub name: String,
    pub path: PathBuf,
    /// Duration reported by the FFmpeg segment list.
    pub duration: Duration,
    /// Stream-time end of the segment (seconds on the shared stream
    /// timeline), from the segment list. Saves use this to wait for the
    /// buffer's content to reach the save moment.
    pub stream_end: f64,
}

pub mod ffmpeg;
pub mod save;
pub mod segmenter;
