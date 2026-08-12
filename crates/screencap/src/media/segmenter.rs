//! The rolling buffer: FFmpeg segments fed by a BGRA video pipe and one f32le
//! audio pipe per track, plus the shared segment store that indexes closed
//! segments from the FFmpeg segment list, prunes them, and hands snapshots to
//! saves. Closed segments are indexed only once their file size is stable
//! across two scans (the muxer still writes the tail of the segment it just
//! closed); the in-progress segment is tracked separately so saves can reach
//! the save moment instead of stopping at the last closed boundary.

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Write as _;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::thread;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crossbeam_channel::{Receiver, RecvTimeoutError, Sender};
use ffmpeg_sidecar::command::FfmpegCommand;
use ffmpeg_sidecar::event::{FfmpegEvent, LogLevel};
use parking_lot::Mutex;
use tracing::{debug, error, info};

use crate::audio::TrackAudioBlock;
use crate::config::{ResolvedTrack, VideoCodec};
use crate::error::{MediaError, RunError};
use crate::media::SegmentInfo;
use crate::util::{write_f32le, RateLimiter};
use crate::video::{VideoFrame, VideoInfo};

/// How often the segment list is rescanned and pruning runs.
const SCAN_INTERVAL: Duration = Duration::from_secs(1);
/// A frame/block must arrive at least this often or the pipeline is stalled.
const STALL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long shutdown waits for FFmpeg to finalize the open segment.
const FINISH_TIMEOUT: Duration = Duration::from_secs(15);

/// Full URL for a named pipe (`\\.\pipe\` prefix on Windows).
fn pipe_url(name: &str) -> String {
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\{name}")
    }
    #[cfg(not(windows))]
    {
        name.to_string()
    }
}

/// Everything the segmenter needs to start encoding.
pub struct SegmenterParams {
    pub ffmpeg: PathBuf,
    pub video: VideoInfo,
    pub sample_rate: u32,
    pub channels: u16,
    pub tracks: Vec<ResolvedTrack>,
    pub codec: VideoCodec,
    pub quality: u8,
    pub segment_seconds: u32,
    pub buffer_dir: PathBuf,
    pub keep: Duration,
}

struct StoreInner {
    buffer_dir: PathBuf,
    segments: VecDeque<SegmentInfo>,
    /// Files referenced by live save snapshots; pruning skips them.
    active: HashSet<PathBuf>,
    total: Duration,
    /// Size of each listed segment at the previous scan (stability check).
    sizes: HashMap<String, u64>,
    /// Segment names already seen in the FFmpeg segment list (closed).
    listed: HashSet<String>,
    /// Current in-progress (open) segment, included in saves so the clip
    /// reaches the save moment instead of stopping at the last closed one.
    open: Option<SegmentInfo>,
}

/// Shared rolling store. The segmenter thread records/prunes; saves take
/// snapshots that pin files until the save completes.
pub struct SegmentStore {
    inner: Mutex<StoreInner>,
}

/// RAII pin: files in a live snapshot cannot be pruned until it drops.
pub struct SegmentSnapshot {
    store: Arc<SegmentStore>,
    segments: Vec<SegmentInfo>,
    pinned: Vec<PathBuf>,
}

impl SegmentStore {
    pub fn new(buffer_dir: PathBuf) -> Self {
        SegmentStore {
            inner: Mutex::new(StoreInner {
                buffer_dir,
                segments: VecDeque::new(),
                active: HashSet::new(),
                total: Duration::ZERO,
                sizes: HashMap::new(),
                listed: HashSet::new(),
                open: None,
            }),
        }
    }

