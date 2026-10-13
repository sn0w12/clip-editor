//! DXGI Desktop Duplication capture producer (the default Windows backend).
//!
//! Why not Windows Graphics Capture: a WGC capture session forces the
//! software cursor on system-wide (see robmikh/Win32CaptureSample#34), which
//! routes every mouse update through the DWM compositor and causes cursor and
//! input lag everywhere — on the desktop, in every app, with no game running.
//! DXGI Desktop Duplication captures the composed desktop without that side
//! effect, which is why OBS-style recorders use it for display capture.
//!
//! The duplication delivers a frame only when the desktop changes (the
//! dirty-region optimization for free); the shared fixed-rate feed thread turns
//! that into the configured stream rate by re-sending the latest frame.
//!
//! Capture runs on its own tick grid, converting at most one frame per stream
//! interval, rather than converting at whatever rate the compositor produces: a
//! 400 fps game would otherwise be converted ~400 times a second, which is work
//! the stream never uses and costs the game frames.
//!
//! How long a tick may spend *waiting* is the delicate part, and it is not the
//! interval. `AcquireNextFrame` blocks until the compositor presents, which on
//! a 60 Hz display can be a full 16.7 ms — the entire budget of a 60 fps tick,
//! leaving nothing for the conversion and readback that must follow. A tick
//! that waits therefore overruns, the grid slips, and because a slipped tick
//! finds a frame waiting it recovers without ever counting the slip, the loop
//! settles quietly below its configured rate and the presents it can no longer
//! reach are folded into the frames it does get. Measured on a 60 fps stream
//! that was 51 polls/s with 2781 presents coalesced away per two minutes.
//!
//! So a tick waits only for what is left after reserving the readback, and
//! retries inside that budget instead of blocking through it. Every tick then
//! fits its period, the poll rate matches the configured rate, and the capture
//! reaches essentially every present the compositor makes — measured at the full
//! 60 polls/s with coalescing down ~20x. What remains as
//! `acquire_timeouts` is then truthful rather than alarming: it counts polls
//! that found nothing because the desktop genuinely did not change, which is
//! the expected reading whenever the stream rate exceeds the desktop's own
//! update rate. `coalesced_presents` is the counter that says whether presents
//! were missed, and it is the one to watch.
//!
//! The acquired texture is converted to NV12 on the GPU (see [`nv12`]) and read
//! back as `width * height * 3 / 2` bytes, so no BGRA frame is ever staged or
//! copied through CPU memory. The pointer is composited by the same pass before
//! the YUV matrix, and the two plane maps are where the driver is waited on —
//! recorded as `CaptureStats::observe_map_wait` rather than hidden, so a
//! contended GPU shows up as latency before it shows up as missing frames.
//!
//! A frame that carries only a pointer move is not published: the pointer is
//! composited separately, so such a frame is byte-identical to the previous
//! one, and a mouse reports far more often than the desktop updates. The feed
//! thread re-sends the last desktop image on a tick that publishes nothing, so
//! the only frames the stream repeats are the ones no tick had a new desktop
//! image for.

use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use tracing::{info, warn};
use windows::Win32::Graphics::Dxgi::{
    DXGI_OUTDUPL_FRAME_INFO, DXGI_OUTDUPL_POINTER_SHAPE_INFO, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR,
};
use windows_capture::dxgi_duplication_api::{
    DxgiDuplicationApi, DxgiDuplicationFrame, Error as DxgiError,
};
use windows_capture::monitor::Monitor;

use crate::error::{CaptureError, RunError};
use crate::util::RateLimiter;
use crate::video::nv12::{CursorUpload, Nv12Converter};
use crate::video::{
    CaptureStats, Latest, MonitorSpec, StopState, VideoBackend, VideoError, VideoFrame, VideoInfo,
    VideoSettings, VIDEO_QUEUE_CAPACITY, PENDING_FRAMES, nv12_frame_bytes,
};

pub struct WindowsDxgiVideoBackend {
    settings: VideoSettings,
    stats: Arc<CaptureStats>,
}

