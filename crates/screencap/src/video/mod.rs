//! Video capture seam: [`VideoBackend`] implemented by Windows Graphics
//! Capture and by a non-Windows stub returning `PlatformUnsupported`. Frames
//! are plain BGRA with a monotonic PTS, so the encoder never sees a platform
//! type.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};

use parking_lot::Mutex;

use crate::error::RunError;

/// Frames the feed thread keeps between the capture and the encoder.
///
/// One slot is not enough to be faithful, and the size is not a guess: it is set
/// by the segment muxer's own bound. With real-time audio streams in the same
/// muxer, video delivery is throttled to real time no matter how far the audio
/// trails (measured: identical writer behaviour with the audio 0 ms and 300 ms
/// behind), so the writer blocks on every frame and the only headroom in the
/// path is what this buffer holds. The muxer may hold video for up to
/// `max_interleave_delta` before writing it anyway, and that constant is 250 ms
/// in [`crate::media::segmenter`], i.e. 15 frames at 60 fps. Measured holds on
/// the real pipeline are 167 to 287 ms. A buffer shorter than the muxer's own
/// tolerance drops exactly the frames the muxer is holding for, which is what
/// turned a stalled write into runs of 5 to 9 identical frames in a saved clip.
///
/// 24 slots cover 400 ms, above the 250 ms the muxer is allowed to hold and
/// above the worst hold measured on a live desktop. Keep this at or above
/// `ceil(max_interleave_delta * fps)`. The queue only fills while the writer is
/// blocked, so a healthy session still holds one frame and adds no latency.
pub const PENDING_FRAMES: usize = 24;

/// Frames published by the capture and not yet handed to the encoder, oldest
/// first. Bounded; the capture drops the oldest when it overruns, because a
/// stale frame is worth less than a current one.
#[doc(hidden)]
pub struct Latest {
    pub frames: VecDeque<VideoFrame>,
    capacity: usize,
}

impl Default for Latest {
    fn default() -> Self {
        Latest::with_capacity(PENDING_FRAMES)
    }
}

