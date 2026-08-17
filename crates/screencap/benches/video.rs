//! Deterministic hot-path benchmarks for the DXGI readback path: pool
//! acquisition/reuse (Arc) versus the removed per-frame full-frame clone,
//! tight/padded row copies, cursor alpha blending, and `send_drop_oldest`
//! under empty and full queues. No Windows capture hardware is required;
//! hardware-dependent checks live in `capbench` and the delivery gate.

use std::sync::Arc;
use std::time::Duration;

use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use screencap::util::{RateLimiter, send_drop_oldest};
use screencap::video::windows_dxgi::{blend_cursor, take_buffer_arc};
use windows::Win32::Graphics::Dxgi::{
    DXGI_OUTDUPL_POINTER_SHAPE_INFO, DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR,
};

const W: usize = 1920;
const H: usize = 1080;
const FRAME_LEN: usize = W * H * 4;

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

    // Tight pitch: the staging mapping's RowPitch equals the packed row.
    let mut src = vec![0x3Cu8; FRAME_LEN];
    let mut dst = vec![0u8; FRAME_LEN];
    group.bench_function("tight_row_copy_1920x1080", |b| {
        b.iter(|| {
            // SAFETY: disjoint, in-bounds regions of `src` and `dst`.
            unsafe {
                std::ptr::copy_nonoverlapping(src.as_ptr(), dst.as_mut_ptr(), FRAME_LEN);
            }
            std::hint::black_box(&dst);
        });
    });

    // Padded pitch: RowPitch is larger than the packed row (e.g. 128-byte
    // aligned staging), so each row is copied separately.
    let row_len = W * 4;
    let row_pitch = (row_len + 127) & !127;
    let mut padded = vec![0u8; row_pitch * H];
    let mut dst2 = vec![0u8; FRAME_LEN];
    group.bench_function("padded_row_copy_1920x1080", |b| {
        b.iter(|| {
            for y in 0..H {
                // SAFETY: `padded` holds `row_pitch * H` bytes; each row's
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

fn shape_info(width: u32, height: u32, pitch: u32) -> DXGI_OUTDUPL_POINTER_SHAPE_INFO {
    DXGI_OUTDUPL_POINTER_SHAPE_INFO {
        Type: DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR.0 as u32,
        Width: width,
        Height: height,
        Pitch: pitch,
        HotSpot: windows::Win32::Foundation::POINT { x: 0, y: 0 },
    }
}

fn bench_cursor_blend(c: &mut Criterion) {
    // A 64x64 color cursor (alpha ramp) at the frame center.
    let shape: Vec<u8> = (0..64 * 64)
        .flat_map(|i| {
            let a = ((i % 64) * 4) as u8;
            [i as u8, (i * 7) as u8, (i * 13) as u8, a]
        })
        .collect();
    let info = shape_info(64, 64, 64 * 4);

    let mut group = c.benchmark_group("cursor_blend");
    group.throughput(criterion::Throughput::Elements(64 * 64 as u64));

    let mut frame = vec![0u8; FRAME_LEN];
    group.bench_function("blend_64x64_center", |b| {
        b.iter(|| {
            blend_cursor(&mut frame, W as u32, H as u32, &shape, info, 900, 500);
            std::hint::black_box(&frame);
        });
    });

    // Clipped at the top-left corner: only the in-bounds part is blended.
    group.bench_function("blend_64x64_clipped_corner", |b| {
        b.iter(|| {
            blend_cursor(&mut frame, W as u32, H as u32, &shape, info, -32, -32);
            std::hint::black_box(&frame);
        });
    });

    // Fully off-screen: the loop must walk the shape without writing.
    group.bench_function("blend_64x64_offscreen", |b| {
        b.iter(|| {
            let drew = blend_cursor(&mut frame, W as u32, H as u32, &shape, info, W as i32, H as i32);
            std::hint::black_box(drew);
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
    bench_cursor_blend(c);
    bench_send_drop_oldest(c);
}

criterion_group!(benches, bench_all);
criterion_main!(benches);
