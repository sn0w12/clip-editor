//! The supervisor: resolves the monitor and FFmpeg, starts every producer and
//! the segmenter, then selects on worker errors, hotkey saves, and Ctrl-C.
//! Terminal errors propagate to all workers; saves are coalesced, never run
//! concurrently.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use tracing::{error, info};

use crate::audio::{AudioEvent, AudioRouter, SourceInfo, SourceKind, TrackAudioBlock};
use crate::config::{Config, ProcessRule, ResolvedTrack};
#[cfg(not(windows))]
use crate::error::PlatformError;
use crate::error::RunError;
use crate::hotkey::{HotkeyCommand, HotkeyControl};
use crate::media::segmenter::{SegmentStore, SegmenterParams};
use crate::media::{ffmpeg as ffmpeg_util, save as save_util};

/// How many shutdown messages to broadcast (more than the worker count, so
/// every worker's channel clone receives one).
const SHUTDOWN_FANOUT: usize = 64;
/// Segmenter finalization grace period after shutdown.
const FINISH_WAIT: Duration = Duration::from_secs(15);

/// Ctrl-C flag, set from the console handler.
static CTRL_C: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
unsafe extern "system" fn console_ctrl_handler(_: u32) -> windows::core::BOOL {
    CTRL_C.store(true, Ordering::SeqCst);
    windows::core::BOOL(1)
}

fn install_ctrl_c() {
    #[cfg(windows)]
    {
        use windows::Win32::System::Console::SetConsoleCtrlHandler;
        unsafe {
            let _ = SetConsoleCtrlHandler(Some(console_ctrl_handler), true);
        }
    }
}

/// Remove leftover auto-placed buffer dirs (`screencap-buffer-*` in the system
/// temp) from runs that were killed hard. A dir is stale when its modification
/// time is older than 10 minutes — a live instance writes a segment every
/// second, so an active dir is always fresh. Never touches the current run's
/// own dir; best effort, failures are ignored.
fn sweep_stale_buffers(current: &std::path::Path) {
    let ten_minutes = std::time::Duration::from_secs(10 * 60);
    let cutoff = std::time::SystemTime::now() - ten_minutes;
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == current {
            continue;
        }
        let is_ours = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("screencap-buffer-"));
        if !is_ours || !path.is_dir() {
            continue;
        }
        let stale = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .is_ok_and(|t| t < cutoff);
        if stale {
            let _ = std::fs::remove_dir_all(&path);
        }
    }
}

/// A request sent to the running supervisor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayCommand {
    /// Save the newest configured duration of the rolling buffer. Save
    /// requests are coalesced: one save runs, at most one further request is
    /// queued, never concurrent.
    SaveNow,
    /// Stop capture, finalize the current segment, and exit the supervisor.
    Stop,
}

/// A life-cycle or save outcome published by the supervisor. Hosts poll
/// `ReplayController::try_recv`; the CLI logs instead.
#[derive(Debug, Clone, PartialEq)]
pub enum ReplayEvent {
    /// Capture is live and the rolling buffer is ready.
    Started { width: u32, height: u32, fps: u32 },
    /// Rolling buffer fill, published roughly once per second.
    BufferProgress {
        available_seconds: f64,
        target_seconds: u32,
    },
    /// A save was requested and is being assembled.
    Saving,
    /// A save finished; the file is complete and atomically present.
    Saved { path: PathBuf },
    /// A terminal failure (setup, worker, or save failure).
    Error { message: String },
    /// The supervisor shut down cleanly.
    Stopped,
}

/// A live replay-buffer supervisor. `start` spawns the capture pipeline on a
/// dedicated thread; `save_now` requests a save (coalesced, never concurrent);
/// `try_recv` drains published events; `stop` shuts the pipeline down, joins
/// the supervisor, and returns its outcome.
pub struct ReplayController {
    cmd_tx: Sender<ReplayCommand>,
    event_rx: Receiver<ReplayEvent>,
    join: Option<std::thread::JoinHandle<Result<(), RunError>>>,
}

impl ReplayController {
    /// Start the pipeline with an already-loaded configuration. `ffmpeg_dir`,
    /// when given, is probed for `ffmpeg[.exe]` before the sibling/sidecar/
    /// download resolution so hosts that bundle FFmpeg as a resource ship the
    /// same binary in development and release.
    pub fn start(config: Config, ffmpeg_dir: Option<PathBuf>) -> Result<Self, RunError> {
        #[cfg(not(windows))]
        {
            let _ = (config, ffmpeg_dir);
            return Err(RunError::Platform(PlatformError::Unsupported(
                "screencap capture requires Windows Graphics Capture and WASAPI \
                 application loopback; CPAL alone cannot reproduce the configured \
                 routing"
                    .to_string(),
            )));
        }
        #[cfg(windows)]
        {
            let (cmd_tx, cmd_rx) = crossbeam_channel::bounded(16);
            let (event_tx, event_rx) = crossbeam_channel::bounded(500);
            let handle = thread_builder("replay-supervisor")
                .spawn(move || supervise(config, ffmpeg_dir, cmd_rx, Some(event_tx)))?;
            Ok(Self {
                cmd_tx,
                event_rx,
                join: Some(handle),
            })
        }
    }

