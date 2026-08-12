//! Paced pipe-feed benchmark: measures how fast FFmpeg can consume raw BGRA
//! video pushed through a named pipe at the configured FPS. The production
//! segmenter serializes at ~0.53x (32fps effective for 1080p60); this harness
//! reproduces that baseline and lets us iterate on pipe strategies without a
//! live capture session.
//!
//! Usage: `cargo run --release --example pipebench -- <seconds> [options]`
//!
//! Options (key=value):
//!   width=1920 height=1080 fps=60            capture geometry / pace
//!   buf=<mb>                                 named-pipe server buffer in MB
//!   codec=h264_nvenc|libx264                 encoder under test
//!   q=28                                     quality/crf
//!   batch=<frames>                           frames written per WriteFile
//!   drain=0|1                                writer drains channel, writes newest only
//!   tq=0|1024                                -thread_queue_size input option
//!   readahead=<bytes>                        -read_ahead_limit (0 = omit)
//!   mux=null|segment                        output target: null muxer or segment files
//!   block_ms=<ms>                            writer recv_timeout
//!   seed=<frame_no>                          only write the Nth frame (0 = all)
//!
//! Reports `speed=<ratio>` = stream seconds of content / wall seconds.

use std::io::Write;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Storage::FileSystem::{FlushFileBuffers, PIPE_ACCESS_OUTBOUND, WriteFile};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
};

struct PipeWriter {
    handle: windows::Win32::Foundation::HANDLE,
}

unsafe impl Send for PipeWriter {}

impl PipeWriter {
    fn create(name: &str, out_buffer_size: u32) -> std::io::Result<PipeWriter> {
        let wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        let handle = unsafe {
            CreateNamedPipeW(
                windows::core::PCWSTR(wide.as_ptr()),
                PIPE_ACCESS_OUTBOUND,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                1,
                out_buffer_size,
                0,
                0,
                None,
            )
        };
        if handle.is_invalid() {
            return Err(std::io::Error::last_os_error());
        }
        Ok(PipeWriter { handle })
    }

    fn connect(&self) -> std::io::Result<()> {
        if unsafe { ConnectNamedPipe(self.handle, None) }.is_ok() {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(win32_error(ERROR_PIPE_CONNECTED)) {
            return Ok(());
        }
        Err(err)
    }
}

impl Write for PipeWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut written = 0u32;
        let ok = unsafe { WriteFile(self.handle, Some(buf), Some(&mut written), None) };
        if ok.is_ok() {
            Ok(written as usize)
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        if unsafe { FlushFileBuffers(self.handle) }.is_ok() {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error())
        }
    }
}

impl Drop for PipeWriter {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

fn win32_error(code: u32) -> i32 {
    code as i32
}

const ERROR_PIPE_CONNECTED: u32 = 535;

fn send_drop_oldest<T: Clone>(tx: &Sender<T>, rx: &Receiver<T>, item: T) {
    if tx.try_send(item.clone()).is_err() {
        let _ = rx.try_recv();
        let _ = tx.try_send(item);
    }
}

fn main() {
    let mut args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: pipebench <seconds> [key=value ...]");
        std::process::exit(2);
    }
    let seconds: u64 = args.remove(1).parse().expect("seconds");
    let mut opts: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for a in &args {
        if let Some((k, v)) = a.split_once('=') {
            opts.insert(k.to_string(), v.to_string());
        }
    }
    let get = |k: &str, d: &str| opts.get(k).map(|s| s.as_str()).unwrap_or(d).to_string();
    let w: u32 = get("width", "1920").parse().unwrap();
    let h: u32 = get("height", "1080").parse().unwrap();
    let fps: u32 = get("fps", "60").parse().unwrap();
    let buf_mb: usize = get("buf", "9").parse().unwrap();
    let codec = get("codec", "h264_nvenc");
    let q: u8 = get("q", "28").parse().unwrap();
    let batch: usize = get("batch", "1").parse().unwrap();
    let drain: bool = get("drain", "0") == "1";
    let tq: u32 = get("tq", "0").parse().unwrap();
    let readahead: u64 = get("readahead", "0").parse().unwrap();
    let mux = get("mux", "null");
    let block_ms: u64 = get("block_ms", "250").parse().unwrap();
    let seed: u64 = get("seed", "0").parse().unwrap();

    let frame_bytes = w as usize * h as usize * 4;
    let name = format!("pipebench_{}", std::process::id());
    let url = format!(r"\\.\pipe\{name}");