impl Latest {
    /// A queue that holds `capacity` frames before dropping the oldest. The
    /// capacity is a parameter so the harness can measure the same pipeline with
    /// a single slot against the real one.
    #[doc(hidden)]
    pub fn with_capacity(capacity: usize) -> Self {
        Latest {
            frames: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    /// Queue a published frame, dropping the oldest if the queue is full.
    /// Returns whether a frame was dropped, and the depth afterwards.
    #[doc(hidden)]
    pub fn push(&mut self, frame: VideoFrame) -> (bool, usize) {
        let dropped = self.frames.len() >= self.capacity;
        if dropped {
            self.frames.pop_front();
        }
        self.frames.push_back(frame);
        (dropped, self.frames.len())
    }

    /// Take the oldest queued frame, so a stretch the writer blocked through is
    /// replayed as the frames that were captured rather than as repeats.
    #[doc(hidden)]
    pub fn pop(&mut self) -> Option<VideoFrame> {
        self.frames.pop_front()
    }
}

/// Shared shutdown bookkeeping: the shutdown channel is consumed by whichever
/// thread notices it first, so a shared flag records that shutdown was
/// requested.
#[doc(hidden)]
#[derive(Default)]
pub struct StopState {
    pub requested: AtomicBool,
}

/// Spawn the video feed thread shared by the Windows capture backends.
///
/// It emits exactly one frame per stream tick, seeding the timeline with a
/// black frame at `origin` so the stream's t=0 lands at the recorder start even
/// before the first captured frame arrives (the pre-capture gap is pruned away
/// with the rolling buffer). A tick that the capture had nothing new for
/// re-sends the previous frame.
///
/// That repeat is load-bearing, not a cosmetic choice. The DXGI duplication
/// produces a frame only when the desktop changes, so a static desktop — an
/// alt-tab, a paused video, a modal dialog — can go many seconds without one.
/// Publishing nothing for that stretch leaves the segmenter's video pipe
/// silent, and a silent pipe is indistinguishable from a wedged feed thread, so
/// the stall watchdog tears down a perfectly healthy recording and the session
/// can never be saved from again. Emitting one frame per tick unconditionally
/// makes frame arrival a faithful liveness signal for this thread: a gap in the
/// stream now means the feed itself stopped, which is the only condition the
/// watchdog should treat as fatal. It is also what keeps the count-based video
/// timeline exact — the writer's frame count stays the wall seconds elapsed.
///
/// A full video channel *blocks* until the writer drains a frame — it never
/// drops, because a dropped frame is a hole the encoder cannot account for.
#[cfg(windows)]
#[doc(hidden)]
pub fn spawn_pacer(
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
    let _pacer_rx = rx;
    let pacer_stop = stop;
    let pacer_latest = latest;
    let pacer_done_join = pacer_done;
    thread::Builder::new()
        .name("video-pacer".to_string())
        .spawn(move || {
            let mut last: Option<VideoFrame> = None;
            let mut next_tick = origin;
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
                // What the capture published since the last tick, else the
                // previous frame again. The duplication only delivers a frame
                // when the desktop changes, so a quiet stretch re-sends rather
                // than going silent — see the note on `spawn_pacer` for why a
                // silent stream is not survivable. Oldest first: a stretch the
                // writer blocked through comes back out as the frames that were
                // captured, in order, not as repeats of the newest one.
                let frame = {
                    let mut guard = pacer_latest.lock();
                    guard.pop().or_else(|| last.clone())
                };
                if !stream_seeded {
                    let seed = VideoFrame::new(
                        origin.elapsed(),
                        seed_w,
                        seed_h,
                        nv12_black(seed_w, seed_h),
                    );
                    if !send_blocking(&pacer_tx, seed.clone(), &pacer_shutdown) {
                        break;
                    }
                    last = Some(seed);
                    stream_seeded = true;
                }
                if let Some(mut frame) = frame {
                    frame.pts = origin.elapsed();
                    if !send_blocking(&pacer_tx, frame.clone(), &pacer_shutdown) {
                        break;
                    }
                    last = Some(frame);
                }
                next_tick += interval;
            }
        })
        .map_err(|e| VideoError::Capture(format!("cannot spawn pacer thread: {e}")))?;
    Ok(())
}

/// Send one frame into the bounded pacer channel, blocking (never dropping)
/// when the channel is full. The encoder timestamps rawvideo input by frame
/// count at `-framerate`, so a dropped frame makes the segment shorter than
/// the wall seconds it spans — the saved clip plays that stretch faster than
/// real time. Blocking lets the writer/encoder catch up; the rolling buffer
/// simply lags the wall for the stalled stretch. Returns `false` when the
/// channel is gone or shutdown arrived, so the pacer exits instead of
/// spinning against a stuck writer.
fn send_blocking(tx: &Sender<VideoFrame>, frame: VideoFrame, shutdown: &Receiver<()>) -> bool {
    loop {
        crossbeam_channel::select! {
            send(tx, frame.clone()) -> res => {
                if res.is_err() {
                    return false;
                }
                return true;
            }
            recv(shutdown) -> res => {
                if res.is_ok() {
                    return false;
                }
            }
        }
    }
}

/// The producer-to-segmenter video channel holds at most this many frames.
/// The pacer blocks (never drops) when the channel is full, so the capacity
/// bounds how much transient encoder slowness is absorbed before the pacer has
/// to wait, while the count-based video timeline stays exact. In steady state
/// the writer drains at exactly the stream rate, so a channel that filled never
/// empties again and every frame in it is standing latency — at 16 that was
/// ~200 ms of backlog held for a whole session. Four frames still spans several
/// blocked pipe writes; muxer stalls are absorbed by the video pipe's buffer.
pub const VIDEO_QUEUE_CAPACITY: usize = 4;

/// Granularity of the readback-latency histogram, in microseconds.
pub const READBACK_BUCKET_MICROS: u64 = 500;
/// Number of readback-latency buckets; the top bucket also collects every
/// slower readback, so `readback_max_nanos` remains the exact worst case.
pub const READBACK_BUCKETS: usize = 32;

/// Granularity of the copy→readback *latency* histogram, in microseconds. It
/// is far coarser than the CPU-cost one because it spans the GPU copy plus any
/// compositor queueing (tens of milliseconds), where sub-millisecond resolution
/// would be noise. 2 ms × [`READBACK_BUCKETS`] covers 64 ms; everything slower
/// lands in the top bucket and is exact via `readback_latency_max_nanos`.
pub const READBACK_LATENCY_BUCKET_MICROS: u64 = 2000;

/// A readback map that waits longer than this is slow enough to threaten a
/// capture tick, so it is counted separately (see
/// [`CaptureStats::slow_map_waits`]). Measured on an idle desktop the map wait
/// is ~1 ms (p95 1.3 ms); anything past this is GPU contention.
pub const SLOW_MAP_WAIT: Duration = Duration::from_millis(5);

/// Ticks per second of the performance counter, which is the timebase DXGI
/// stamps `LastPresentTime` with. Queried once and cached: it is fixed for the
/// life of the system, and it is the divisor that turns a present stamp into
/// milliseconds.
///
/// Falls back to 10 MHz (the historical default) if the query fails, so a
/// failure degrades the reported interval instead of dividing by zero.
fn qpc_hz() -> f64 {
    #[cfg(windows)]
    {
        static HZ: std::sync::OnceLock<f64> = std::sync::OnceLock::new();
        *HZ.get_or_init(|| {
            let mut freq = 0i64;
            // SAFETY: `QueryPerformanceFrequency` only writes through the
            // out-parameter, which points at a live `i64`.
            let ok = unsafe {
                windows::Win32::System::Performance::QueryPerformanceFrequency(&mut freq)
            };
            if ok.is_ok() && freq > 0 {
                freq as f64
            } else {
                10_000_000.0
            }
        })
    }
    #[cfg(not(windows))]
    10_000_000.0
}

/// Capture statistics shared with the rate-limited capture log, the capture
/// health event, and the benchmarks (`capbench`). The capture thread updates
/// these via atomics; benchmarks use them to prove that a static screen costs
/// no readback while the pacer keeps delivering the configured FPS, and that
/// acquisition happens once per stream frame instead of once per compositor
/// update.
#[derive(Debug)]
pub struct CaptureStats {
    /// Frames read back and published by the capture thread.
    pub callbacks: AtomicU64,
    /// Frames a tick acquired but never read back because a newer frame
    /// already superseded them (only possible when a tick runs long).
    pub pre_readback_drops: AtomicU64,
    /// Full-frame staging copies performed by the capture thread.
    pub full_copies: AtomicU64,
    /// Dirty-region partial copies (the DXGI duplication delivers only
    /// changed frames, so partial copies are unused; kept for parity).
    pub partial_copies: AtomicU64,
    /// Frames with no desktop change (the feed thread re-sends the last frame,
    /// so no readback work is needed).
    pub skipped_empty_damage: AtomicU64,
    /// GPU readback failures (the capture falls back to retrying).
    pub readback_errors: AtomicU64,
    /// Successful duplication acquires. In steady state this tracks the
    /// configured FPS: one acquire per stream tick, not one per compositor
    /// update (`capbench`'s no-busy-spin assertion).
    pub acquires: AtomicU64,
    /// Acquires that carried no desktop update, only a pointer move.
    ///
    /// DXGI hands out a frame for a cursor move with `AccumulatedFrames == 0`
    /// and an unchanged `LastPresentTime`: the pointer moved, the desktop image
    /// did not. With pointer compositing off such a frame is byte-identical to
    /// the previous one, so publishing it puts a repeated frame in the stream
    /// for every cursor move. A gaming mouse reports far more often than the
    /// desktop updates, so on a moving pointer this is most ticks.
    pub mouse_only_frames: AtomicU64,
    /// Acquires that found no new frame within the tick's acquire budget.
    pub acquire_timeouts: AtomicU64,
    /// Frames the capture discarded because the feed thread had not drained the
    /// pending queue yet. Non-zero means the encoder stopped reading for longer
    /// than [`crate::video::PENDING_FRAMES`] intervals; those are the frames a
    /// clip can only repeat.
    pub pending_drops: AtomicU64,
    /// Deepest the pending queue has run, over the whole session. This is the
    /// measured size of the encode path's holds, in frame intervals.
    pub pending_depth_max: AtomicU64,
    /// Published frames whose pixels are identical to the previous publish.
    ///
    /// The split that matters: a repeat in a file is either a frame the capture
    /// published twice (DXGI handed back a recomposition of an unchanged image)
    /// or a frame the feed thread re-sent because the capture published nothing
    /// for that tick. Equal to the first means the loss is upstream of the feed
    /// thread.
    pub duplicate_publishes: AtomicU64,
    /// Presents the compositor performed that DXGI folded into a frame this
    /// capture already had, so they were never seen individually
    /// (`AccumulatedFrames - 1`, summed).
    ///
    /// This is the counter that separates the two reasons a timeout happens,
    /// which look identical in `acquires`/`acquire_timeouts` alone. A timeout
    /// with `coalesced_presents` climbing means the compositor *is* producing
    /// frames and the capture is dropping them (a poll or hold problem, and the
    /// fix is to drain the duplication faster). A timeout with
    /// `coalesced_presents` flat and `present_interval_ms` stretched means the
    /// compositor genuinely stopped presenting, and the correct response is the
    /// feed thread's re-send, not a faster poll.
    pub coalesced_presents: AtomicU64,
    /// Sum of the intervals between consecutive compositor presents, in QPC
    /// ticks, and how many intervals produced it. The mean is the display's
    /// real present cadence, measured by the compositor rather than inferred
    /// from our own poll rate.
    present_delta_ticks: AtomicU64,
    present_samples: AtomicU64,
    /// Ticks that started late (a long readback, a duplication rebuild, or a
    /// descheduled thread) and were skipped to keep the tick grid honest.
    pub tick_overruns: AtomicU64,
    /// Readback maps that waited longer than [`SLOW_MAP_WAIT`] on the GPU: the
    /// tail that can make a capture tick miss its interval, counted so it is
    /// visible instead of hiding inside the mean.
    pub slow_map_waits: AtomicU64,
    /// Total and worst CPU time spent per published frame (the plane maps and
    /// row copies), in nanoseconds.
    pub readback_nanos: AtomicU64,
    pub readback_max_nanos: AtomicU64,
    /// Readback-latency histogram (see [`READBACK_BUCKET_MICROS`]).
    readback_buckets: [AtomicU64; READBACK_BUCKETS],
    /// Total and worst time between submitting a readback's GPU copy and
    /// mapping it, in nanoseconds. This is the capture path's latency floor:
    /// no pipeline can deliver more unique frames per second than its inverse,
    /// and a latency near the stream interval means the feed thread has to
    /// repeat the previous frame to keep the cadence (visible in a clip as
    /// repeated frames).
    pub readback_latency_nanos: AtomicU64,
    pub readback_latency_max_nanos: AtomicU64,
    /// Copy→map latency histogram (see [`READBACK_LATENCY_BUCKET_MICROS`]).
    readback_latency_buckets: [AtomicU64; READBACK_BUCKETS],
}

impl Default for CaptureStats {
    fn default() -> Self {
        CaptureStats {
            callbacks: AtomicU64::new(0),
            pre_readback_drops: AtomicU64::new(0),
            full_copies: AtomicU64::new(0),
            partial_copies: AtomicU64::new(0),
            skipped_empty_damage: AtomicU64::new(0),
            readback_errors: AtomicU64::new(0),
            acquires: AtomicU64::new(0),
            mouse_only_frames: AtomicU64::new(0),
            acquire_timeouts: AtomicU64::new(0),
            pending_drops: AtomicU64::new(0),
            pending_depth_max: AtomicU64::new(0),
            duplicate_publishes: AtomicU64::new(0),
            coalesced_presents: AtomicU64::new(0),
            present_delta_ticks: AtomicU64::new(0),
            present_samples: AtomicU64::new(0),
            tick_overruns: AtomicU64::new(0),
            slow_map_waits: AtomicU64::new(0),
            readback_nanos: AtomicU64::new(0),
            readback_max_nanos: AtomicU64::new(0),
            readback_buckets: std::array::from_fn(|_| AtomicU64::new(0)),
            readback_latency_nanos: AtomicU64::new(0),
            readback_latency_max_nanos: AtomicU64::new(0),
            readback_latency_buckets: std::array::from_fn(|_| AtomicU64::new(0)),
        }
    }
}

/// A consistent-enough read of [`CaptureStats`] for logging, the health event,
/// and benchmarks (each counter is read once; the set is not a transaction).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct CaptureStatsSnapshot {
    pub callbacks: u64,
    pub pre_readback_drops: u64,
    pub full_copies: u64,
    pub partial_copies: u64,
    pub skipped_empty_damage: u64,
    pub readback_errors: u64,
    pub acquires: u64,
    /// Acquires that carried only a pointer move and were not published.
    pub mouse_only_frames: u64,
    pub acquire_timeouts: u64,
    /// Frames discarded because the pending queue was full.
    pub pending_drops: u64,
    /// Deepest the pending queue has run this session.
    pub pending_depth_max: u64,
    /// Published frames whose pixels are identical to the previous publish.
    ///
    /// This is the split that matters: a repeat in the file is either a frame
    /// the capture published twice (DXGI handed back a recomposition of an
    /// unchanged image) or a frame the feed thread re-sent because the capture
    /// published nothing for that tick. Equal to the first means the loss is
    /// upstream of the feed thread.
    pub duplicate_publishes: u64,
    /// Presents the compositor performed that DXGI folded into frames already
    /// held, so they were never processed individually.
    pub coalesced_presents: u64,
    /// Mean interval between compositor presents, in milliseconds — the
    /// display's real cadence as reported by DXGI. `0.0` before two presents
    /// have been seen.
    pub present_interval_ms: f64,
    pub tick_overruns: u64,
    pub slow_map_waits: u64,
    /// Total CPU time spent in the readback path, in milliseconds.
    pub readback_total_ms: f64,
    /// Worst single readback, in milliseconds.
    pub readback_max_ms: f64,
    /// Mean and 95th-percentile copy→map latency, in milliseconds.
    pub readback_latency_mean_ms: f64,
    pub readback_latency_p95_ms: f64,
    /// Worst copy→map latency, in milliseconds.
    pub readback_latency_max_ms: f64,
}