impl WindowsDxgiVideoBackend {
    /// Create the backend, validating that the configured monitor can be
    /// duplicated.
    pub fn new(settings: VideoSettings) -> Result<Box<dyn VideoBackend>, VideoError> {
        let monitor = Self::monitor(&settings.monitor)?;
        DxgiDuplicationApi::new(monitor).map_err(|e| {
            VideoError::Capture(format!("cannot open DXGI duplication for capture: {e:?}"))
        })?;
        Ok(Box::new(WindowsDxgiVideoBackend {
            settings,
            stats: Arc::new(CaptureStats::default()),
        }))
    }

    fn monitor(spec: &MonitorSpec) -> Result<Monitor, VideoError> {
        match spec {
            MonitorSpec::Primary => {
                Monitor::primary().map_err(|e| VideoError::Monitor(format!("primary monitor: {e}")))
            }
            MonitorSpec::Index(i) => Monitor::from_index(*i as usize)
                .map_err(|e| VideoError::Monitor(format!("index:{i} (one-based): {e}"))),
        }
    }
}

impl VideoBackend for WindowsDxgiVideoBackend {
    fn resolve(&self) -> Result<VideoInfo, VideoError> {
        let monitor = Self::monitor(&self.settings.monitor)?;
        let width = monitor
            .width()
            .map_err(|e| VideoError::Capture(format!("cannot read monitor width: {e}")))?;
        let height = monitor
            .height()
            .map_err(|e| VideoError::Capture(format!("cannot read monitor height: {e}")))?;
        Ok(VideoInfo {
            width,
            height,
            fps: self.settings.fps,
        })
    }

    fn spawn(
        self: Box<Self>,
        info: VideoInfo,
        origin: std::time::Instant,
        tx: Sender<VideoFrame>,
        rx: Receiver<VideoFrame>,
        err_tx: Sender<RunError>,
        shutdown: Receiver<()>,
    ) -> Result<(), VideoError> {
        let monitor = Self::monitor(&self.settings.monitor)?;
        let api = DxgiDuplicationApi::new(monitor)
            .map_err(|e| VideoError::Capture(format!("cannot open DXGI duplication: {e:?}")))?;

        let latest = Arc::new(Mutex::new(Latest::default()));
        let stop = Arc::new(StopState::default());

        // Feed thread: emits one frame per tick, re-sending the last one when
        // the desktop had nothing new (see `spawn_pacer`). It holds the only
        // clone of the caller's sender, so the segmenter's video channel
        // disconnects when it exits — which is how the writer learns to
        // finalize the open segment on shutdown.
        let pacer_done = Arc::new(AtomicBool::new(false));
        crate::video::spawn_pacer(
            info,
            origin,
            tx.clone(),
            rx.clone(),
            shutdown.clone(),
            latest.clone(),
            stop.clone(),
            pacer_done.clone(),
        )?;

        // Capture thread: acquire changed frames, read them into a pooled
        // BGRA buffer, publish to the pacer.
        let interval = Duration::from_micros(1_000_000 / info.fps as u64);
        let capture_done = pacer_done.clone();
        let capture_stop = stop.clone();
        let capture_latest = latest.clone();
        let capture_stats = self.stats.clone();
        let capture_err = err_tx.clone();
        let capture_shutdown = shutdown;
        let cursor = self.settings.cursor;
        thread::Builder::new()
            .name("video-capture".to_string())
            .spawn(move || {
                let result = run_capture(
                    Some(api),
                    monitor,
                    origin,
                    interval,
                    cursor,
                    capture_latest,
                    capture_stop,
                    capture_stats,
                    capture_shutdown,
                );
                if let Err(e) = result {
                    let _ = capture_err.send(RunError::Capture(CaptureError::Video(
                        VideoError::Capture(e),
                    )));
                }
                capture_done.store(true, Ordering::SeqCst);
            })
            .map_err(|e| VideoError::Capture(format!("cannot spawn capture thread: {e}")))?;

        Ok(())
    }

    fn stats(&self) -> Option<Arc<CaptureStats>> {
        Some(self.stats.clone())
    }
}

