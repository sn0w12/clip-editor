//! Harness for the capture->encode path, so the pipeline can be measured without
//! running the app or waiting an hour for it to degrade.
//!
//! Two modes:
//!
//! `pacer` runs the real feed thread against a consumer that blocks the way a
//! stalled encoder does, at several queue depths. No capture, no ffmpeg, a few
//! seconds. This is the deterministic reproduction of the defect: a blocking
//! write plus a one-frame handoff turns every frame produced during the block
//! into a repeat.
//!
//! `live` runs the real DXGI capture through the real feed thread and the real
//! segmenter into a temp directory, then decodes the segments with ffmpeg and
//! reports how much of the screen's real change survived. Put something moving
//! on the primary monitor (ffplay with a test pattern) before running it, or the
//! screen's own change rate is zero and the output is legitimately frozen.
//!
//! Usage:
//!   cargo run --release --example harness -- pacer
//!   cargo run --release --example harness -- live [seconds]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel;
use parking_lot::Mutex;

use screencap::config::VideoCodec;
use screencap::error::RunError;
use screencap::media::segmenter::{DeliveryStats, SegmentStore, SegmenterParams, spawn_segmenter};
use screencap::video::{
    Latest, MonitorSpec, StopState, VIDEO_QUEUE_CAPACITY, VideoFrame, VideoInfo, VideoSettings,
    create_backend, nv12_frame_bytes, spawn_pacer,
};

/// The first eight bytes of a synthetic frame carry its sequence number.
fn seq_of(data: &[u8]) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[..8]);
    u64::from_le_bytes(b)
}

struct Case {
    slots: usize,
    hold_ms: u64,
    published: u64,
    delivered: u64,
    distinct: u64,
    repeats: u64,
    drops: u64,
    depth_max: usize,
}

/// One run of the feed thread with a producer at the stream rate and a consumer
/// that blocks for `hold_ms` once per second.
fn pacer_case(slots: usize, hold_ms: u64, seconds: f64) -> Case {
    let info = VideoInfo {
        width: 8,
        height: 8,
        fps: 60,
    };
    let (tx, rx) = crossbeam_channel::bounded::<VideoFrame>(VIDEO_QUEUE_CAPACITY);
    let pacer_rx = rx.clone();
    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded::<()>(64);
    let origin = Instant::now();
    let latest = Arc::new(Mutex::new(Latest::with_capacity(slots)));
    let stop = Arc::new(StopState::default());
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    spawn_pacer(
        info,
        origin,
        tx.clone(),
        pacer_rx,
        shutdown_rx.clone(),
        latest.clone(),
        stop,
        done.clone(),
    )
    .expect("pacer spawns");

    let consumer = thread::spawn(move || {
        let (mut delivered, mut distinct, mut repeats) = (0u64, 0u64, 0u64);
        let mut last: Option<u64> = None;
        let mut since_hold = 0u64;
        loop {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(frame) => {
                    let id = seq_of(&frame.data);
                    if last == Some(id) {
                        repeats += 1;
                    } else {
                        distinct += 1;
                    }
                    last = Some(id);
                    delivered += 1;
                    since_hold += 1;
                    if since_hold >= 60 {
                        since_hold = 0;
                        thread::sleep(Duration::from_millis(hold_ms));
                    }
                }
                Err(_) => break,
            }
        }
        (delivered, distinct, repeats)
    });

    let (mut published, mut drops, mut depth_max) = (0u64, 0u64, 0usize);
    let interval = Duration::from_micros(1_000_000 / 60);
    let mut next = origin;
    let deadline = origin + Duration::from_secs_f64(seconds);
    let mut seq = 0u64;
    while Instant::now() < deadline {
        let now = Instant::now();
        if now < next {
            thread::sleep(next - now);
            continue;
        }
        next += interval;
        seq += 1;
        let mut data = vec![0u8; nv12_frame_bytes(info.width, info.height)];
        data[..8].copy_from_slice(&seq.to_le_bytes());
        let (dropped, depth) = latest
            .lock()
            .push(VideoFrame::new(origin.elapsed(), info.width, info.height, data));
        if dropped {
            drops += 1;
        }
        if depth > depth_max {
            depth_max = depth;
        }
        published += 1;
    }

    for _ in 0..64 {
        let _ = shutdown_tx.try_send(());
    }
    drop(tx);
    done.store(true, Ordering::SeqCst);
    let (delivered, distinct, repeats) = consumer.join().unwrap_or((0, 0, 0));

    Case {
        slots,
        hold_ms,
        published,
        delivered,
        distinct,
        repeats,
        drops,
        depth_max,
    }
}

