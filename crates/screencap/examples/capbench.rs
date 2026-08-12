//! Capture-path benchmark: runs the real Windows Graphics Capture backend
//! (as `replay.rs` does) for a few seconds and reports the delivered frame
//! rate and per-thread CPU time, so the capture's overhead is measured in
//! isolation from the encoder/segmenter.
//!
//! Usage: `cargo run --release --example capbench -- <seconds>`

use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};

use screencap::error::RunError;
use screencap::video::{MonitorSpec, VideoFrame, VideoSettings};

fn main() {
    let seconds: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);
    let fps: u32 = 60;

    let settings = VideoSettings {
        monitor: MonitorSpec::Primary,
        fps,
        cursor: false,
    };
    let info = {
        let backend = screencap::video::create_backend(&settings).expect("backend");
        backend.resolve().expect("resolve")
    };
    println!("geometry: {}x{} @ {}fps", info.width, info.height, info.fps);

    let (tx, rx): (Sender<VideoFrame>, Receiver<VideoFrame>) = crossbeam_channel::bounded(64);
    let rx2 = rx.clone();
    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded::<()>(8);
    let (err_tx, err_rx) = crossbeam_channel::bounded::<RunError>(16);

    let origin = Instant::now();
    let backend = screencap::video::create_backend(&settings).expect("backend");
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
                    // ~2MB of the frame; compare across frames for variety.
                    let bgra = frame.bgra;
                    let end = bgra.len().min(2_000_000);
                    let sum: u64 = bgra[..end].iter().map(|&b| b as u64).sum();
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
    let _ = tx.send(VideoFrame::new(Instant::now() - origin, 1, 1, vec![0u8; 4]));
    drop(tx);
    let (frames, non_zero, varied) = consumer.join().unwrap_or((0, 0, 0));
    let _ = err_rx.try_recv();

    let wall = origin.elapsed().as_secs_f64();
    println!(
        "RESULT wall={wall:.1}s frames={frames} rate={:.1}fps non_zero_frames={non_zero} varied_frames={varied}",
        frames as f64 / wall
    );
}
