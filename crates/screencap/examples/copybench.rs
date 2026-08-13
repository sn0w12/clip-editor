//! Microbenchmark for the two candidate "further optimization" directions:
//!
//! 1. Parallel (multithreaded) frame copy vs serial — the capture does one
//!    8MB memcpy per frame; would spreading it over threads help?
//! 2. BGRA -> NV12 conversion cost — NV12 is 1.5 bytes/pixel vs 4 for BGRA,
//!    so sending NV12 through the pipe would cut every copy in the chain
//!    (app copy, pipe, ffmpeg read, ffmpeg GPU upload) by ~62%, but the
//!    conversion itself costs CPU.
//!
//! Usage: `cargo run --release --example copybench`

use std::sync::Arc;
use std::thread;
use std::time::Instant;

const W: usize = 1920;
const H: usize = 1080;
const FRAME: usize = W * H * 4;
const ITERS: usize = 100;

fn bench(name: &str, mut f: impl FnMut()) {
    f(); // warmup
    let start = Instant::now();
    for _ in 0..ITERS {
        f();
    }
    let per = start.elapsed() / ITERS as u32;
    let per_ms = per.as_secs_f64() * 1000.0;
    let gbps = (FRAME as f64 / per.as_secs_f64()) / 1e9;
    println!("{name:<34} {per_ms:>7.3}ms/frame  {gbps:>6.2} GB/s (BGRA bytes)");
}

fn main() {
    let src = vec![0u8; FRAME];
    let dst = vec![0u8; FRAME];
    let src = Arc::new(src);
    let dst = Arc::new(dst);

    // Serial copy (what the capture does today).
    let s = src.clone();
    let d = dst.clone();
    bench("copy serial", move || unsafe {
        std::ptr::copy_nonoverlapping(s.as_ptr(), d.as_ptr() as *mut u8, FRAME);
    });

    // Parallel copy over 4 threads.
    let s = src.clone();
    let d = dst.clone();
    bench("copy parallel 4 threads", move || {
        let s = s.clone();
        let d = d.clone();
        let handles: Vec<_> = (0..4)
            .map(|t| {
                let s = s.clone();
                let d = d.clone();
                thread::spawn(move || {
                    let start = t * FRAME / 4;
                    let end = (t + 1) * FRAME / 4;
                    unsafe {
                        std::ptr::copy_nonoverlapping(
                            s.as_ptr().add(start),
                            (d.as_ptr() as *mut u8).add(start),
                            end - start,
                        );
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
    });

    // Scalar BGRA -> NV12 conversion (RGB->YUV matrix + 2x1 chroma subsample).
    let s = src.clone();
    bench("bgra->nv12 scalar (4:2:0)", move || {
        let mut out = vec![0u8; FRAME * 3 / 2];
        let y_plane = H * W;
        let uv_row = W / 2;
        for y in 0..H {
            let row = y * W;
            for x in 0..W {
                let i = (row + x) * 4;
                let b = s[i] as i32;
                let g = s[i + 1] as i32;
                let r = s[i + 2] as i32;
                let yy = (66 * r + 129 * g + 25 * b + 128) >> 8;
                out[row + x] = (yy + 16).clamp(0, 255) as u8;
                if y % 2 == 0 && x % 2 == 0 {
                    let u = (-38 * r - 74 * g + 112 * b + 128) >> 8;
                    let v = (112 * r - 94 * g - 18 * b + 128) >> 8;
                    let uv = (y / 2) * uv_row + (x / 2);
                    out[y_plane + uv * 2] = (u + 128).clamp(0, 255) as u8;
                    out[y_plane + uv * 2 + 1] = (v + 128).clamp(0, 255) as u8;
                }
            }
        }
        std::hint::black_box(&out);
    });

    println!(
        "note: memory-bound copies do not speed up when split across threads; the extra thread scheduling only contends with the game."
    );
}
