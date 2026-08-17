//! Video capture seam: [`VideoBackend`] implemented by Windows Graphics
//! Capture and by a non-Windows stub returning `PlatformUnsupported`. Frames
//! are plain BGRA with a monotonic PTS, so the encoder never sees a platform
//! type.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};

use parking_lot::Mutex;
use tracing::info;

use crate::error::RunError;
use crate::util::{RateLimiter, send_drop_oldest};

/// Latest frame shared between the capture producer and the pacer.
#[derive(Default)]
pub(crate) struct Latest {
    pub(crate) frame: Option<VideoFrame>,
}

/// Shared shutdown bookkeeping: the shutdown channel is consumed by whichever
/// thread notices it first, so a shared flag records that shutdown was
/// requested.
#[derive(Default)]
pub(crate) struct StopState {
    pub(crate) requested: AtomicBool,
}

/// Spawn the fixed-rate pacer thread shared by the Windows capture backends.
/// It re-sends the latest published frame at `info.fps`, seeding the timeline
/// with a black frame at `origin` so the stream's t=0 lands at the recorder
/// start even before the first captured frame arrives (the pre-capture gap is
/// pruned away with the rolling buffer). A full video channel drops the
/// oldest queued frame instead of building a stale backlog.
#[cfg(windows)]
pub(crate) fn spawn_pacer(
    info: VideoInfo,
    origin: Instant,
    tx: Sender<VideoFrame>,
    rx: Receiver<VideoFrame>,
    shutdown: Receiver<()>,
    latest: Arc<Mutex<Latest>>,
    stop: Arc<StopState>,
    pacer_done: Arc<AtomicBool>,
) -> Result<(), VideoError> {
    let interval = Duration::from_micros(1_000_000 / info.fps as u64);
    let pacer_shutdown = shutdown;
    let pacer_tx = tx;
    let pacer_rx = rx;
    let pacer_stop = stop;
    let pacer_latest = latest;
    let pacer_done_join = pacer_done;
    thread::Builder::new()
        .name("video-pacer".to_string())
        .spawn(move || {
            let mut limiter = RateLimiter::new(Duration::from_secs(5));
            let mut last: Option<VideoFrame> = None;
            let mut next_tick = origin;
            // Pre-encoder drops: a full video channel means the encoder is
            // behind; dropping the oldest queued frame keeps the stream
            // fresh instead of building a stale backlog. Counted and
            // rate-limit-logged so a chronic backlog is visible.
            let mut encoder_drops: u64 = 0;
            let mut last_drops_log = Instant::now();
            let mut stream_seeded = false;
            let (seed_w, seed_h) = (info.width, info.height);
            loop {
                if pacer_stop.requested.load(Ordering::SeqCst)
                    || pacer_done_join.load(Ordering::SeqCst)
                {
                    break;
                }
                if pacer_shutdown.try_recv().is_ok() {
                    pacer_stop.requested.store(true, Ordering::SeqCst);
                    break;
                }
                let now = Instant::now();
                if now < next_tick {
                    let _ = pacer_shutdown
                        .recv_timeout((next_tick - now).min(Duration::from_millis(50)));
                    continue;
                }
                next_tick += interval;
                if next_tick < now {
                    // Fell behind; resync rather than burst-sending.
                    next_tick = now + interval;
                }
                let frame = {
                    let mut guard = pacer_latest.lock();
                    guard.frame.take().or_else(|| last.clone())
                };
                if !stream_seeded {
                    let seed = VideoFrame::new(
                        origin.elapsed(),
                        seed_w,
                        seed_h,
                        vec![0u8; seed_w as usize * seed_h as usize * 4],
                    );
                    send_drop_oldest(&pacer_tx, &pacer_rx, seed.clone(), &mut limiter, "video");
                    last = Some(seed);
                    stream_seeded = true;
                }
                if let Some(mut frame) = frame {
                    frame.pts = origin.elapsed();
                    if send_drop_oldest(
                        &pacer_tx,
                        &pacer_rx,
                        frame.clone(),
                        &mut limiter,
                        "video",
                    ) {
                        encoder_drops += 1;
                    }
                    last = Some(frame);
                }
                if last_drops_log.elapsed() >= Duration::from_secs(5) {
                    info!(pre_encoder_drops = encoder_drops, "video pacer");
                    last_drops_log = Instant::now();
                }
            }
        })
        .map_err(|e| VideoError::Capture(format!("cannot spawn pacer thread: {e}")))?;
    Ok(())
}

