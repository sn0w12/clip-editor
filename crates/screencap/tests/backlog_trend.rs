//! Backlog-trend harness for the real `spawn_segmenter` video writer.
//!
//! `segmenter_throughput` answers "can the segmenter keep up at all". This one
//! answers a different question: **does the backlog grow over a long run?** The
//! live app showed `max_queue_depth` climbing 4 → 10 and `max_frame_age_ms`
//! 52 → 158 over 50 minutes while `consumed` held at ~60 fps — i.e. average
//! throughput stayed correct and only the tail got worse, so a peak-only gate
//! cannot see it. This harness records every delivery window and reports the
//! slope of each metric over the run.
//!
//! Isolated to the video writer: no capture stage, no audio tracks, so the only
//! thing that can build a queue is the writer's `write_all` into the FFmpeg
//! pipe. The producer uses a blocking send exactly like the live feed thread,
//! so nothing is ever dropped and every depth observed is the writer's.
//!
//! Gated behind `SCREENCAP_BACKLOG=1` because it runs real FFmpeg + named
//! pipes. `BACKLOG_SECONDS` sets the run length (default 600).
//!
//! Usage:
//!   copy <ffmpeg.exe> to target/{debug,release}/
//!   SCREENCAP_BACKLOG=1 BACKLOG_SECONDS=600 cargo test --release --test backlog_trend -- --nocapture

#![cfg(windows)]

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use screencap::audio::TrackAudioBlock;
use screencap::config::ResolvedTrack;
use screencap::media::segmenter::{DeliveryStats, SegmentStore, SegmenterParams};
use screencap::video::{VIDEO_QUEUE_CAPACITY, VideoFrame, VideoInfo};

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

#[derive(Clone)]
struct LogWriter(Arc<std::sync::Mutex<String>>);

impl std::io::Write for LogWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("log mutex")
            .push_str(&String::from_utf8_lossy(buf));
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogWriter {
    type Writer = LogWriter;
    fn make_writer(&'a self) -> LogWriter {
        self.clone()
    }
}

struct Window {
    consumed: f64,
    depth: f64,
    age_ms: f64,
    write_mean_ms: f64,
    write_max_ms: f64,
    depth_end: f64,
}

/// Free bytes on the volume holding `path`.
///
/// The live run wrote and deleted a 1-second segment every second into
/// `%TEMP%`, and `%TEMP%` was on a volume with under 1% free. On a nearly-full
/// NTFS volume allocation and deallocation slow down as the free-space map
/// fragments, which would stall FFmpeg's segment finalization and stop it
/// reading the video pipe — the writer's queue would then grow for a reason that
/// has nothing to do with the writer. Sampling this alongside the delivery
/// windows distinguishes "the writer got slower" from "the volume filled up".
fn free_bytes(path: &std::path::Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    // Walk up to the volume root (`C:\`), which is what the API wants.
    let mut p = path;
    loop {
        let is_root = p
            .components()
            .next()
            .is_some_and(|c| matches!(c, std::path::Component::Prefix(_)))
            && p.as_os_str().len() <= 3;
        if is_root {
            break;
        }
        p = p.parent()?;
    }
    let mut wide: Vec<u16> = p.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut free = 0u64;
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the call,
    // and the out-parameter points at a live, correctly typed local.
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR(wide.as_ptr()),
            Some(&mut free),
            None,
            None,
        )
    };
    ok.is_ok().then_some(free)
}

fn parse_windows(log: &str) -> Vec<Window> {
    let mut out = Vec::new();
    for line in log.lines() {
        if !line.contains("segmenter-video delivery") {
            continue;
        }
        let num = |key: &str| -> f64 {
            line.split_whitespace()
                .find_map(|f| f.strip_prefix(key))
                .and_then(|v| v.trim_matches('"').parse().ok())
                .unwrap_or(0.0)
        };
        out.push(Window {
            consumed: num("consumed="),
            depth: num("max_queue_depth="),
            age_ms: num("max_frame_age_ms="),
            write_mean_ms: num("write_mean_ms="),
            write_max_ms: num("write_max_ms="),
            depth_end: num("queue_depth_end="),
        });
    }
    out
}