    /// Request a save of the newest configured duration. The foreground
    /// window title is sampled when the supervisor processes the request.
    pub fn save_now(&self) -> Result<(), RunError> {
        self.cmd_tx
            .send(ReplayCommand::SaveNow)
            .map_err(|_| RunError::media("replay controller is not running (buffer stopped)"))
    }

    /// Drain one published event, if any.
    pub fn try_recv(&self) -> Option<ReplayEvent> {
        self.event_rx.try_recv().ok()
    }

    /// Stop capture, finalize the current segment, and join the supervisor.
    /// Returns the supervisor outcome (an `Err` means the run failed).
    pub fn stop(mut self) -> Result<(), RunError> {
        let _ = self.cmd_tx.send(ReplayCommand::Stop);
        drop(self.cmd_tx);
        let join = self.join.take().expect("controller join handle");
        join.join()
            .map_err(|_| RunError::media("replay supervisor thread panicked"))?
    }

    /// Block until the supervisor exits on its own (Ctrl-C or a terminal
    /// worker error) without sending Stop. Used by the CLI. The command
    /// sender is deliberately kept alive: `supervise_inner`'s select must
    /// block on `cmd_rx` rather than see a permanently-ready disconnected
    /// channel, which would spin the supervisor loop at 100% of one core for
    /// the whole run (a real input-lag source on a busy desktop).
    pub fn wait(mut self) -> Result<(), RunError> {
        let join = self.join.take().expect("controller join handle");
        join.join()
            .map_err(|_| RunError::media("replay supervisor thread panicked"))?
    }
}

/// Entry point for the `run` command.
pub fn run(config_path: Option<PathBuf>) -> Result<(), RunError> {
    #[cfg(not(windows))]
    {
        let _ = config_path;
        return Err(RunError::Platform(PlatformError::Unsupported(
            "process-level per-application audio exclusion requires Windows \
             WASAPI application loopback; CPAL alone cannot reproduce the \
             configured routing"
                .to_string(),
        )));
    }

    #[cfg(windows)]
    {
        install_ctrl_c();
        CTRL_C.store(false, Ordering::SeqCst);
        let config = Config::load(config_path.as_deref())?;
        let controller = ReplayController::start(config, None)?;
        controller.wait()
    }
}

/// Run the supervisor until it exits, publishing `ReplayEvent`s on `event_tx`
/// when present. Setup and terminal worker failures are published as
/// `Error` events before the returned `Err` is observed.
#[cfg(windows)]
fn supervise(
    config: Config,
    ffmpeg_dir: Option<PathBuf>,
    cmd_rx: Receiver<ReplayCommand>,
    rec_event_tx: Option<Sender<ReplayEvent>>,
) -> Result<(), RunError> {
    let outcome = supervise_inner(config, ffmpeg_dir, cmd_rx, rec_event_tx.clone());
    if let Err(e) = &outcome {
        if let Some(tx) = rec_event_tx {
            let _ = tx.try_send(ReplayEvent::Error {
                message: e.to_string(),
            });
        }
    }
    outcome
}