/// Result of [`recreate_duplication`]: the duplication is live again, or the
/// supervisor asked to stop while the rebuild was waiting.
enum Rebuild {
    Done,
    Shutdown,
}

/// Rebuild the duplication after access is lost. DXGI allows only one
/// Desktop Duplication client per output, so access loss happens on mode
/// changes, fast user switch, the secure desktop (screen lock/UAC), or when
/// another app (OBS, Discord, a game overlay) takes over duplication.
///
/// While the secure desktop is up, `DuplicateOutput` returns `E_ACCESSDENIED`
/// until LOCAL_SYSTEM hands the desktop back, which is the entire duration of
/// the lock or UAC prompt, minutes included. A bounded retry budget therefore
/// ends the capture on every screen lock, so the loop instead waits until the
/// rebuild succeeds or the supervisor stops it.
fn recreate_duplication(
    api: &mut Option<DxgiDuplicationApi>,
    monitor: &Monitor,
    stop: &StopState,
    shutdown: &Receiver<()>,
) -> Result<Rebuild, String> {
    const MAX_WAIT: Duration = Duration::from_millis(500);
    let mut wait = Duration::from_millis(50);
    let mut waiting = false;

    loop {
        if stop.requested.load(Ordering::SeqCst) {
            return Ok(Rebuild::Shutdown);
        }
        // `recreate(self)` consumes the api and drops it on failure; a fresh
        // open is the fallback. `take` empties the slot first so the old
        // duplication interface is fully released before `DuplicateOutput`, in
        // case our own previous interface still holds the output.
        let rebuilt = match api.take() {
            Some(old) => match old.recreate() {
                Ok(new) => Ok(new),
                Err(e) => DxgiDuplicationApi::new(*monitor)
                    .map_err(|e2| format!("recreate: {e:?}; fresh open: {e2:?}")),
            },
            None => DxgiDuplicationApi::new(*monitor).map_err(|e| format!("fresh open: {e:?}")),
        };

        match rebuilt {
            Ok(new) => {
                *api = Some(new);
                if waiting {
                    info!("DXGI duplication reacquired");
                }
                return Ok(Rebuild::Done);
            }
            Err(e) => {
                if !waiting {
                    waiting = true;
                    warn!(
                        error = %e,
                        "DXGI duplication unavailable; waiting for the desktop"
                    );
                }
            }
        }

        // Sleep on the shutdown channel rather than the clock, so a stop is
        // never delayed by a wait of up to `MAX_WAIT`.
        match shutdown.recv_timeout(wait) {
            Ok(()) | Err(RecvTimeoutError::Disconnected) => return Ok(Rebuild::Shutdown),
            Err(RecvTimeoutError::Timeout) => {}
        }
        wait = (wait * 2).min(MAX_WAIT);
    }
}

