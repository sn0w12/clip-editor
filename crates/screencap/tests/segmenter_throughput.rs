//! Throughput harness for the real `spawn_segmenter` path: feeds paced frames
//! into the segmenter's video channel exactly like the live pacer and measures
//! how much stream-time FFmpeg produces per wall-second. Gated behind
//! `SCREENCAP_THROUGHPUT=1` because it runs real FFmpeg + named pipes.

#![cfg(windows)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::Sender;
use screencap::media::segmenter::{SegmentStore, SegmenterParams};
use screencap::video::{VideoFrame, VideoInfo};

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

#[test]
fn segmenter_keeps_pace_with_the_wall() {
    if std::env::var("SCREENCAP_THROUGHPUT").as_deref() != Ok("1") {
        eprintln!("SKIP: set SCREENCAP_THROUGHPUT=1 to run the segmenter throughput test");
        return;
    }
    let seconds: u64 = std::env::var("THROUGHPUT_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(30);
    let width: u32 = 1920;
    let height: u32 = 1080;
    let fps: u32 = 60;
    let frame_bytes = width as usize * height as usize * 4;

    let work = std::env::temp_dir().join(format!("screencap_tput_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();

    let store = Arc::new(SegmentStore::new(work.clone()));
    store.prepare().unwrap();

    let (video_tx, video_rx) = crossbeam_channel::bounded(60 * 2);
    let pacer_rx = video_rx.clone();
    let track_count = 0;
    let (_track_txs, track_rxs): (Vec<_>, Vec<_>) = (0..track_count)
        .map(|_| crossbeam_channel::bounded::<screencap::audio::TrackAudioBlock>(64))
        .unzip();

    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded(64);
    let (err_tx, err_rx) = crossbeam_channel::bounded(16);

    let done = screencap::media::segmenter::spawn_segmenter(
        SegmenterParams {
            ffmpeg: ffmpeg(),
            video: VideoInfo { width, height, fps },
            sample_rate: 48000,
            channels: 2,
            tracks: Vec::new(),
            codec: screencap::config::VideoCodec::H264Nvenc,
            quality: 28,
            segment_seconds: 1,
            buffer_dir: work.clone(),
            keep: Duration::from_secs(120),
        },
        store.clone(),
        video_rx,
        track_rxs,
        shutdown_rx,
        err_tx,
    )
    .expect("segmenter spawns");

    let origin = Instant::now();
    let mut next_tick = origin;
    let interval = Duration::from_micros(1_000_000 / fps as u64);
    let mut frame_no: u64 = 0;
    let deadline = origin + Duration::from_secs(seconds);
    // The pacer owns a clone; the main thread keeps one so the channel does
    // not disconnect before shutdown is broadcast (the writer must observe the
    // shutdown flag, not a producer-end error).
    let pacer_tx = video_tx.clone();
    let pacer = std::thread::spawn(move || {
        let mut sent = 0u64;
        let mut frame = vec![0u8; frame_bytes];
        while Instant::now() < deadline {
            let now = Instant::now();
            if now < next_tick {
                std::thread::sleep(next_tick - now);
                continue;
            }
            next_tick += interval;
            if next_tick < now {
                next_tick = now + interval;
            }
            frame_no += 1;
            for i in 0..4 {
                frame[i] = (frame_no as u8).wrapping_mul(31).wrapping_add(i as u8);
            }
            send_drop_oldest(
                &pacer_tx,
                &pacer_rx,
                VideoFrame::new(origin.elapsed(), width, height, frame.clone()),
            );
            sent += 1;
        }
        sent
    });

    // Drain any terminal errors into a shared log.
    let err_log: Arc<std::sync::Mutex<Vec<String>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
    let err_log2 = err_log.clone();
    let _err_thread = std::thread::spawn(move || {
        loop {
            match err_rx.recv_timeout(Duration::from_secs(1)) {
                Ok(e) => err_log2.lock().unwrap().push(e.to_string()),
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    if Instant::now() > deadline {
                        break;
                    }
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    let sent = pacer.join().unwrap();
    // Let the writer drain the tail, then shut down cleanly. The pacer's
    // channel stays alive until shutdown is broadcast.
    std::thread::sleep(Duration::from_millis(2000));
    for _ in 0..64 {
        let _ = shutdown_tx.try_send(());
    }
    drop(video_tx);
    let _ = done.recv_timeout(Duration::from_secs(20));

    let wall = origin.elapsed().as_secs_f64();

    // Sum recorded segment durations (they are 1s each).
    let mut produced = 0.0f64;
    let mut count = 0usize;
    // Read segments.txt directly (segmenter records after stability checks).
    let list = std::fs::read_to_string(work.join("segments.txt")).unwrap_or_default();
    for line in list.lines() {
        let f: Vec<&str> = line.trim().split(',').collect();
        if f.len() == 3 {
            let s: f64 = f[1].trim().parse().unwrap_or(0.0);
            let e: f64 = f[2].trim().parse().unwrap_or(0.0);
            produced += e - s;
            count += 1;
        }
    }

    let errors = err_log.lock().unwrap().clone();
    let speed = produced / wall;
    println!(
        "THROUGHPUT wall={wall:.1}s sent={sent} segments={count} produced={produced:.1}s speed={speed:.3}x",
    );
    assert!(
        errors.is_empty(),
        "segmenter reported terminal errors: {errors:?}"
    );
    // The whole point of this harness: the segmenter must keep up with the wall.
    assert!(
        speed > 0.9,
        "segmenter fell behind the wall (speed={speed:.3}x); content will lag the save moment"
    );

    let _ = std::fs::remove_dir_all(&work);
}
