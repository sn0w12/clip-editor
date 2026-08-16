//! Windows Graphics Capture producer: converts frames to BGRA in an
//! asynchronous readback worker (never in `on_frame_arrived`), then an FPS
//! pacer re-sends the latest frame at the configured rate (duplicating it on
//! static screens). Session closes and frame-read failures are terminal
//! errors.
//!
//! Input-lag design: the WGC callback only clones the source texture, queries
//! dirty regions, and enqueues a `ReadbackTask` into a three-slot channel.
//! A dedicated worker owns the immediate D3D context and performs the
//! GPU→CPU readback (full or dirty-region copies) off the capture thread, so
//! the callback never blocks a game's D3D work. When the queue is full the
//! oldest queued task is dropped rather than blocking the callback; a stale
//! frame is preferable to a blocked producer. Empty damage after a valid
//! frame is a no-copy task: the pacer keeps re-sending the latest frame at
//! the configured FPS without any readback work.

use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender, TrySendError};
use tracing::{info, warn};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BOX, D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, ID3D11Device, ID3D11DeviceContext,
    ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::d3d11::SendDirectX;
use windows_capture::frame::{DirtyRegion, Frame};
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

use crate::error::{CaptureError, RunError};
use crate::util::{RateLimiter, send_drop_oldest};
use crate::video::{
    CaptureStats, MonitorSpec, VideoBackend, VideoError, VideoFrame, VideoInfo, VideoSettings,
};

/// Latest frame shared between the readback worker and the pacer.
#[derive(Default)]
struct Latest {
    frame: Option<VideoFrame>,
}

/// Shared shutdown bookkeeping: the shutdown channel is consumed by whichever
/// thread notices it first, so a shared flag records that shutdown was
/// requested.
#[derive(Default)]
struct StopState {
    requested: AtomicBool,
}

/// Depth of the callback→readback-worker task queue. Three slots absorb the
/// capture burst (frames are delivered in bursts on some systems) while
/// keeping readback latency bounded; overflow drops the oldest queued task
/// instead of blocking the callback.
const READBACK_QUEUE_CAPACITY: usize = 3;

/// Staging ring depth: one CPU-readable staging texture per in-flight task.
const STAGING_SLOTS: usize = 3;

/// A frame handed from the WGC callback to the readback worker. The texture
/// is cloned (AddRef) so the frame pool can reuse its buffer while the worker
/// reads it; the worker is the only thread touching the immediate context.
struct ReadbackTask {
    texture: SendDirectX<ID3D11Texture2D>,
    width: u32,
    height: u32,
    /// `Some(regions)` when dirty regions were reported (possibly empty);
    /// `None` when the query failed or dirty regions are unsupported, in
    /// which case the worker must fall back to a full copy.
    dirty: Option<Vec<DirtyRegion>>,
    /// Supervisor-relative capture time; published as the frame's PTS (the
    /// pacer may re-stamp with its send time for the fixed-rate stream).
    captured_at: Duration,
}

pub struct WindowsVideoBackend {
    settings: VideoSettings,
    stats: Arc<CaptureStats>,
}

impl WindowsVideoBackend {
    pub fn new(settings: VideoSettings) -> Result<Box<dyn VideoBackend>, VideoError> {
        Ok(Box::new(WindowsVideoBackend {
            settings,
            stats: Arc::new(CaptureStats::default()),
        }))
    }

    fn monitor(&self) -> Result<Monitor, VideoError> {
        match &self.settings.monitor {
            MonitorSpec::Primary => {
                Monitor::primary().map_err(|e| VideoError::Monitor(format!("primary monitor: {e}")))
            }
            MonitorSpec::Index(i) => Monitor::from_index(*i as usize)
                .map_err(|e| VideoError::Monitor(format!("index:{i} (one-based): {e}"))),
        }
    }
}