    /// Create the buffer directory and wipe any leftovers from a previous run
    /// so every run starts with a clean rolling directory.
    pub fn prepare(&self) -> Result<(), MediaError> {
        let inner = self.inner.lock();
        std::fs::create_dir_all(&inner.buffer_dir).map_err(|e| {
            MediaError::General(format!("cannot create buffer dir {}: {e}", inner.buffer_dir.display()))
        })?;
        if let Ok(entries) = std::fs::read_dir(&inner.buffer_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        Ok(())
    }

    /// Snapshot the closed segments in chronological order, pinning them so
    /// pruning cannot delete files a save is about to read. Requires an `Arc`
    /// so the snapshot can release its pin when dropped.
    ///
    /// Only closed segments are included. The in-progress segment is still
    /// being written by FFmpeg (its metadata is not flushed), so a concat save
    /// reading it would block or stall. Saves wait until a closed boundary
    /// reaches the request moment before snapshotting, so the newest frame is
    /// still the wall at save time.
    pub fn snapshot(self: &Arc<Self>) -> SegmentSnapshot {
        let mut inner = self.inner.lock();
        let segments: Vec<SegmentInfo> = inner.segments.iter().cloned().collect();
        let pinned: Vec<PathBuf> = segments.iter().map(|s| s.path.clone()).collect();
        for path in &pinned {
            inner.active.insert(path.clone());
        }
        SegmentSnapshot { store: self.clone(), segments, pinned }
    }

    /// Total closed-segment duration (seconds), for buffer-fill logging.
    pub fn available_seconds(&self) -> f64 {
        self.inner.lock().total.as_secs_f64()
    }

    /// The newest stream-time end among recorded segments (and the open one).
    /// Saves wait until this reaches the request moment so the clip's newest
    /// frame is the wall at save time, not a segment boundary early.
    pub fn newest_end_seconds(&self) -> f64 {
        let inner = self.inner.lock();
        inner
            .segments
            .back()
            .map(|s| s.stream_end)
            .or_else(|| inner.open.as_ref().map(|o| o.stream_end))
            .unwrap_or(0.0)
    }

    /// Record a closed segment (called by the segmenter thread).
    pub(crate) fn record(&self, segment: SegmentInfo) {
        let mut inner = self.inner.lock();
        inner.total += segment.duration;
        inner.segments.push_back(segment);
    }

    /// Update the in-progress segment (the newest listed file still growing).
    fn set_open(&self, segment: SegmentInfo) {
        let mut inner = self.inner.lock();
        inner.open = Some(segment);
    }

    /// Clear the in-progress marker once the segment closes.
    fn clear_open(&self) {
        let mut inner = self.inner.lock();
        inner.open = None;
    }

    /// Mark the size of a listed segment at the current scan.
    fn observe_size(&self, name: &str, size: u64) {
        let mut inner = self.inner.lock();
        inner.sizes.insert(name.to_string(), size);
    }

    fn is_listed(&self, name: &str) -> bool {
        let inner = self.inner.lock();
        inner.listed.contains(name)
    }

    fn mark_listed(&self, name: &str) {
        let mut inner = self.inner.lock();
        inner.listed.insert(name.to_string());
    }

    /// Delete the oldest segments that exceed `keep` and are not pinned by a
    /// live save snapshot.
    fn prune(&self, keep: Duration) {
        loop {
            let (oldest, over) = {
                let inner = self.inner.lock();
                let oldest = inner.segments.front().cloned();
                let over = inner.total > keep;
                (oldest, over)
            };
            let Some(segment) = oldest else { break };
            if !over {
                break;
            }
            let pinned = {
                let inner = self.inner.lock();
                inner.active.contains(&segment.path)
            };
            if pinned {
                break; // a save is reading it; retry after it releases
            }
            let _ = std::fs::remove_file(&segment.path);
            let mut inner = self.inner.lock();
            if let Some(front) = inner.segments.front()
                && front.name == segment.name
            {
                inner.segments.pop_front();
                inner.total = inner.total.saturating_sub(segment.duration);
                debug!(name = %segment.name, "pruned stale segment");
            }
        }
    }

    fn release(&self, paths: &[PathBuf]) {
        let mut inner = self.inner.lock();
        for p in paths {
            inner.active.remove(p);
        }
    }
}

impl SegmentSnapshot {
    /// The pinned segments in chronological order.
    pub fn segments(&self) -> &[SegmentInfo] {
        &self.segments
    }
}

impl Drop for SegmentSnapshot {
    fn drop(&mut self) {
        self.store.release(&self.pinned);
    }
}

#[cfg(windows)]
mod pipe {
    use std::io;

    use windows::Win32::Foundation::{CloseHandle, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE};
    use windows::Win32::Storage::FileSystem::{
        FlushFileBuffers, WriteFile, PIPE_ACCESS_OUTBOUND,
    };
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE,
    };

    /// A server-side named pipe the app writes and FFmpeg reads.
    pub struct PipeWriter {
        handle: HANDLE,
    }

    // The handle is owned; HANDLE is a raw pointer but transferring between
    // threads is safe because this wrapper serializes access.
    unsafe impl Send for PipeWriter {}