/// The producer-to-segmenter video channel holds at most this many frames.
/// Two frames bound end-to-end frame age: a frame in flight to the encoder
/// plus one waiting, so a queued frame can never sit more than two frame
/// intervals before FFmpeg reads it. This public constant is the single
/// queue-capacity contract shared by the supervisor, its tests, and the
/// segmenter throughput harness.
pub const VIDEO_QUEUE_CAPACITY: usize = 2;

/// Capture statistics shared with the rate-limited capture log and the
/// benchmarks (`capbench`). The capture thread updates these via atomics;
/// benchmarks use them to prove that static-screen capture stops doing
/// readback work while the pacer keeps delivering the configured FPS.
#[derive(Debug, Default)]
pub struct CaptureStats {
    /// Frames read back and published by the capture thread.
    pub callbacks: AtomicU64,
    /// Frames dropped before GPU readback because they were superseded before
    /// the next stream interval.
    pub pre_readback_drops: AtomicU64,
    /// Full-frame staging copies performed by the capture thread.
    pub full_copies: AtomicU64,
    /// Dirty-region partial copies (the DXGI duplication delivers only
    /// changed frames, so partial copies are unused; kept for parity).
    pub partial_copies: AtomicU64,
    /// Frames with no desktop change (the pacer re-sends the last frame, so
    /// no readback work is needed).
    pub skipped_empty_damage: AtomicU64,
    /// GPU readback failures (the capture falls back to retrying).
    pub readback_errors: AtomicU64,
    /// Frames where a cursor shape was alpha-blended into the frame.
    pub cursor_blends: AtomicU64,
}

impl CaptureStats {
    pub fn snapshot(&self) -> (u64, u64, u64, u64, u64, u64, u64) {
        let load = |a: &AtomicU64| a.load(Ordering::Relaxed);
        (
            load(&self.callbacks),
            load(&self.pre_readback_drops),
            load(&self.full_copies),
            load(&self.partial_copies),
            load(&self.skipped_empty_damage),
            load(&self.readback_errors),
            load(&self.cursor_blends),
        )
    }
}

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
        VideoFrame {
            pts,
            width,
            height,
            bgra: Arc::new(bgra),
        }
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

    /// Optional producer statistics (the Windows backend exposes readback
    /// counters); other backends return `None`. Benchmarks use this to prove
    /// that static-screen capture performs no readback work.
    fn stats(&self) -> Option<Arc<CaptureStats>> {
        None
    }
}

/// Construct the platform backend. On non-Windows this returns
/// [`VideoError::PlatformUnsupported`] — the same trait remains the insertion
/// point for future ScreenCaptureKit/PipeWire backends, and no fake captured
/// output is ever produced.
pub fn create_backend(settings: &VideoSettings) -> Result<Box<dyn VideoBackend>, VideoError> {
    #[cfg(windows)]
    {
        // DXGI Desktop Duplication is the only Windows capture path. WGC was
        // removed: a WGC capture session forces the software cursor on
        // system-wide (robmikh/Win32CaptureSample#34), which causes cursor and
        // input lag everywhere; DXGI duplication does not.
        windows_dxgi::WindowsDxgiVideoBackend::new(settings.clone())
    }
    #[cfg(not(windows))]
    {
        let _ = settings;
        Err(VideoError::PlatformUnsupported(
            "video capture requires Windows (DXGI Desktop Duplication)".to_string(),
        ))
    }
}

#[cfg(windows)]
pub mod windows_dxgi;
