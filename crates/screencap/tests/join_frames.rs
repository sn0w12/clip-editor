//! Join frame accounting: saves a clip from several live segments and asserts
//! the saved clip contains exactly the frames the segments held.
//!
//! This is the regression net for the save-time concat. The concat demuxer
//! rebuilds the timeline from each file's declared duration and inpoint, so a
//! mismatch there silently drops a frame (and a slice of audio) at *every*
//! segment join — a 30 s clip with 1 s segments has 30 joins, which is exactly
//! the "the clip skips a lot of frames" failure mode. Duration bounds (checked
//! by the save-window tests) cannot see it: one missing frame per join is well
//! inside those tolerances.
//!
//! Gated behind `SCREENCAP_JOIN_TEST=1` because it runs real FFmpeg and named
//! pipes, and needs `ffmpeg.exe` beside the test binary.

#![cfg(windows)]

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use screencap::audio::TrackAudioBlock;
use screencap::config::{ResolvedTrack, Selector, VideoCodec};
use screencap::media::save::save_replay;
use screencap::media::segmenter::{DeliveryStats, SegmentStore, SegmenterParams, spawn_segmenter};
use screencap::video::{VIDEO_QUEUE_CAPACITY, VideoFrame, VideoInfo};

const WIDTH: u32 = 640;
const HEIGHT: u32 = 360;
const FPS: u32 = 30;
const SEGMENT_SECONDS: u32 = 1;
const RUN_SECONDS: u64 = 6;

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

/// `ffprobe` beside `ffmpeg` when the app bundles it, else `ffprobe` from
/// `PATH`; `None` lets the test skip on a machine without a full FFmpeg build
/// rather than failing on a missing probe. The probe flags below belong to
/// `ffprobe`, which `ffmpeg.exe` does not accept.
fn ffprobe() -> Option<PathBuf> {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("target");
    p.push(if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    });
    p.push("ffprobe.exe");
    if p.exists() {
        return Some(p);
    }
    let on_path = PathBuf::from("ffprobe");
    Command::new(&on_path)
        .arg("-version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|_| on_path)
}

/// Frames decoded from the first video stream.
fn decoded_frames(ffprobe: &PathBuf, path: &PathBuf) -> u64 {
    let output = Command::new(ffprobe)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .expect("ffprobe runs");
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<u64>()
        .unwrap_or_else(|_| panic!("no frame count for {}", path.display()))
}

fn container_seconds(ffprobe: &PathBuf, path: &PathBuf) -> f64 {
    let output = Command::new(ffprobe)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .expect("ffprobe runs");
    String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<f64>()
        .unwrap_or_else(|_| panic!("no duration for {}", path.display()))
}