fn run_capture(
    mut api: Option<DxgiDuplicationApi>,
    monitor: Monitor,
    origin: Instant,
    interval: Duration,
    cursor: bool,
    latest: Arc<Mutex<Latest>>,
    stop: Arc<StopState>,
    stats: Arc<CaptureStats>,
    shutdown: Receiver<()>,
) -> Result<(), String> {
    let mut state = CaptureState::new();
    let mut limiter = RateLimiter::new(Duration::from_secs(5));
    let mut last_log = Instant::now();
    let mut last_log_frames: u64 = 0;
    // One acquire per stream tick: DXGI coalesces every compositor update
    // since the last release, so a tick never needs to poll faster than the
    // stream rate. What a tick *may* spend waiting is decided per attempt
    // below, from the budget the conversion and readback leave behind.
    let mut next_tick = origin;

    loop {
        if stop.requested.load(Ordering::SeqCst) {
            return Ok(());
        }
        if shutdown.try_recv().is_ok() {
            stop.requested.store(true, Ordering::SeqCst);
            return Ok(());
        }
        // 1. Wait for the next stream tick, interrupting for shutdown.
        let now = Instant::now();
        if now < next_tick {
            let wait = (next_tick - now).min(Duration::from_millis(50));
            let _ = shutdown.recv_timeout(wait);
            continue;
        }
        next_tick += interval;
        // A tick that started late (a long readback, a duplication rebuild, a
        // descheduled thread) is skipped rather than bursted: the feed thread
        // owns the stream cadence and duplicates the last frame instead.
        let now = Instant::now();
        if next_tick <= now {
            let behind = (now - next_tick).as_nanos();
            let missed = behind / interval.as_nanos().max(1);
            if missed > 0 {
                stats
                    .tick_overruns
                    .fetch_add(missed as u64, Ordering::Relaxed);
            }
            next_tick = now + interval;
        }
        // 2. Acquire at most one frame for this tick, read it back and publish
        //    it before the tick ends. The acquisition borrows `api`, so it is
        //    scoped to end before any recreation below.
        //
        //    The poll runs right up to the tick deadline, retrying for whatever
        //    is left after each attempt. That deadline is the whole budget:
        //    nothing is held back for the conversion.
        //
        //    Reserving readback time here is what silently halved the frame
        //    rate. `readback_p99_ms` settles around 10 ms, so a reserve capped
        //    at half the interval left the poll only ~8 ms of a 16.7 ms tick
        //    and the remaining ~8 ms became a blind window that no present was
        //    ever looked for. On a display presenting ~58 times a second that
        //    discarded roughly half the available frames — measured 37.8
        //    acquires/s from 58.2 presents/s — which is what made saved clips
        //    stutter even though the feed was delivering a clean 60 fps of
        //    mostly-duplicated frames.
        //
        //    A present missed because the poll stopped early is gone for good;
        //    the conversion running a few ms past the deadline is not, because
        //    the tick grid is absolute and simply resumes on the next
        //    iteration. `tick_overruns` records the difference.
        let tick_start = Instant::now();
        // The readback is charged against the poll window, so stopping at the
        // interval truncates it to `interval - readback` and loses any present
        // that landed in the gap; a tick that publishes nothing is a frame the
        // feed thread re-sends. Overrunning is the cheap direction — the grid is
        // absolute, so a long tick only makes the next one start late.
        let tick_budget = interval + interval / 2;
        let should_recreate = {
            let Some(current) = api.as_mut() else {
                return Err("DXGI duplication unavailable".to_string());
            };
            let mut recreate = false;
            loop {
                // Whatever is left of this tick's budget. A 1 ms floor keeps
                // the final attempt a cheap poll rather than an instant no-op,
                // so a tick that is already out of budget stops instead of
                // spinning.
                let left = tick_budget
                    .saturating_sub(tick_start.elapsed())
                    .max(Duration::from_millis(1));
                match current.acquire_next_frame(left.as_millis().clamp(1, 50) as u32) {
                    Ok(frame) => {
                        // A cursor move is a frame to DXGI but not a picture.
                        // With pointer compositing off, publishing it repeats
                        // the previous frame, and a mouse reports far more often
                        // than the desktop updates, so on a moving pointer most
                        // ticks would be repeats. Keep polling inside this
                        // tick's budget for a real update instead; a tick that
                        // finds none publishes nothing and the feed thread
                        // re-sends, which is what an unchanged desktop means.
                        if state.is_pointer_only(frame.frame_info()) {
                            stats.mouse_only_frames.fetch_add(1, Ordering::Relaxed);
                            if tick_start.elapsed() >= tick_budget {
                                break;
                            }
                            continue;
                        }
                        stats.acquires.fetch_add(1, Ordering::Relaxed);
                        state.observe_present(frame.frame_info(), &stats);
                        state.process(&frame, cursor, origin, &latest, &stats)?;
                        // The frame is released on the next acquire.
                        break;
                    }
                    Err(DxgiError::Timeout) => {
                        // Nothing new within this attempt's slice. Either the
                        // desktop is genuinely idle (the feed thread re-sends
                        // the last frame for this tick) or the present landed
                        // just after the slice expired, in which case the
                        // budget check below hands the rest of the tick to
                        // another attempt.
                        stats.acquire_timeouts.fetch_add(1, Ordering::Relaxed);
                        if tick_start.elapsed() >= tick_budget {
                            break;
                        }
                    }
                    Err(DxgiError::AccessLost) => {
                        recreate = true;
                        break;
                    }
                    Err(e) => {
                        return Err(format!("DXGI duplication error: {e:?}"));
                    }
                }
            }
            recreate
        };
        if should_recreate {
            // A rebuilt duplication restarts the compositor's present
            // sequence, so the next interval would span the gap and read as a
            // multi-second stall. The converter is not touched here: it
            // compares devices and is rebuilt inside `process` when they differ.
            state.reset_presents();
            match recreate_duplication(&mut api, &monitor, &stop, &shutdown) {
                Ok(Rebuild::Done) => {}
                Ok(Rebuild::Shutdown) => return Ok(()),
                Err(e) => return Err(format!("DXGI duplication recreate failed: {e}")),
            }
        }
        if limiter.should_emit() {
            let elapsed = last_log.elapsed().as_secs_f64().max(0.001);
            let delivered = (state.frames - last_log_frames) as f64 / elapsed;
            let snap = stats.snapshot();
            info!(
                delivered = format!("{delivered:.1}/s"),
                acquires = snap.acquires,
                mouse_only = snap.mouse_only_frames,
                acquire_timeouts = snap.acquire_timeouts,
                pending_drops = snap.pending_drops,
                pending_max = snap.pending_depth_max,
                duplicate_publishes = snap.duplicate_publishes,
                coalesced_presents = snap.coalesced_presents,
                present_every_ms = format!("{:.2}", snap.present_interval_ms),
                readbacks = snap.callbacks,
                slow_map_waits = snap.slow_map_waits,
                map_wait_p95_ms = format!("{:.2}", stats.readback_latency_percentile_ms(0.95)),
                tick_overruns = snap.tick_overruns,
                readback_cpu_mean_ms = format!("{:.2}", stats.readback_mean_ms()),
                readback_p99_ms = format!("{:.2}", stats.readback_percentile_ms(0.99)),
                "capture readback"
            );
            last_log_frames = state.frames;
            last_log = Instant::now();
        }
    }
}

