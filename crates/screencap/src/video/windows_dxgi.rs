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
//! dirty-region optimization for free); the shared FPS pacer turns that into
//! the configured fixed-rate stream by re-sending the latest frame.
//!
//! Capture runs on its own tick grid (one acquire per stream interval) rather
//! than spinning on `AcquireNextFrame` at whatever rate the compositor
//! produces: a 400 fps game would otherwise be handed to the duplication ~400
//! times a second, which is compositor work the stream never uses and costs the
//! game frames. Each tick submits exactly one staging copy and reads it back
//! before the tick ends, so every stream frame is a distinct desktop frame one
//! tick old (never a duplicate the pacer had to invent).
//!
//! The readback maps the staging texture once and lets the driver wait for the
//! copy: measured with `examples/readbacklat.rs`, that map costs p50 1.04 ms and
//! p95 1.33 ms for a 1080p frame (the live loop reports ~2.5 ms mean and 4 ms
//! p95, the difference being a desktop that keeps changing under it), against a
//! 16.7 ms tick at 60 fps. Probing it
//! non-blocking instead is strictly worse *and* misleading: `Map` reports
//! `WAS_STILL_DRAWING` until something asks for the data, so a probe deferred to
//! the next tick reads as ~31 ms of latency while the very same copy, waited on
//! in place, is ready in about a millisecond. The wait is recorded
//! (`CaptureStats::observe_map_wait`) rather than hidden, so a contended GPU
//! shows up as latency before it shows up as missing frames.
//!
//! Readbacks are skipped entirely when the duplication reports a negligible
//! changed area (a cursor- or clock-sized region): the previous pixels are
//! re-published, and a moved pointer is blended into them without touching the
//! GPU. The pacer keeps the stream cadence either way.

use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use tracing::info;
use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::{
    DXGI_OUTDUPL_POINTER_SHAPE_INFO, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR, IDXGIOutputDuplication,
};
use windows_capture::dxgi_duplication_api::{
    DxgiDuplicationApi, DxgiDuplicationFrame, Error as DxgiError,
};
use windows_capture::monitor::Monitor;