/// Least-squares slope of `ys` against window index, in units per window.
/// Reported per minute so the numbers read the way the log does.
fn slope_per_min(ys: &[f64]) -> f64 {
    let n = ys.len();
    if n < 3 {
        return 0.0;
    }
    let (mut sx, mut sy, mut sxy, mut sxx) = (0.0, 0.0, 0.0, 0.0);
    for (i, &y) in ys.iter().enumerate() {
        let x = i as f64;
        sx += x;
        sy += y;
        sxy += x * y;
        sxx += x * x;
    }
    let denom = n as f64 * sxx - sx * sx;
    if denom.abs() < f64::EPSILON {
        return 0.0;
    }
    let per_window = (n as f64 * sxy - sx * sy) / denom;
    // Windows are 5 s apart.
    per_window * (60.0 / 5.0)
}

#[test]
fn backlog_does_not_grow_over_a_long_run() {
    if std::env::var("SCREENCAP_BACKLOG").as_deref() != Ok("1") {
        eprintln!(
            "SKIP: set SCREENCAP_BACKLOG=1 to run the backlog trend harness (BACKLOG_SECONDS sets the length)"
        );
        return;
    }
    let seconds: u64 = std::env::var("BACKLOG_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600);

    let width: u32 = 1920;
    let height: u32 = 1080;
    let fps: u32 = 60;
    let sample_rate: u32 = 48000;
    let block_ms: u32 = 5;
    let frame_bytes = width as usize * height as usize * 3 / 2;

    let work = std::env::temp_dir().join(format!("screencap_backlog_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).expect("work dir");

    let store = Arc::new(SegmentStore::new(work.clone()));
    store.prepare().expect("prepare");

    let log_buf: Arc<std::sync::Mutex<String>> = Arc::new(std::sync::Mutex::new(String::new()));
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .with_ansi(false)
        .with_writer(LogWriter(log_buf.clone()))
        .finish();
    let _ = tracing::subscriber::set_global_default(subscriber);

    let (video_tx, video_rx) = crossbeam_channel::bounded(VIDEO_QUEUE_CAPACITY);
    let pacer_rx = video_rx.clone();
    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded(64);
    let (err_tx, err_rx) = crossbeam_channel::bounded(16);
    let origin = Instant::now();
    let delivery = Arc::new(DeliveryStats::default());

    // Audio tracks, because the live pipeline has them and they are part of the
    // suspect set: FFmpeg is fed every input through one process, and the
    // segmenter muxer is configured with `max_interleave_delta=0`, so an audio
    // stream that arrives irregularly can stall video muxing. Running with zero
    // tracks would not reproduce that at all.
    const TRACKS: [(u16, &str); 4] = [
        (1, "discord"),
        (2, "spotify"),
        (3, "zen"),
        (4, "system"),
    ];
    let block_samples = (sample_rate * block_ms / 1000) as usize * 2;
    let (track_txs, track_rxs): (Vec<_>, Vec<_>) = TRACKS
        .iter()
        .map(|_| crossbeam_channel::bounded::<TrackAudioBlock>(256))
        .unzip();
    let tracks: Vec<ResolvedTrack> = TRACKS
        .iter()
        .map(|(n, name)| ResolvedTrack {
            number: *n,
            name: (*name).to_string(),
            include: Vec::new(),
            exclude: Vec::new(),
        })
        .collect();

    let track_rx_clones: Vec<_> = track_rxs.to_vec();
    let done = screencap::media::segmenter::spawn_segmenter(
        SegmenterParams {
            ffmpeg: ffmpeg(),
            video: VideoInfo { width, height, fps },
            sample_rate,
            channels: 2,
            tracks,
            codec: screencap::config::VideoCodec::H264Nvenc,
            quality: 28,
            segment_seconds: 1,
            buffer_dir: work.clone(),
            keep: Duration::from_secs(120),
            capture_origin: origin,
            delivery: delivery.clone(),
        },
        store.clone(),
        video_rx,
        track_rxs,
        shutdown_rx,
        err_tx,
    )
    .expect("segmenter spawns");

    // Audio producers: one block per `block_ms` per track, like the mixer, so
    // every audio input is live. Blocks are sent non-blocking with the oldest
    // dropped, which is what the mixer does when a consumer falls behind.
    let mut audio_producers = Vec::new();
    for (i, tx) in track_txs.into_iter().enumerate() {
        let (number, name) = TRACKS[i];
        // A receiver clone so a full channel can drop its oldest block, which is
        // what the mixer does when the writer falls behind. Cloned before
        // `track_rxs` is moved into `spawn_segmenter`.
        let rx = track_rx_clones[i].clone();
        audio_producers.push(std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(seconds);
            let mut next = Instant::now();
            let mut sent = 0u64;
            while Instant::now() < deadline {
                let now = Instant::now();
                if now < next {
                    std::thread::sleep(next - now);
                    continue;
                }
                next += Duration::from_millis(block_ms as u64);
                let samples: Vec<f32> = (0..block_samples)
                    .map(|s| ((s as f32) * 0.01 + sent as f32).sin() * 0.2)
                    .collect();
                let block = TrackAudioBlock {
                    number,
                    name: name.to_string(),
                    pts: origin.elapsed(),
                    sample_rate,
                    channels: 2,
                    samples,
                };
                if tx.try_send(block).is_err() {
                    let _ = rx.try_recv();
                    let _ = tx.try_send(TrackAudioBlock {
                        number,
                        name: name.to_string(),
                        pts: origin.elapsed(),
                        sample_rate,
                        channels: 2,
                        samples: Vec::new(),
                    });
                }
                sent += 1;
            }
            sent
        }));
    }

    // Video producer: one frame per tick, blocking send (never drops), mirroring
    // the live feed thread so any queue depth is attributable to the writer.
    //
    // The payload is a small pool of pre-generated frames shared by `Arc`, built
    // with the struct literal rather than `VideoFrame::new`, because `new` takes
    // a `Vec<u8>` and would copy 3 MB per frame — that copy alone can starve the
    // tick grid and would show up here as a backlog that is really the
    // producer's fault.
    //
    // The frames must differ from each other. An all-zero frame is trivially
    // cheap for `h264_nvenc` (nothing changes, so there is nothing to encode),
    // which would leave the encoder idle and make this harness unable to
    // reproduce anything the live pipeline does. Cycling a pool of distinct
    // noisy frames gives the encoder real work every frame while still costing
    // the producer no per-frame copy.
    const FRAME_POOL: usize = 8;
    let producer = std::thread::spawn(move || {
        let interval = Duration::from_micros(1_000_000 / fps as u64);
        let deadline = Instant::now() + Duration::from_secs(seconds);
        let mut next_tick = Instant::now();
        let pool: Vec<Arc<Vec<u8>>> = (0..FRAME_POOL)
            .map(|k| {
                let mut v = vec![0u8; frame_bytes];
                // Cheap deterministic per-frame variation: a byte ramp seeded by
                // the pool index, so consecutive frames always differ.
                let seed = (k as u32).wrapping_mul(2_654_435_761);
                for (i, b) in v.iter_mut().enumerate() {
                    *b = ((i as u32).wrapping_mul(31).wrapping_add(seed) >> 13) as u8;
                }
                Arc::new(v)
            })
            .collect();
        let mut sent: u64 = 0;
        while Instant::now() < deadline {
            let now = Instant::now();
            if now < next_tick {
                std::thread::sleep(next_tick - now);
                continue;
            }
            next_tick += interval;
            let frame = VideoFrame {
                pts: origin.elapsed(),
                width,
                height,
                data: pool[(sent as usize) % FRAME_POOL].clone(),
            };
            if video_tx.send(frame).is_err() {
                break; // writer gone
            }
            sent += 1;
        }
        let _ = &pacer_rx;
        sent
    });

    // Sample the buffer volume's free space on the same 5 s grid as the writer's
// delivery windows, so the table can show backlog against volume pressure.
let free_samples: Arc<std::sync::Mutex<Vec<Option<u64>>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
let sampler = {
    let free_samples = free_samples.clone();
    let work = work.clone();
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(seconds);
        while Instant::now() < deadline {
            free_samples.lock().expect("free mutex").push(free_bytes(&work));
            std::thread::sleep(Duration::from_secs(5));
        }
    })
};