/// Take a uniquely-owned writable buffer of at least `len` bytes from the
/// release pool, or allocate a fresh zeroed one. An entry is reused only
/// while no published frame still references it (`Arc::get_mut`); a
/// published Arc is never mutated. The pool stays bounded by the caller.
#[doc(hidden)]
pub fn take_buffer_arc(pool: &mut Vec<Arc<Vec<u8>>>, len: usize) -> Arc<Vec<u8>> {
    for i in (0..pool.len()).rev() {
        let mut arc = pool.swap_remove(i);
        if let Some(vec) = Arc::get_mut(&mut arc) {
            vec.resize(len, 0);
            return arc;
        }
        // Still referenced by a published frame; keep it for later reuse.
        pool.push(arc);
    }
    Arc::new(vec![0u8; len])
}

/// A pointer position plus shape captured at acquire time, so a later tick can
/// composite it into the frame it belongs to.
struct CursorSample {
    x: i32,
    y: i32,
    shape: Vec<u8>,
    info: DXGI_OUTDUPL_POINTER_SHAPE_INFO,
}

/// Everything the capture loop carries between ticks.
struct CaptureState {
    /// GPU converter, created on the first frame and rebuilt if the duplication
    /// hands out a different device or surface size.
    converter: Option<Nv12Converter>,
    /// Recycled CPU frame buffers, reused only while uniquely owned.
    pool: Vec<Arc<Vec<u8>>>,
    /// The most recent published frame, kept only to tell whether the next one
    /// is pixel-identical (see `CaptureStats::duplicate_publishes`).
    last_publish: Option<Arc<Vec<u8>>>,
    /// Scratch buffer reused across ticks (pointer shape).
    shape: Vec<u8>,
    /// `LastPresentTime` of the previously acquired frame, in QPC ticks, and
    /// whether one has been seen. Reset by `reset_presents` whenever the
    /// duplication is rebuilt, because a fresh duplication restarts the
    /// present sequence and a delta across that boundary would be meaningless.
    last_present_ticks: Option<i64>,
    /// Frames published by this capture thread.
    frames: u64,
}

