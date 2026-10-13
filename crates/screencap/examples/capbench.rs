//! Capture-path benchmark: runs the real DXGI Desktop Duplication backend
//! (as `replay.rs` does) for a few seconds and reports the delivered frame
//! rate and per-thread CPU time, so the capture's overhead is measured in
//! isolation from the encoder/segmenter. The readback-worker counters prove
//! the capture stops doing GPU/CPU readback work on a static screen while the
//! pacer keeps delivering the configured FPS. The result line distinguishes
//! DXGI frames acquired, frames read back, pre-readback drops, cursor blends,
//! and pacer-delivered frames.
//!
//! Usage: `cargo run --release --example capbench -- <seconds> [fps=<n>] [cursor=true|false]`

use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};

use screencap::error::RunError;
use screencap::video::{CaptureStats, MonitorSpec, VideoFrame, VideoSettings};

fn main() {
    // Honor RUST_LOG so the capture readback stats log is visible.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();

    let args: Vec<String> = std::env::args().collect();
    let seconds: u64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(10);
    let mut fps: u32 = 60;
    let mut cursor = false;
    for a in args.iter().skip(2) {
        if let Some((k, v)) = a.split_once('=') {
            match k {
                "fps" => fps = v.parse().expect("fps must be a number"),
                "cursor" => cursor = v == "true" || v == "1",
                other => eprintln!("ignoring unknown option `{other}`"),
            }
        }
    }

    let settings = VideoSettings {
        monitor: MonitorSpec::Primary,
        fps,
        cursor,
    };
    let info = {
        let backend = screencap::video::create_backend(&settings).expect("backend");
        backend.resolve().expect("resolve")
    };
    println!(
        "geometry: {}x{} @ {}fps cursor={cursor}",
        info.width, info.height, info.fps
    );

    let (tx, rx): (Sender<VideoFrame>, Receiver<VideoFrame>) = crossbeam_channel::bounded(64);
    let rx2 = rx.clone();
    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded::<()>(8);
    let (err_tx, err_rx) = crossbeam_channel::bounded::<RunError>(16);

    let origin = Instant::now();
    let backend = screencap::video::create_backend(&settings).expect("backend");
    let stats: Option<std::sync::Arc<CaptureStats>> = backend.stats();
    backend
        .spawn(
            info,
            origin,
            tx.clone(),
            rx.clone(),
            err_tx.clone(),
            shutdown_rx.clone(),
        )
        .expect("spawn capture");

    // Consumer mirrors the segmenter's video writer drain (just discards here).
    let consumer = std::thread::spawn(move || {
        let mut frames = 0u64;
        let mut non_zero_frames = 0u64;
        let mut last_sum: u64 = 0;
        let mut varied = 0u64;
        loop {
            match rx2.recv_timeout(Duration::from_secs(2)) {
                Ok(frame) => {
                    frames += 1;
                    // Sanity: a live desktop is never all-black. Sum the first
                    // ~2MB of the frame; compare across frames for variety
                    // (the changed-frame checksum).
                    let data = frame.data;
                    let end = data.len().min(2_000_000);
                    let sum: u64 = data[..end].iter().map(|&b| b as u64).sum();
                    if sum != 0 {
                        non_zero_frames += 1;
                    }
                    if frames > 1 && sum != last_sum {
                        varied += 1;
                    }
                    last_sum = sum;
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) | Err(_) => break,
            }
        }
        (frames, non_zero_frames, varied)
    });

    std::thread::sleep(Duration::from_secs(seconds));
    for _ in 0..8 {
        let _ = shutdown_tx.try_send(());
    }
    let _ = tx.send(VideoFrame::new(
        Instant::now() - origin,
        2,
        2,
        screencap::video::nv12_black(2, 2),
    ));
    drop(tx);
    let (frames, non_zero, varied) = consumer.join().unwrap_or((0, 0, 0));
    let _ = err_rx.try_recv();

    let wall = origin.elapsed().as_secs_f64();
    let snap = stats.as_ref().map(|s| s.snapshot());
    let callbacks = snap.as_ref().map_or(0, |s| s.callbacks);
    let pre_readback_drops = snap.as_ref().map_or(0, |s| s.pre_readback_drops);
    let full = snap.as_ref().map_or(0, |s| s.full_copies);
    let partial = snap.as_ref().map_or(0, |s| s.partial_copies);
    let skipped = snap.as_ref().map_or(0, |s| s.skipped_empty_damage);
    let errors = snap.as_ref().map_or(0, |s| s.readback_errors);
    // DXGI delivered a changed frame for every readback plus every frame
    // dropped before readback; timeouts (no desktop change) are not acquires.
    let acquired = callbacks + pre_readback_drops;
    // `acquires + acquire_timeouts` is the number of polls made, so the pair
    // says how often the duplication had nothing new for us. `coalesced` and
    // `present_every_ms` say why: coalesced presents climbing means the
    // compositor produced frames this run dropped, while a stretched present
    // interval means the compositor itself went quiet.
    let timeouts = snap.as_ref().map_or(0, |s| s.acquire_timeouts);
    let mouse_only = snap.as_ref().map_or(0, |s| s.mouse_only_frames);
    let pending_drops = snap.as_ref().map_or(0, |s| s.pending_drops);
    let pending_max = snap.as_ref().map_or(0, |s| s.pending_depth_max);
    let duplicate_publishes = snap.as_ref().map_or(0, |s| s.duplicate_publishes);
    let coalesced = snap.as_ref().map_or(0, |s| s.coalesced_presents);
    let present_every_ms = snap.as_ref().map_or(0.0, |s| s.present_interval_ms);
    let polls = acquired + timeouts;
    let timeout_pct = if polls == 0 {
        0.0
    } else {
        100.0 * timeouts as f64 / polls as f64
    };
    println!(
        "RESULT wall={wall:.1}s pacer_delivered={frames} rate={:.1}fps acquired={acquired} readback={callbacks} pre_readback_drops={pre_readback_drops} polls={polls} acquire_timeouts={timeouts} mouse_only={mouse_only} pending_drops={pending_drops} pending_max={pending_max} duplicate_publishes={duplicate_publishes} timeout_pct={timeout_pct:.1} coalesced_presents={coalesced} present_every_ms={present_every_ms:.2} non_zero_frames={non_zero} varied_frames={varied} full_copies={full} partial_copies={partial} skipped_empty_damage={skipped} readback_errors={errors}",
        frames as f64 / wall
    );
}