use crate::error::{CaptureError, RunError};
use crate::util::RateLimiter;
use crate::video::{
    CaptureStats, Latest, MonitorSpec, StopState, VideoBackend, VideoError, VideoFrame, VideoInfo,
    VideoSettings,
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

        // Pacer thread: shared fixed-rate re-sender (see `spawn_pacer`).
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

/// Rebuild the duplication after access is lost. DXGI allows only one
/// Desktop Duplication client per output, so access loss happens on mode
/// changes, fast user switch, the secure desktop (screen lock/UAC), or when
/// another app (OBS, Discord, a game overlay) takes over duplication. In all
/// of those cases recreation can transiently fail with `E_ACCESSDENIED`;
/// retry with a short backoff and fall back to a fresh open instead of
/// tearing down the whole capture on the first failure.
fn recreate_duplication(
    api: &mut Option<DxgiDuplicationApi>,
    monitor: &Monitor,
) -> Result<(), String> {
    const ATTEMPTS: usize = 6;
    let mut wait = Duration::from_millis(50);
    let mut last_err = String::new();

    for _ in 0..ATTEMPTS {
        // `recreate(self)` consumes the api and drops it on failure; a fresh
        // open is the fallback. `take` empties the slot first so the old
        // duplication interface is fully released before `DuplicateOutput`, in
        // case our own previous interface still holds the output.
        let rebuilt = match api.take() {
            Some(old) => match old.recreate() {
                Ok(new) => new,
                Err(e) => {
                    last_err = format!("recreate: {e:?}");
                    match DxgiDuplicationApi::new(*monitor) {
                        Ok(new) => new,
                        Err(e2) => {
                            last_err = format!("{last_err}; fresh open: {e2:?}");
                            thread::sleep(wait);
                            wait = wait.saturating_mul(2);
                            continue;
                        }
                    }
                }
            },
            None => match DxgiDuplicationApi::new(*monitor) {
                Ok(new) => new,
                Err(e) => {
                    last_err = format!("fresh open: {e:?}");
                    thread::sleep(wait);
                    wait = wait.saturating_mul(2);
                    continue;
                }
            },
        };
        *api = Some(rebuilt);
        return Ok(());
    }

    Err(last_err)
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
    // One acquire per stream interval: DXGI coalesces every compositor update
    // since the last release, so a tick never needs to poll faster than the
    // stream rate. The short timeout keeps the grid honest on a static desktop
    // (the pacer re-sends the previous frame).
    let acquire_timeout_ms = (interval.as_millis() as u64 / 4).clamp(1, 8) as u32;
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
        // descheduled thread) is skipped rather than bursted: the pacer owns
        // the stream cadence and duplicates the last frame instead.
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
        let should_recreate = {
            let Some(current) = api.as_mut() else {
                return Err("DXGI duplication unavailable".to_string());
            };
            match current.acquire_next_frame(acquire_timeout_ms) {
                Ok(frame) => {
                    stats.acquires.fetch_add(1, Ordering::Relaxed);
                    state.process(&frame, cursor, origin, &latest, &stats)?;
                    // The frame is released on the next acquire.
                    false
                }
                Err(DxgiError::Timeout) => {
                    // Desktop unchanged: nothing to read back, and the pacer
                    // re-sends the last frame for this tick.
                    stats.acquire_timeouts.fetch_add(1, Ordering::Relaxed);
                    false
                }
                Err(DxgiError::AccessLost) => true,
                Err(e) => {
                    return Err(format!("DXGI duplication error: {e:?}"));
                }
            }
        };
        if should_recreate {
            recreate_duplication(&mut api, &monitor)
                .map_err(|e| format!("DXGI duplication recreate failed: {e}"))?;
        }
        if limiter.should_emit() {
            let elapsed = last_log.elapsed().as_secs_f64().max(0.001);
            let delivered = (state.frames - last_log_frames) as f64 / elapsed;
            let snap = stats.snapshot();
            info!(
                delivered = format!("{delivered:.1}/s"),
                acquires = snap.acquires,
                acquire_timeouts = snap.acquire_timeouts,
                readbacks = snap.callbacks,
                dirty_skips = snap.dirty_skips,
                cursor_reuse = snap.cursor_reuse,
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

#[cfg(test)]
mod cursor_blend_tests {
    use super::*;

    fn shape_info(
        width: u32,
        height: u32,
        hot_x: i32,
        hot_y: i32,
    ) -> DXGI_OUTDUPL_POINTER_SHAPE_INFO {
        DXGI_OUTDUPL_POINTER_SHAPE_INFO {
            Type: DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 as u32,
            Width: width,
            Height: height,
            Pitch: width * 4,
            HotSpot: windows::Win32::Foundation::POINT { x: hot_x, y: hot_y },
        }
    }

    #[test]
    fn opaque_pixel_overwrites_frame() {
        // 1x1 opaque red cursor at (0,0); frame starts black.
        let mut frame = vec![0u8; 4];
        let shape = [0, 0, 255, 255]; // BGRA: red, alpha 255
        blend_cursor(&mut frame, 1, 1, &shape, shape_info(1, 1, 0, 0), 0, 0);
        assert_eq!(
            frame,
            [0, 0, 255, 255],
            "opaque cursor pixel replaces the frame (alpha copied)"
        );
    }

    #[test]
    fn transparent_pixel_skipped() {
        let mut frame = [100u8, 100, 100, 255];
        let shape = [0, 0, 255, 0]; // alpha 0
        blend_cursor(&mut frame, 1, 1, &shape, shape_info(1, 1, 0, 0), 0, 0);
        assert_eq!(
            frame,
            [100, 100, 100, 255],
            "alpha-0 pixels leave the frame untouched"
        );
    }

    #[test]
    fn half_alpha_blends() {
        // dst = 100, src = 200, alpha = 128 -> (200*128 + 100*127)/255 = 150
        let mut frame = [100u8, 100, 100, 255];
        let shape = [200, 200, 200, 128];
        blend_cursor(&mut frame, 1, 1, &shape, shape_info(1, 1, 0, 0), 0, 0);
        assert_eq!(frame[0], 150, "50% alpha blends toward the cursor color");
    }

    #[test]
    fn hotspot_and_clipping() {
        // 2x2 cursor with hotspot (0,0) drawn at start (10,10): the cursor's
        // bottom row falls outside an 11px-tall frame and must be clipped.
        let mut frame = vec![0u8; 2 * 2 * 4]; // 2x2 frame
        let shape = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 1, 1, 1, 255];
        blend_cursor(&mut frame, 2, 2, &shape, shape_info(2, 2, 0, 0), 0, 0);
        assert_eq!(frame[0..4], [255, 0, 0, 255], "top-left cursor pixel drawn");
        assert_eq!(
            frame[4..8],
            [0, 255, 0, 255],
            "top-right cursor pixel drawn"
        );
        assert_eq!(
            frame[8..12],
            [0, 0, 255, 255],
            "bottom-left cursor pixel drawn"
        );
        assert_eq!(
            frame[12..16],
            [1, 1, 1, 255],
            "in-frame pixel after the clipped row (opaque copy carries alpha)"
        );
    }

    #[test]
    fn malformed_shape_never_draws() {
        let mut frame = vec![42u8; 4];
        let mut info = shape_info(2, 2, 0, 0);
        info.Pitch = 4; // smaller than width*4
        blend_cursor(&mut frame, 1, 1, &[0u8; 16], info, 0, 0);
        assert_eq!(frame, vec![42u8; 4], "malformed pitch draws nothing");
    }
}

#[cfg(test)]
mod buffer_pool_tests {
    use super::*;

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

/// Fraction of the frame that must change for a tick to pay for a GPU→CPU
/// readback. Below it, the changed pixels are a cursor- or clock-sized region:
/// the previous pixels are re-published (with a freshly blended cursor) rather
/// than reading the whole desktop back for content that is visually identical.
const DIRTY_SKIP_FRACTION: f64 = 0.005;

/// Dirty rects inspected before the area heuristic gives up. A longer list is
/// certainly a large change, and skipping is only allowed when the changed area
/// is known to be small.
const MAX_DIRTY_RECTS: usize = 256;

/// A pointer position plus shape captured at acquire time, so a later tick can
/// composite it into the frame it belongs to.
struct CursorSample {
    x: i32,
    y: i32,
    shape: Vec<u8>,
    info: DXGI_OUTDUPL_POINTER_SHAPE_INFO,
}

/// The staging texture readbacks go through, plus the description it was
/// created with (rebuilt only when the duplication surface changes).
#[derive(Default)]
struct Slot {
    staging: Option<ID3D11Texture2D>,
    desc: Option<D3D11_TEXTURE2D_DESC>,
}

/// Everything the capture loop carries between ticks.
struct CaptureState {
    slot: Slot,
    /// Recycled CPU frame buffers, reused only while uniquely owned.
    pool: Vec<Arc<Vec<u8>>>,
    /// Pixels of the last published frame, for cursor-only reuse.
    last_pixels: Option<(Arc<Vec<u8>>, u32, u32)>,
    /// Pointer position in the last published frame.
    last_cursor_pos: Option<(i32, i32)>,
    /// Scratch buffers reused across ticks (dirty rects, pointer shape).
    rects: Vec<RECT>,
    shape: Vec<u8>,
    /// Frames published by this capture thread.
    frames: u64,
}

impl CaptureState {
    fn new() -> Self {
        CaptureState {
            slot: Slot::default(),
            pool: Vec::new(),
            last_pixels: None,
            last_cursor_pos: None,
            rects: vec![RECT::default(); MAX_DIRTY_RECTS],
            shape: Vec::new(),
            frames: 0,
        }
    }

    /// Publish a frame and keep its pixels for cursor-only reuse. The buffer is
    /// recycled through the pool: the published `Arc` keeps the pixels alive
    /// until the pacer releases them, so a pool entry is reused only when it is
    /// uniquely owned again.
    fn publish(
        &mut self,
        buffer: Arc<Vec<u8>>,
        width: u32,
        height: u32,
        cursor_pos: Option<(i32, i32)>,
        origin: Instant,
        latest: &Mutex<Latest>,
    ) {
        let pixels = buffer.clone();
        latest.lock().frame = Some(VideoFrame {
            pts: origin.elapsed(),
            width,
            height,
            bgra: pixels.clone(),
        });
        self.last_pixels = Some((pixels, width, height));
        self.last_cursor_pos = cursor_pos;
        if self.pool.len() < 4 {
            self.pool.push(buffer);
        }
        self.frames += 1;
    }

    /// Finish a readback: blend the frame's pointer sample in and publish the
    /// pixels to the pacer. `cpu` is the row-copy time the map already spent;
    /// the blend (the CPU work left) is measured here.
    #[allow(clippy::too_many_arguments)]
    fn publish_readback(
        &mut self,
        mut buffer: Arc<Vec<u8>>,
        width: u32,
        height: u32,
        cursor: bool,
        sample: Option<&CursorSample>,
        cpu: Duration,
        origin: Instant,
        latest: &Mutex<Latest>,
        stats: &CaptureStats,
    ) {
        let blend_started = Instant::now();
        let mut cursor_pos = None;
        if cursor {
            if let Some(sample) = sample {
                let data = Arc::get_mut(&mut buffer).expect("recycled buffer is uniquely owned");
                if blend_cursor(
                    data,
                    width,
                    height,
                    &sample.shape,
                    sample.info,
                    sample.x,
                    sample.y,
                ) {
                    stats.cursor_blends.fetch_add(1, Ordering::Relaxed);
                }
                cursor_pos = Some((sample.x, sample.y));
            }
        }
        stats.observe_readback(cpu.saturating_add(blend_started.elapsed()));
        stats.full_copies.fetch_add(1, Ordering::Relaxed);
        stats.callbacks.fetch_add(1, Ordering::Relaxed);
        self.publish(buffer, width, height, cursor_pos, origin, latest);
    }

    /// Read the staging texture back into a pooled CPU buffer, recording how
    /// long the map had to wait on the GPU copy.
    fn readback(
        staging: &ID3D11Texture2D,
        context: &ID3D11DeviceContext,
        pool: &mut Vec<Arc<Vec<u8>>>,
        width: u32,
        height: u32,
        stats: &CaptureStats,
    ) -> Result<(Arc<Vec<u8>>, Duration), String> {
        let (buffer, map_wait, cpu) = map_and_copy(staging, context, pool, width, height)?;
        stats.observe_map_wait(map_wait);
        Ok((buffer, cpu))
    }

    /// Handle one acquired frame: skip it, reuse the previous pixels with its
    /// cursor, or read it back and publish it before the tick ends.
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
        let fraction = dirty_area_fraction(frame.duplication(), width, height, &mut self.rects);
        // The pointer shape is only reported while the frame is held, so a
        // fresh readback would blend a stale one: sample it here.
        let sample = if cursor {
            fetch_cursor(frame, &mut self.shape)
        } else {
            None
        };
        let pointer_moved = sample
            .as_ref()
            .is_some_and(|c| Some((c.x, c.y)) != self.last_cursor_pos);
        if fraction.is_some_and(|f| f <= DIRTY_SKIP_FRACTION) {
            if pointer_moved {
                if let (Some((prev, w, h)), Some(sample)) = (self.last_pixels.clone(), sample) {
                    // Content unchanged and only the pointer moved: reuse the
                    // previous pixels with a fresh cursor — one CPU copy
                    // instead of a GPU→CPU readback of the whole desktop.
                    let mut buffer =
                        take_buffer_arc(&mut self.pool, (w as usize) * (h as usize) * 4);
                    if let Some(data) = Arc::get_mut(&mut buffer) {
                        data.copy_from_slice(prev.as_slice());
                        if blend_cursor(data, w, h, &sample.shape, sample.info, sample.x, sample.y)
                        {
                            stats.cursor_blends.fetch_add(1, Ordering::Relaxed);
                        }
                        stats.cursor_reuse.fetch_add(1, Ordering::Relaxed);
                        self.publish(buffer, w, h, Some((sample.x, sample.y)), origin, latest);
                    }
                    return Ok(());
                }
            }
            // A cursor- or clock-sized region changed: the pacer re-sends the
            // previous frame, so no readback is needed for this tick.
            stats.dirty_skips.fetch_add(1, Ordering::Relaxed);
            return Ok(());
        }
        ensure_staging(&mut self.slot, frame)?;
        let Some(staging) = self.slot.staging.clone() else {
            return Err("capture staging texture unavailable".to_string());
        };
        let context = frame.device_context();
        // SAFETY: the acquired frame is held, so its texture is valid, and the
        // staging texture is not mapped (a readback unmaps before it returns,
        // and copies never overlap because one readback finishes before the
        // next is queued).
        unsafe {
            context.CopyResource(&staging, frame.texture());
            // D3D11 batches commands until it has a reason to submit them, and
            // the map below is that reason (it waits for the copy either way);
            // flushing keeps the copy from sitting unsubmitted until the map
            // discovers it, which is the difference between a 1 ms readback and
            // a whole extra tick of latency (see `readbacklat`).
            context.Flush();
        }
        let (buffer, cpu) =
            Self::readback(&staging, context, &mut self.pool, width, height, stats)?;
        self.publish_readback(
            buffer,
            width,
            height,
            cursor,
            sample.as_ref(),
            cpu,
            origin,
            latest,
            stats,
        );
        Ok(())
    }
}

/// (Re)create the slot's staging texture when the duplication surface changes
/// size or format.
fn ensure_staging(slot: &mut Slot, frame: &DxgiDuplicationFrame<'_>) -> Result<(), String> {
    let desc = frame.texture_desc();
    let needs = slot.desc.as_ref().is_none_or(|d| {
        d.Width != desc.Width || d.Height != desc.Height || d.Format != desc.Format
    });
    if !needs {
        return Ok(());
    }
    let new_desc = D3D11_TEXTURE2D_DESC {
        Width: desc.Width,
        Height: desc.Height,
        MipLevels: 1,
        ArraySize: 1,
        Format: desc.Format,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
    };
    let mut tex = None;
    // SAFETY: the device belongs to the live duplication and `tex` receives the
    // newly created staging texture.
    if unsafe {
        frame
            .device()
            .CreateTexture2D(&new_desc, None, Some(&mut tex))
    }
    .is_err()
    {
        return Err("cannot create capture staging texture".to_string());
    }
    slot.staging = tex;
    slot.desc = Some(new_desc);
    Ok(())
}

/// Total changed area of the frame as a fraction of the frame, or `None` when
/// the duplication reports more rects than the scratch buffer holds (certainly
/// large) or the query fails. Callers may only skip a readback on a `Some` that
/// is small, never on `None`.
fn dirty_area_fraction(
    duplication: &IDXGIOutputDuplication,
    width: u32,
    height: u32,
    scratch: &mut [RECT],
) -> Option<f64> {
    if scratch.is_empty() {
        return None;
    }
    let bytes = (scratch.len() * std::mem::size_of::<RECT>()) as u32;
    let mut required = 0u32;
    // SAFETY: `scratch` is a live buffer of `bytes` bytes and the duplication
    // writes at most that many rects into it, reporting the needed size.
    if unsafe { duplication.GetFrameDirtyRects(bytes, scratch.as_mut_ptr(), &mut required) }
        .is_err()
    {
        return None;
    }
    let count = (required as usize / std::mem::size_of::<RECT>()).min(scratch.len());
    let mut area: u64 = 0;
    for rect in &scratch[..count] {
        let w = (rect.right - rect.left).max(0) as u64;
        let h = (rect.bottom - rect.top).max(0) as u64;
        area += w * h;
    }
    let frame_area = (width as u64).max(1) * (height as u64).max(1);
    Some((area as f64 / frame_area as f64).min(1.0))
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
    // `blend_cursor` bounds the shape by `Pitch * Height`; a shape whose pitch
    // cannot hold its own rows would read out of bounds, so reject it here.
    if shape_info.Pitch < shape_info.Width * 4 {
        return None;
    }
    Some(CursorSample {
        x: info.PointerPosition.Position.x - shape_info.HotSpot.x,
        y: info.PointerPosition.Position.y - shape_info.HotSpot.y,
        // Keep the whole buffer: `got` may report fewer bytes than requested,
        // and `blend_cursor` assumes `Pitch * Height` bytes are readable.
        shape: shape_buf.clone(),
        info: shape_info,
    })
}

/// Map the staging texture, waiting for the copy to complete, and copy its rows
/// into a pooled CPU buffer. Returns the buffer, the map's wait on the GPU and
/// the CPU time spent copying rows out.
fn map_and_copy(
    staging: &ID3D11Texture2D,
    context: &ID3D11DeviceContext,
    pool: &mut Vec<Arc<Vec<u8>>>,
    width: u32,
    height: u32,
) -> Result<(Arc<Vec<u8>>, Duration, Duration), String> {
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    let map_started = Instant::now();
    // SAFETY: `staging` is a live staging texture owned by the capture state and
    // is not mapped here; `mapped` receives the mapped description. The map
    // waits for the copy, which is the one wait in this path and is measured.
    let mapped_result = unsafe { context.Map(staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) };
    let map_wait = map_started.elapsed();
    if let Err(e) = mapped_result {
        return Err(format!("capture frame readback failed: {e}"));
    }
    let cpu_started = Instant::now();
    let len = width as usize * height as usize * 4;
    // The helper returns a uniquely-owned `Arc`, so the mapping is copied
    // straight into the published buffer (no per-frame full-frame clone).
    let mut buffer = take_buffer_arc(pool, len);
    let data = Arc::get_mut(&mut buffer).expect("recycled buffer is uniquely owned");
    // SAFETY: the mapping is valid until `Unmap`; `RowPitch` is at least the
    // packed row length and `pData` points at `RowPitch * height` bytes.
    unsafe {
        let row_pitch = mapped.RowPitch as usize;
        let row_len = width as usize * 4;
        let src = mapped.pData.cast::<u8>();
        if row_pitch == row_len {
            std::ptr::copy_nonoverlapping(src, data.as_mut_ptr(), len);
        } else {
            for y in 0..height as usize {
                std::ptr::copy_nonoverlapping(
                    src.add(y * row_pitch),
                    data.as_mut_ptr().add(y * row_len),
                    row_len,
                );
            }
        }
        context.Unmap(staging, 0);
    }
    Ok((buffer, map_wait, cpu_started.elapsed()))
}

/// Pure cursor-blend math: overlay an ARGB shape (BGRA byte order, `pitch`
/// row stride) onto a BGRA frame at `start_x`/`start_y` (top-left), clipped
/// to the frame. Alpha-blends partially transparent pixels. Returns whether
/// any pixel was drawn.
#[doc(hidden)]
pub fn blend_cursor(
    data: &mut [u8],
    width: u32,
    height: u32,
    shape: &[u8],
    shape_info: DXGI_OUTDUPL_POINTER_SHAPE_INFO,
    start_x: i32,
    start_y: i32,
) -> bool {
    let pitch = shape_info.Pitch as usize;
    let sw = shape_info.Width as usize;
    let sh = shape_info.Height as usize;
    if pitch < sw * 4 {
        return false; // malformed shape; never draw garbage
    }
    let row_len = width as usize * 4;
    let mut drew = false;
    for sy in 0..sh {
        let fy = start_y + sy as i32;
        if fy < 0 || fy >= height as i32 {
            continue;
        }
        for sx in 0..sw {
            let fx = start_x + sx as i32;
            if fx < 0 || fx >= width as i32 {
                continue;
            }
            let si = sy * pitch + sx * 4;
            let alpha = shape[si + 3] as u32;
            if alpha == 0 {
                continue;
            }
            let di = fy as usize * row_len + fx as usize * 4;
            if alpha == 255 {
                data[di..di + 4].copy_from_slice(&shape[si..si + 4]);
            } else {
                let blend = |dst: u32, src: u32| ((src * alpha + dst * (255 - alpha)) / 255) as u8;
                data[di] = blend(data[di] as u32, shape[si] as u32);
                data[di + 1] = blend(data[di + 1] as u32, shape[si + 1] as u32);
                data[di + 2] = blend(data[di + 2] as u32, shape[si + 2] as u32);
            }
            drew = true;
        }
    }
    drew
}
