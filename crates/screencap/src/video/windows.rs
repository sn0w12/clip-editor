//! Windows Graphics Capture producer: converts frames to BGRA in
//! `on_frame_arrived`, then an FPS pacer re-sends the latest frame at the
//! configured rate (duplicating it on static screens). Session closes and
//! frame-read failures are terminal errors.

use std::sync::atomic::{AtomicBool, Ordering};
use parking_lot::Mutex;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

use crate::error::{CaptureError, RunError};
use crate::util::{send_drop_oldest, RateLimiter};
use crate::video::{MonitorSpec, VideoBackend, VideoError, VideoFrame, VideoInfo, VideoSettings};

/// Latest frame shared between the capture thread and the pacer.
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

pub struct WindowsVideoBackend {
    settings: VideoSettings,
}

impl WindowsVideoBackend {
    pub fn new(settings: VideoSettings) -> Result<Box<dyn VideoBackend>, VideoError> {
        Ok(Box::new(WindowsVideoBackend { settings }))
    }

    fn monitor(&self) -> Result<Monitor, VideoError> {
        match &self.settings.monitor {
            MonitorSpec::Primary => {
                Monitor::primary().map_err(|e| VideoError::Monitor(format!("primary monitor: {e}")))
            }
            MonitorSpec::Index(i) => Monitor::from_index(*i as usize).map_err(|e| {
                VideoError::Monitor(format!("index:{i} (one-based): {e}"))
            }),
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
        Ok(VideoInfo { width, height, fps: self.settings.fps })
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
                        send_drop_oldest(&pacer_tx, &pacer_rx, frame.clone(), &mut limiter, "video");
                        last = Some(frame);
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
        };
        let settings = Settings::new(
            monitor,
            cursor,
            DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(interval),
            DirtyRegionSettings::Default,
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
                        let _ = watcher_err_tx.send(RunError::Capture(
                            CaptureError::Video(VideoError::Capture(format!(
                                "capture session ended with error: {e}"
                            ))),
                        ));
                    }
                }
            })
            .map_err(|e| VideoError::Capture(format!("cannot spawn watcher thread: {e}")))?;

        Ok(())
    }
}

/// Data moved into the capture thread via `Settings.flags`.
struct HandlerInit {
    err_tx: Sender<RunError>,
    shutdown: Receiver<()>,
    latest: Arc<Mutex<Latest>>,
    stop: Arc<StopState>,
    start: Instant,
}

struct CaptureHandler {
    err_tx: Sender<RunError>,
    shutdown: Receiver<()>,
    latest: Arc<Mutex<Latest>>,
    stop: Arc<StopState>,
    start: Instant,
    /// Frame buffers that can be reused once the pacer releases them. Reusing
    /// avoids a multi-MB allocation + copy on every captured frame, which is
    /// the dominant CPU cost of the capture thread at 60fps.
    pool: Vec<Arc<Vec<u8>>>,
    /// One CPU-readable staging texture, reused for every frame. Creating a
    /// fresh staging texture per frame (as the crate's `Frame::buffer` does)
    /// adds 60 GPU allocations a second that a game's threads compete with.
    staging: Option<ID3D11Texture2D>,
    staging_desc: Option<D3D11_TEXTURE2D_DESC>,
}

impl CaptureHandler {
    fn terminal(&mut self, message: String) {
        let _ = self
            .err_tx
            .send(RunError::Capture(CaptureError::Video(VideoError::Capture(message))));
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
}

impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = HandlerInit;
    type Error = VideoError;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(CaptureHandler {
            err_tx: ctx.flags.err_tx,
            shutdown: ctx.flags.shutdown,
            latest: ctx.flags.latest,
            stop: ctx.flags.stop,
            start: ctx.flags.start,
            pool: Vec::new(),
            staging: None,
            staging_desc: None,
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

        let width = frame.width();
        let height = frame.height();
        let frame_len = width as usize * height as usize * 4;

        // (Re)create the persistent staging texture when the capture geometry
        // or format changes; WGC delivers a fixed size, so this runs once.
        let src_desc = frame.desc();
        let needs_recreate = self.staging_desc.as_ref().is_none_or(|d| {
            d.Width != src_desc.Width || d.Height != src_desc.Height || d.Format != src_desc.Format
        });
        if needs_recreate {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: src_desc.Width,
                Height: src_desc.Height,
                MipLevels: 1,
                ArraySize: 1,
                Format: src_desc.Format,
                SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut tex = None;
            let device = frame.device();
            if unsafe { device.CreateTexture2D(&desc, None, Some(&mut tex)) }.is_err() {
                self.terminal("cannot create capture staging texture".to_string());
                capture_control.stop();
                return Ok(());
            }
            self.staging = tex;
            self.staging_desc = Some(desc);
        }
        let Some(staging) = self.staging.clone() else {
            self.terminal("capture staging texture unavailable".to_string());
            capture_control.stop();
            return Ok(());
        };

        // Copy the WGC frame into the reusable staging texture, then read it
        // straight into a pooled CPU buffer. Row pitch may be aligned beyond
        // `width * 4`, so rows are copied individually.
        let mut data = self.take_buffer(frame_len);
        let context = frame.device_context();
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            context.CopyResource(&staging, frame.as_raw_texture());
            if context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)).is_err() {
                self.terminal("capture frame readback failed".to_string());
                capture_control.stop();
                return Ok(());
            }
            let row_pitch = mapped.RowPitch as usize;
            let row_len = width as usize * 4;
            let src = mapped.pData.cast::<u8>();
            if row_pitch == row_len {
                // Contiguous rows: one memcpy instead of per-row copies.
                std::ptr::copy_nonoverlapping(src, data.as_mut_ptr(), frame_len);
            } else {
                for y in 0..height as usize {
                    std::ptr::copy_nonoverlapping(
                        src.add(y * row_pitch),
                        data.as_mut_ptr().add(y * row_len),
                        row_len,
                    );
                }
            }
            context.Unmap(&staging, 0);
        }

        let pts = self.start.elapsed();
        let frame = VideoFrame::new(pts, width, height, data);
        // Keep a reference in the pool so this buffer can be reused once the
        // pacer releases it; bound the pool so a stalled consumer cannot grow
        // it without limit.
        if self.pool.len() < 4 {
            self.pool.push(frame.bgra.clone());
        }
        let mut guard = self.latest.lock();
        guard.frame = Some(frame);
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if !self.stop.requested.load(Ordering::SeqCst) {
            self.terminal("capture session closed unexpectedly (display removed or access revoked)"
                .to_string());
        }
        Ok(())
    }
}
