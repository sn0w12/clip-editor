//! Streaming resampler throughput and the deterministic decode/channel
//! conversions: 44.1 kHz -> 48 kHz resampling, little-endian f32 decode
//! (aligned and unaligned), and channel conversion (mono->stereo,
//! stereo->mono, passthrough). All benches reuse the scratch `out` buffer
//! exactly like the production capture workers.

use criterion::{Criterion, criterion_group, criterion_main};
use screencap::audio::resample::{StreamingResampler, convert_channels_into};

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

fn bench_channel_conversion(c: &mut Criterion) {
    let mono: Vec<f32> = (0..48000)
        .map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 440.0 / 48000.0).sin())
        .collect();
    let stereo: Vec<f32> = mono.iter().flat_map(|&s| [s, s * 0.5]).collect();
    let mut group = c.benchmark_group("channel_conversion");
    group.throughput(criterion::Throughput::Elements(48000));

    let mut out = Vec::new();
    group.bench_function("mono_to_stereo_1s", |b| {
        b.iter(|| {
            convert_channels_into(&mono, 1, 2, &mut out);
            std::hint::black_box(&out);
        });
    });
    group.bench_function("stereo_to_mono_1s", |b| {
        b.iter(|| {
            convert_channels_into(&stereo, 2, 1, &mut out);
            std::hint::black_box(&out);
        });
    });
    group.bench_function("passthrough_same_channels", |b| {
        b.iter(|| {
            convert_channels_into(&stereo, 2, 2, &mut out);
            std::hint::black_box(&out);
        });
    });
    group.finish();
}

#[cfg(windows)]
fn bench_decode(c: &mut Criterion) {
    use screencap::audio::windows::f32s_from_le_into;

    let mut bytes = Vec::with_capacity(48000 * 4);
    for i in 0..48000 {
        bytes.extend_from_slice(
            &(i as f32 * 2.0 * std::f32::consts::PI * 440.0 / 48000.0)
                .sin()
                .to_le_bytes(),
        );
    }
    // Shift by one byte so the window pointer is not 4-aligned.
    let mut shifted = vec![0u8; bytes.len() + 1];
    shifted[1..].copy_from_slice(&bytes);

    let mut group = c.benchmark_group("decode");
    group.throughput(criterion::Throughput::Elements(48000));

    let mut out = Vec::new();
    group.bench_function("f32_le_aligned_1s", |b| {
        b.iter(|| {
            f32s_from_le_into(&bytes, &mut out);
            std::hint::black_box(&out);
        });
    });
    group.bench_function("f32_le_unaligned_1s", |b| {
        b.iter(|| {
            f32s_from_le_into(&shifted[1..], &mut out);
            std::hint::black_box(&out);
        });
    });
    group.finish();
}

fn bench_all(c: &mut Criterion) {
    bench_resample(c);
    bench_channel_conversion(c);
    #[cfg(windows)]
    bench_decode(c);
}

criterion_group!(benches, bench_all);
criterion_main!(benches);