impl CaptureState {
    fn new() -> Self {
        CaptureState {
            converter: None,
            pool: Vec::new(),
            last_publish: None,
            shape: Vec::new(),
            last_present_ticks: None,
            frames: 0,
        }
    }

    /// Forget the previous present stamp. Called after the duplication is
    /// recreated so the next measured interval spans one continuous session.
    fn reset_presents(&mut self) {
        self.last_present_ticks = None;
    }

    /// Whether this acquisition carried only a pointer move.
    ///
    /// A cursor move is a frame to DXGI but not a picture: it reports
    /// `AccumulatedFrames == 0` for one and leaves `LastPresentTime` where it
    /// was. Both signals must agree that the desktop image did not change, so a
    /// driver that reports either one loosely cannot turn every tick into a
    /// dropped frame. The first frame of a session, and the first after a
    /// duplication rebuild, compare against `None` and are never pointer-only.
    fn is_pointer_only(&self, info: &DXGI_OUTDUPL_FRAME_INFO) -> bool {
        info.AccumulatedFrames == 0 && self.last_present_ticks == Some(info.LastPresentTime)
    }

    /// Record what the compositor reported for this frame.
    ///
    /// `AccumulatedFrames` is how many presents DXGI folded into the frame it
    /// just handed us, and `LastPresentTime` is when the newest of them hit the
    /// screen. Together they separate the two causes of an acquire timeout,
    /// which are otherwise indistinguishable: presents being coalesced away
    /// means the compositor is producing frames this capture is dropping, while
    /// a stretched interval between stamps means the compositor itself slowed
    /// down. See [`crate::video::CaptureStats::coalesced_presents`].
    fn observe_present(&mut self, info: &DXGI_OUTDUPL_FRAME_INFO, stats: &CaptureStats) {
        let present = info.LastPresentTime;
        let delta = self
            .last_present_ticks
            .map(|previous| present.saturating_sub(previous))
            // A stamp that did not move forward is a compositor quirk, not a
            // zero-length interval; report no sample rather than poison the
            // mean with a zero.
            .filter(|d| *d > 0);
        self.last_present_ticks = Some(present);
        stats.observe_present(info.AccumulatedFrames, delta);
    }

    /// Publish a converted frame. The buffer is recycled through the pool: the
    /// published `Arc` keeps it alive until the pacer releases it, so a pool
    /// entry is reused only when it is uniquely owned again.
    fn publish(
        &mut self,
        buffer: Arc<Vec<u8>>,
        width: u32,
        height: u32,
        origin: Instant,
        latest: &Mutex<Latest>,
        stats: &CaptureStats,
    ) {
        // Compare against the previous publish: DXGI reports a present for a
        // recomposition of an unchanged image, and publishing that puts a frame
        // in the stream that repeats the one before it. The count is the
        // measurement that says whether the repeats in a clip come from here or
        // from the feed thread's re-sends.
        if let Some(previous) = self.last_publish.as_ref() {
            if previous.as_slice() == buffer.as_slice() {
                stats.duplicate_publishes.fetch_add(1, Ordering::Relaxed);
            }
        }
        self.last_publish = Some(buffer.clone());
        {
            let (dropped, depth) = latest.lock().push(VideoFrame {
                pts: origin.elapsed(),
                width,
                height,
                data: buffer.clone(),
            });
            if dropped {
                stats.pending_drops.fetch_add(1, Ordering::Relaxed);
            }
            stats
                .pending_depth_max
                .fetch_max(depth as u64, Ordering::Relaxed);
        }
        // One pooled buffer per frame that can be queued or in flight: the
        // pending queue, the writer's channel, and the conversion in progress.
        // A smaller pool makes every publish allocate and zero a fresh 3 MB
        // frame, which is pure cost once the queue can hold frames.
        if self.pool.len() < PENDING_FRAMES + VIDEO_QUEUE_CAPACITY + 2 {
            self.pool.push(buffer);
        }
        self.frames += 1;
    }

