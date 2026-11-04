//! Audio capture under load: plays a continuous tone, saturates the CPU, and
//! captures the tone through the real Windows process-loopback path. A client
//! that is descheduled past the engine's buffer returns a silence-flagged
//! packet, which lands in the clip as a 20 ms hole. The capture stream must
//! stay contiguous under the same load that the encoder puts on the machine.
//!
//! Gated behind `SCREENCAP_AUDIO_LOAD_TEST=1` because it plays sound, needs an
//! audio endpoint, and runs for several seconds.

#![cfg(windows)]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use screencap::audio::{AudioBlock, AudioEvent};
use screencap::config::ProcessRule;

const RATE: u32 = 48000;
const BLOCK_MS: u64 = 20;
const RUN_US: u64 = 8_000_000;

fn ffmpeg() -> PathBuf {
    let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    p.push("target");
    p.push(if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    });
    p.push("ffmpeg.exe");
    p
}

fn spawn_tone(wav: &PathBuf) -> Child {
    let script = format!(
        "Add-Type -AssemblyName System; \
         $p = New-Object System.Media.SoundPlayer '{}'; \
         $p.PlayLooping(); Start-Sleep -Seconds 30",
        wav.display()
    );
    Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("powershell starts")
}

#[test]
fn loopback_capture_stays_contiguous_under_cpu_load() {
    if std::env::var("SCREENCAP_AUDIO_LOAD_TEST").as_deref() != Ok("1") {
        eprintln!("SKIP: set SCREENCAP_AUDIO_LOAD_TEST=1 to run the audio capture load test");
        return;
    }
    let ffmpeg = ffmpeg();
    let work = std::env::temp_dir().join(format!("screencap_load_{}", std::process::id()));
    std::fs::create_dir_all(&work).unwrap();
    let wav = work.join("tone.wav");
    let status = Command::new(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:duration=5",
            "-ac",
            "2",
            "-ar",
            &RATE.to_string(),
        ])
        .arg(&wav)
        .status()
        .expect("ffmpeg generates the tone");
    assert!(status.success(), "tone generation failed");

    let mut tone = spawn_tone(&wav);
    std::thread::sleep(Duration::from_millis(800));

    let (event_tx, event_rx) = crossbeam_channel::bounded(500);
    let (err_tx, err_rx) = crossbeam_channel::bounded::<screencap::error::RunError>(16);
    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded(64);
    let origin = Instant::now();
    screencap::audio::windows::spawn_process_audio(
        vec![ProcessRule {
            id: "tone".to_string(),
            executable: "powershell.exe".to_string(),
            tags: Vec::new(),
            include_children: true,
        }],
        origin,
        event_tx.clone(),
        event_rx.clone(),
        err_tx,
        shutdown_rx,
        RATE,
        2,
    )
    .expect("process audio starts");

    // Saturate every core with above-normal threads, the way a 1080p60 encoder
    // and its capture path saturate the machine at save time. A capture client
    // at normal priority is then starved; an MMCSS "Pro Audio" client is not.
    let load_deadline = Instant::now() + Duration::from_millis(RUN_US / 1000 + 1000);
    let mut load_threads = Vec::new();
    let workers = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(8);
    for _ in 0..workers {
        load_threads.push(std::thread::spawn(move || {
            use windows::Win32::System::Threading::{
                GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_HIGHEST,
            };
            // SAFETY: pseudo-handle for this thread; only its priority changes.
            unsafe {
                let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
            }
            let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
            while Instant::now() < load_deadline {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                std::hint::spin_loop();
            }
            x
        }));
    }

    let mut blocks: Vec<AudioBlock> = Vec::new();
    let deadline = Instant::now() + Duration::from_micros(RUN_US);
    while Instant::now() < deadline {
        match event_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(AudioEvent::Block(b)) => blocks.push(b),
            Ok(_) => {}
            Err(_) => {}
        }
    }
    let captured_ms = origin.elapsed().as_millis() as u64;

    for t in load_threads {
        let _ = t.join();
    }
    for _ in 0..64 {
        let _ = shutdown_tx.try_send(());
    }
    drop(event_tx);
    let _ = tone.kill();
    let _ = tone.wait();
    let _ = err_rx.try_recv();

    assert!(
        !blocks.is_empty(),
        "no tone captured: the process loopback never attached (is an output device present?)"
    );
    // The manager can attach the same process tree under more than one source
    // key; analyse the source that actually carries the tone.
    let mut by_source: std::collections::HashMap<String, Vec<&AudioBlock>> = Default::default();
    for block in &blocks {
        by_source
            .entry(block.source.0.clone())
            .or_default()
            .push(block);
    }
    for (source, list) in &by_source {
        let loud = list
            .iter()
            .filter(|b| !b.samples.iter().all(|s| s.abs() < 1e-6))
            .count();
        println!("  source {source}: blocks={} loud={}", list.len(), loud);
    }
    let (source, list) = by_source
        .iter()
        .max_by_key(|(_, list)| {
            list.iter()
                .filter(|b| !b.samples.iter().all(|s| s.abs() < 1e-6))
                .count()
        })
        .expect("a source was captured");
    let total_ms = list.len() as u64 * BLOCK_MS;
    let first_pts = list[0].pts;
    let warmup = Duration::from_millis(500);
    let silent = list
        .iter()
        .filter(|b| b.pts.saturating_sub(first_pts) > warmup)
        .filter(|b| b.samples.iter().all(|s| s.abs() < 1e-6))
        .count();
    let silent_total = list
        .iter()
        .filter(|b| b.samples.iter().all(|s| s.abs() < 1e-6))
        .count();
    let mut worst_gap_ms = 0u64;
    for pair in list.windows(2) {
        let step = pair[1].pts.saturating_sub(pair[0].pts).as_millis() as u64;
        worst_gap_ms = worst_gap_ms.max(step);
    }
    println!(
        "CAPTURE: source={source} wall={captured_ms}ms blocks={} audio={total_ms}ms \
         silent_blocks={silent_total} silent_after_warmup={silent} worst_pts_gap={worst_gap_ms}ms",
        list.len()
    );
    assert!(
        silent == 0,
        "source {source} captured {silent} silent blocks (20 ms holes) after the tone started"
    );
    assert!(
        worst_gap_ms <= BLOCK_MS + 2,
        "a {worst_gap_ms}ms gap appeared between blocks: the capture client dropped samples"
    );
    let _ = std::fs::remove_dir_all(&work);
}