    impl PipeWriter {
        /// Create the pipe instance (`name` must include the `\\.\pipe\`
        /// prefix) with an `out_buffer_size`-byte server buffer. A buffer at
        /// least one frame/block big lets each write complete in one syscall
        /// instead of chunked round-trips. Blocks in `connect` until FFmpeg
        /// opens the client end.
        pub fn create(name: &str, out_buffer_size: u32) -> io::Result<Self> {
            let mut name_utf16: Vec<u16> = name.encode_utf16().collect();
            name_utf16.push(0);
            // SAFETY: `name_utf16` is null-terminated and outlives the call;
            // the returned handle is owned by this wrapper.
            let handle = unsafe {
                CreateNamedPipeW(
                    windows::core::PCWSTR(name_utf16.as_ptr()),
                    PIPE_ACCESS_OUTBOUND,
                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE,
                    1,
                    out_buffer_size,
                    out_buffer_size,
                    0,
                    None,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(io::Error::last_os_error());
            }
            Ok(PipeWriter { handle })
        }

        /// Wait for the FFmpeg client to open the pipe.
        pub fn connect(&mut self) -> io::Result<()> {
            // SAFETY: the handle is valid until this wrapper drops.
            match unsafe { ConnectNamedPipe(self.handle, None) } {
                Ok(()) => Ok(()),
                // A client may connect between CreateNamedPipeW and the first
                // ConnectNamedPipe call; that is a success, not an error.
                Err(e) if e.code() == windows::core::HRESULT::from_win32(ERROR_PIPE_CONNECTED.0) => {
                    Ok(())
                }
                Err(_) => Err(io::Error::last_os_error()),
            }
        }
    }

    impl io::Write for PipeWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            // SAFETY: `buf` lives for the call; the number of bytes written is
            // returned by the OS.
            unsafe {
                WriteFile(self.handle, Some(buf), None, None)
                    .map_err(|_| io::Error::last_os_error())?;
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            // SAFETY: the handle is valid until this wrapper drops.
            unsafe { FlushFileBuffers(self.handle) }.map_err(|_| io::Error::last_os_error())
        }
    }

    impl Drop for PipeWriter {
        fn drop(&mut self) {
            // SAFETY: the handle is valid and owned.
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

#[cfg(not(windows))]
mod pipe {
    use std::io;

    /// Placeholder for non-Windows builds: named pipes do not exist there.
    pub struct PipeWriter;

    impl PipeWriter {
        pub fn create(_name: &str, _out_buffer_size: u32) -> io::Result<Self> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "named pipes are Windows-only",
            ))
        }

        pub fn connect(&mut self) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "named pipes are Windows-only",
            ))
        }
    }

    impl io::Write for PipeWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "named pipes are Windows-only",
            ))
        }

        fn flush(&mut self) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "named pipes are Windows-only",
            ))
        }
    }
}

/// Channel-layout string for the silent placeholder track's `anullsrc`.
fn layout_for(channels: u16) -> &'static str {
    match channels {
        1 => "mono",
        _ => "stereo",
    }
}