impl CaptureStats {
    /// Record one readback's copy→map latency: how long the map waited for the
    /// staging copy to complete. This is the capture path's latency floor, and
    /// the number the feed thread's re-sends are made of.
    pub fn observe_map_wait(&self, elapsed: Duration) {
        let micros = elapsed.as_micros() as u64;
        self.readback_latency_nanos
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
        self.readback_latency_max_nanos
            .fetch_max(elapsed.as_nanos() as u64, Ordering::Relaxed);
        if elapsed > SLOW_MAP_WAIT {
            self.slow_map_waits.fetch_add(1, Ordering::Relaxed);
        }
        let bucket =
            (micros / READBACK_LATENCY_BUCKET_MICROS).min(READBACK_BUCKETS as u64 - 1) as usize;
        self.readback_latency_buckets[bucket].fetch_add(1, Ordering::Relaxed);
    }

    /// Record one published frame's readback cost (map + row copy + blend).
    pub fn observe_readback(&self, elapsed: Duration) {
        let micros = elapsed.as_micros() as u64;
        self.readback_nanos
            .fetch_add(elapsed.as_nanos() as u64, Ordering::Relaxed);
        self.readback_max_nanos
            .fetch_max(elapsed.as_nanos() as u64, Ordering::Relaxed);
        let bucket = (micros / READBACK_BUCKET_MICROS).min(READBACK_BUCKETS as u64 - 1) as usize;
        self.readback_buckets[bucket].fetch_add(1, Ordering::Relaxed);
    }