impl VideoBackend for WindowsVideoBackend {
    fn resolve(&self) -> Result<VideoInfo, VideoError> {
        let monitor = self.monitor()?;
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
        let monitor = self.monitor()?;

        let cursor = if self.settings.cursor {
            CursorCaptureSettings::WithCursor
        } else {
            CursorCaptureSettings::WithoutCursor
        };
        let interval = Duration::from_micros(1_000_000 / info.fps as u64);

        // Dirty-region support decides the whole readback strategy: with
        // `ReportAndRender` the worker receives dirty rectangles (and the
        // frame texture keeps the changed content); without it every task is
        // a full copy. Query the capability up front so `GraphicsCaptureApi`
        // never rejects the session for an unsupported setting.
        let (dirty_settings, dirty_supported) =
            match GraphicsCaptureApi::is_dirty_region_supported() {
                Ok(true) => (DirtyRegionSettings::ReportAndRender, true),
                Ok(false) => (DirtyRegionSettings::Default, false),
                Err(e) => {
                    warn!(
                        error = %e,
                        "dirty-region capability query failed; falling back to full-frame copies"
                    );
                    (DirtyRegionSettings::Default, false)
                }
            };

        let latest = Arc::new(Mutex::new(Latest::default()));
        let stop = Arc::new(StopState::default());

        // Pacer thread: re-send the latest frame at the configured FPS.
        let pacer_done = Arc::new(AtomicBool::new(false));
        let pacer_shutdown = shutdown.clone();
        let pacer_tx = tx.clone();
        let pacer_rx = rx.clone();
        let pacer_stop = stop.clone();
        let pacer_latest = latest.clone();
        let pacer_done_join = pacer_done.clone();
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
                let mut last_drops_log = std::time::Instant::now();
                // The capture session can take many seconds to deliver its
                // first frame. If the pacer waits, the stream's t=0 lands
                // late and the rolling save (last N seconds of the stream)
                // ends up N seconds behind the wall clock. Seed the timeline
                // with a black frame at the origin instead: the stream starts
                // at the recorder start and the pre-capture gap is pruned
                // away with the buffer.
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
                        last_drops_log = std::time::Instant::now();
                    }
                }
            })
            .map_err(|e| VideoError::Capture(format!("cannot spawn pacer thread: {e}")))?;

        let flags = HandlerInit {
            err_tx: err_tx.clone(),
            shutdown,
            latest: latest.clone(),
            stop: stop.clone(),
            start: origin,
            stats: self.stats.clone(),
            dirty_supported,
            cursor: self.settings.cursor,
        };
        let settings = Settings::new(
            monitor,
            cursor,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(interval),
            dirty_settings,
            ColorFormat::Bgra8,
            flags,
        );

        let control = CaptureHandler::start_free_threaded(settings)
            .map_err(|e| VideoError::Capture(format!("failed to start capture: {e}")))?;

        // Watcher thread: block until the capture thread ends, then stop the
        // pacer. Hard errors from the capture loop are terminal; a clean stop
        // (shutdown or handler-initiated) is not re-reported here.
        let watcher_done = pacer_done.clone();
        let watcher_stop = stop.clone();
        let watcher_err_tx = err_tx.clone();
        thread::Builder::new()
            .name("video-watcher".to_string())
            .spawn(move || {
                let result = control.wait();
                watcher_done.store(true, Ordering::SeqCst);
                if let Err(e) = result {
                    if !watcher_stop.requested.load(Ordering::SeqCst) {
                        let _ = watcher_err_tx.send(RunError::Capture(CaptureError::Video(
                            VideoError::Capture(format!("capture session ended with error: {e}")),
                        )));
                    }
                }
            })
            .map_err(|e| VideoError::Capture(format!("cannot spawn watcher thread: {e}")))?;

        Ok(())
    }

    fn stats(&self) -> Option<Arc<CaptureStats>> {
        Some(self.stats.clone())
    }
}

/// Data moved into the capture thread via `Settings.flags`.
struct HandlerInit {
    err_tx: Sender<RunError>,
    shutdown: Receiver<()>,
    latest: Arc<Mutex<Latest>>,
    stop: Arc<StopState>,
    start: Instant,
    stats: Arc<CaptureStats>,
    dirty_supported: bool,
    cursor: bool,
}

struct CaptureHandler {
    err_tx: Sender<RunError>,
    shutdown: Receiver<()>,
    latest: Arc<Mutex<Latest>>,
    stop: Arc<StopState>,
    start: Instant,
    stats: Arc<CaptureStats>,
    /// Whether the capture session reports dirty regions (decided at spawn;
    /// `false` forces every task to a full copy).
    dirty_supported: bool,
    /// Whether cursor capture is on: cursor pixels can land outside the
    /// reported dirty rects, so non-empty damage always uses a full copy.
    cursor: bool,
    /// Callback→worker task queue (capacity [`READBACK_QUEUE_CAPACITY`]).
    task_tx: Sender<ReadbackTask>,
    /// Receiver clone the callback uses to drop the oldest queued task when
    /// the queue is full.
    task_rx: Receiver<ReadbackTask>,
    /// Readback worker, started on the first callback; joined when the
    /// handler drops so no D3D context or staging texture outlives the
    /// capture session.
    worker: Option<thread::JoinHandle<()>>,
    worker_started: bool,
}