/// Feed a moving pattern (so the encoder has real work and every frame is a
/// distinct packet) and silent audio, then save and compare frame counts.
#[test]
fn saved_clip_keeps_every_segment_frame_across_joins() {
    if std::env::var("SCREENCAP_JOIN_TEST").as_deref() != Ok("1") {
        eprintln!("SKIP: set SCREENCAP_JOIN_TEST=1 to run the join frame accounting test");
        return;
    }
    let ffmpeg = ffmpeg();
    let Some(ffprobe) = ffprobe() else {
        eprintln!("SKIP: no ffprobe next to ffmpeg.exe and none on PATH");
        return;
    };
    let work = std::env::temp_dir().join(format!("screencap_join_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    let buffer_dir = work.join("buffer");
    let out_dir = work.join("out");
    std::fs::create_dir_all(&buffer_dir).unwrap();
    std::fs::create_dir_all(&out_dir).unwrap();

    let store = Arc::new(SegmentStore::new(buffer_dir.clone()));
    store.prepare().unwrap();
    let delivery = Arc::new(DeliveryStats::default());
    let (video_tx, video_rx) = crossbeam_channel::bounded(VIDEO_QUEUE_CAPACITY);
    let (track_tx, track_rx) = crossbeam_channel::bounded(1200);
    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded(64);
    let (err_tx, err_rx) = crossbeam_channel::bounded::<screencap::error::RunError>(16);
    let origin = Instant::now();

    let done = spawn_segmenter(
        SegmenterParams {
            ffmpeg: ffmpeg.clone(),
            video: VideoInfo {
                width: WIDTH,
                height: HEIGHT,
                fps: FPS,
            },
            sample_rate: 48000,
            channels: 2,
            tracks: vec![ResolvedTrack {
                number: 1,
                name: "all".to_string(),
                include: vec![Selector::AllProcesses],
                exclude: Vec::new(),
            }],
            // libx264 keeps the test runnable on any machine (no GPU needed) and
            // exercises the same segment/concat path.
            codec: VideoCodec::LibX264,
            quality: 28,
            segment_seconds: SEGMENT_SECONDS,
            buffer_dir: buffer_dir.clone(),
            keep: Duration::from_secs(120),
            capture_origin: origin,
            delivery: delivery.clone(),
        },
        store.clone(),
        video_rx,
        vec![track_rx],
        shutdown_rx,
        err_tx,
    )
    .expect("segmenter spawns");

    let errors: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let errors_sink = errors.clone();
    std::thread::spawn(move || {
        while let Ok(e) = err_rx.recv_timeout(Duration::from_secs(1)) {
            errors_sink.lock().unwrap().push(e.to_string());
        }
    });

    let stop = Arc::new(AtomicBool::new(false));
    let y_len = WIDTH as usize * HEIGHT as usize;
    let frame_bytes = y_len * 3 / 2;
    let pacer_tx = video_tx.clone();
    let pacer_stop = stop.clone();
    let pacer = std::thread::spawn(move || {
        let interval = Duration::from_micros(1_000_000 / FPS as u64);
        let mut next_tick = origin;
        let mut tick: u64 = 0;
        while !pacer_stop.load(Ordering::SeqCst) {
            let now = Instant::now();
            if now < next_tick {
                std::thread::sleep((next_tick - now).min(Duration::from_millis(5)));
                continue;
            }
            next_tick += interval;
            if next_tick < now {
                next_tick = now + interval;
            }
            // A moving band in the luma plane, neutral chroma: distinct NV12
            // frames, so no two packets collapse.
            let mut pixels = vec![128u8; frame_bytes];
            let shift = (tick * 4) as usize % HEIGHT as usize;
            for y in 0..HEIGHT as usize {
                let value = (((y + shift) % 256) as u8).wrapping_add((tick % 256) as u8);
                for x in 0..WIDTH as usize {
                    pixels[y * WIDTH as usize + x] = value;
                }
            }
            tick += 1;
            let frame = VideoFrame::new(origin.elapsed(), WIDTH, HEIGHT, pixels);
            loop {
                match pacer_tx.send_timeout(frame.clone(), Duration::from_millis(50)) {
                    Ok(()) => break,
                    Err(crossbeam_channel::SendTimeoutError::Timeout(_)) => {
                        if pacer_stop.load(Ordering::SeqCst) {
                            return;
                        }
                    }
                    Err(crossbeam_channel::SendTimeoutError::Disconnected(_)) => return,
                }
            }
        }
    });

    let audio_tx = track_tx.clone();
    let audio_stop = stop.clone();
    let audio = std::thread::spawn(move || {
        let block_frames = (20u64 * 48000 / 1000) as usize;
        let mut next = origin;
        while !audio_stop.load(Ordering::SeqCst) {
            let now = Instant::now();
            if now < next {
                std::thread::sleep((next - now).min(Duration::from_millis(5)));
                continue;
            }
            next += Duration::from_millis(20);
            if next < now {
                next = now + Duration::from_millis(20);
            }
            let block = TrackAudioBlock {
                number: 1,
                name: "all".to_string(),
                pts: origin.elapsed(),
                sample_rate: 48000,
                channels: 2,
                samples: vec![0f32; block_frames * 2],
            };
            if audio_tx.try_send(block).is_err() {
                break;
            }
        }
    });

    // Run long enough for several whole segments to close and be indexed, then
    // save from the live store exactly as the replay supervisor does.
    std::thread::sleep(Duration::from_secs(RUN_SECONDS));
    let deadline = Instant::now() + Duration::from_secs(10);
    while store.available_seconds() < (SEGMENT_SECONDS as f64 * 3.0) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    let snapshot = store.snapshot();
    let selected: Vec<PathBuf> = snapshot.segments().iter().map(|s| s.path.clone()).collect();
    assert!(
        selected.len() >= 3,
        "the run must produce at least three closed segments to exercise joins, got {}",
        selected.len()
    );

    // Ask for more than the buffer holds so every indexed segment is selected:
    // the assertion below is only meaningful for the segments that went in.
    let saved = save_replay(
        &ffmpeg,
        snapshot,
        &buffer_dir,
        &out_dir,
        "JoinTest",
        "join",
        RUN_SECONDS as u32 * 4,
    )
    .expect("save_replay succeeds");

    stop.store(true, Ordering::SeqCst);
    let _ = pacer.join();
    let _ = audio.join();
    for _ in 0..64 {
        let _ = shutdown_tx.try_send(());
    }
    let _ = done.recv_timeout(Duration::from_secs(30));
    drop(video_tx);
    drop(track_tx);

    let terminal = errors.lock().unwrap().clone();
    assert!(
        terminal.is_empty(),
        "segmenter terminal errors: {terminal:?}"
    );

    let clip_frames = decoded_frames(&ffprobe, &saved);
    let mut segment_frames = 0u64;
    for segment in &selected {
        segment_frames += decoded_frames(&ffprobe, segment);
    }
    let clip_seconds = container_seconds(&ffprobe, &saved);
    println!(
        "JOIN-FRAMES: segments={} clip_frames={clip_frames} segment_frames={segment_frames} \
         clip_seconds={clip_seconds:.3} clip_rate={:.2}fps",
        selected.len(),
        clip_frames as f64 / clip_seconds.max(1e-3)
    );

    assert_eq!(
        clip_frames,
        segment_frames,
        "the saved clip must hold exactly the frames the segments held; a gap of {} frame(s) \
         across {} joins means the concat join is dropping video",
        segment_frames as i64 - clip_frames as i64,
        selected.len().saturating_sub(1)
    );
    // Sanity: the clip is the recorded video, not a trimmed or stretched copy
    // of it (the container duration carries the audio overhang, hence the
    // one-frame-plus-slack tolerance).
    let video_span = clip_frames as f64 / FPS as f64;
    assert!(
        (video_span - clip_seconds).abs() <= 0.5,
        "clip video span {video_span:.3}s disagrees with its container duration {clip_seconds:.3}s"
    );

    let _ = std::fs::remove_dir_all(&work);
}
