//! Streaming resampler throughput: 44.1 kHz -> 48 kHz, one second of audio.

use criterion::{Criterion, criterion_group, criterion_main};
use screencap::audio::resample::StreamingResampler;

fn bench_resample(c: &mut Criterion) {
    let mut input = Vec::with_capacity(44100 * 2);
    for i in 0..44100 {
        let v = (i as f32 * 2.0 * std::f32::consts::PI * 440.0 / 44100.0).sin();
        input.push(v);
        input.push(v);
    }
    let mut group = c.benchmark_group("resample");
    group.throughput(criterion::Throughput::Elements(input.len() as u64));
    group.bench_function("44100_to_48000_1s", |b| {
        b.iter(|| {
            let mut resampler = StreamingResampler::new(44100, 48000, 2, 960).unwrap();
            resampler.push(&input);
            std::hint::black_box(resampler.take_output());
        });
    });
    group.finish();
}

criterion_group!(benches, bench_resample);
criterion_main!(benches);