impl CaptureHandler {
    fn terminal(&mut self, message: String) {
        let _ = self
            .err_tx
            .send(RunError::Capture(CaptureError::Video(VideoError::Capture(
                message,
            ))));
    }

    /// Start the readback worker with the capture's device/context (cloned
    /// from the first frame, at which point the capture session is live).
    /// The worker creates its staging ring from the first task's texture.
    fn start_worker(&mut self, frame: &Frame) {
        self.worker_started = true;
        let device = SendDirectX::new(frame.device().clone());
        let context = SendDirectX::new(frame.device_context().clone());
        let task_rx = self.task_rx.clone();
        let latest = self.latest.clone();
        let stop = self.stop.clone();
        let stats = self.stats.clone();
        let err_tx = self.err_tx.clone();
        let shutdown = self.shutdown.clone();
        let cursor = self.cursor;
        let handle = thread::Builder::new()
            .name("video-readback".to_string())
            .spawn(move || {
                ReadbackWorker {
                    device,
                    context,
                    staging: Vec::new(),
                    staging_desc: None,
                    slot: 0,
                    canvas: Vec::new(),
                    pool: Vec::new(),
                    task_rx,
                    latest,
                    stop,
                    stats,
                    err_tx,
                    shutdown,
                    cursor,
                    published: false,
                    limiter: RateLimiter::new(Duration::from_secs(5)),
                    last_log_callbacks: 0,
                    last_log_processed: 0,
                    last_log_at: std::time::Instant::now(),
                }
                .run();
            });
        match handle {
            Ok(handle) => self.worker = Some(handle),
            Err(e) => {
                self.terminal(format!("cannot spawn readback worker: {e}"));
                self.stop.requested.store(true, Ordering::SeqCst);
            }
        }
    }
}

/// The readback worker: the sole owner of the immediate D3D context. It
/// copies each task's texture into a persistent CPU-readable staging ring
/// (never a per-frame allocation), maps it, and copies the pixels into a
/// pooled BGRA buffer that the pacer re-sends.
struct ReadbackWorker {
    device: SendDirectX<ID3D11Device>,
    context: SendDirectX<ID3D11DeviceContext>,
    /// Ring of persistent full-size staging textures, one per in-flight
    /// task. Creating a fresh staging texture per frame (as the crate's
    /// `Frame::buffer` does) would add dozens of GPU allocations a second
    /// that a game's threads compete with.
    staging: Vec<ID3D11Texture2D>,
    staging_desc: Option<D3D11_TEXTURE2D_DESC>,
    slot: usize,
    /// Persistent full-frame canvas for partial copies: dirty rows are
    /// patched in place across tasks, then the publish copies the canvas into
    /// a pooled buffer. The canvas stays exclusively owned by this worker —
    /// the pacer pins the newest published buffer, so patching the published
    /// allocation in place would race its reads.
    canvas: Vec<u8>,
    /// Frame buffers that can be reused once the pacer releases them. Reusing
    /// avoids a multi-MB allocation + copy on every captured frame, which is
    /// the dominant CPU cost of the capture path at 60fps.
    pool: Vec<Arc<Vec<u8>>>,
    task_rx: Receiver<ReadbackTask>,
    latest: Arc<Mutex<Latest>>,
    stop: Arc<StopState>,
    stats: Arc<CaptureStats>,
    err_tx: Sender<RunError>,
    shutdown: Receiver<()>,
    cursor: bool,
    /// Whether at least one frame has been published (an empty-damage task is
    /// only skippable when there is a valid frame to keep re-sending).
    published: bool,
    limiter: RateLimiter,
    last_log_callbacks: u64,
    last_log_processed: u64,
    last_log_at: std::time::Instant,
}