    /// Handle one frame the acquire loop accepted: convert it to NV12 on the
    /// GPU and publish it before the tick ends. The loop only reaches here for a
    /// frame that carries a desktop image update, so nothing published is a
    /// repeat of the previous image.
    fn process(
        &mut self,
        frame: &DxgiDuplicationFrame<'_>,
        cursor: bool,
        origin: Instant,
        latest: &Mutex<Latest>,
        stats: &CaptureStats,
    ) -> Result<(), String> {
        let width = frame.width();
        let height = frame.height();
        // The pointer shape is only reported while the frame is held, so it is
        // sampled here and composited by the conversion pass.
        let sample = if cursor {
            fetch_cursor(frame, &mut self.shape)
        } else {
            None
        };

        let device = frame.device();
        let context = frame.device_context();
        // The converter owns its objects on the duplication's device, so a
        // rebuilt duplication or a resized surface needs a fresh one.
        if !self
            .converter
            .as_ref()
            .is_some_and(|c| c.matches(device, width, height))
        {
            self.converter = Some(Nv12Converter::new(
                device,
                frame.texture_desc().Format,
                width,
                height,
            )?);
            info!(width, height, "capture NV12 conversion ready on the GPU");
        }
        let converter = self.converter.as_mut().expect("created just above");

        let len = nv12_frame_bytes(width, height);
        let mut buffer = take_buffer_arc(&mut self.pool, len);
        let data = Arc::get_mut(&mut buffer).expect("recycled buffer is uniquely owned");
        let upload = sample.as_ref().map(|s| CursorUpload {
            shape: &s.shape,
            pitch: s.info.Pitch,
            width: s.info.Width,
            height: s.info.Height,
            x: s.x,
            y: s.y,
        });
        // SAFETY: the acquired frame is held, so its texture is valid on this
        // context; the converter's targets are unmapped and no conversion is in
        // flight because one finishes before the next starts. The staging
        // textures are unmapped by `copy_plane` before it returns.
        let cpu =
            unsafe { converter.convert(context, frame.texture(), width, height, upload, data) }?;
        stats.observe_map_wait(cpu);
        stats.observe_readback(cpu);
        stats.full_copies.fetch_add(1, Ordering::Relaxed);
        stats.callbacks.fetch_add(1, Ordering::Relaxed);
        self.publish(buffer, width, height, origin, latest, stats);
        Ok(())
    }
}

/// Sample the pointer position and shape while the frame is held. Returns
/// `None` when the pointer is hidden or the shape is not a color bitmap
/// (monochrome/masked shapes are skipped: they are rare on modern Windows).
fn fetch_cursor(frame: &DxgiDuplicationFrame<'_>, shape_buf: &mut Vec<u8>) -> Option<CursorSample> {
    let info = frame.frame_info();
    if info.PointerPosition.Visible.0 == 0 {
        return None;
    }
    let needed = info.PointerShapeBufferSize as usize;
    if needed == 0 {
        return None;
    }
    shape_buf.resize(needed, 0);
    let mut shape_info = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
    let mut got = 0u32;
    // SAFETY: `shape_buf` is `needed` bytes long; the duplication fills at
    // most that many. Called while the frame is held, so the shape is valid.
    let hr = unsafe {
        frame.duplication().GetFramePointerShape(
            needed as u32,
            shape_buf.as_mut_ptr().cast(),
            &mut got,
            &mut shape_info,
        )
    };
    if hr.is_err() || shape_info.Type != DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 as u32 {
        return None;
    }
    // The conversion shader indexes the shape by `Pitch`, so a shape whose
    // pitch cannot hold its own rows would read out of bounds: reject it here.
    if shape_info.Pitch < shape_info.Width * 4 {
        return None;
    }
    Some(CursorSample {
        x: info.PointerPosition.Position.x - shape_info.HotSpot.x,
        y: info.PointerPosition.Position.y - shape_info.HotSpot.y,
        // Keep the whole buffer: `got` may report fewer bytes than requested,
        // and the upload reads `Pitch * Height` bytes.
        shape: shape_buf.clone(),
        info: shape_info,
    })
}