let sent = producer.join().expect("producer joins");
    let audio_sent: u64 = audio_producers
        .into_iter()
        .map(|h| h.join().unwrap_or(0))
        .sum();
    for _ in 0..64 {
        let _ = shutdown_tx.try_send(());
    }
    let _ = done.recv_timeout(Duration::from_secs(30));
    let _ = err_rx.try_recv();
    let _ = sampler.join();

    let log = log_buf.lock().expect("log mutex").clone();
    let windows = parse_windows(&log);
    assert!(
        !windows.is_empty(),
        "no segmenter-video delivery reports captured; the writer never logged"
    );

    println!(
        "\nBACKLOG run={seconds}s sent={sent} audioBlocks={audio_sent} windows={} capacity={VIDEO_QUEUE_CAPACITY}",
        windows.len()
    );
    println!(
        "{:>4}  {:>7}  {:>6}  {:>6}  {:>11}  {:>11}  {:>6}  {:>10}",
        "win", "consumed", "depth", "depthE", "writeMean", "writeMax", "ageMs", "volFreeMB"
    );
    let frees = free_samples.lock().expect("free mutex").clone();
    for (i, w) in windows.iter().enumerate() {
        let free = frees.get(i).copied().flatten();
        println!(
            "{:>4}  {:>7.0}  {:>6.0}  {:>6.0}  {:>11.2}  {:>11.2}  {:>6.0}  {:>10}",
            i,
            w.consumed,
            w.depth,
            w.depth_end,
            w.write_mean_ms,
            w.write_max_ms,
            w.age_ms,
            match free {
                Some(b) => format!("{:.0}", b as f64 / (1024.0 * 1024.0)),
                None => "?".to_string(),
            }
        );
    }

    let depths: Vec<f64> = windows.iter().map(|w| w.depth).collect();
    let ends: Vec<f64> = windows.iter().map(|w| w.depth_end).collect();
    let ages: Vec<f64> = windows.iter().map(|w| w.age_ms).collect();
    let wmax: Vec<f64> = windows.iter().map(|w| w.write_max_ms).collect();
    let wmean: Vec<f64> = windows.iter().map(|w| w.write_mean_ms).collect();

    let depth_slope = slope_per_min(&depths);
    let age_slope = slope_per_min(&ages);
    let wmax_slope = slope_per_min(&wmax);
    let wmean_slope = slope_per_min(&wmean);

    println!("\nTREND (per minute, least squares over the run)");
    println!("  max_queue_depth  {:+.3}   (first={:.0} last={:.0})", depth_slope, depths[0], depths[depths.len()-1]);
    println!("  queue_depth_end  {:+.3}   (first={:.0} last={:.0})", slope_per_min(&ends), ends[0], ends[ends.len()-1]);
    println!("  max_frame_age_ms {:+.3}   (first={:.0} last={:.0})", age_slope, ages[0], ages[ages.len()-1]);
    println!("  write_mean_ms    {:+.3}   (first={:.2} last={:.2})", wmean_slope, wmean[0], wmean[wmean.len()-1]);
    println!("  write_max_ms     {:+.3}   (first={:.2} last={:.2})", wmax_slope, wmax[0], wmax[wmax.len()-1]);

    // The live failure mode: a positive depth slope that outruns a flat write
    // time means the queue is growing for a reason the writer's own timing does
    // not explain. Fail loudly on that so the run is not silently informative.
    assert!(
        depth_slope <= 0.05,
        "video backlog is growing: max_queue_depth slope {depth_slope:+.3}/min \
         (write_mean slope {wmean_slope:+.3}/min, write_max slope {wmax_slope:+.3}/min)"
    );

    let _ = std::fs::remove_dir_all(&work);
}