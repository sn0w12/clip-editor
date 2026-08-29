//! Empirical probe: Chromium-style idle — the render client is FULLY released
//! (stream stopped, client dropped) during a long quiet stretch, exactly like
//! Discord/Chrome audio threads do when idle. Answers three questions:
//!
//! 1. Does the process's audio session LEAVE `IAudioSessionEnumerator` while
//!    the render client is released? (Our audio manager polls that enumerator
//!    every second and STOPS the worker when a configured source's session
//!    disappears — a re-spawned worker cannot capture audio rendered before
//!    it started, so the first bit of resumed audio would be lost.)
//! 2. Does the OLD loopback capture client keep delivering the resumed audio
//!    after the render client is re-created, or does it go stale/silent?
//! 3. Are the first resumed samples present in the captured blocks, and where
//!    do our wall-clock stamps place them?
//!
//! Run:  cargo run --example loopback_resume

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use wasapi::{
    AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode, WaveFormat, initialize_mta,
};

const RATE: usize = 48000;
const CH: usize = 2;
const BLOCK_FRAMES: usize = 960; // 20 ms
const BLOCK_DUR: Duration = Duration::from_millis(20);

fn main() {
    initialize_mta().ok();
    let origin = Instant::now();
    let my_pid: u32 = std::process::id();

    // ---- session enumerator: is our PID's session present right now? ----
    fn session_present(my_pid: u32) -> bool {
        let enumerator = match DeviceEnumerator::new() {
            Ok(e) => e,
            Err(_) => return false,
        };
        let device = match enumerator.get_default_device(&Direction::Render) {
            Ok(d) => d,
            Err(_) => return false,
        };
        let manager = match device.get_iaudiosessionmanager() {
            Ok(m) => m,
            Err(_) => return false,
        };
        let sessions = match manager.get_audiosessionenumerator() {
            Ok(s) => s,
            Err(_) => return false,
        };
        let count = match sessions.get_count() {
            Ok(c) => c,
            Err(_) => return false,
        };
        for i in 0..count {
            if let Ok(s) = sessions.get_session(i) {
                if let Ok(pid) = s.get_process_id() {
                    if pid == my_pid {
                        return true;
                    }
                }
            }
        }
        false
    }

    let stop = Arc::new(AtomicBool::new(false));

    // ---- capture thread: the exact `run_worker` read/stamp pattern ----
    let cap_stop = stop.clone();
    let cap_origin = origin;
    let cap_pid = my_pid;
    let cap_thread = thread::spawn(move || {
        let mut cap =
            AudioClient::new_application_loopback_client(cap_pid, true).expect("loopback client");
        let fmt = WaveFormat::new(32, 32, &SampleType::Float, RATE, CH, None);
        cap.initialize_client(
            &fmt,
            &Direction::Capture,
            &StreamMode::EventsShared {
                autoconvert: false,
                buffer_duration_hns: 1_000_000, // 100 ms, as in run_worker
            },
        )
        .expect("init capture");
        let ev = cap.set_get_eventhandle().expect("event");
        let capture = cap.get_audiocaptureclient().expect("capture client");
        let mut cap_buf = vec![0u8; 4800 * 8];
        let mut out: Vec<f32> = Vec::new();
        let mut scratch: Vec<f32> = Vec::new();
        cap.start_stream().expect("start capture");

        let mut total_blocks = 0usize;
        let mut non_silent_at: Vec<f64> = Vec::new();
        while !cap_stop.load(Ordering::SeqCst) {
            let _ = ev.wait_for_event(20);
            let mut wave_pkts = 0u32;
            loop {
                match capture.get_next_packet_size() {
                    Ok(Some(0)) | Ok(None) => break,
                    Ok(Some(_)) => match capture.read_from_device(&mut cap_buf) {
                        Ok((read, _info)) => {
                            wave_pkts += 1;
                            let bytes = read as usize * 8;
                            scratch.clear();
                            scratch.extend_from_slice(&bytemuck_from_le(&cap_buf[..bytes]));
                            out.extend_from_slice(&scratch);
                            let wall = cap_origin.elapsed();
                            let audio_back = Duration::from_secs_f64(
                                out.len() as f64 / (CH as f64 * RATE as f64),
                            );
                            let start = wall.saturating_sub(audio_back);
                            let base_ms = (start.as_millis() as u64 / 20) * 20;
                            let mut pts = Duration::from_millis(base_ms);
                            while out.len() >= BLOCK_FRAMES * CH {
                                let b: Vec<f32> = out.drain(..BLOCK_FRAMES * CH).collect();
                                let peak = b.iter().fold(0f32, |m, s| m.max(s.abs()));
                                let onset = b
                                    .chunks_exact(CH)
                                    .position(|f| f[0].abs() > 0.01)
                                    .map(|f| pts.as_secs_f64() + f as f64 / RATE as f64);
                                if peak > 0.001
                                    || total_blocks < 30
                                    || (pts.as_millis() as u64 >= 10800
                                        && pts.as_millis() as u64 <= 11300)
                                {
                                    println!(
                                        "BLK {:3} wall={:4}ms pkt={} pts={:4}ms peak={:.3} onset={:.3} first5={:.2},{:.2},{:.2},{:.2},{:.2}",
                                        total_blocks,
                                        wall.as_millis(),
                                        wave_pkts,
                                        pts.as_millis(),
                                        peak,
                                        onset.unwrap_or(-1.0),
                                        b[0],
                                        b[2],
                                        b[4],
                                        b[6],
                                        b[8]
                                    );
                                }
                                if peak > 0.001 {
                                    if let Some(o) = onset {
                                        non_silent_at.push(o);
                                    }
                                }
                                total_blocks += 1;
                                pts += BLOCK_DUR;
                            }
                        }
                        Err(e) => {
                            println!("CAPTURE read err: {e}");
                            break;
                        }
                    },
                    Err(e) => {
                        println!("CAPTURE pkt err: {e}");
                        break;
                    }
                }
            }
        }
        let _ = cap.stop_stream();
        let ns = non_silent_at.len();
        let first = non_silent_at.first().copied();
        let last = non_silent_at.last().copied();
        println!(
            "CAPTURE: total blocks {}, non-silent blocks {}, first non-silent at {:.3}s, last {:.3}s",
            total_blocks,
            ns,
            first.unwrap_or(-1.0),
            last.unwrap_or(-1.0)
        );
    });

    // ---- render helpers ----
    struct Renderer {
        client: AudioClient,
        render: wasapi::AudioRenderClient,
    }
    impl Renderer {
        fn open() -> Renderer {
            let enumerator = DeviceEnumerator::new().expect("enumerator");
            let device = enumerator
                .get_default_device(&Direction::Render)
                .expect("default render device");
            let mut client = device.get_iaudioclient().expect("render client");
            let rfmt = WaveFormat::new(32, 32, &SampleType::Float, RATE, CH, None);
            client
                .initialize_client(
                    &rfmt,
                    &Direction::Render,
                    &StreamMode::PollingShared {
                        autoconvert: true,
                        buffer_duration_hns: 100_000, // 10 ms
                    },
                )
                .expect("init render");
            let render = client.get_audiorenderclient().expect("render buffer");
            client.start_stream().expect("start render");
            Renderer { client, render }
        }
        fn tone(&mut self, seconds: f64, on: bool, origin: Instant, tag: &str) {
            let mut phase: f64 = 0.0;
            let t0 = Instant::now();
            let mut written = 0usize;
            let mut first_write_ms = None;
            while t0.elapsed() < Duration::from_secs_f64(seconds) {
                let avail = self.client.get_available_space_in_frames().expect("avail");
                if avail > 0 {
                    if first_write_ms.is_none() {
                        first_write_ms = Some(origin.elapsed().as_millis() as u64);
                    }
                    let mut data = vec![0u8; avail as usize * 8];
                    for (i, frame) in data.chunks_exact_mut(8).enumerate() {
                        let v = if on {
                            phase += 1.0 / RATE as f64;
                            (2.0 * std::f64::consts::PI * 440.0 * phase).sin() as f32 * 0.2
                        } else {
                            0.0
                        };
                        let bytes = v.to_le_bytes();
                        frame[..4].copy_from_slice(&bytes);
                        frame[4..].copy_from_slice(&bytes);
                    }
                    self.render
                        .write_to_device(avail as usize, &data, None)
                        .expect("write");
                    written += avail as usize;
                }
                thread::sleep(Duration::from_millis(5));
            }
            println!(
                "RENDER: {tag} first write at wall {}ms, done at {}ms ({} frames)",
                first_write_ms.unwrap_or(0),
                origin.elapsed().as_millis(),
                written
            );
        }
        fn close(mut self) {
            let _ = self.client.stop_stream();
            drop(self.client);
        }
    }

    println!("session present at start: {}", session_present(my_pid));

    // Phase 1: render tone 1 s (establishes the session).
    let mut r1 = Renderer::open();
    r1.tone(1.0, true, origin, "tone1");
    r1.close(); // FULLY release the render client, Chromium-idle style
    println!(
        "RENDER: client released at wall {}ms; session present: {}",
        origin.elapsed().as_millis(),
        session_present(my_pid)
    );

    // Phase 2: idle 10 s, polling whether our session stays in the enumerator.
    let idle_start = Instant::now();
    while idle_start.elapsed() < Duration::from_secs(10) {
        thread::sleep(Duration::from_millis(500));
        println!(
            "IDLE {:.1}s session_present={}",
            idle_start.elapsed().as_secs_f64(),
            session_present(my_pid)
        );
    }

    // Phase 3: re-create the render client (Chromium resume) and render again.
    let mut r2 = Renderer::open();
    println!(
        "RENDER: new client opened at wall {}ms",
        origin.elapsed().as_millis()
    );
    r2.tone(2.0, true, origin, "tone2");

    thread::sleep(Duration::from_millis(500));
    stop.store(true, Ordering::SeqCst);
    cap_thread.join().expect("capture thread");
}

fn bytemuck_from_le(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}
