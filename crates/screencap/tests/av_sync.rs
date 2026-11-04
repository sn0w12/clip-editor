//! End-to-end A/V sync: runs the real video feed thread (`spawn_pacer`), the
//! real segmenter and the real save path, with a visual step change and an
//! audio frequency step change at the same wall instant. The saved clip must
//! place both at the same stream time.
//!
//! The pacer is started 500 ms "late" (its origin lies in the past), which is
//! exactly the condition that used to make it drop ticks: with the frame index
//! rebased, the picture lags the audio and the two markers separate. Replaying
//! the missed ticks keeps the frame index on the wall clock.
//!
//! Gated behind `SCREENCAP_AV_SYNC_TEST=1` because it runs real FFmpeg.

#![cfg(windows)]

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use screencap::audio::TrackAudioBlock;
use screencap::config::{ResolvedTrack, Selector, VideoCodec};
use screencap::media::save::save_replay;
use screencap::media::segmenter::{DeliveryStats, SegmentStore, SegmenterParams, spawn_segmenter};
use screencap::video::{
    Latest, StopState, VIDEO_QUEUE_CAPACITY, VideoFrame, VideoInfo, spawn_pacer,
};

const WIDTH: u32 = 640;
const HEIGHT: u32 = 360;
const FPS: u32 = 30;
const SEGMENT_SECONDS: u32 = 1;
const RUN_SECONDS: u64 = 4;
const MARKER_MS: u64 = 2000;
const LATE_ORIGIN_MS: u64 = 500;
const RATE: u32 = 48000;

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

fn nv12(luma: u8) -> Vec<u8> {
    let y = (WIDTH * HEIGHT) as usize;
    let mut data = vec![luma; y];
    data.resize(y * 3 / 2, 128);
    data
}

fn decode_gray(ffmpeg: &PathBuf, clip: &PathBuf) -> Vec<u8> {
    let out = std::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(clip)
        .args([
            "-map",
            "0:v:0",
            "-vf",
            "scale=8:8",
            "-pix_fmt",
            "gray",
            "-f",
            "rawvideo",
            "-",
        ])
        .output()
        .expect("ffmpeg decodes video");
    assert!(out.status.success(), "video decode failed");
    out.stdout
}