/// Start the FFmpeg segmenter: create every pipe before FFmpeg starts (so its
/// input opens never race the writers), spawn it with the video and per-track
/// audio inputs, then run the video/track writer threads, the stderr monitor,
/// and the scan/prune loop. Returns a `Receiver` that resolves when the
/// segmenter has finished finalizing the current segment.
#[allow(clippy::too_many_arguments)]
pub fn spawn_segmenter(
    params: SegmenterParams,
    store: Arc<SegmentStore>,
    video_rx: Receiver<VideoFrame>,
    track_rxs: Vec<Receiver<TrackAudioBlock>>,
    shutdown: Receiver<()>,
    err_tx: Sender<RunError>,
) -> Result<Receiver<()>, MediaError> {
    // Unique pipe namespace per segmenter instance: two segmenters in the same
    // process (e.g. tests) or a pid reused after an earlier ffmpeg lingers
    // must not collide on `screencap_<pid>_video`.
    static PIPE_SEQ: AtomicU64 = AtomicU64::new(0);
    let name = format!(
        "screencap_{}_{}",
        std::process::id(),
        PIPE_SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let video_url = pipe_url(&format!("{name}_video"));
    let pipe_names: Vec<String> = (0..params.tracks.len())
        .map(|i| format!("{name}_t{i}"))
        .collect();
    let pipe_urls: Vec<String> = pipe_names.iter().map(|n| pipe_url(n)).collect();

    // Create every pipe instance before FFmpeg starts so its input opens
    // never race the writers.
    let video_frame_bytes = params.video.width as usize * params.video.height as usize * 4;
    let video_pipe = pipe::PipeWriter::create(&video_url, (video_frame_bytes + 256 * 1024) as u32)
        .map_err(|e| MediaError::General(format!("cannot create video pipe {video_url}: {e}")))?;
    let track_pipes: Vec<pipe::PipeWriter> = pipe_urls
        .iter()
        .map(|url| pipe::PipeWriter::create(url, 256 * 1024))
        .collect::<Result<_, _>>()
        .map_err(|e| MediaError::General(format!("cannot create track pipe: {e}")))?;

    let mut cmd = FfmpegCommand::new_with_path(&params.ffmpeg);
    cmd.args([
        "-hide_banner",
        "-loglevel",
        "warning",
        "-y",
        // Flush each output packet instead of buffering it in the muxer. The
        // segment muxer otherwise batches file data (and the segment list),
        // so segment files can sit at zero bytes long after they should be
        // closed — which stalls saves and can lose the newest frames on exit.
        "-flush_packets",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgra",
        "-video_size",
        &format!("{}x{}", params.video.width, params.video.height),
        "-framerate",
        &params.video.fps.to_string(),
        // Read the pipes at native rate: the producers (capture, mixer) pace
        // the inputs themselves. `-re` on a raw-audio pipe is destructive: its
        // pacing cannot service 1024-byte packets (one every ~2.7ms), the input
        // thread falls seconds behind and the whole pipeline stalls.
        "-i",
        &video_url,
    ]);

    // Expand the configured tracks with silent placeholder tracks for any
    // missing numbers (e.g. tracks 1,2,3,5 get a silent track 4) so the dense
    // stream order in the file matches the configured track numbers instead
    // of renumbering track 5 down to 4.
    let max_number = params.tracks.iter().map(|t| t.number).max().unwrap_or(0);
    let slot_for = |number: u16| -> Option<usize> {
        params.tracks.iter().position(|t| t.number == number)
    };
    let slots: Vec<u16> = (1..=max_number).collect();
    for number in &slots {
        match slot_for(*number) {
            Some(track_idx) => {
                let url = &pipe_urls[track_idx];
                cmd.args([
                    "-f",
                    "f32le",
                    "-ar",
                    &params.sample_rate.to_string(),
                    "-ac",
                    &params.channels.to_string(),
                    "-i",
                    url,
                ]);
            }
            None => {
                // Silent placeholder: anullsrc generates the track's silence.
                let layout = layout_for(params.channels);
                let anull = format!("anullsrc=channel_layout={layout}:sample_rate={}", params.sample_rate);
                cmd.args(["-f", "lavfi", "-i", &anull]);
            }
        }
    }
    cmd.arg("-map").arg("0:v");
    for input_index in 1..=slots.len() {
        cmd.arg("-map").arg(format!("{input_index}:a"));
    }
    cmd.arg("-c:v").arg(params.codec.ffmpeg_name());
    // The segment muxer can only cut at keyframes. `-force_key_frames` is
    // honored by x264 but NOT by NVENC, so set the encoder GOP instead:
    // one IDR every `fps * segment_seconds` frames keeps `-segment_time`
    // exact for both encoders.
    let gop = (params.video.fps as u64 * params.segment_seconds as u64) as u32;
    cmd.arg("-g").arg(gop.to_string());
    match params.codec {
        VideoCodec::LibX264 => {
            // Cap frame threads: x264 auto-threading on many-core CPUs is
            // counterproductive for 1080p.
            cmd.arg("-threads").arg("4");
            cmd.arg("-preset").arg("veryfast");
            cmd.arg("-crf").arg(params.quality.to_string());
        }
        VideoCodec::H264Nvenc => {
            // `p1` is the fastest NVENC preset: the dedicated encoder silicon
            // does the work, so the slower presets only add rate-control
            // tuning cost (and a hair of GPU scheduling pressure) without any
            // benefit for a rolling 60fps buffer.
            cmd.arg("-preset").arg("p1");
            cmd.arg("-cq").arg(params.quality.to_string());
        }
        VideoCodec::H264Amf => {
            // Constant-QP rate control; AMF accepts BGRA input directly.
            cmd.arg("-rc").arg("cqp");
            cmd.arg("-qp_i").arg(params.quality.to_string());
            cmd.arg("-qp_p").arg(params.quality.to_string());
        }
        VideoCodec::H264Qsv => {
            // QSV accepts only NV12, so FFmpeg converts BGRA->NV12 with
            // swscale; the hardware encode still beats a full software encode.
            // Constant quality via `-global_quality` (0..=51 QP scale).
            cmd.arg("-preset").arg("veryfast");
            cmd.arg("-global_quality").arg(params.quality.to_string());
        }
        VideoCodec::Auto => {
            return Err(MediaError::General(
                "auto codec must be resolved before the segmenter starts".to_string(),
            ));
        }
    }
    cmd.arg("-c:a").arg("aac").arg("-b:a").arg("192k");
    // Stop when the live inputs end: if the app dies, the pipes EOF and
    // ffmpeg must exit (with an endless anullsrc placeholder it would spin
    // forever otherwise). During a normal run the pipes never EOF.
    //
    // `-shortest` alone buffers output packets while it decides when the
    // shortest stream ends, which starves the segment muxer's interleave and
    // freezes the whole pipeline (segment files sit at zero bytes).
    // `-shortest_buf_duration 0` keeps the early-exit behavior without the
    // buffering.
    cmd.arg("-shortest");
    cmd.args(["-shortest_buf_duration", "0"]);
    for (slot_idx, number) in slots.iter().enumerate() {
        let (title, track_number) = match slot_for(*number) {
            Some(track_idx) => (params.tracks[track_idx].name.clone(), *number),
            None => ("silent".to_string(), *number),
        };
        cmd.args([
            &format!("-metadata:s:a:{slot_idx}"),
            &format!("title={title}"),
            &format!("-metadata:s:a:{slot_idx}"),
            &format!("screencap_track={track_number}"),
        ]);
    }
    let segments_txt = params.buffer_dir.join("segments.txt");
    cmd.args([
        "-f",
        "segment",
        // The muxer's interleave logic waits for every stream to have a
        // buffered packet before writing. The audio demuxer delivers rare,
        // large packets, so with the default delta the muxer holds video (and
        // blocks the encoder, throttling the whole pipeline to a fraction of
        // real-time). Zero disables the wait: packets are written as soon as
        // they are produced, so segment files fill continuously.
        "-max_interleave_delta",
        "0",
        "-segment_time",
        &params.segment_seconds.to_string(),
        "-reset_timestamps",
        "1",
        // Mirror the option into the per-segment mkv muxer (which wraps each
        // segment's container).
        "-segment_format_options",
        "max_interleave_delta=0",
        "-segment_list_type",
        "csv",
        "-segment_list",
        segments_txt.to_str().unwrap_or("segments.txt"),
    ]);
    let pattern = params.buffer_dir.join("segment_%05d.mkv");
    cmd.arg(
        pattern
            .to_str()
            .ok_or_else(|| MediaError::General("buffer path is not UTF-8".to_string()))?,
    );
    cmd.create_no_window();

    let mut child = cmd
        .spawn()
        .map_err(|e| MediaError::Ffmpeg(format!("cannot start ffmpeg: {e}")))?;
    let stdin = child
        .take_stdin()
        .ok_or_else(|| MediaError::Ffmpeg("ffmpeg stdin unavailable".to_string()))?;

    let shutdown_flag = Arc::new(AtomicBool::new(false));

    // Video writer: connects the video pipe (one write per frame), drains
    // frames; on shutdown writes `q` to ffmpeg stdin so it finalizes the
    // current segment (stdin is no longer an input, so ffmpeg reads commands).
    let writer_shutdown = shutdown.clone();
    let writer_flag = shutdown_flag.clone();
    let writer_err = err_tx.clone();
    thread::Builder::new()
        .name("segmenter-video".to_string())
        .spawn(move || {
            let mut writer = video_pipe;
            if let Err(e) = writer.connect() {
                let _ = writer_err.send(RunError::media(format!(
                    "ffmpeg never opened video pipe: {e}"
                )));
                return;
            }
            let mut stdin = stdin;
            let mut last_write = std::time::Instant::now();
            loop {
                match video_rx.recv_timeout(Duration::from_millis(250)) {
                    Ok(frame) => {
                        if writer.write_all(&frame.bgra).is_err() {
                            break; // ffmpeg closed the pipe; monitor reports exit
                        }
                        last_write = std::time::Instant::now();
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if writer_shutdown.try_recv().is_ok() {
                            let _ = stdin.write_all(b"q");
                            let _ = stdin.flush();
                            break;
                        }
                        if last_write.elapsed() > STALL_TIMEOUT && !writer_flag.load(Ordering::SeqCst) {
                            let _ = writer_err.send(RunError::media(
                                "media pipeline stalled: no video frames for several seconds",
                            ));
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        // The producer ended. During a deliberate shutdown the
                        // "q" signal is sent the same way, so only treat a
                        // disconnect as a stall if shutdown wasn't requested.
                        if writer_shutdown.try_recv().is_ok() {
                            let _ = stdin.write_all(b"q");
                            let _ = stdin.flush();
                            break;
                        }
                        let _ = writer_err.send(RunError::media(
                            "media pipeline stalled: video producer ended",
                        ));
                        break;
                    }
                }
            }
        })
        .map_err(|e| MediaError::General(format!("cannot spawn video writer: {e}")))?;

    // Track writers: connect the pre-created pipes, then stream blocks.
    for (i, (rx, pipe)) in track_rxs.into_iter().zip(track_pipes).enumerate() {
        let url = pipe_urls[i].clone();
        let track = params.tracks[i].clone();
        let writer_shutdown = shutdown.clone();
        let writer_err = err_tx.clone();
        thread::Builder::new()
            .name(format!("segmenter-track-{}", track.number))
            .spawn(move || {
                let mut writer = pipe;
                if let Err(e) = writer.connect() {
                    let _ = writer_err.send(RunError::media(format!(
                        "ffmpeg never opened pipe {url}: {e}"
                    )));
                    return;
                }
                let mut last_write = std::time::Instant::now();
                loop {
                    match rx.recv_timeout(Duration::from_millis(250)) {
                        Ok(block) => {
                            if write_f32le(&mut writer, &block.samples).is_err() {
                                break;
                            }
                            last_write = std::time::Instant::now();
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            if writer_shutdown.try_recv().is_ok() {
                                let _ = writer.flush();
                                break;
                            }
                            if last_write.elapsed() > STALL_TIMEOUT {
                                let _ = writer_err.send(RunError::media(format!(
                                    "media pipeline stalled: no audio for track {}",
                                    track.number
                                )));
                                break;
                            }
                        }
                        Err(RecvTimeoutError::Disconnected) => {
                            if writer_shutdown.try_recv().is_ok() {
                                let _ = writer.flush();
                                break;
                            }
                            let _ = writer_err.send(RunError::media(format!(
                                "media pipeline stalled: track {} producer ended",
                                track.number
                            )));
                            break;
                        }
                    }
                }
            })
            .map_err(|e| MediaError::General(format!("cannot spawn track writer: {e}")))?;
    }

    // FFmpeg monitor: drains stderr, detects exit.
    let monitor_flag = shutdown_flag.clone();
    let monitor_err = err_tx.clone();
    let (exit_tx, exit_rx) = crossbeam_channel::bounded::<Option<std::process::ExitStatus>>(1);
    thread::Builder::new()
        .name("segmenter-monitor".to_string())
        .spawn(move || {
            let iter = match child.iter() {
                Ok(it) => it,
                Err(e) => {
                    let _ = monitor_err.send(RunError::media(format!("ffmpeg event loop: {e}")));
                    return;
                }
            };
            let mut last_lines: VecDeque<String> = VecDeque::new();
            let mut event_error: Option<String> = None;
            for event in iter {
                match event {
                    FfmpegEvent::Log(level, line) => {
                        last_lines.push_back(line.clone());
                        if last_lines.len() > 8 {
                            last_lines.pop_front();
                        }
                        match level {
                            LogLevel::Error | LogLevel::Fatal => {
                                error!(%line, "ffmpeg reported an error");
                            }
                            _ => {
                                debug!(%line, "ffmpeg stderr");
                            }
                        }
                    }
                    FfmpegEvent::Error(e) => {
                        event_error = Some(e);
                    }
                    FfmpegEvent::Done => break,
                    _ => {}
                }
            }
            // The monitor only reports unexpected exits: a shutdown-triggered
            // "q" is the normal path and must not surface as an error.
            if !monitor_flag.load(Ordering::SeqCst) {
                if let Some(e) = event_error {
                    let _ = monitor_err.send(RunError::media(format!("ffmpeg event error: {e}")));
                } else if !last_lines.is_empty() {
                    let _ = monitor_err.send(RunError::media(format!(
                        "ffmpeg exited unexpectedly: {}",
                        last_lines.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" | ")
                    )));
                }
            }
            let _ = exit_tx.send(None);
        })
        .map_err(|e| MediaError::General(format!("cannot spawn ffmpeg monitor: {e}")))?;

    let (done_tx, done_rx) = crossbeam_channel::bounded::<()>(1);

    // Main loop: index closed segments from the list, prune, and wait for
    // shutdown. Once shutdown arrives, wait for FFmpeg to finalize the open
    // segment (the monitor signals when its stderr closes).
    thread::Builder::new()
        .name("segmenter".to_string())
        .spawn(move || {
            let mut last_sizes_seen: HashMap<String, u64> = HashMap::new();
            let mut limiter = RateLimiter::new(Duration::from_secs(5));
            let mut shutting_down = false;
            loop {
                if shutting_down {
                    match exit_rx.recv_timeout(FINISH_TIMEOUT) {
                        Ok(_) | Err(RecvTimeoutError::Disconnected) => break,
                        Err(RecvTimeoutError::Timeout) => break,
                    }
                }
                scan_segments(&params.buffer_dir, &store, &params.ffmpeg, &mut last_sizes_seen, &mut limiter);
                store.prune(params.keep);
                if !shutting_down {
                    match shutdown.recv_timeout(SCAN_INTERVAL) {
                        Ok(()) => {
                            shutdown_flag.store(true, Ordering::SeqCst);
                            shutting_down = true;
                        }
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => {
                            shutdown_flag.store(true, Ordering::SeqCst);
                            shutting_down = true;
                        }
                    }
                }
            }
            let _ = done_tx.send(());
            info!("segmenter finished; final segment finalized");
        })
        .map_err(|e| MediaError::General(format!("cannot spawn segmenter thread: {e}")))?;

    Ok(done_rx)
}

/// Read the FFmpeg segment list and index entries that are closed and whose
/// file size is stable across two scans. The newest entry that is still
/// changing is tracked as the in-progress (open) segment.
///
/// The segment list is used when present, but it is *not* the source of truth:
/// FFmpeg buffers its list writes, so rows can appear seconds late or in
/// bursts. Segments are instead discovered from the buffer directory (FFmpeg
/// creates each segment file the moment it opens it); stream times come from
/// the list when the row is available, otherwise from probing the closed file
/// with FFmpeg. This keeps indexing timely regardless of list flush timing.
fn scan_segments(
    buffer_dir: &std::path::Path,
    store: &SegmentStore,
    ffmpeg: &std::path::Path,
    last_sizes: &mut HashMap<String, u64>,
    limiter: &mut RateLimiter,
) {
    // Best-effort list: filename -> (duration, cumulative stream end).
    let list = read_segment_list(buffer_dir);
    let Ok(entries) = std::fs::read_dir(buffer_dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            let is_file = e.file_type().map(|t| t.is_file()).unwrap_or(false);
            is_file && name.starts_with("segment_") && name.ends_with(".mkv")
        })
        .map(|e| e.path())
        .collect();
    // Zero-padded `segment_%05d.mkv` names sort lexicographically in stream
    // order, which keeps recording order correct even when the list bursts.
    files.sort();
    let dbg = std::env::var("SCREENCAP_SCAN_DBG").as_deref() == Ok("1");
    if dbg && !files.is_empty() {
        let names: Vec<String> = files
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
            .collect();
        eprintln!("SCANDIR: files=[{}]", names.join(","));
    }
    for path in files {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().to_string()) else {
            continue;
        };
        if store.is_listed(&name) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            continue; // size-changing / not yet flushed
        };
        let size = meta.len();
        let previous = last_sizes.get(&name).copied();
        store.observe_size(&name, size);
        if previous != Some(size) {
            // Still changing: this is the in-progress segment (or it just
            // appeared). Track it so saves reach the save moment, then index
            // it on the next stable scan.
            last_sizes.insert(name.clone(), size);
            if dbg {
                eprintln!("SCANDIR: {name} open size={size} prev={previous:?}");
            }
            let (_, stream_end) = list.get(&name).copied().unwrap_or((0.0, 0.0));
            store.set_open(SegmentInfo {
                name,
                path,
                duration: Duration::ZERO,
                stream_end,
            });
            continue;
        }
        // Closed: FFmpeg finished the file. Resolve stream times from the
        // list when its row is present, otherwise probe the file itself.
        let (duration, stream_end) = if let Some(entry) = list.get(&name).copied() {
            entry
        } else {
            let prev_end = store.newest_end_seconds();
            match probe_duration_seconds(ffmpeg, &path) {
                Some(duration) if duration > 0.0 => (duration, prev_end + duration),
                _ => {
                    if dbg {
                        eprintln!("SCANDIR: {name} probe failed size={size} prev={previous:?}");
                    }
                    continue; // not decodable yet; retry on the next scan
                }
            }
        };
        if dbg {
            eprintln!("SCANDIR: {name} RECORD size={size} end={stream_end:.2}");
        }
        store.mark_listed(&name);
        store.record(SegmentInfo {
            name,
            path,
            duration: Duration::from_secs_f64(duration),
            stream_end,
        });
        // The previous open segment just closed.
        store.clear_open();
        if limiter.should_emit() {
            info!(
                "new closed segment indexed; buffer now {:.1}s",
                store.available_seconds()
            );
        }
    }
}