#[cfg(test)]
mod buffer_pool_tests {
    use super::*;

    #[test]
    fn pointer_only_requires_both_signals_to_agree() {
        let mut state = CaptureState::new();
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        // Nothing to compare the first frame of a session against, so it must
        // never be withheld.
        assert!(
            !state.is_pointer_only(&info),
            "the first frame is never pointer-only"
        );
        state.last_present_ticks = Some(1000);
        info.LastPresentTime = 1000;
        info.AccumulatedFrames = 0;
        assert!(
            state.is_pointer_only(&info),
            "an unchanged stamp with no accumulated frame is a pointer move"
        );
        info.AccumulatedFrames = 1;
        assert!(
            !state.is_pointer_only(&info),
            "an accumulated frame is a desktop update"
        );
        info.AccumulatedFrames = 0;
        info.LastPresentTime = 2000;
        assert!(
            !state.is_pointer_only(&info),
            "an advanced stamp is a desktop update"
        );
    }

    #[test]
    fn pool_reuses_uniquely_owned_buffer() {
        let mut pool: Vec<Arc<Vec<u8>>> = Vec::new();
        let mut buf = take_buffer_arc(&mut pool, 16);
        let ptr = Arc::as_ptr(&buf);
        pool.push(buf.clone());
        drop(buf); // only the pool reference remains
        let reused = take_buffer_arc(&mut pool, 16);
        assert_eq!(
            Arc::as_ptr(&reused),
            ptr,
            "uniquely-owned pooled Arc must be reused"
        );
        pool.push(reused);
    }

    #[test]
    fn pool_skips_published_buffer_and_allocates_fresh() {
        let mut pool: Vec<Arc<Vec<u8>>> = Vec::new();
        let buf = take_buffer_arc(&mut pool, 16);
        let ptr = Arc::as_ptr(&buf);
        pool.push(buf.clone());
        let published = buf.clone(); // a published frame still holds it
        drop(buf);
        let fresh = take_buffer_arc(&mut pool, 16);
        assert_ne!(
            Arc::as_ptr(&fresh),
            ptr,
            "a still-referenced Arc must never be reused or mutated"
        );
        // The skipped entry stays in the pool; the fresh buffer is returned
        // to the caller, which decides whether to pool it (bounded at 4).
        assert_eq!(pool.len(), 1, "the published entry remains pooled");
        assert!(fresh.iter().all(|&b| b == 0), "fresh allocation is zeroed");
        drop(published);
    }

    #[test]
    fn published_buffer_unchanged_after_next_acquisition() {
        let mut pool: Vec<Arc<Vec<u8>>> = Vec::new();
        let mut buf = take_buffer_arc(&mut pool, 16);
        {
            let data = Arc::get_mut(&mut buf).unwrap();
            data.fill(0xAB);
        }
        let published = buf.clone();
        pool.push(buf);
        let next = take_buffer_arc(&mut pool, 16);
        assert_eq!(
            published.as_slice(),
            &[0xAB; 16],
            "publishing must freeze the buffer content"
        );
        assert!(
            next.iter().all(|&b| b == 0),
            "a fresh buffer is zeroed, not recycled garbage"
        );
        drop(published);
    }

    #[test]
    fn resize_shrinks_reused_buffer_to_len() {
        let mut pool: Vec<Arc<Vec<u8>>> = Vec::new();
        let mut big = take_buffer_arc(&mut pool, 4096);
        {
            let data = Arc::get_mut(&mut big).unwrap();
            data.fill(0x7F);
        }
        pool.push(big);
        let mut small = take_buffer_arc(&mut pool, 16);
        assert_eq!(
            small.len(),
            16,
            "reused buffer is resized to the requested length"
        );
        // The readback copies exactly `len` bytes into the returned buffer,
        // so the stale prefix is fully overwritten and the tail beyond `len`
        // is truncated; verify the requested-length region is writable.
        let data = Arc::get_mut(&mut small).unwrap();
        data.copy_from_slice(&[0x11; 16]);
        assert_eq!(small.as_slice(), &[0x11; 16]);
    }
}