    /// Record what the compositor reported about one acquired frame:
    /// `accumulated_frames` is DXGI's count of presents folded into this frame
    /// since the previous acquire (1 means nothing was coalesced away), and
    /// `present_delta_ticks` is the QPC gap since the previously acquired
    /// frame's present (`None` on the first frame of a session).
    ///
    /// The caller owns the previous present stamp because it must skip the
    /// duplicated/recreated-duplication cases where the sequence restarts; this
    /// only accumulates what it is handed.
    pub fn observe_present(&self, accumulated_frames: u32, present_delta_ticks: Option<i64>) {
        // `AccumulatedFrames` counts the presents this frame represents, so the
        // ones that never existed as separate frames are all but the first.
        // Saturating: a reset or wrapped counter must never wrap the total.
        self.coalesced_presents
            .fetch_add(accumulated_frames.saturating_sub(1) as u64, Ordering::Relaxed);
        // DXGI reports `LastPresentTime = 0` for a frame whose present it
        // cannot attribute, and the first stamp after such a frame is the
        // performance counter's value since boot — hundreds of millions of
        // ticks. One of those in the mean would swamp every real interval for
        // the rest of the session, so a gap beyond a second is dropped: a gap
        // that long is a stall rather than a refresh cadence, and the stall is
        // already visible as `acquire_timeouts`.
        let ceiling = qpc_hz() as i64;
        if let Some(delta) = present_delta_ticks
            && delta > 0
            && delta <= ceiling
        {
            self.present_delta_ticks
                .fetch_add(delta as u64, Ordering::Relaxed);
            self.present_samples.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Mean interval between the compositor's presents, in milliseconds, or
    /// `0.0` before two presents have been observed.
    ///
    /// This is the display's real cadence, reported by DXGI rather than
    /// inferred from how often the capture happened to poll — the measurement
    /// that tells a genuinely idle compositor apart from a capture that is
    /// dropping frames the compositor did produce.
    pub fn present_interval_ms(&self) -> f64 {
        let samples = self.present_samples.load(Ordering::Relaxed);
        if samples == 0 {
            return 0.0;
        }
        let ticks = self.present_delta_ticks.load(Ordering::Relaxed) as f64 / samples as f64;
        ticks * 1_000.0 / qpc_hz()
    }

    /// Read every counter once.
    pub fn snapshot(&self) -> CaptureStatsSnapshot {
        let load = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let total_nanos = load(&self.readback_nanos);
        CaptureStatsSnapshot {
            callbacks: load(&self.callbacks),
            pre_readback_drops: load(&self.pre_readback_drops),
            full_copies: load(&self.full_copies),
            partial_copies: load(&self.partial_copies),
            skipped_empty_damage: load(&self.skipped_empty_damage),
            readback_errors: load(&self.readback_errors),
            acquires: load(&self.acquires),
            mouse_only_frames: load(&self.mouse_only_frames),
            acquire_timeouts: load(&self.acquire_timeouts),
            pending_drops: load(&self.pending_drops),
            pending_depth_max: load(&self.pending_depth_max),
            duplicate_publishes: load(&self.duplicate_publishes),
            coalesced_presents: load(&self.coalesced_presents),
            present_interval_ms: self.present_interval_ms(),
            tick_overruns: load(&self.tick_overruns),
            slow_map_waits: load(&self.slow_map_waits),
            readback_total_ms: total_nanos as f64 / 1_000_000.0,
            readback_max_ms: load(&self.readback_max_nanos) as f64 / 1_000_000.0,
            readback_latency_mean_ms: self.readback_latency_mean_ms(),
            readback_latency_p95_ms: self.readback_latency_percentile_ms(0.95),
            readback_latency_max_ms: load(&self.readback_latency_max_nanos) as f64 / 1_000_000.0,
        }
    }

    /// Mean copy→map latency (the readback map's GPU wait) per published frame,
    /// in milliseconds.
    pub fn readback_latency_mean_ms(&self) -> f64 {
        let frames = self.callbacks.load(Ordering::Relaxed);
        if frames == 0 {
            return 0.0;
        }
        self.readback_latency_nanos.load(Ordering::Relaxed) as f64 / 1_000_000.0 / frames as f64
    }

    /// Copy→map latency at percentile `p` (0.0..=1.0), in milliseconds.
    #[allow(clippy::wrong_self_convention)]
    pub fn readback_latency_percentile_ms(&self, p: f64) -> f64 {
        percentile_ms_from(
            &self.readback_latency_buckets,
            READBACK_LATENCY_BUCKET_MICROS,
            p,
        )
    }

    /// Mean CPU time per published frame, in milliseconds (0 with no frames).
    pub fn readback_mean_ms(&self) -> f64 {
        let frames = self.callbacks.load(Ordering::Relaxed);
        if frames == 0 {
            return 0.0;
        }
        self.readback_nanos.load(Ordering::Relaxed) as f64 / 1_000_000.0 / frames as f64
    }

    /// Readback latency at percentile `p` (0.0..=1.0), in milliseconds. The
    /// histogram is bucketed at [`READBACK_BUCKET_MICROS`], so the result is the
    /// floor of the containing bucket.
    pub fn readback_percentile_ms(&self, p: f64) -> f64 {
        percentile_ms_from(&self.readback_buckets, READBACK_BUCKET_MICROS, p)
    }
}

/// Percentile from a bucket histogram: the lower bound of the containing
/// bucket, in milliseconds.
fn percentile_ms_from(buckets: &[AtomicU64; READBACK_BUCKETS], bucket_micros: u64, p: f64) -> f64 {
    let counts: Vec<u64> = buckets.iter().map(|b| b.load(Ordering::Relaxed)).collect();
    let total: u64 = counts.iter().sum();
    if total == 0 {
        return 0.0;
    }
    let target = ((p.clamp(0.0, 1.0) * total as f64).ceil() as u64).max(1);
    let mut seen = 0u64;
    for (i, count) in counts.iter().enumerate() {
        seen += count;
        if seen >= target {
            return (i as u64 * bucket_micros) as f64 / 1000.0;
        }
    }
    ((counts.len() as u64 - 1) * bucket_micros) as f64 / 1000.0
}

/// One captured frame as NV12 (`width * height * 3 / 2` bytes: a luma plane
/// followed by interleaved chroma). Capture converts on the GPU, so this is the
/// only pixel format that crosses the frame channel; every hardware encoder
/// accepts NV12 without a conversion filter.
///
/// The payload is behind an `Arc` so the feed thread can re-send the latest
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
    pub data: Arc<Vec<u8>>,
}

/// Bytes in one NV12 frame.
pub fn nv12_frame_bytes(width: u32, height: u32) -> usize {
    width as usize * height as usize * 3 / 2
}

/// A black NV12 frame. Limited-range black is luma 16 and neutral chroma 128,
/// not zero bytes, so the pre-capture seed is not a green flash before the
/// first real frame arrives.
pub fn nv12_black(width: u32, height: u32) -> Vec<u8> {
    let mut frame = vec![128u8; nv12_frame_bytes(width, height)];
    for y in frame[..width as usize * height as usize].iter_mut() {
        *y = 16;
    }
    frame
}

impl VideoFrame {
    pub fn new(pts: Duration, width: u32, height: u32, data: Vec<u8>) -> Self {
        debug_assert_eq!(data.len(), nv12_frame_bytes(width, height));
        VideoFrame {
            pts,
            width,
            height,
            data: Arc::new(data),
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

#[cfg(windows)]
pub mod nv12;

#[cfg(test)]
mod capture_stats_tests {
    use super::*;

    #[test]
    fn pending_queue_keeps_order_and_drops_the_oldest() {
        let mut latest = Latest::default();
        for i in 0..PENDING_FRAMES {
            let (dropped, depth) = latest.push(VideoFrame::new(
                Duration::from_millis(i as u64),
                2,
                2,
                vec![i as u8; 6],
            ));
            assert!(!dropped, "the queue holds {PENDING_FRAMES} frames before dropping");
            assert_eq!(depth, i + 1);
        }
        let (dropped, depth) = latest.push(VideoFrame::new(
            Duration::from_millis(999),
            2,
            2,
            vec![0u8; 6],
        ));
        assert!(dropped, "one past the bound drops the oldest");
        assert_eq!(depth, PENDING_FRAMES);
        // Oldest first, so a stretch the writer blocked through comes back out
        // as the frames that were captured rather than as the newest repeated.
        let first = latest.pop().expect("queued");
        assert_eq!(first.pts, Duration::from_millis(1));
    }

    #[test]
    fn readback_latency_is_measured_and_bucketed() {
        let stats = CaptureStats::default();
        assert_eq!(stats.readback_mean_ms(), 0.0, "no frames means no mean");
        assert_eq!(stats.readback_percentile_ms(0.95), 0.0);

        // Nine fast readbacks and one slow one: the mean and p99 must see both.
        for _ in 0..9 {
            stats.observe_readback(Duration::from_micros(200));
        }
        stats.observe_readback(Duration::from_micros(6_100));
        stats.callbacks.store(10, Ordering::Relaxed);

        let mean = stats.readback_mean_ms();
        assert!(
            (0.7..0.8).contains(&mean),
            "mean of 9x0.2ms + 1x6.1ms frames is ~0.79ms, got {mean}"
        );
        assert_eq!(stats.readback_max_nanos.load(Ordering::Relaxed), 6_100_000);
        assert_eq!(
            stats.readback_percentile_ms(0.5),
            0.0,
            "the median readback sits in the first bucket"
        );
        assert_eq!(
            stats.readback_percentile_ms(0.99),
            6.0,
            "p99 lands in the bucket containing the slow readback"
        );
        let snap = stats.snapshot();
        assert_eq!(snap.readback_max_ms, 6.1);
        assert!((snap.readback_total_ms - 7.9).abs() < 0.01);
    }

    #[test]
    fn counters_default_to_zero_and_are_independent() {
        let a = CaptureStats::default();
        let b = CaptureStats::default();
        a.acquires.fetch_add(3, Ordering::Relaxed);
        assert_eq!(a.snapshot().acquires, 3);
        assert_eq!(
            b.snapshot().acquires,
            0,
            "each stats block owns its counters"
        );
    }
}