    let work = std::env::temp_dir().join(format!("pipebench_{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let segments_txt = work.join("segments.txt");

    let pipe = PipeWriter::create(&url, (buf_mb * 1024 * 1024) as u32).expect("create pipe");

    let ffmpeg = {
        let mut p = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        p.push("target");
        p.push(if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        });
        p.push("ffmpeg.exe");
        if !p.exists() {
            eprintln!("ffmpeg.exe not found at {}", p.display());
            std::process::exit(2);
        }
        p
    };

    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "warning", "-y"]);
    if tq > 0 {
        cmd.arg("-thread_queue_size").arg(tq.to_string());
    }
    if readahead > 0 {
        cmd.arg("-read_ahead_limit").arg(readahead.to_string());
    }
    cmd.args([
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgra",
        "-video_size",
        &format!("{w}x{h}"),
        "-framerate",
        &fps.to_string(),
        "-i",
        &url,
    ]);
    cmd.arg("-c:v").arg(&codec);
    if codec == "libx264" {
        cmd.arg("-threads")
            .arg("4")
            .arg("-preset")
            .arg("veryfast")
            .arg("-crf")
            .arg(q.to_string());
    } else {
        cmd.arg("-cq").arg(q.to_string());
    }
    if mux == "segment" {
        cmd.args([
            "-f",
            "segment",
            "-segment_time",
            "1",
            "-reset_timestamps",
            "1",
            "-segment_list_type",
            "csv",
            "-segment_list",
            segments_txt.to_str().unwrap(),
        ]);
        let pattern = work.join("seg_%05d.mkv");
        cmd.arg(pattern.to_str().unwrap());
    } else {
        cmd.arg("-f").arg("null").arg("NUL");
    }
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    let mut child = cmd.spawn().expect("spawn ffmpeg");
    pipe.connect().expect("connect pipe");

    // Frame channel mimics the segmenter's bounded channel.
    let (tx, rx) = crossbeam_channel::bounded::<Arc<Vec<u8>>>(120);
    let origin = Instant::now();

    // Writer thread: identical to the segmenter's video writer.
    let writer_rx = rx.clone();
    let (shutdown_tx, shutdown_rx) = crossbeam_channel::bounded::<()>(1);
    let writer_shutdown = shutdown_rx.clone();
    let writer = thread::spawn(move || {
        let mut writer = pipe;
        let mut last_write = Instant::now();
        loop {
            match writer_rx.recv_timeout(Duration::from_millis(block_ms)) {
                Ok(frame) => {
                    if drain {
                        let mut newest = frame;
                        while let Ok(f) = writer_rx.try_recv() {
                            newest = f;
                        }
                        if writer.write_all(&newest).is_err() {
                            break;
                        }
                    } else if batch > 1 {
                        let mut buf = Vec::with_capacity(batch * frame_bytes);
                        buf.extend_from_slice(&frame);
                        let mut got = 1;
                        while got < batch {
                            match writer_rx.try_recv() {
                                Ok(f) => {
                                    buf.extend_from_slice(&f);
                                    got += 1;
                                }
                                Err(_) => break,
                            }
                        }
                        if writer.write_all(&buf).is_err() {
                            break;
                        }
                    } else if writer.write_all(&frame).is_err() {
                        break;
                    }
                    last_write = Instant::now();
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                    if writer_shutdown.try_recv().is_ok() {
                        let _ = writer.flush();
                        break;
                    }
                }
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    // Pacer: seed once, then send the latest frame at `fps`.
    let mut next_tick = origin;
    let interval = Duration::from_micros(1_000_000 / fps as u64);
    let mut frame = vec![0u8; frame_bytes];
    let mut frame_no: u64 = 0;
    let deadline = origin + Duration::from_secs(seconds);
    let mut sent: u64 = 0;
    while Instant::now() < deadline {
        let now = Instant::now();
        if now < next_tick {
            thread::sleep(next_tick - now);
            continue;
        }
        next_tick += interval;
        if next_tick < now {
            next_tick = now + interval;
        }
        // Cheap varying pattern so encoded frames differ slightly.
        frame_no += 1;
        for i in 0..4 {
            frame[i] = (frame_no as u8).wrapping_mul(31).wrapping_add(i as u8);
        }
        if seed == 0 || frame_no % seed == 0 {
            let f = Arc::new(frame.clone());
            send_drop_oldest(&tx, &rx, f);
            sent += 1;
        }
    }

    // Stop: signal the writer to flush and close the pipe; ffmpeg sees EOF.
    let _ = shutdown_tx.send(());
    writer.join().unwrap();
    // Give ffmpeg a moment to flush, then kill.
    thread::sleep(Duration::from_millis(1500));
    let _ = child.kill();
    let _ = child.wait();

    let wall = origin.elapsed().as_secs_f64();

    let produced = if mux == "segment" {
        // Sum the durations listed in segments.txt.
        let content = std::fs::read_to_string(&segments_txt).unwrap_or_default();
        let mut total = 0.0f64;
        for line in content.lines() {
            let f: Vec<&str> = line.trim().split(',').collect();
            if f.len() == 3 {
                let s: f64 = f[1].trim().parse().unwrap_or(0.0);
                let e: f64 = f[2].trim().parse().unwrap_or(0.0);
                total += e - s;
            }
        }
        total
    } else {
        // null muxer: no segments to count; report frames expected * fps...
        // Not meaningful; use 0 and print sent count.
        0.0
    };

    let _ = std::fs::remove_dir_all(&work);
    let speed = if produced > 0.0 { produced / wall } else { 0.0 };
    println!(
        "RESULT wall={wall:.1}s sent={sent} produced={produced:.1}s speed={speed:.3}x (opts: buf={buf_mb}MB codec={codec} batch={batch} drain={drain} tq={tq} readahead={readahead} mux={mux})"
    );
}