/// What to do with a readback task.
enum CopyKind {
    /// Empty damage after a valid publish: no readback work at all.
    Skip,
    /// Full-frame `CopyResource` + readback.
    Full,
    /// `CopySubresourceRegion` per clipped dirty rectangle + row patch.
    Partial(Vec<DirtyRegion>),
}

impl ReadbackWorker {
    /// Rate-limited capture stats log: callback and worker rates plus the
    /// counters that prove less GPU/CPU readback work on static screens.
    /// `force` emits immediately (used on shutdown so a short run still shows
    /// its counters).
    fn log_stats(&mut self, processed: u64, force: bool) {
        if !force && !self.limiter.should_emit() {
            return;
        }
        let elapsed = self.last_log_at.elapsed().as_secs_f64().max(0.001);
        let callbacks = self.stats.callbacks.load(Ordering::Relaxed);
        let cb_rate = (callbacks - self.last_log_callbacks) as f64 / elapsed;
        let wk_rate = (processed - self.last_log_processed) as f64 / elapsed;
        info!(
            callback_rate = format!("{cb_rate:.1}/s"),
            worker_rate = format!("{wk_rate:.1}/s"),
            queued = self.task_rx.len(),
            callbacks = callbacks,
            pre_readback_drops = self.stats.pre_readback_drops.load(Ordering::Relaxed),
            full_copies = self.stats.full_copies.load(Ordering::Relaxed),
            partial_copies = self.stats.partial_copies.load(Ordering::Relaxed),
            skipped_empty_damage = self.stats.skipped_empty_damage.load(Ordering::Relaxed),
            readback_errors = self.stats.readback_errors.load(Ordering::Relaxed),
            "capture readback"
        );
        self.last_log_callbacks = callbacks;
        self.last_log_processed = processed;
        self.last_log_at = std::time::Instant::now();
    }

    fn run(mut self) {
        let mut processed: u64 = 0;
        loop {
            if self.stop.requested.load(Ordering::SeqCst) {
                break;
            }
            match self.task_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(task) => {
                    self.process(task);
                    processed += 1;
                }
                Err(RecvTimeoutError::Timeout) => {
                    // No frames while the producer lives (e.g. a static
                    // desktop): poll shutdown so a quiet screen cannot hold
                    // the capture open forever.
                    if self.shutdown.try_recv().is_ok() {
                        self.stop.requested.store(true, Ordering::SeqCst);
                        break;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    // The capture thread ended. A clean stop sets the shared
                    // flag first; an unexpected end is terminal.
                    if !self.stop.requested.load(Ordering::SeqCst) {
                        self.stop.requested.store(true, Ordering::SeqCst);
                        let _ = self.err_tx.send(RunError::Capture(CaptureError::Video(
                            VideoError::Capture(
                                "readback worker ended: capture producer disconnected".to_string(),
                            ),
                        )));
                    }
                    break;
                }
            }
            self.log_stats(processed, false);
        }
        // Final stats log so a short run still shows the counters.
        self.log_stats(processed, true);
    }

    fn process(&mut self, task: ReadbackTask) {
        if std::env::var("SCREENCAP_DBG_DIRTY").as_deref() == Ok("1")
            && let Some(regions) = &task.dirty
        {
            let total: u64 = regions
                .iter()
                .map(|r| (r.width.max(0) as u64) * (r.height.max(0) as u64))
                .sum();
            eprintln!(
                "DBG-DIRTY rects={} area={} frame={}x{}",
                regions.len(),
                total,
                task.width,
                task.height
            );
        }
        if let Err(e) = self.ensure_staging(&task) {
            self.fail(e);
            return;
        }
        let kind = self.classify(&task);
        match kind {
            CopyKind::Skip => {
                self.stats.skipped_empty_damage.fetch_add(1, Ordering::Relaxed);
            }
            CopyKind::Full => {
                if let Err(e) = self.full_copy(&task) {
                    self.fail(e);
                }
            }
            CopyKind::Partial(rects) => {
                if let Err(e) = self.partial_copy(&task, &rects) {
                    self.fail(e);
                }
            }
        }
    }