/// Parse the segment list file into `filename -> (duration_seconds, stream_end_seconds)`.
fn read_segment_list(buffer_dir: &std::path::Path) -> HashMap<String, (f64, f64)> {
    let mut map = HashMap::new();
    let Ok(content) = std::fs::read_to_string(buffer_dir.join("segments.txt")) else {
        return map;
    };
    for line in content.lines() {
        let fields: Vec<&str> = line.split(',').collect();
        let [name, start, end] = fields.as_slice() else {
            continue;
        };
        let (Ok(start), Ok(end)) = (start.trim().parse::<f64>(), end.trim().parse::<f64>()) else {
            continue;
        };
        let duration = end - start;
        if duration > 0.0 {
            map.insert(name.trim().to_string(), (duration, end));
        }
    }
    map
}

/// Probe a closed segment with FFmpeg and return its duration in seconds.
/// Header probing (`-i`) is enough for MKV: the duration is in the header.
fn probe_duration_seconds(ffmpeg: &std::path::Path, path: &std::path::Path) -> Option<f64> {
    let output = std::process::Command::new(ffmpeg)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW: no console flash
        .args(["-hide_banner", "-i"])
        .arg(path)
        .output()
        .ok()?;
    parse_duration_seconds(&String::from_utf8_lossy(&output.stderr))
}

