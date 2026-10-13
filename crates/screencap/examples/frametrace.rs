//! Diagnostic: run the real capture backend and count how many of the frames
//! that arrive at the encoder are distinct images.
//!
//! A repeated frame in a saved clip can only come from two places: the capture
//! and its feed thread never produced a new image (so the repeats are the real
//! content), or they did and something between the feed thread and the file
//! replaced them. This counts repeats at the encoder's input, so the two cases
//! are distinguishable without guessing.
//!
//! Usage: `cargo run --release --example frametrace -- <seconds>`

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};

use screencap::error::RunError;
use screencap::video::{CaptureStats, MonitorSpec, VideoFrame, VideoSettings};

/// FNV-1a over a stride of the NV12 payload plus the length. The stride is
/// prime so it walks every row start instead of aliasing on the row pitch, and
/// it keeps a 3 MB frame to ~32k multiply-adds.
fn fingerprint(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data.iter().step_by(97) {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h ^ (data.len() as u64)
}

fn main() {
    let seconds: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(20);

    let settings = VideoSettings {
        monitor: MonitorSpec::Primary,
        fps: 60,
        cursor: false,
    };
    let info = {
        let backend = screencap::video::create_backend(&settings).expect("backend");
        backend.resolve().expect("resolve")
    };
    println!(
        "geometry {}x{} @ {}fps, running {seconds}s",
        info.width, info.height, info.fps
    );

    let (tx, rx): (Sender<VideoFrame>, Receiver<VideoFrame>) = crossbeam_channel::bounded(8);
    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded::<()>(8);
    let (err_tx, err_rx) = crossbeam_channel::bounded::<RunError>(16);

    let origin = Instant::now();
    let backend = screencap::video::create_backend(&settings).expect("backend");
    let stats: Option<Arc<CaptureStats>> = backend.stats();
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

    let consumer = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let mut received: u64 = 0;
        let mut repeats: u64 = 0;
        let mut unique: HashSet<u64> = HashSet::new();
        let mut last: Option<u64> = None;
        let mut window = Instant::now();
        let (mut w_frames, mut w_repeats) = (0u64, 0u64);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(frame) => {
                    let h = fingerprint(&frame.data);
                    if last == Some(h) {
                        repeats += 1;
                        w_repeats += 1;
                    }
                    last = Some(h);
                    unique.insert(h);
                    received += 1;
                    w_frames += 1;
                    if window.elapsed() >= Duration::from_secs(1) {
                        let s = window.elapsed().as_secs_f64();
                        println!(
                            "t={:5.1}s frames={:5.1}/s repeats={:5.1}/s distinct={:5.1}/s",
                            origin.elapsed().as_secs_f64(),
                            w_frames as f64 / s,
                            w_repeats as f64 / s,
                            (w_frames - w_repeats) as f64 / s
                        );
                        window = Instant::now();
                        w_frames = 0;
                        w_repeats = 0;
                    }
                }
                Err(_) => break,
            }
        }
        (received, repeats, unique.len())
    });

    std::thread::sleep(Duration::from_secs(seconds));
    for _ in 0..8 {
        let _ = shutdown_tx.try_send(());
    }
    drop(tx);
    let (received, repeats, unique) = consumer.join().unwrap_or((0, 0, 0));

    println!(
        "TOTAL at encoder input: frames={received} repeats={repeats} distinct={} unique_hashes={unique}",
        received - repeats
    );
    if let Some(s) = stats.as_ref().map(|s| s.snapshot()) {
        println!(
            "CAPTURE acquires={} mouse_only={} timeouts={} pending_drops={} pending_max={} callbacks={} duplicate_publishes={} coalesced={} present_every_ms={:.2} tick_overruns={} map_wait_p95_ms={:.2}",
            s.acquires,
            s.mouse_only_frames,
            s.acquire_timeouts,
            s.pending_drops,
            s.pending_depth_max,
            s.callbacks,
            s.duplicate_publishes,
            s.coalesced_presents,
            s.present_interval_ms,
            s.tick_overruns,
            s.readback_latency_p95_ms,
        );
    }
    if let Ok(e) = err_rx.try_recv() {
        println!("ERROR {e}");
    }
}