    fn classify(&self, task: &ReadbackTask) -> CopyKind {
        // The first task after startup or a geometry change is a full copy:
        // the canvas has no valid base and the staging ring is fresh.
        if !self.published {
            return CopyKind::Full;
        }
        match &task.dirty {
            // Query failed or dirty regions unsupported: full copy.
            None => CopyKind::Full,
            // Nothing changed since the last delivered frame; the pacer keeps
            // re-sending the last published frame at the configured FPS.
            Some(rects) if rects.is_empty() => CopyKind::Skip,
            Some(rects) => {
                if self.cursor {
                    // Cursor pixels are composited by the system and can land
                    // outside the reported dirty rects; a partial copy could
                    // silently omit them. Full copy whenever anything moved.
                    return CopyKind::Full;
                }
                match clip_rects(rects, task.width, task.height) {
                    Some((clipped, area))
                        if area * 2 < task.width as u64 * task.height as u64 =>
                    {
                        CopyKind::Partial(clipped)
                    }
                    // Malformed, clipped away, or ≥ half the frame: the
                    // partial path would copy nearly everything anyway.
                    _ => CopyKind::Full,
                }
            }
        }
    }

    /// Allocate (or recreate) the staging ring to match the task geometry.
    /// Returns `true` when the ring was (re)created, which forces a full copy
    /// of this task because the previous canvas and staging state are stale.
    fn ensure_staging(&mut self, task: &ReadbackTask) -> Result<bool, String> {
        let desc = self.staging_desc;
        let needs = desc.is_none_or(|d| d.Width != task.width || d.Height != task.height);
        if !needs {
            return Ok(false);
        }
        let mut src_desc = D3D11_TEXTURE2D_DESC::default();
        unsafe { task.texture.0.GetDesc(&mut src_desc) };
        let desc = D3D11_TEXTURE2D_DESC {
            Width: src_desc.Width,
            Height: src_desc.Height,
            MipLevels: 1,
            ArraySize: 1,
            Format: src_desc.Format,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut ring = Vec::with_capacity(STAGING_SLOTS);
        for _ in 0..STAGING_SLOTS {
            let mut tex = None;
            if unsafe { self.device.0.CreateTexture2D(&desc, None, Some(&mut tex)) }.is_err() {
                return Err("cannot create capture staging texture".to_string());
            }
            ring.push(tex.expect("texture filled on success"));
        }
        self.staging = ring;
        self.staging_desc = Some(desc);
        self.slot = 0;
        self.published = false; // canvas and staging state are stale
        Ok(true)
    }

    /// Next staging ring slot, wrapping around. Each slot's full cycle
    /// (Copy* → Map → Unmap) completes synchronously before the slot is
    /// reused, so no slot is ever mapped twice concurrently.
    fn next_slot(&mut self) -> Result<ID3D11Texture2D, String> {
        let slot = self
            .staging
            .get(self.slot)
            .cloned()
            .ok_or_else(|| "capture staging ring empty".to_string())?;
        self.slot = (self.slot + 1) % STAGING_SLOTS;
        Ok(slot)
    }

    /// Take a buffer of at least `len` bytes from the pool (reusing one the
    /// pacer has released), or allocate a fresh one.
    fn take_buffer(&mut self, len: usize) -> Vec<u8> {
        for i in (0..self.pool.len()).rev() {
            let arc = self.pool.swap_remove(i);
            match Arc::try_unwrap(arc) {
                Ok(mut vec) => {
                    vec.resize(len, 0);
                    return vec;
                }
                // Still referenced by the pacer; keep it pooled and try the
                // rest before falling back to an allocation.
                Err(arc) => self.pool.push(arc),
            }
        }
        vec![0u8; len]
    }

    /// Publish a frame: keep a reference in the pool so this buffer can be
    /// reused once the pacer releases it (bounded so a stalled consumer
    /// cannot grow the pool without limit), then hand it to the pacer.
    fn publish(&mut self, frame: VideoFrame) {
        self.published = true;
        if self.pool.len() < 4 {
            self.pool.push(frame.bgra.clone());
        }
        let mut guard = self.latest.lock();
        guard.frame = Some(frame);
    }

    fn fail(&mut self, message: String) {
        self.stats.readback_errors.fetch_add(1, Ordering::Relaxed);
        self.terminal(message);
        self.stop.requested.store(true, Ordering::SeqCst);
    }

    fn terminal(&mut self, message: String) {
        let _ = self
            .err_tx
            .send(RunError::Capture(CaptureError::Video(VideoError::Capture(
                message,
            ))));
    }

    /// Full-frame copy: `CopyResource` into the next staging slot, map it,
    /// copy every row into a pooled BGRA buffer. When cursor capture is off
    /// the canvas is refreshed so the next partial task has a valid base.
    fn full_copy(&mut self, task: &ReadbackTask) -> Result<(), String> {
        let staging = self.next_slot()?;
        let context = self.context.0.clone();
        let w = task.width as usize;
        let h = task.height as usize;
        let frame_bytes = w * h * 4;
        unsafe {
            context.CopyResource(&staging, &task.texture.0);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            if context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .is_err()
            {
                return Err("capture frame readback failed".to_string());
            }
            let row_pitch = mapped.RowPitch as usize;
            let row_len = w * 4;
            let src = mapped.pData.cast::<u8>();
            let mut data = self.take_buffer(frame_bytes);
            if row_pitch == row_len {
                // Contiguous rows: one memcpy instead of per-row copies.
                std::ptr::copy_nonoverlapping(src, data.as_mut_ptr(), frame_bytes);
            } else {
                for y in 0..h {
                    std::ptr::copy_nonoverlapping(
                        src.add(y * row_pitch),
                        data.as_mut_ptr().add(y * row_len),
                        row_len,
                    );
                }
            }
            context.Unmap(&staging, 0);
            if !self.cursor {
                // Refresh the partial canvas so a subsequent partial task has
                // the previous published content as its base.
                if self.canvas.len() != frame_bytes {
                    self.canvas = vec![0u8; frame_bytes];
                }
                self.canvas.copy_from_slice(&data);
            }
            let frame = VideoFrame::new(task.captured_at, task.width, task.height, data);
            self.publish(frame);
        }
        self.stats.full_copies.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Dirty-region copy: `CopySubresourceRegion` each clipped rectangle into
    /// the next staging slot, map it, and patch only the dirty rows into the
    /// persistent canvas before publishing. Used only with cursor capture
    /// disabled and damage below half the frame.
    fn partial_copy(&mut self, task: &ReadbackTask, rects: &[DirtyRegion]) -> Result<(), String> {
        let staging = self.next_slot()?;
        let context = self.context.0.clone();
        let w = task.width as usize;
        let h = task.height as usize;
        let frame_bytes = w * h * 4;
        unsafe {
            for r in rects {
                let left = r.x.max(0) as u32;
                let top = r.y.max(0) as u32;
                let right = (r.x.saturating_add(r.width)).min(task.width as i32) as u32;
                let bottom = (r.y.saturating_add(r.height)).min(task.height as i32) as u32;
                if right <= left || bottom <= top {
                    continue;
                }
                let box_ = D3D11_BOX {
                    left,
                    top,
                    right,
                    bottom,
                    front: 0,
                    back: 1,
                };
                context.CopySubresourceRegion(&staging, 0, left, top, 0, &task.texture.0, 0, Some(&box_));
            }
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            if context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .is_err()
            {
                return Err("capture frame readback failed".to_string());
            }
            if self.canvas.len() != frame_bytes {
                self.canvas = vec![0u8; frame_bytes];
            }
            let row_pitch = mapped.RowPitch as usize;
            let row_len = w * 4;
            let src = mapped.pData.cast::<u8>();
            for r in rects {
                let left = r.x.max(0) as usize;
                let top = r.y.max(0) as usize;
                let right = (r.x.saturating_add(r.width)).min(task.width as i32) as usize;
                let bottom = (r.y.saturating_add(r.height)).min(task.height as i32) as usize;
                if right <= left || bottom <= top {
                    continue;
                }
                for y in top..bottom {
                    std::ptr::copy_nonoverlapping(
                        src.add((y - top) * row_pitch + left * 4),
                        self.canvas.as_mut_ptr().add(y * row_len + left * 4),
                        (right - left) * 4,
                    );
                }
            }
            context.Unmap(&staging, 0);
            // Publish a copy of the canvas into a pooled buffer: the pacer
            // pins the newest published buffer, so the canvas itself must
            // stay exclusively owned by this worker.
            let mut data = self.take_buffer(frame_bytes);
            data.copy_from_slice(&self.canvas);
            let frame = VideoFrame::new(task.captured_at, task.width, task.height, data);
            self.publish(frame);
        }
        self.stats.partial_copies.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

/// Clip dirty rectangles to the frame bounds. Returns `None` when the list is
/// malformed (a non-positive extent) or when everything is clipped away — the
/// caller must fall back to a full copy so no partial frame is published as
/// complete. Otherwise returns the clipped rectangles and their total area
/// (used for the half-frame full-copy threshold).
fn clip_rects(rects: &[DirtyRegion], width: u32, height: u32) -> Option<(Vec<DirtyRegion>, u64)> {
    let mut clipped = Vec::with_capacity(rects.len());
    let mut area: u64 = 0;
    for r in rects {
        if r.width <= 0 || r.height <= 0 {
            return None;
        }
        let left = r.x.max(0);
        let top = r.y.max(0);
        let right = r.x.saturating_add(r.width).min(width as i32).max(left);
        let bottom = r.y.saturating_add(r.height).min(height as i32).max(top);
        if right <= left || bottom <= top {
            continue;
        }
        area += (right as u64 - left as u64) * (bottom as u64 - top as u64);
        clipped.push(DirtyRegion {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        });
    }
    if clipped.is_empty() {
        None
    } else {
        Some((clipped, area))
    }
}

impl Drop for CaptureHandler {
    fn drop(&mut self) {
        // Join the readback worker so no D3D context or staging texture
        // outlives the capture session. The worker never blocks (it only
        // receives with a timeout and sends on the bounded error channel),
        // so this cannot deadlock.
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
    }
}

impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = HandlerInit;
    type Error = VideoError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        let (task_tx, task_rx) = crossbeam_channel::bounded(READBACK_QUEUE_CAPACITY);
        Ok(CaptureHandler {
            err_tx: ctx.flags.err_tx,
            shutdown: ctx.flags.shutdown,
            latest: ctx.flags.latest,
            stop: ctx.flags.stop,
            start: ctx.flags.start,
            stats: ctx.flags.stats,
            dirty_supported: ctx.flags.dirty_supported,
            cursor: ctx.flags.cursor,
            task_tx,
            task_rx,
            worker: None,
            worker_started: false,
        })
    }
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.shutdown.try_recv().is_ok() {
            self.stop.requested.store(true, Ordering::SeqCst);
            capture_control.stop();
            return Ok(());
        }
        if self.stop.requested.load(Ordering::SeqCst) {
            capture_control.stop();
            return Ok(());
        }

        // Start the worker on the first callback: the capture session is live
        // by then, so the device/context clones are fully initialized.
        if !self.worker_started {
            self.start_worker(frame);
        }

        // Query dirty regions here (on the capture thread) so a failure is
        // cheap to fall back from; the worker only copies pixels.
        let dirty = if self.dirty_supported {
            match frame.dirty_regions() {
                Ok(regions) => Some(regions),
                Err(_) => {
                    self.stats.readback_errors.fetch_add(1, Ordering::Relaxed);
                    None // full copy
                }
            }
        } else {
            None // dirty regions unsupported: every task is a full copy
        };

        let task = ReadbackTask {
            texture: SendDirectX::new(frame.as_raw_texture().clone()),
            width: frame.width(),
            height: frame.height(),
            dirty,
            captured_at: self.start.elapsed(),
        };
        // Never wait for the worker: a full queue drops the oldest queued
        // task (its texture is already stale) and enqueues the newest.
        match self.task_tx.try_send(task) {
            Ok(()) => {}
            Err(TrySendError::Full(task)) => {
                let _ = self.task_rx.try_recv();
                self.stats.pre_readback_drops.fetch_add(1, Ordering::Relaxed);
                if self.task_tx.try_send(task).is_err() {
                    self.terminal("readback worker ended".to_string());
                    self.stop.requested.store(true, Ordering::SeqCst);
                    capture_control.stop();
                    return Ok(());
                }
            }
            Err(TrySendError::Disconnected(_)) => {
                if !self.stop.requested.load(Ordering::SeqCst) {
                    self.terminal("readback worker ended".to_string());
                    self.stop.requested.store(true, Ordering::SeqCst);
                }
                capture_control.stop();
                return Ok(());
            }
        }
        self.stats.callbacks.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if !self.stop.requested.load(Ordering::SeqCst) {
            // Terminal: the session ended without a shutdown request. Set the
            // shared flag so the worker's disconnect path does not double-
            // report, then publish the error.
            self.stop.requested.store(true, Ordering::SeqCst);
            self.terminal(
                "capture session closed unexpectedly (display removed or access revoked)"
                    .to_string(),
            );
        }
        Ok(())
    }
}