fn decode_audio(ffmpeg: &PathBuf, clip: &PathBuf) -> Vec<f32> {
    let out = std::process::Command::new(ffmpeg)
        .args(["-hide_banner", "-loglevel", "error", "-i"])
        .arg(clip)
        .args(["-map", "0:a:0", "-f", "f32le", "-ac", "1", "-ar"])
        .arg(RATE.to_string())
        .arg("-")
        .output()
        .expect("ffmpeg decodes audio");
    assert!(out.status.success(), "audio decode failed");
    out.stdout
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn zero_crossings(window: &[f32]) -> usize {
    window
        .windows(2)
        .filter(|w| (w[0] < 0.0) != (w[1] < 0.0))
        .count()
}

#[test]
fn late_video_start_keeps_audio_and_video_markers_together() {
    if std::env::var("SCREENCAP_AV_SYNC_TEST").as_deref() != Ok("1") {
        eprintln!("SKIP: set SCREENCAP_AV_SYNC_TEST=1 to run the A/V sync test");
        return;
    }
    let ffmpeg = ffmpeg();
    let work = std::env::temp_dir().join(format!("screencap_sync_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    let buffer_dir = work.join("buffer");
    let out_dir = work.join("out");
    std::fs::create_dir_all(&buffer_dir).unwrap();
    std::fs::create_dir_all(&out_dir).unwrap();

    // The feed thread starts half a second after the clock it is fed, which is
    // what a blocked writer looks like to it.
    let origin = Instant::now() - Duration::from_millis(LATE_ORIGIN_MS);
    let store = Arc::new(SegmentStore::new(buffer_dir.clone()));
    store.prepare().unwrap();
    let delivery = Arc::new(DeliveryStats::default());
    let (video_tx, video_rx) = crossbeam_channel::bounded(VIDEO_QUEUE_CAPACITY);
    let pacer_rx = video_rx.clone();
    let (track_tx, track_rx) = crossbeam_channel::bounded(1200);
    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded(64);
    let (pacer_shutdown_tx, pacer_shutdown_rx) = crossbeam_channel::unbounded::<()>();
    let (err_tx, err_rx) = crossbeam_channel::bounded::<screencap::error::RunError>(16);

    let done = spawn_segmenter(
        SegmenterParams {
            ffmpeg: ffmpeg.clone(),
            video: VideoInfo {
                width: WIDTH,
                height: HEIGHT,
                fps: FPS,
            },
            sample_rate: RATE,
            channels: 2,
            tracks: vec![ResolvedTrack {
                number: 1,
                name: "all".to_string(),
                include: vec![Selector::AllProcesses],
                exclude: Vec::new(),
            }],
            codec: VideoCodec::LibX264,
            quality: 26,
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

    std::thread::spawn(move || {
        while let Ok(e) = err_rx.recv_timeout(Duration::from_secs(1)) {
            eprintln!("[segmenter] {e}");
        }
    });

    let latest = Arc::new(Mutex::new(Latest::default()));
    let stop = Arc::new(StopState::default());
    spawn_pacer(
        VideoInfo {
            width: WIDTH,
            height: HEIGHT,
            fps: FPS,
        },
        origin,
        video_tx.clone(),
        pacer_rx,
        pacer_shutdown_rx,
        latest.clone(),
        stop.clone(),
        Arc::new(AtomicBool::new(false)),
    )
    .expect("pacer spawns");

    // Capture side: a black desktop until the marker, then white.
    let capture_stop = stop.clone();
    let capture_latest = latest.clone();
    let capture = std::thread::spawn(move || {
        let interval = Duration::from_micros(1_000_000 / FPS as u64);
        let mut next = Instant::now();
        while !capture_stop.requested.load(Ordering::SeqCst) {
            let now = Instant::now();
            if now < next {
                std::thread::sleep((next - now).min(Duration::from_millis(5)));
                continue;
            }
            next += interval;
            let luma = if origin.elapsed() >= Duration::from_millis(MARKER_MS) {
                235
            } else {
                16
            };
            capture_latest.lock().push(VideoFrame::new(
                origin.elapsed(),
                WIDTH,
                HEIGHT,
                nv12(luma),
            ));
        }
    });

    // Mixer side: 1 kHz before the marker, 2 kHz after, released 250 ms behind
    // wall exactly as `mix_loop` releases blocks.
    let audio_tx = track_tx.clone();
    let audio_stop = stop.clone();
    let audio = std::thread::spawn(move || {
        let mut next_release = origin + Duration::from_millis(250);
        let mut frame_index: u64 = 0;
        while !audio_stop.requested.load(Ordering::SeqCst) {
            let now = Instant::now();
            if now < next_release {
                std::thread::sleep((next_release - now).min(Duration::from_millis(5)));
                continue;
            }
            let content_ms = frame_index as f64 * 1000.0 / RATE as f64;
            let hz = if content_ms >= MARKER_MS as f64 {
                2000.0
            } else {
                1000.0
            };
            let mut samples = Vec::with_capacity(960 * 2);
            for _ in 0..960 {
                let t = frame_index as f64 / RATE as f64;
                let v = (std::f64::consts::TAU * hz * t).sin() as f32 * 0.4;
                samples.push(v);
                samples.push(v);
                frame_index += 1;
            }
            let block = TrackAudioBlock {
                number: 1,
                name: "all".to_string(),
                pts: Duration::from_millis(content_ms as u64),
                sample_rate: RATE,
                channels: 2,
                samples,
            };
            if audio_tx
                .send_timeout(block, Duration::from_secs(1))
                .is_err()
            {
                break;
            }
            next_release += Duration::from_millis(20);
        }
    });

    std::thread::sleep(Duration::from_secs(RUN_SECONDS));
    let deadline = Instant::now() + Duration::from_secs(10);
    while store.available_seconds() < 3.0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(100));
    }
    let snapshot = store.snapshot();
    let saved = save_replay(
        &ffmpeg,
        snapshot,
        &buffer_dir,
        &out_dir,
        "SyncTest",
        "sync",
        30,
    )
    .expect("save works");

    stop.requested.store(true, Ordering::SeqCst);
    let _ = pacer_shutdown_tx.send(());
    let _ = capture.join();
    let _ = audio.join();
    for _ in 0..64 {
        let _ = shutdown_tx.try_send(());
    }
    let _ = done.recv_timeout(Duration::from_secs(30));
    drop(video_tx);
    drop(track_tx);

    // Video marker: the first bright frame.
    let gray = decode_gray(&ffmpeg, &saved);
    let frame_len = 8 * 8;
    let frames = gray.len() / frame_len;
    let bright = gray
        .chunks_exact(frame_len)
        .position(|f| f.iter().map(|v| *v as u32).sum::<u32>() / frame_len as u32 > 128)
        .expect("bright marker frame present");
    let video_ms = bright as f64 * 1000.0 / FPS as f64;

    // Audio marker: first 20 ms window dominated by 2 kHz (twice the crossings
    // of the 1 kHz tone).
    let pcm = decode_audio(&ffmpeg, &saved);
    let win = RATE as usize / 50; // 20 ms
    let audio_ms = (0..pcm.len().saturating_sub(win) / win)
        .map(|w| &pcm[w * win..(w + 1) * win])
        .position(|w| zero_crossings(w) > 60)
        .map(|w| w as f64 * 1000.0 / 50.0)
        .expect("audio frequency step present");

    println!(
        "SYNC: frames={frames} video_marker={video_ms:.0}ms audio_marker={audio_ms:.0}ms delta={:.0}ms",
        (video_ms - audio_ms).abs()
    );
    assert!(
        (video_ms - audio_ms).abs() <= 60.0,
        "audio and video markers {video_ms:.0}ms / {audio_ms:.0}ms differ by more than 60ms"
    );
    assert!(
        (video_ms - MARKER_MS as f64).abs() <= 120.0,
        "video marker at {video_ms:.0}ms, expected about {MARKER_MS}ms"
    );
    // A rebased (skipping) feed puts this marker 500 ms early, because the
    // late start is dropped from the frame index. The marker sitting on the
    // wall clock is the proof that the ticks were replayed.
    assert!(
        video_ms >= MARKER_MS as f64 - 120.0,
        "video marker at {video_ms:.0}ms is early: the late start was dropped"
    );
    let _ = std::fs::remove_dir_all(&work);
}