fn run_pacer() {
    println!("feed thread against a consumer that blocks for hold_ms once per second");
    println!();
    println!("slots | hold | published | delivered | distinct | repeats | dropped | maxDepth");
    println!("------+------+-----------+-----------+----------+---------+---------+---------");
    for slots in [1usize, 4, 16] {
        for hold_ms in [0u64, 100, 200] {
            let c = pacer_case(slots, hold_ms, 5.0);
            println!(
                "{:5} | {:4} | {:9} | {:9} | {:8} | {:7} | {:7} | {:8}",
                c.slots,
                c.hold_ms,
                c.published,
                c.delivered,
                c.distinct,
                c.repeats,
                c.drops,
                c.depth_max
            );
        }
        println!("------+------+-----------+-----------+----------+---------+---------+---------");
    }
    println!();
    println!("distinct + dropped should equal published: every frame the capture");
    println!("published is either handed to the encoder or counted as a drop.");
}

/// Per-frame luma change of one segment, in decode order.
fn frame_deltas(ffmpeg: &str, segment: &Path, work: &Path) -> Vec<f64> {
    let _ = std::fs::remove_file(work.join("d.txt"));
    let filter = "tblend=all_mode=difference,format=gray,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=d.txt";
    let _ = std::process::Command::new(ffmpeg)
        .current_dir(work)
        .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-i"])
        .arg(segment.file_name().unwrap_or_default())
        .args(["-an", "-vf", filter, "-f", "null", "-"])
        .output();
    let mut out = Vec::new();
    if let Ok(text) = std::fs::read_to_string(work.join("d.txt")) {
        for line in text.lines() {
            if let Some(rest) = line.strip_prefix("lavfi.signalstats.YAVG=") {
                if let Ok(v) = rest.trim().parse::<f64>() {
                    out.push(v);
                }
            }
        }
    }
    out
}