#[cfg(windows)]
fn supervise_inner(
    config: Config,
    ffmpeg_dir: Option<PathBuf>,
    cmd_rx: Receiver<ReplayCommand>,
    rec_event_tx: Option<Sender<ReplayEvent>>,
) -> Result<(), RunError> {
    let emit = |event: ReplayEvent| {
        if let Some(tx) = &rec_event_tx {
            let _ = tx.try_send(event);
        }
    };
    info!("startup configuration:\n{}", config.describe());

    // Resolve FFmpeg before any worker starts so a missing binary or encoder
    // fails startup, not mid-run.
    let ffmpeg = ffmpeg_util::resolve_ffmpeg(ffmpeg_dir)?;
    let codec = config.video.codec.resolve(&ffmpeg)?;
    ffmpeg_util::check_encoder(&ffmpeg, &codec)?;
    info!(codec = codec.ffmpeg_name(), "video codec resolved");

    // Monitor resolution before audio/media workers (plan §2.2).
    let video_settings = crate::video::VideoSettings {
        monitor: config.replay.monitor.clone(),
        fps: config.replay.fps,
        cursor: config.video.cursor,
    };
    let backend = crate::video::create_backend(&video_settings)?;
    let video_info = backend.resolve()?;
    info!(
        width = video_info.width,
        height = video_info.height,
        fps = video_info.fps,
        "monitor resolved"
    );

    // Directories. The rolling buffer lives on the fast system drive by
    // default (see ReplayConfig::resolved_buffer_dir) — not in the save dir,
    // which users commonly point at a slow secondary disk.
    let output_dir = config.replay.output_dir.clone();
    let buffer_dir = config.replay.resolved_buffer_dir();
    sweep_stale_buffers(&buffer_dir);
    let store = Arc::new(SegmentStore::new(buffer_dir.clone()));
    store.prepare()?;
    info!(buffer_dir = %buffer_dir.display(), "rolling buffer ready");

    // All producers stamp PTS on this shared timeline so a source that starts
    // a moment later is never treated as late by the mixer.
    let origin = Instant::now();

    // Channels. The video queue is bounded to two frames so end-to-end frame
    // age stays at most two frame intervals (see VIDEO_QUEUE_CAPACITY).
    let (video_tx, video_rx) = crossbeam_channel::bounded(crate::video::VIDEO_QUEUE_CAPACITY);
    let (event_tx, event_rx) = crossbeam_channel::bounded(500);
    let (hotkey_tx, hotkey_rx) = crossbeam_channel::bounded(16);
    let (err_tx, err_rx) = crossbeam_channel::bounded(16);
    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded(SHUTDOWN_FANOUT);

    let track_count = config.audio.tracks.len();
    // Buffer well past the encoder's cold-start delay (the first NVENC session
    // can take ~10s): if the track channels overflow before FFmpeg opens the
    // pipes, the oldest audio is dropped and the saved audio stream starts
    // ahead of the video, so it plays several seconds early.
    let (track_txs, track_rxs): (Vec<_>, Vec<_>) = (0..track_count)
        .map(|_| crossbeam_channel::bounded(1200))
        .unzip();
    let track_pairs: Vec<(Sender<TrackAudioBlock>, Receiver<TrackAudioBlock>)> =
        track_txs.into_iter().zip(track_rxs.clone()).collect();

    // Initial sources from config (configured processes are always present;
    // unknown roots are added dynamically by the audio manager).
    let initial_sources: Vec<SourceInfo> = config
        .audio
        .processes
        .iter()
        .map(|p| SourceInfo {
            key: crate::audio::SourceKey::process(&p.id),
            kind: SourceKind::Process,
            tags: p.tags.clone(),
            executable: Some(p.executable.clone()),
        })
        .chain(config.audio.inputs.iter().map(|i| SourceInfo {
            key: crate::audio::SourceKey::input(&i.id),
            kind: SourceKind::Input,
            tags: Vec::new(),
            executable: None,
        }))
        .collect();

    // Start order (plan §5.2): video, process audio, microphones, router,
    // segmenter, hotkey.
    backend.spawn(
        video_info,
        origin,
        video_tx,
        video_rx.clone(),
        err_tx.clone(),
        shutdown_rx.clone(),
    )?;

    let process_rules: Vec<ProcessRule> = config.audio.processes.clone();
    crate::audio::windows::spawn_process_audio(
        process_rules,
        origin,
        event_tx.clone(),
        event_rx.clone(),
        err_tx.clone(),
        shutdown_rx.clone(),
        config.audio.sample_rate,
        config.audio.channels,
    )?;

    for input in &config.audio.inputs {
        crate::audio::microphone::spawn_microphone(
            input,
            origin,
            event_tx.clone(),
            event_rx.clone(),
            err_tx.clone(),
            shutdown_rx.clone(),
            config.audio.sample_rate,
            config.audio.channels,
            config.audio.block_ms,
        )?;
    }

    let mix_shutdown = shutdown_rx.clone();
    let mix_tracks: Vec<ResolvedTrack> = config.audio.tracks.clone();
    let mix_block_ms = config.audio.block_ms;
    let mix_rate = config.audio.sample_rate;
    let mix_channels = config.audio.channels;
    thread_builder("mix").spawn(move || {
        mix_loop(
            event_rx,
            track_pairs,
            mix_shutdown,
            origin,
            mix_block_ms,
            mix_rate,
            mix_channels,
            mix_tracks,
            initial_sources,
        );
    })?;

    let segmenter_done = crate::media::segmenter::spawn_segmenter(
        SegmenterParams {
            ffmpeg: ffmpeg.clone(),
            video: video_info,
            sample_rate: config.audio.sample_rate,
            channels: config.audio.channels,
            tracks: config.audio.tracks.clone(),
            codec,
            quality: config.video.quality,
            segment_seconds: config.replay.segment_seconds,
            buffer_dir: buffer_dir.clone(),
            keep: Duration::from_secs(
                config.replay.duration_seconds as u64 + config.replay.segment_seconds as u64,
            ),
            capture_origin: origin,
        },
        store.clone(),
        video_rx,
        track_rxs,
        shutdown_rx.clone(),
        err_tx.clone(),
    )?;

    let mut hotkey = HotkeyControl::start(&config.replay.hotkey, hotkey_tx, err_tx.clone())?;

    // Supervisor loop.
    let duration_secs = config.replay.duration_seconds;
    let mut last_fill_log = Instant::now();
    let mut last_progress = Instant::now();
    let mut outcome: Option<RunError> = None;

    emit(ReplayEvent::Started {
        width: video_info.width,
        height: video_info.height,
        fps: video_info.fps,
    });

    'supervise: loop {
        if CTRL_C.load(Ordering::SeqCst) {
            info!("Ctrl-C received; stopping capture without saving");
            break;
        }
        crossbeam_channel::select! {
            recv(err_rx) -> msg => {
                match msg {
                    Ok(e) => {
                        error!(error = %e, "terminal worker error");
                        outcome = Some(e);
                        break 'supervise;
                    }
                    Err(_) => {} // all senders gone; nothing more can fail
                }
            }
            recv(hotkey_rx) -> msg => {
                if let Ok(HotkeyCommand::Save { foreground_title }) = msg {
                    handle_save(
                        &ffmpeg,
                        &store,
                        &buffer_dir,
                        &output_dir,
                        &config.replay.filename_base,
                        foreground_title,
                        duration_secs,
                        config.replay.segment_seconds,
                        origin,
                        config.replay.success_sound.as_deref(),
                        &rec_event_tx,
                    );
                    // Coalesce any saves queued during the run into one
                    // pending save — never run concurrently.
                    let mut pending: Option<String> = None;
                    while let Ok(HotkeyCommand::Save { foreground_title }) = hotkey_rx.try_recv() {
                        pending = Some(foreground_title);
                    }
                    if let Some(title) = pending {
                        handle_save(
                            &ffmpeg,
                            &store,
                            &buffer_dir,
                            &output_dir,
                            &config.replay.filename_base,
                            title,
                            duration_secs,
                            config.replay.segment_seconds,
                            origin,
                            config.replay.success_sound.as_deref(),
                            &rec_event_tx,
                        );
                    }
                }
            }
            recv(cmd_rx) -> msg => {
                match msg {
                    Ok(ReplayCommand::SaveNow) => {
                        // Sample the foreground title at save time so a save
                        // requested by a host names the window in front.
                        let title = crate::naming::active_window_title();
                        handle_save(
                            &ffmpeg,
                            &store,
                            &buffer_dir,
                            &output_dir,
                            &config.replay.filename_base,
                            title.clone(),
                            duration_secs,
                            config.replay.segment_seconds,
                            origin,
                            config.replay.success_sound.as_deref(),
                            &rec_event_tx,
                        );
                        // Coalesce saves queued during the run into one
                        // pending save — never run concurrently.
                        let mut pending = false;
                        while let Ok(ReplayCommand::SaveNow) = cmd_rx.try_recv() {
                            pending = true;
                        }
                        if pending {
                            handle_save(
                                &ffmpeg,
                                &store,
                                &buffer_dir,
                                &output_dir,
                                &config.replay.filename_base,
                                title,
                                duration_secs,
                                config.replay.segment_seconds,
                                origin,
                                config.replay.success_sound.as_deref(),
                                &rec_event_tx,
                            );
                        }
                    }
                    Ok(ReplayCommand::Stop) => break 'supervise,
                    // Command channel closed (CLI mode): keep running until
                    // Ctrl-C or a terminal worker error.
                    Err(_) => {}
                }
            }
            default(Duration::from_millis(250)) => {}
        }
        if last_fill_log.elapsed() >= Duration::from_secs(5) {
            let fill = store.available_seconds() / duration_secs as f64;
            info!(
                fill_percent = format!("{:.0}%", (fill * 100.0).clamp(0.0, 100.0)),
                "buffer"
            );
            last_fill_log = Instant::now();
        }
        if last_progress.elapsed() >= Duration::from_secs(1) {
            emit(ReplayEvent::BufferProgress {
                available_seconds: store.available_seconds(),
                target_seconds: duration_secs,
            });
            last_progress = Instant::now();
        }
    }

    // Shutdown: broadcast, stop the hotkey thread, let the segmenter finalize
    // the current segment.
    for _ in 0..SHUTDOWN_FANOUT {
        let _ = shutdown_tx.try_send(());
    }
    hotkey.stop();
    let _ = segmenter_done.recv_timeout(FINISH_WAIT);
    info!("capture stopped");
    emit(ReplayEvent::Stopped);

    match outcome {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

fn thread_builder(name: &str) -> std::thread::Builder {
    std::thread::Builder::new().name(name.to_string())
}
/// The audio router loop: apply worker events, then mix one block per track
/// per window. The mixer runs a fixed latency behind wall time so in-flight
/// producer blocks (which always arrive one callback late) are never dropped
/// as late. Track sends never block: a full track channel drops the oldest
/// mixed block (rate-limited warning), so a slow segmenter cannot stall the
/// mixer into a catch-up burst that drops whole sources.
#[allow(clippy::too_many_arguments)]
fn mix_loop(
    event_rx: Receiver<AudioEvent>,
    track_channels: Vec<(Sender<TrackAudioBlock>, Receiver<TrackAudioBlock>)>,
    shutdown: Receiver<()>,
    origin: Instant,
    block_ms: u32,
    sample_rate: u32,
    channels: u16,
    tracks: Vec<ResolvedTrack>,
    initial_sources: Vec<SourceInfo>,
) {
    let mut router = AudioRouter::new(block_ms, sample_rate, channels, tracks, initial_sources);
    /// Producers emit blocks only after their data interval completes, and
    /// workers whose capture events never fire fall back to polling reads with
    /// up to one poll-period of burst delay; the mixer must lag wall time by
    /// more than that so in-flight blocks are never dropped as late.
    const LATENCY: Duration = Duration::from_millis(250);
    let mut mixed: u64 = 0;
    let mut limiter = crate::util::RateLimiter::new(Duration::from_secs(5));

    loop {
        if shutdown.try_recv().is_ok() {
            break;
        }
        // Drain whatever events are queued (never block on them).
        while let Ok(event) = event_rx.try_recv() {
            router.apply_event(event);
        }
        // Mix every window whose data is already LATENCY in the past.
        let elapsed = origin.elapsed();
        let target: u64 = if elapsed > LATENCY {
            (elapsed - LATENCY).as_millis() as u64 / block_ms as u64
        } else {
            0
        };
        while mixed < target {
            for (block, (tx, rx)) in router.mix().into_iter().zip(track_channels.iter()) {
                crate::util::send_drop_oldest(tx, rx, block, &mut limiter, "track");
            }
            mixed += 1;
        }

        if let Ok(event) = event_rx.recv_timeout(Duration::from_millis(block_ms as u64)) {
            router.apply_event(event);
        }
    }
}

/// Execute one save request. Saves are serialized by the supervisor loop and
/// never run concurrently. Returns the path of the atomically-present file.
fn perform_save(
    ffmpeg: &std::path::Path,
    store: &Arc<SegmentStore>,
    buffer_dir: &std::path::Path,
    output_dir: &std::path::Path,
    filename_base: &str,
    foreground_title: &str,
    duration_seconds: u32,
    segment_seconds: u32,
    origin: Instant,
) -> Result<PathBuf, RunError> {
    // FFmpeg buffers the in-progress segment in memory; its content is not
    // readable on disk until the segment closes. A save at wall time T can
    // therefore only reach the last closed boundary, which lags T by up to a
    // full segment. Wait until the newest recorded segment's stream-time end
    // reaches the request moment so the clip's newest frame is the wall at
    // save time, not `segment_seconds` early. Bounded: the current segment
    // closes within `segment_seconds`, plus the scan interval and stability
    // checks before it is recorded.
    let request_stream = origin.elapsed().as_secs_f64();
    let wait_deadline = Instant::now() + Duration::from_secs(segment_seconds as u64 + 3);
    while store.newest_end_seconds() < request_stream && Instant::now() < wait_deadline {
        std::thread::sleep(Duration::from_millis(50));
    }

    let snapshot = store.snapshot();
    if snapshot.segments().is_empty() {
        return Err(RunError::media(
            "save requested but buffer not ready (no completed segments yet)",
        ));
    }
    let path = save_util::save_replay(
        ffmpeg,
        snapshot,
        buffer_dir,
        output_dir,
        filename_base,
        foreground_title,
        duration_seconds,
    )?;
    Ok(path)
}

/// Run one save and publish `Saving`/`Saved`/`Error` events around it. A save
/// failure never kills the run.
#[allow(clippy::too_many_arguments)]
fn handle_save(
    ffmpeg: &std::path::Path,
    store: &Arc<SegmentStore>,
    buffer_dir: &std::path::Path,
    output_dir: &std::path::Path,
    filename_base: &str,
    foreground_title: String,
    duration_seconds: u32,
    segment_seconds: u32,
    origin: Instant,
    success_sound: Option<&str>,
    rec_event_tx: &Option<Sender<ReplayEvent>>,
) {
    let emit = |event: ReplayEvent| {
        if let Some(tx) = rec_event_tx {
            let _ = tx.try_send(event);
        }
    };
    emit(ReplayEvent::Saving);
    match perform_save(
        ffmpeg,
        store,
        buffer_dir,
        output_dir,
        filename_base,
        &foreground_title,
        duration_seconds,
        segment_seconds,
        origin,
    ) {
        Ok(path) => {
            info!(path = %path.display(), "replay saved");
            if let Some(path) = success_sound {
                crate::sound::play_sound(path);
            }
            emit(ReplayEvent::Saved { path });
        }
        Err(e) => {
            error!(error = %e, "replay save failed");
            emit(ReplayEvent::Error {
                message: e.to_string(),
            });
        }
    }
}

#[cfg(test)]
mod save_window_test {
    use std::io::Read;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use crossbeam_channel::Sender;

    use crate::audio::TrackAudioBlock;
    use crate::config::ResolvedTrack;
    use crate::media::segmenter::{SegmentStore, SegmenterParams};
    use crate::video::{VideoFrame, VideoInfo};

    fn ffmpeg() -> PathBuf {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.push("target");
        p.push(if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        });
        p.push("ffmpeg.exe");
        assert!(p.exists(), "ffmpeg.exe must sit at {}", p.display());
        p
    }

    fn send_drop_oldest(
        tx: &Sender<VideoFrame>,
        rx: &crossbeam_channel::Receiver<VideoFrame>,
        item: VideoFrame,
    ) {
        if tx.try_send(item.clone()).is_err() {
            let _ = rx.try_recv();
            let _ = tx.try_send(item);
        }
    }

    /// Decode path and return the clip's duration in seconds, recovered from
    /// the number of decoded frames. Content markers are unusable here: at
    /// this bitrate H.264 collapses near-static frames (30 identical frames
    /// between one-row grey changes are encoded as skips), so a grey row
    /// painted once per second is not recoverable from the encoded clip.
    /// Frame count is exact.
    fn decoded_seconds(ffmpeg: &PathBuf, path: &PathBuf, width: u32, height: u32, fps: u32) -> f64 {
        let mut child = Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(path)
            .args(["-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "bgra", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("ffmpeg decode runs");
        let mut stdout = child.stdout.take().expect("decode stdout");
        let frame_len = width as usize * height as usize * 4;
        let mut buf = vec![0u8; frame_len];
        let mut frames = 0u64;
        while let Ok(()) = stdout.read_exact(&mut buf) {
            frames += 1;
        }
        let _ = child.wait();
        if frames == 0 {
            panic!("no decoded content in {}", path.display());
        }
        frames as f64 / fps as f64
    }

    /// Run the real segmenter with a frame feed that encodes the wall-second
    /// into the first row's red channel, save mid-segment, and verify the
    /// saved clip's newest content reaches the save moment. Without the
    /// wait-for-boundary in perform_save the clip would end at the last
    /// closed boundary (up to segment_seconds early).
    ///
    /// Gated behind SCREENCAP_SAVE_WINDOW=1 (real FFmpeg + named pipes).
    #[test]
    fn saved_clip_reaches_the_save_moment() {
        if std::env::var("SCREENCAP_SAVE_WINDOW").as_deref() != Ok("1") {
            eprintln!("SKIP: set SCREENCAP_SAVE_WINDOW=1 to run the save-window test");
            return;
        }
        let width: u32 = 640;
        let height: u32 = 360;
        let fps: u32 = 30;
        let segment_seconds: u32 = 4;
        let frame_bytes = width as usize * height as usize * 4;

        let work = std::env::temp_dir().join(format!("screencap_sw_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        let buffer_dir = work.join("buffer");
        let out_dir = work.join("out");
        std::fs::create_dir_all(&buffer_dir).unwrap();
        std::fs::create_dir_all(&out_dir).unwrap();

        let store = Arc::new(SegmentStore::new(buffer_dir.clone()));
        store.prepare().unwrap();

        let (video_tx, video_rx) = crossbeam_channel::bounded(crate::video::VIDEO_QUEUE_CAPACITY);
        let pacer_rx = video_rx.clone();
        let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded(64);
        let (err_tx, err_rx) = crossbeam_channel::bounded(16);
        let origin = Instant::now();

        let done = crate::media::segmenter::spawn_segmenter(
            SegmenterParams {
                ffmpeg: ffmpeg(),
                video: VideoInfo { width, height, fps },
                sample_rate: 48000,
                channels: 2,
                tracks: Vec::new(),
                codec: crate::config::VideoCodec::H264Nvenc,
                quality: 28,
                segment_seconds,
                buffer_dir: buffer_dir.clone(),
                keep: Duration::from_secs(120),
                capture_origin: origin,
            },
            store.clone(),
            video_rx,
            Vec::new(),
            shutdown_rx,
            err_tx,
        )
        .expect("segmenter spawns");

        let err_log: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let err_log2 = err_log.clone();
        let _err_thread = std::thread::spawn(move || {
            loop {
                match err_rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(e) => err_log2.lock().unwrap().push(e.to_string()),
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        let pacer_tx = video_tx.clone();
        let (stop_tx, stop_rx) = crossbeam_channel::bounded::<()>(1);
        let pacer = std::thread::spawn(move || {
            let mut next_tick = origin;
            let interval = Duration::from_micros(1_000_000 / fps as u64);
            loop {
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                let now = Instant::now();
                if now < next_tick {
                    std::thread::sleep((next_tick - now).min(Duration::from_millis(10)));
                    continue;
                }
                next_tick += interval;
                if next_tick < now {
                    next_tick = now + interval;
                }
                let frame = vec![0u8; frame_bytes];
                send_drop_oldest(
                    &pacer_tx,
                    &pacer_rx,
                    VideoFrame::new(origin.elapsed(), width, height, frame),
                );
            }
            origin.elapsed()
        });

        // Save mid-segment: at wall ~9.5s the current segment (started at
        // 8.033) is ~1.5s in and buffered — its content is not yet on disk.
        std::thread::sleep(Duration::from_millis(9500));
        let save_requested = Instant::now();
        let saved = super::perform_save(
            &ffmpeg(),
            &store,
            &buffer_dir,
            &out_dir,
            "Replay",
            "save-window",
            20,
            segment_seconds,
            origin,
        )
        .expect("perform_save succeeds");
        let save_done = Instant::now();

        let _ = stop_tx.send(());
        let _ = pacer.join();
        // Shut the segmenter down cleanly while `video_tx` is still alive so
        // the writer observes the shutdown flag, not a producer-end error.
        for _ in 0..64 {
            let _ = shutdown_tx.try_send(());
        }
        let _ = done.recv_timeout(Duration::from_secs(20));
        drop(video_tx);

        let errors = err_log.lock().unwrap().clone();
        assert!(errors.is_empty(), "segmenter terminal errors: {errors:?}");

        let saved_seconds = decoded_seconds(&ffmpeg(), &saved, width, height, fps);
        let save_done_sec = save_done.duration_since(origin).as_secs() % 60;
        let requested_sec = save_requested.duration_since(origin).as_secs() % 60;
        let request_stream = save_requested.duration_since(origin).as_secs_f64();
        println!(
            "SAVE-WINDOW: requested_at={requested_sec}s done_at={save_done_sec}s saved_duration={saved_seconds:.1}s"
        );
        // The clip must extend past the save request: its newest segment ends
        // at or after the request moment. Without the wait-for-boundary it
        // would end at the last closed boundary before the request (~8s
        // here), short by a full segment. Content cannot verify this (H.264
        // collapses the near-static test frames), so measure the clip's
        // duration: segments start at stream time 0, so the clip's end in
        // stream seconds equals its duration.
        assert!(
            saved_seconds >= request_stream - 1.0,
            "saved clip ends before the save request (saved {saved_seconds:.1}s, request at {request_stream:.1}s); the wait-for-boundary did not take effect"
        );

        let _ = std::fs::remove_dir_all(&work);
    }

    /// Decode the first audio stream to f32le and return its duration in
    /// seconds.
    fn decoded_audio_seconds(ffmpeg: &PathBuf, path: &PathBuf) -> f64 {
        let mut child = Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(path)
            .args([
                "-map", "0:a:0", "-f", "f32le", "-ac", "2", "-ar", "48000", "-",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("ffmpeg audio decode runs");
        let mut stdout = child.stdout.take().expect("decode stdout");
        let mut total = 0u64;
        let mut buf = vec![0u8; 65536];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => total += n as u64,
                Err(_) => break,
            }
        }
        let _ = child.wait();
        total as f64 / 4.0 / 2.0 / 48000.0
    }

    /// Probe each stream's first packet start time (seconds) from the saved
    /// file with the bundled ffprobe. Used to bound the first A/V packet
    /// offset: the mixer emits one block per window, so a clip whose audio
    /// starts more than one block after (or before) its video has drifted.
    fn stream_start_times(
        ffprobe: &PathBuf,
        path: &PathBuf,
    ) -> std::collections::HashMap<String, f64> {
        let output = std::process::Command::new(ffprobe)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-show_entries",
                "stream=codec_type,start_time",
                "-of",
                "csv=p=0",
            ])
            .arg(path)
            .output()
            .expect("ffprobe runs");
        let mut map = std::collections::HashMap::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            // csv: codec_type,start_time
            let mut it = line.split(',');
            if let (Some(codec), Some(start)) = (it.next(), it.next()) {
                if let Ok(v) = start.trim().parse::<f64>() {
                    map.insert(codec.trim().to_string(), v);
                }
            }
        }
        map
    }

    /// The production save path includes live audio tracks. Reproduce that
    /// here (video + one audio track fed over the real pipes) and verify the
    /// saved clip's video AND audio both reach the save request moment.
    /// Gated behind SCREENCAP_SAVE_WINDOW=1.
    #[test]
    fn saved_clip_with_audio_reaches_the_moment() {
        if std::env::var("SCREENCAP_SAVE_WINDOW").as_deref() != Ok("1") {
            eprintln!("SKIP: set SCREENCAP_SAVE_WINDOW=1 to run the save-window test");
            return;
        }
        let width: u32 = 640;
        let height: u32 = 360;
        let fps: u32 = 30;
        let segment_seconds: u32 = 4;
        let frame_bytes = width as usize * height as usize * 4;
        let rate: u32 = 48000;
        // Production mixer block cadence (config default); the first A/V
        // packet offset must stay within one block.
        let block_ms: u32 = 20;
        let block_frames = (block_ms as u64 * rate as u64 / 1000) as usize;

        let work = std::env::temp_dir().join(format!("screencap_swa_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        let buffer_dir = work.join("buffer");
        let out_dir = work.join("out");
        std::fs::create_dir_all(&buffer_dir).unwrap();
        std::fs::create_dir_all(&out_dir).unwrap();

        let store = Arc::new(SegmentStore::new(buffer_dir.clone()));
        store.prepare().unwrap();

        let (video_tx, video_rx) = crossbeam_channel::bounded(crate::video::VIDEO_QUEUE_CAPACITY);
        let pacer_rx = video_rx.clone();
        let (track_tx, track_rx) = crossbeam_channel::bounded(1200);
        let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded(64);
        let (err_tx, err_rx) = crossbeam_channel::bounded(16);
        let (stop_tx, stop_rx) = crossbeam_channel::bounded::<()>(2);
        let origin = Instant::now();

        let done = crate::media::segmenter::spawn_segmenter(
            SegmenterParams {
                ffmpeg: ffmpeg(),
                video: VideoInfo { width, height, fps },
                sample_rate: rate,
                channels: 2,
                tracks: vec![ResolvedTrack {
                    number: 1,
                    name: "t1".to_string(),
                    include: Vec::new(),
                    exclude: Vec::new(),
                }],
                codec: crate::config::VideoCodec::H264Nvenc,
                quality: 28,
                segment_seconds,
                buffer_dir: buffer_dir.clone(),
                keep: Duration::from_secs(120),
                capture_origin: origin,
            },
            store.clone(),
            video_rx,
            vec![track_rx],
            shutdown_rx,
            err_tx,
        )
        .expect("segmenter spawns");

        let err_log: Arc<std::sync::Mutex<Vec<String>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let err_log2 = err_log.clone();
        let _err_thread = std::thread::spawn(move || {
            loop {
                match err_rx.recv_timeout(Duration::from_secs(1)) {
                    Ok(e) => err_log2.lock().unwrap().push(e.to_string()),
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }
            }
        });

        let pacer_tx = video_tx.clone();
        let track_stop_rx = stop_rx.clone();
        let pacer = std::thread::spawn(move || {
            let mut next_tick = origin;
            let interval = Duration::from_micros(1_000_000 / fps as u64);
            loop {
                if stop_rx.try_recv().is_ok() {
                    break;
                }
                let now = Instant::now();
                if now < next_tick {
                    std::thread::sleep((next_tick - now).min(Duration::from_millis(10)));
                    continue;
                }
                next_tick += interval;
                if next_tick < now {
                    next_tick = now + interval;
                }
                let frame = vec![0u8; frame_bytes];
                send_drop_oldest(
                    &pacer_tx,
                    &pacer_rx,
                    VideoFrame::new(origin.elapsed(), width, height, frame),
                );
            }
            origin.elapsed()
        });

        // Audio feeder: one silent 100ms stereo block every window, like the
        // production mixer (which emits silence for empty tracks).
        let track_feeder_tx = track_tx.clone();
        let track_feeder = std::thread::spawn(move || {
            let mut next = origin;
            let interval = Duration::from_millis(block_ms as u64);
            loop {
                if track_stop_rx.try_recv().is_ok() {
                    break;
                }
                let now = Instant::now();
                if now < next {
                    std::thread::sleep((next - now).min(Duration::from_millis(10)));
                    continue;
                }
                next += interval;
                if next < now {
                    next = now + interval;
                }
                let _ = track_feeder_tx.try_send(TrackAudioBlock {
                    number: 1,
                    name: "t1".to_string(),
                    pts: origin.elapsed(),
                    sample_rate: rate,
                    channels: 2,
                    samples: vec![0f32; block_frames * 2],
                });
            }
        });

        std::thread::sleep(Duration::from_millis(9500));
        let save_requested = Instant::now();
        let saved = super::perform_save(
            &ffmpeg(),
            &store,
            &buffer_dir,
            &out_dir,
            "Replay",
            "save-window-audio",
            20,
            segment_seconds,
            origin,
        )
        .expect("perform_save succeeds");
        let save_done = Instant::now();

        let _ = stop_tx.send(());
        let _ = stop_tx.send(());
        let _ = pacer.join();
        let _ = track_feeder.join();
        for _ in 0..64 {
            let _ = shutdown_tx.try_send(());
        }
        let _ = done.recv_timeout(Duration::from_secs(20));
        drop(video_tx);
        // Drop the track sender only after shutdown is signaled so the writer
        // observes the shutdown flag, not a producer-end error.
        drop(track_tx);

        let errors = err_log.lock().unwrap().clone();
        assert!(errors.is_empty(), "segmenter terminal errors: {errors:?}");

        let video_seconds = decoded_seconds(&ffmpeg(), &saved, width, height, fps);
        let audio_seconds = decoded_audio_seconds(&ffmpeg(), &saved);
        let requested_sec = save_requested.duration_since(origin).as_secs() % 60;
        let save_done_sec = save_done.duration_since(origin).as_secs() % 60;
        let request_stream = save_requested.duration_since(origin).as_secs_f64();
        println!(
            "SAVE-WINDOW-AUDIO: requested_at={requested_sec}s done_at={save_done_sec}s video={video_seconds:.2}s audio={audio_seconds:.2}s"
        );
        assert!(
            video_seconds >= request_stream - 1.0,
            "saved clip video ends before the save request (video {video_seconds:.1}s, request at {request_stream:.1}s)"
        );
        assert!(
            audio_seconds >= request_stream - 1.0,
            "saved clip audio ends before the save request (audio {audio_seconds:.1}s, video {video_seconds:.1}s, request at {request_stream:.1}s)"
        );

        // The first A/V packet start offset must stay within one mixer block:
        // the new readback worker and low-latency encoder path must not trade
        // queue freshness for A/V drift.
        let ffprobe = ffmpeg().with_file_name("ffprobe.exe");
        assert!(
            ffprobe.exists(),
            "ffprobe.exe must sit at {}",
            ffprobe.display()
        );
        let starts = stream_start_times(&ffprobe, &saved);
        let video_start = starts
            .get("video")
            .copied()
            .expect("saved clip has a video stream start time");
        let audio_start = starts
            .get("audio")
            .copied()
            .expect("saved clip has an audio stream start time");
        let offset_ms = (video_start - audio_start).abs() * 1000.0;
        println!(
            "SAVE-WINDOW-AUDIO: video_start={video_start:.3}s audio_start={audio_start:.3}s offset={offset_ms:.1}ms block={block_ms}ms"
        );
        assert!(
            offset_ms <= block_ms as f64 + 5.0,
            "first A/V packet offset {offset_ms:.1}ms exceeds one {block_ms}ms mixer block (+5ms probe rounding)"
        );

        let _ = std::fs::remove_dir_all(&work);
    }
}
