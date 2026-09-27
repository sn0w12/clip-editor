//! Deterministic hot-path benchmarks for the DXGI capture path: pool
//! acquisition/reuse (Arc) versus the removed per-frame full-frame clone, the
//! staging row copies the NV12 readback still performs, and `send_drop_oldest`
//! under empty and full queues. No Windows capture hardware is required;
//! hardware-dependent checks live in `capbench` and the delivery gate.

use std::sync::Arc;
use std::time::Duration;

use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use screencap::util::{RateLimiter, send_drop_oldest};
use screencap::video::windows_dxgi::take_buffer_arc;

const W: usize = 1920;
const H: usize = 1080;
/// NV12 luma plus chroma, the size of one captured frame.
const FRAME_LEN: usize = W * H * 3 / 2;
/// A width whose luma row is not 128-byte aligned, so the readback takes the
/// per-row path rather than one contiguous copy.
const PW: usize = 1366;
const PH: usize = 768;

/// The pre-optimization operation: clone the full frame into a fresh Arc for
/// the pool, then wrap the original in a second Arc for the published frame.
fn clone_based_readback(pool: &mut Vec<Arc<Vec<u8>>>, data: &mut Vec<u8>) -> Arc<Vec<u8>> {
    if pool.len() < 4 {
        pool.push(Arc::new(data.clone()));
    }
    Arc::new(std::mem::take(data))
}

fn bench_buffer_ownership(c: &mut Criterion) {
    let mut group = c.benchmark_group("video_buffer");
    group.throughput(criterion::Throughput::Bytes(FRAME_LEN as u64));

    group.bench_function("arc_pool_acquire_only_warm", |b| {
        b.iter_batched(
            || {
                let mut pool: Vec<Arc<Vec<u8>>> = Vec::new();
                for _ in 0..4 {
                    let buf = take_buffer_arc(&mut pool, FRAME_LEN);
                    pool.push(buf);
                }
                pool
            },
            |mut pool| {
                let buf = take_buffer_arc(&mut pool, FRAME_LEN);
                std::hint::black_box(Arc::as_ptr(&buf));
                if pool.len() < 4 {
                    pool.push(buf);
                }
            },
            BatchSize::SmallInput,
        );
    });

    group.bench_function("arc_pool_write_and_publish", |b| {
        b.iter_batched(
            || {
                let mut pool: Vec<Arc<Vec<u8>>> = Vec::new();
                // Warm the pool as production does: every published clone has
                // been released by the pacer, so entries are uniquely owned.
                for _ in 0..4 {
                    let buf = take_buffer_arc(&mut pool, FRAME_LEN);
                    pool.push(buf);
                }
                (pool, vec![0x5Au8; FRAME_LEN])
            },
            |(mut pool, frame)| {
                let mut buffer = take_buffer_arc(&mut pool, FRAME_LEN);
                let data = Arc::get_mut(&mut buffer).expect("uniquely owned");
                data.copy_from_slice(&frame);
                let published = buffer.clone();
                if pool.len() < 4 {
                    pool.push(buffer);
                }
                std::hint::black_box(published);
            },
            BatchSize::SmallInput,
        );
    });

    group.bench_function("clone_based_readback", |b| {
        b.iter_batched(
            || (Vec::new(), vec![0x5Au8; FRAME_LEN]),
            |(mut pool, mut frame)| {
                let published = clone_based_readback(&mut pool, &mut frame);
                std::hint::black_box(published);
            },
            BatchSize::SmallInput,
        );
    });

    group.finish();
}

fn bench_row_copy(c: &mut Criterion) {
    let mut group = c.benchmark_group("row_copy");
    group.throughput(criterion::Throughput::Bytes(FRAME_LEN as u64));

    // Tight pitch: an luma plane of W bytes per row is 128-byte aligned at
    // 1920 wide, so the readback copies it as one contiguous run.
    let y_len = W * H;
    let src = vec![0x3Cu8; y_len];
    let mut dst = vec![0u8; y_len];
    group.bench_function("tight_luma_copy_1920x1080", |b| {
        b.iter(|| {
            // SAFETY: disjoint, in-bounds regions of `src` and `dst`.
            unsafe {
                std::ptr::copy_nonoverlapping(src.as_ptr(), dst.as_mut_ptr(), y_len);
            }
            std::hint::black_box(&dst);
        });
    });

    // Padded pitch: at 1366 wide the luma row is not 128-byte aligned, so
    // `RowPitch` exceeds it and every row is copied separately.
    let row_len = PW;
    let row_pitch = (row_len + 127) & !127;
    let padded = vec![0u8; row_pitch * PH];
    let mut dst2 = vec![0u8; row_len * PH];
    group.bench_function("padded_luma_copy_1366x768", |b| {
        b.iter(|| {
            for y in 0..PH {
                // SAFETY: `padded` holds `row_pitch * PH` bytes; each row's
                // source range and the packed destination range are in-bounds
                // and disjoint.
                unsafe {
                    std::ptr::copy_nonoverlapping(
                        padded.as_ptr().add(y * row_pitch),
                        dst2.as_mut_ptr().add(y * row_len),
                        row_len,
                    );
                }
            }
            std::hint::black_box(&dst2);
        });
    });

    group.finish();
}

fn bench_send_drop_oldest(c: &mut Criterion) {
    let mut group = c.benchmark_group("send_drop_oldest");
    group.throughput(criterion::Throughput::Elements(1));

    group.bench_function("empty_queue", |b| {
        b.iter_batched(
            || {
                let (tx, rx) = crossbeam_channel::bounded::<u64>(64);
                let mut limiter = RateLimiter::new(Duration::from_secs(5));
                (tx, rx, limiter)
            },
            |(tx, rx, mut limiter)| {
                let dropped = send_drop_oldest(&tx, &rx, 1u64, &mut limiter, "bench");
                std::hint::black_box(dropped);
            },
            BatchSize::SmallInput,
        );
    });

    group.bench_function("full_queue", |b| {
        b.iter_batched(
            || {
                // A single-slot queue: every send must evict the oldest.
                let (tx, rx) = crossbeam_channel::bounded::<u64>(1);
                let mut limiter = RateLimiter::new(Duration::from_secs(5));
                (tx, rx, limiter)
            },
            |(tx, rx, mut limiter)| {
                let dropped = send_drop_oldest(&tx, &rx, 1u64, &mut limiter, "bench");
                std::hint::black_box(dropped);
            },
            BatchSize::SmallInput,
        );
    });

    group.finish();
}

fn bench_all(c: &mut Criterion) {
    bench_buffer_ownership(c);
    bench_row_copy(c);
    bench_send_drop_oldest(c);
}

criterion_group!(benches, bench_all);
criterion_main!(benches);