fn run_live(seconds: u64, audio_tracks: usize, audio_lag_ms: u64) {
    let settings = VideoSettings {
        monitor: MonitorSpec::Primary,
        fps: 60,
        cursor: false,
    };
    let info = {
        let backend = create_backend(&settings).expect("backend");
        backend.resolve().expect("resolve")
    };
    println!(
        "live capture {}x{} @ {} fps for {}s, {audio_tracks} audio tracks trailing the video by {audio_lag_ms} ms",
        info.width, info.height, info.fps, seconds
    );

    let work = std::env::temp_dir().join(format!("screencap_harness_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).expect("create work dir");
    let store = Arc::new(SegmentStore::new(work.clone()));
    store.prepare().expect("prepare store");

    let delivery = Arc::new(DeliveryStats::default());
    let origin = Instant::now();
    let (video_tx, video_rx) = crossbeam_channel::bounded::<VideoFrame>(VIDEO_QUEUE_CAPACITY);
    let pacer_rx = video_rx.clone();
    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded::<()>(64);
    let (err_tx, err_rx) = crossbeam_channel::bounded::<RunError>(16);

    // Silent tracks at the mixer's cadence: one 20 ms block per track per
    // window, started `audio_lag_ms` after the video so the audio stream trails
    // the video's exactly the way the live mixer's latency makes it. Without
    // tracks the muxer never has a reason to hold video, which is why the first
    // 45 minute run of this harness stayed flat.
    let mut tracks = Vec::new();
    let mut track_rxs = Vec::new();
    let mut track_txs = Vec::new();
    for i in 0..audio_tracks {
        tracks.push(screencap::config::ResolvedTrack {
            number: (i + 1) as u16,
            name: format!("harness{}", i + 1),
            include: Vec::new(),
            exclude: Vec::new(),
        });
        let (tx, rx) = crossbeam_channel::bounded::<screencap::audio::TrackAudioBlock>(64);
        track_txs.push(tx);
        track_rxs.push(rx);
    }

    let done = spawn_segmenter(
        SegmenterParams {
            ffmpeg: PathBuf::from("ffmpeg"),
            video: info,
            sample_rate: 48000,
            channels: 2,
            tracks,
            codec: VideoCodec::H264Nvenc,
            quality: 23,
            segment_seconds: 1,
            buffer_dir: work.clone(),
            keep: Duration::from_secs(300),
            capture_origin: origin,
            delivery: delivery.clone(),
        },
        store.clone(),
        video_rx,
        track_rxs,
        shutdown_rx.clone(),
        err_tx.clone(),
    )
    .expect("segmenter spawns");

    let run_deadline = origin + Duration::from_secs(seconds);
    for (i, tx) in track_txs.into_iter().enumerate() {
        let lag = Duration::from_millis(audio_lag_ms);
        // Outlive the video shutdown by ten seconds so the muxer is never
        // starved of audio while the video pipe drains; otherwise the drain
        // looks like a stalled producer and freezes the encoder.
        let feeder_deadline = run_deadline + Duration::from_secs(10);
        thread::spawn(move || {
            thread::sleep(lag);
            let block = vec![0f32; 960 * 2];
            let mut next = Instant::now();
            while Instant::now() < feeder_deadline {
                if tx
                    .send(screencap::audio::TrackAudioBlock {
                        number: (i + 1) as u16,
                        name: format!("harness{}", i + 1),
                        pts: origin.elapsed(),
                        sample_rate: 48000,
                        channels: 2,
                        samples: block.clone(),
                    })
                    .is_err()
                {
                    break;
                }
                next += Duration::from_millis(20);
                let now = Instant::now();
                if now < next {
                    thread::sleep(next - now);
                } else {
                    next = now;
                }
            }
        });
    }

    let backend = create_backend(&settings).expect("backend");
    let stats = backend.stats();
    backend
        .spawn(
            info,
            origin,
            video_tx,
            pacer_rx,
            err_tx,
            shutdown_rx.clone(),
        )
        .expect("capture spawns");

    // Report the pipeline's own trend, since the defect this harness exists for
    // shows up as a drift in the writer's blocked time over tens of minutes, not
    // as a step.
    let started = Instant::now();
    let deadline = started + Duration::from_secs(seconds);
    let mut next_report = started + Duration::from_secs(5);
    let mut last_written = 0u64;
    println!();
    println!("    t  publishes  pending_max  pending_drops  dup_publishes  write_mean_ms  write_max_ms  queue  frame_age_ms");
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
        if Instant::now() < next_report {
            continue;
        }
        next_report = Instant::now() + Duration::from_secs(5);
        let d = delivery.take_snapshot();
        let window_written = d.written.saturating_sub(last_written).max(1);
        last_written = d.written;
        let (publishes, dup, depth_max, drops) = stats
            .as_ref()
            .map(|s| {
                let snap = s.snapshot();
                (
                    snap.callbacks + snap.pre_readback_drops,
                    snap.duplicate_publishes,
                    snap.pending_depth_max,
                    snap.pending_drops,
                )
            })
            .unwrap_or((0, 0, 0, 0));
        println!(
            "{:5.0}  {:8}  {:11}  {:13}  {:13}  {:13.2}  {:12.2}  {:5}  {:12}",
            started.elapsed().as_secs_f64(),
            publishes,
            depth_max,
            drops,
            dup,
            d.write_nanos as f64 / 1e6 / window_written as f64,
            d.write_max_nanos as f64 / 1e6,
            d.max_queue_depth,
            d.max_frame_age_micros / 1000
        );
    }
    for _ in 0..64 {
        let _ = shutdown_tx.try_send(());
    }
    let _ = done.recv_timeout(Duration::from_secs(20));
    thread::sleep(Duration::from_millis(500));

    if let Ok(e) = err_rx.try_recv() {
        println!("run error: {e}");
    }

    let mut segments: Vec<PathBuf> = std::fs::read_dir(&work)
        .map(|d| {
            d.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.extension().and_then(|s| s.to_str()) == Some("mkv")
                        && p.metadata().map(|m| m.len() > 0).unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    segments.sort();
    println!("segments written: {}", segments.len());

    report_segments(&work, &segments);

    println!();
    if let Some(s) = stats.as_ref().map(|s| s.snapshot()) {
        println!(
            "capture: publishes={} acquires={} mouse_only={} timeouts={} duplicate_publishes={} pending_max={} pending_drops={} coalesced={} tick_overruns={}",
            s.callbacks + s.pre_readback_drops,
            s.acquires,
            s.mouse_only_frames,
            s.acquire_timeouts,
            s.duplicate_publishes,
            s.pending_depth_max,
            s.pending_drops,
            s.coalesced_presents,
            s.tick_overruns
        );
    }
    let d = delivery.take_snapshot();
    let written = d.written.max(1);
    println!(
        "writer: written={} mean_write_ms={:.2} max_write_ms={:.2} max_queue_depth={} max_frame_age_ms={}",
        d.written,
        d.write_nanos as f64 / 1e6 / written as f64,
        d.write_max_nanos as f64 / 1e6,
        d.max_queue_depth,
        d.max_frame_age_micros / 1000
    );
    let _ = std::fs::remove_dir_all(&work);
}

fn report_segments(work: &Path, segments: &[PathBuf]) {
    // Measure a window from the middle of the run. The last seconds of any run
    // span the shutdown, where the video pipe drains and the encoder flushes, so
    // they are frozen for reasons that have nothing to do with the pipeline
    // under load.
    let end = segments.len().saturating_sub(20);
    let start = end.saturating_sub(6);
    let mut change_rates = Vec::new();
    let mut identical_pct = Vec::new();
    let mut near_pct = Vec::new();
    println!();
    println!("segment            frames  changes(>=1.0)  identical(<0.05)  near(<0.5)  runs(<0.05)  runs(<0.5)");
    for seg in &segments[start..end] {
        let deltas = frame_deltas("ffmpeg", seg, work);
        if deltas.is_empty() {
            continue;
        }
        let changes = deltas.iter().filter(|d| **d >= 1.0).count();
        let identical = deltas.iter().filter(|d| **d < 0.05).count();
        let near = deltas.iter().filter(|d| **d < 0.5).count();
        // The encoder does not reproduce an identical frame identically, so a
        // re-sent frame can land anywhere below ~1.0. The run structure is the
        // trustworthy signal: a hold-driven repeat is a run, a re-send shows as
        // a run at the wider threshold, and encoder noise does not make runs.
        let runs_at = |limit: f64| -> Vec<usize> {
            let pattern: String = deltas
                .iter()
                .map(|d| if *d < limit { 'F' } else { '.' })
                .collect();
            pattern
                .split('.')
                .filter(|s| !s.is_empty())
                .map(|s| s.len())
                .collect()
        };
        change_rates.push(changes as f64);
        identical_pct.push(100.0 * identical as f64 / deltas.len() as f64);
        near_pct.push(100.0 * near as f64 / deltas.len() as f64);
        println!(
            "{:18} {:6}  {:13}  {:5}/{:5}  {:5}/{:5}  {:?}  {:?}",
            seg.file_name().unwrap_or_default().to_string_lossy(),
            deltas.len(),
            changes,
            identical,
            deltas.len(),
            near,
            deltas.len(),
            runs_at(0.05),
            runs_at(0.5)
        );
    }
    if !change_rates.is_empty() {
        let n = change_rates.len() as f64;
        println!();
        println!(
            "mean real changes/s: {:.1}   mean identical(<0.05): {:.1}%   mean near-identical(<0.5): {:.1}%",
            change_rates.iter().sum::<f64>() / n,
            identical_pct.iter().sum::<f64>() / n,
            near_pct.iter().sum::<f64>() / n
        );
    }
}

/// End-to-end frame fidelity with a known input: a deterministic sequence with a
/// different luma level every frame, pushed through the real feed thread and the
/// real segmenter with real audio tracks, then decoded and counted. A repeat in
/// the output is a frame the pipeline failed to carry, with no screen and no
/// stimulus involved, so the expected answer is exactly known: zero repeats and
/// one change per frame.
fn run_synthetic(seconds: u64, audio_tracks: usize, audio_lag_ms: u64, slots: usize) {
    let info = VideoInfo {
        width: 1920,
        height: 1080,
        fps: 60,
    };
    println!(
        "synthetic {0}x{1} @ {2} fps for {seconds}s, {audio_tracks} tracks trailing {audio_lag_ms} ms, {slots} queue slots",
        info.width, info.height, info.fps
    );
    let work = std::env::temp_dir().join(format!("screencap_synth_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).expect("create work dir");
    let store = Arc::new(SegmentStore::new(work.clone()));
    store.prepare().expect("prepare store");

    let delivery = Arc::new(DeliveryStats::default());
    let origin = Instant::now();
    let (video_tx, video_rx) = crossbeam_channel::bounded::<VideoFrame>(VIDEO_QUEUE_CAPACITY);
    let pacer_rx = video_rx.clone();
    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded::<()>(64);
    let (err_tx, err_rx) = crossbeam_channel::bounded::<RunError>(16);

    let mut tracks = Vec::new();
    let mut track_rxs = Vec::new();
    let mut track_txs = Vec::new();
    for i in 0..audio_tracks {
        tracks.push(screencap::config::ResolvedTrack {
            number: (i + 1) as u16,
            name: format!("harness{}", i + 1),
            include: Vec::new(),
            exclude: Vec::new(),
        });
        let (tx, rx) = crossbeam_channel::bounded::<screencap::audio::TrackAudioBlock>(64);
        track_txs.push(tx);
        track_rxs.push(rx);
    }

    let done = spawn_segmenter(
        SegmenterParams {
            ffmpeg: PathBuf::from("ffmpeg"),
            video: info,
            sample_rate: 48000,
            channels: 2,
            tracks,
            codec: VideoCodec::H264Nvenc,
            quality: 23,
            segment_seconds: 1,
            buffer_dir: work.clone(),
            keep: Duration::from_secs(300),
            capture_origin: origin,
            delivery: delivery.clone(),
        },
        store.clone(),
        video_rx,
        track_rxs,
        shutdown_rx.clone(),
        err_tx.clone(),
    )
    .expect("segmenter spawns");

    let run_deadline = origin + Duration::from_secs(seconds);
    for (i, tx) in track_txs.into_iter().enumerate() {
        let feeder_deadline = run_deadline + Duration::from_secs(10);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(audio_lag_ms));
            let block = vec![0f32; 960 * 2];
            let mut next = Instant::now();
            while Instant::now() < feeder_deadline {
                if tx
                    .send(screencap::audio::TrackAudioBlock {
                        number: (i + 1) as u16,
                        name: format!("harness{}", i + 1),
                        pts: origin.elapsed(),
                        sample_rate: 48000,
                        channels: 2,
                        samples: block.clone(),
                    })
                    .is_err()
                {
                    break;
                }
                next += Duration::from_millis(20);
                let now = Instant::now();
                if now < next {
                    thread::sleep(next - now);
                } else {
                    next = now;
                }
            }
        });
    }

    let latest = Arc::new(Mutex::new(Latest::with_capacity(slots)));
    let stop = Arc::new(StopState::default());
    let pacer_done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    spawn_pacer(
        info,
        origin,
        video_tx,
        pacer_rx,
        shutdown_rx.clone(),
        latest.clone(),
        stop,
        pacer_done.clone(),
    )
    .expect("pacer spawns");

    // Publisher: one frame per interval, luma stepping so consecutive frames are
    // far apart and any repeat in the output shows as a near-zero delta.
    let (mut published, mut drops, mut depth_max) = (0u64, 0u64, 0u64);
    let luma = info.width as usize * info.height as usize;
    let frame_len = nv12_frame_bytes(info.width, info.height);
    let interval = Duration::from_micros(1_000_000 / info.fps as u64);
    let mut next = origin;
    let mut seq = 0u64;
    let started = Instant::now();
    let mut next_report = started + Duration::from_secs(5);
    let mut last_written = 0u64;
    println!();
    println!("    t  published  pending_max  pending_drops  written  written/s (window)");
    while Instant::now() < run_deadline {
        let now = Instant::now();
        if now < next {
            thread::sleep(next - now);
            continue;
        }
        next += interval;
        seq += 1;
        let mut data = vec![128u8; frame_len];
        let level = 16 + ((seq * 97) % 220) as u8;
        data[..luma].fill(level);
        let (dropped, depth) = latest
            .lock()
            .push(VideoFrame::new(origin.elapsed(), info.width, info.height, data));
        if dropped {
            drops += 1;
        }
        depth_max = depth_max.max(depth as u64);
        published += 1;
        if Instant::now() >= next_report {
            next_report = Instant::now() + Duration::from_secs(5);
            let w = delivery.take_snapshot().written;
            let window_s = 5.0;
            println!(
                "{:5.0}  {:9}  {:11}  {:13}  {:7}  {:18.2}",
                started.elapsed().as_secs_f64(),
                published,
                depth_max,
                drops,
                w,
                w.saturating_sub(last_written) as f64 / window_s
            );
            last_written = w;
        }
    }

    for _ in 0..64 {
        let _ = shutdown_tx.try_send(());
    }
    let _ = done.recv_timeout(Duration::from_secs(20));
    thread::sleep(Duration::from_millis(500));
    if let Ok(e) = err_rx.try_recv() {
        println!("run error: {e}");
    }

    let mut segments: Vec<PathBuf> = std::fs::read_dir(&work)
        .map(|d| {
            d.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    p.extension().and_then(|s| s.to_str()) == Some("mkv")
                        && p.metadata().map(|m| m.len() > 0).unwrap_or(false)
                })
                .collect()
        })
        .unwrap_or_default();
    segments.sort();
    println!(
        "published={published} pending_drops={drops} pending_max={depth_max} segments={}",
        segments.len()
    );
    report_segments(&work, &segments);

    let d = delivery.take_snapshot();
    let written = d.written.max(1);
    println!(
        "writer: written={} mean_write_ms={:.2} max_write_ms={:.2} max_queue_depth={} max_frame_age_ms={}",
        d.written,
        d.write_nanos as f64 / 1e6 / written as f64,
        d.write_max_nanos as f64 / 1e6,
        d.max_queue_depth,
        d.max_frame_age_micros / 1000
    );
    let _ = std::fs::remove_dir_all(&work);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(|s| s.as_str()).unwrap_or("pacer") {
        "pacer" => run_pacer(),
        "live" => {
            let seconds = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(20);
            let mut audio_tracks = 0usize;
            let mut audio_lag_ms = 250u64;
            for a in args.iter().skip(3) {
                if let Some((k, v)) = a.split_once('=') {
                    match k {
                        "tracks" => audio_tracks = v.parse().unwrap_or(0),
                        "lag-ms" => audio_lag_ms = v.parse().unwrap_or(0),
                        other => eprintln!("ignoring unknown option `{other}`"),
                    }
                }
            }
            run_live(seconds, audio_tracks, audio_lag_ms);
        }
        "synthetic" => {
            let seconds = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(30);
            let mut audio_tracks = 5usize;
            let mut audio_lag_ms = 250u64;
            let mut slots = screencap::video::PENDING_FRAMES;
            for a in args.iter().skip(3) {
                if let Some((k, v)) = a.split_once('=') {
                    match k {
                        "tracks" => audio_tracks = v.parse().unwrap_or(0),
                        "lag-ms" => audio_lag_ms = v.parse().unwrap_or(0),
                        "slots" => slots = v.parse().unwrap_or(screencap::video::PENDING_FRAMES),
                        other => eprintln!("ignoring unknown option `{other}`"),
                    }
                }
            }
            run_synthetic(seconds, audio_tracks, audio_lag_ms, slots);
        }
        other => eprintln!("unknown mode `{other}`; use `pacer`, `live` or `synthetic`"),
    }
}