/// Extract the duration from FFmpeg stderr (`Duration: HH:MM:SS.cc, ...`).
fn parse_duration_seconds(stderr: &str) -> Option<f64> {
    let line = stderr.lines().find(|l| l.contains("Duration:"))?;
    let rest = line.split("Duration:").nth(1)?;
    let part = rest.trim().split(',').next()?.trim();
    let mut fields = part.split(':');
    let hours: f64 = fields.next()?.trim().parse().ok()?;
    let minutes: f64 = fields.next()?.trim().parse().ok()?;
    let seconds: f64 = fields.next()?.trim().parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

#[cfg(test)]
mod pipe_isolation_test {
    //! Feed distinct frames through the real named pipe into the real segment
    //! FFmpeg command (no channel, no pacer) and verify the encoded segments
    //! preserve the varying first-row content. If the pipe/FFmpeg path froze
    //! the content, the freeze lives in the pipe write or the FFmpeg command;
    //! if it is preserved, the freeze is in the writer/pacer channel path.
    //! Gated behind SCREENCAP_PIPE_ISO=1 (real FFmpeg + named pipes).

    use std::io::Write as _;
    use std::path::PathBuf;
    use std::time::Duration;

    use ffmpeg_sidecar::command::FfmpegCommand;

    use super::{pipe, pipe_url};

    fn ffmpeg() -> PathBuf {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.push("target");
        p.push(if cfg!(debug_assertions) { "debug" } else { "release" });
        p.push("ffmpeg.exe");
        p
    }

    #[test]
    fn pipe_preserves_varying_frames() {
        if std::env::var("SCREENCAP_PIPE_ISO").as_deref() != Ok("1") {
            eprintln!("SKIP: set SCREENCAP_PIPE_ISO=1 to run the pipe isolation test");
            return;
        }
        let work = std::env::temp_dir().join(format!("screencap_pipeiso_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::fs::create_dir_all(&work).unwrap();

        let name = format!("screencap_pipeiso_{}_video", std::process::id());
        let url = pipe_url(&name);
        let frame_bytes = 640 * 360 * 4;
        let mut pipew = pipe::PipeWriter::create(&url, (frame_bytes + 256 * 1024) as u32).unwrap();

        let mut cmd = FfmpegCommand::new_with_path(ffmpeg());
        cmd.args([
            "-hide_banner",
            "-loglevel",
            "warning",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "bgra",
            "-video_size",
            "640x360",
            "-framerate",
            "30",
            "-i",
            &url,
            "-map",
            "0:v",
            "-c:v",
            "h264_nvenc",
            "-g",
            "120",
            "-cq",
            "28",
            "-shortest",
            "-f",
            "segment",
            "-segment_time",
            "4",
            "-reset_timestamps",
            "1",
            "-segment_list_type",
            "csv",
            "-segment_list",
            work.join("segments.txt").to_str().unwrap(),
            work.join("segment_%05d.mkv").to_str().unwrap(),
        ]);
        cmd.create_no_window();
        let mut child = cmd.spawn().unwrap();
        let mut stdin = child.take_stdin().unwrap();
        pipew.connect().unwrap();

        // Write 120 distinct frames (first-row grey = frame index % 60) as
        // fast as the pipe allows. Note: this uses a new grey every frame; a
        // cadence with long runs of identical frames (e.g. one grey per
        // second) collapses under H.264's skip encoding at this bitrate and
        // would decode frozen — that is expected encoder behavior, not a pipe
        // or FFmpeg defect.
        let mut frame = vec![0u8; frame_bytes];
        for i in 0..120u32 {
            let g = (i % 60) as u8;
            for x in 0..640usize {
                frame[x * 4] = g;
                frame[x * 4 + 1] = g;
                frame[x * 4 + 2] = g;
            }
            pipew.write_all(&frame).unwrap();
        }
        drop(pipew);
        std::thread::sleep(Duration::from_secs(2));
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
        let _ = child.wait();

        let mut report = Vec::new();
        for entry in std::fs::read_dir(&work).unwrap().flatten() {
            let p = entry.path();
            if p.extension().is_none_or(|e| e != "mkv") {
                continue;
            }
            let out = work.join(format!("dec_{}.bin", p.file_stem().unwrap().to_string_lossy()));
            let status = std::process::Command::new(ffmpeg())
                .args(["-hide_banner", "-loglevel", "error", "-i"])
                .arg(&p)
                .args(["-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "bgra"])
                .arg(&out)
                .status()
                .unwrap();
            assert!(status.success(), "decode failed for {}", p.display());
            let bytes = std::fs::read(&out).unwrap();
            let nf = bytes.len() / frame_bytes;
            let mut vals: Vec<u8> = (0..nf)
                .map(|f| bytes[f * frame_bytes + 2])
                .collect();
            vals.dedup();
            report.push(format!(
                "{}:{}frames:greys[{}]",
                p.file_name().unwrap().to_string_lossy(),
                nf,
                vals.iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
        println!("PIPE-ISO: {}", report.join(" | "));
        let _ = std::fs::remove_dir_all(&work);
    }
}
