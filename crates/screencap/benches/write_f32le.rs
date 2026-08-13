//! f32le serialization throughput (the segmenter's per-track pipe writer).

use criterion::{Criterion, criterion_group, criterion_main};
use screencap::util::write_f32le;

fn write_f32le_per_sample<W: std::io::Write>(
    writer: &mut W,
    samples: &[f32],
) -> std::io::Result<()> {
    for s in samples {
        writer.write_all(&s.to_le_bytes())?;
    }
    Ok(())
}

fn bench_write_f32le(c: &mut Criterion) {
    let samples: Vec<f32> = vec![0.5; 1920 * 100]; // 100 blocks of 20 ms
    let mut group = c.benchmark_group("write_f32le");
    group.throughput(criterion::Throughput::Bytes(samples.len() as u64 * 4));
    group.bench_function("bulk_100_blocks_to_vec", |b| {
        b.iter(|| {
            let mut buf = Vec::with_capacity(samples.len() * 4);
            std::hint::black_box(write_f32le(&mut buf, &samples).unwrap());
            std::hint::black_box(buf.len());
        });
    });
    group.bench_function("per_sample_100_blocks_to_vec", |b| {
        b.iter(|| {
            let mut buf = Vec::with_capacity(samples.len() * 4);
            std::hint::black_box(write_f32le_per_sample(&mut buf, &samples).unwrap());
            std::hint::black_box(buf.len());
        });
    });
    group.finish();
}

criterion_group!(benches, bench_write_f32le);
criterion_main!(benches);
