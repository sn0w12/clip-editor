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
//! the configured fixed-rate stream by re-sending the latest frame. The
//! readback runs synchronously on the capture thread (the duplication surface
//! is reused on the next acquire, so each frame must be read before then);
//! the pacer and the bounded video channel keep the encoder path decoupled.
//! The readback is rate-limited to one read per stream interval: when the
//! desktop changes faster than the stream rate, excess frames are dropped
//! before readback (the pacer re-sends the latest).

use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use tracing::info;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_STAGING, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_SAMPLE_DESC;
use windows::Win32::Graphics::Dxgi::{
    DXGI_OUTDUPL_POINTER_SHAPE_INFO, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR,
};
use windows_capture::dxgi_duplication_api::{DxgiDuplicationApi, Error as DxgiError};
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
                    api,
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

fn run_capture(
    mut api: DxgiDuplicationApi,
    origin: Instant,
    interval: Duration,
    cursor: bool,
    latest: Arc<Mutex<Latest>>,
    stop: Arc<StopState>,
    stats: Arc<CaptureStats>,
    shutdown: Receiver<()>,
) -> Result<(), String> {
    let mut staging: Option<ID3D11Texture2D> = None;
    let mut staging_desc: Option<D3D11_TEXTURE2D_DESC> = None;
    let mut pool: Vec<Arc<Vec<u8>>> = Vec::new();
    let mut cursor_shape: Vec<u8> = Vec::new();
    let mut last_publish = origin;
    let mut limiter = RateLimiter::new(Duration::from_secs(5));
    let mut frames: u64 = 0;
    let mut last_log = Instant::now();
    let mut last_log_frames: u64 = 0;

    loop {
        if stop.requested.load(Ordering::SeqCst) {
            return Ok(());
        }
        if shutdown.try_recv().is_ok() {
            stop.requested.store(true, Ordering::SeqCst);
            return Ok(());
        }
        match api.acquire_next_frame(1000) {
            Ok(frame) => {
                let now = Instant::now();
                let should_read = now.duration_since(last_publish) >= interval;
                if should_read {
                    // Rate-limited readback: at most one read per stream
                    // interval; the pacer re-sends the latest between reads.
                    let w = frame.width() as usize;
                    let h = frame.height() as usize;
                    let len = w * h * 4;
                    // (Re)create the persistent staging texture when the
                    // duplication surface changes size or format.
                    let desc = frame.texture_desc();
                    let needs = staging_desc.as_ref().is_none_or(|d| {
                        d.Width != desc.Width || d.Height != desc.Height || d.Format != desc.Format
                    });
                    if needs {
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
                        if unsafe { frame.device().CreateTexture2D(&new_desc, None, Some(&mut tex)) }
                            .is_err()
                        {
                            return Err("cannot create capture staging texture".to_string());
                        }
                        staging = tex;
                        staging_desc = Some(new_desc);
                    }
                    let Some(staging_tex) = staging.clone() else {
                        return Err("capture staging texture unavailable".to_string());
                    };
                    let context = frame.device_context();
                    let mut buffer = take_buffer_arc(&mut pool, len);
                    // The helper returned a uniquely-owned Arc, so the
                    // readback writes the mapping in place (no per-frame
                    // full-frame copy).
                    let data = Arc::get_mut(&mut buffer)
                        .expect("recycled buffer is uniquely owned");
                    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
                    unsafe {
                        context.CopyResource(&staging_tex, frame.texture());
                        if context
                            .Map(&staging_tex, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                            .is_err()
                        {
                            return Err("capture frame readback failed".to_string());
                        }
                        let row_pitch = mapped.RowPitch as usize;
                        let row_len = w * 4;
                        let src = mapped.pData.cast::<u8>();
                        if row_pitch == row_len {
                            std::ptr::copy_nonoverlapping(src, data.as_mut_ptr(), len);
                        } else {
                            for y in 0..h {
                                std::ptr::copy_nonoverlapping(
                                    src.add(y * row_pitch),
                                    data.as_mut_ptr().add(y * row_len),
                                    row_len,
                                );
                            }
                        }
                        context.Unmap(&staging_tex, 0);
                    }
                    if cursor {
                        // Composite the system cursor into the frame: the
                        // duplication reports the pointer position and shape
                        // separately, so fetch the current shape and blend it
                        // in. Only color (ARGB) shapes are drawn; the rare
                        // monochrome/masked shapes are skipped.
                        if composite_cursor(&frame, w as u32, h as u32, data, &mut cursor_shape) {
                            stats.cursor_blends.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    // Publish a clone of the Arc (a refcount bump) and return
                    // the original to the pool; the pool entry is reused only
                    // after the pacer/latest releases the published clone.
                    let frame = VideoFrame {
                        pts: origin.elapsed(),
                        width: w as u32,
                        height: h as u32,
                        bgra: buffer.clone(),
                    };
                    if pool.len() < 4 {
                        pool.push(buffer);
                    }
                    let mut guard = latest.lock();
                    guard.frame = Some(frame);
                    last_publish = now;
                    stats.callbacks.fetch_add(1, Ordering::Relaxed);
                    stats.full_copies.fetch_add(1, Ordering::Relaxed);
                    frames += 1;
                } else {
                    // Desktop changes faster than the stream rate: drop the
                    // frame before readback (the pacer re-sends the latest).
                    stats.pre_readback_drops.fetch_add(1, Ordering::Relaxed);
                }
                // The frame is released on the next acquire.
            }
            Err(DxgiError::Timeout) => {
                // Desktop unchanged; the pacer re-sends the last frame.
            }
            Err(DxgiError::AccessLost) => {
                // Desktop layout or mode changed; recreate the duplication.
                let old = api;
                match old.recreate() {
                    Ok(api2) => api = api2,
                    Err(e) => {
                        return Err(format!("DXGI duplication recreate failed: {e:?}"));
                    }
                }
            }
            Err(e) => {
                return Err(format!("DXGI duplication error: {e:?}"));
            }
        }
        if limiter.should_emit() {
            let elapsed = last_log.elapsed().as_secs_f64().max(0.001);
            let rate = (frames - last_log_frames) as f64 / elapsed;
            info!(
                capture_rate = format!("{rate:.1}/s"),
                full_copies = stats.full_copies.load(Ordering::Relaxed),
                pre_readback_drops = stats.pre_readback_drops.load(Ordering::Relaxed),
                readback_errors = stats.readback_errors.load(Ordering::Relaxed),
                "capture readback"
            );
            last_log_frames = frames;
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

    fn shape_info(width: u32, height: u32, hot_x: i32, hot_y: i32) -> DXGI_OUTDUPL_POINTER_SHAPE_INFO {
        DXGI_OUTDUPL_POINTER_SHAPE_INFO {
            Type: DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 as u32,
            Width: width,
            Height: height,
            Pitch: width * 4,
            HotSpot: windows::Win32::Foundation::POINT {
                x: hot_x,
                y: hot_y,
            },
        }
    }

    #[test]
    fn opaque_pixel_overwrites_frame() {
        // 1x1 opaque red cursor at (0,0); frame starts black.
        let mut frame = vec![0u8; 4];
        let shape = [0, 0, 255, 255]; // BGRA: red, alpha 255
        blend_cursor(&mut frame, 1, 1, &shape, shape_info(1, 1, 0, 0), 0, 0);
        assert_eq!(frame, [0, 0, 255, 255], "opaque cursor pixel replaces the frame (alpha copied)");
    }

    #[test]
    fn transparent_pixel_skipped() {
        let mut frame = [100u8, 100, 100, 255];
        let shape = [0, 0, 255, 0]; // alpha 0
        blend_cursor(&mut frame, 1, 1, &shape, shape_info(1, 1, 0, 0), 0, 0);
        assert_eq!(frame, [100, 100, 100, 255], "alpha-0 pixels leave the frame untouched");
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
        assert_eq!(frame[4..8], [0, 255, 0, 255], "top-right cursor pixel drawn");
        assert_eq!(frame[8..12], [0, 0, 255, 255], "bottom-left cursor pixel drawn");
        assert_eq!(frame[12..16], [1, 1, 1, 255], "in-frame pixel after the clipped row (opaque copy carries alpha)");
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

/// Composite the DXGI pointer shape into a captured BGRA frame. The pointer
/// shape is fetched from the duplication (it is current while the frame is
/// held) and alpha-blended at the reported position. Only
/// `DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR` (32-bit ARGB) shapes are drawn;
/// monochrome/masked shapes are skipped (they are rare on modern Windows).
/// Returns whether any cursor pixel was actually composited.
fn composite_cursor(
    frame: &windows_capture::dxgi_duplication_api::DxgiDuplicationFrame<'_>,
    width: u32,
    height: u32,
    data: &mut [u8],
    shape_buf: &mut Vec<u8>,
) -> bool {
    let info = frame.frame_info();
    if info.PointerPosition.Visible.0 == 0 {
        return false;
    }
    let needed = info.PointerShapeBufferSize as usize;
    if needed == 0 {
        return false;
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
        return false;
    }
    let start_x = info.PointerPosition.Position.x - shape_info.HotSpot.x;
    let start_y = info.PointerPosition.Position.y - shape_info.HotSpot.y;
    blend_cursor(data, width, height, shape_buf, shape_info, start_x, start_y)
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
