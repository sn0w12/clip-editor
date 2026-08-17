//! Steady-state mix throughput: per-window cost with 8 sources and 4 tracks
//! (including one block per source being pushed back per window).

use std::time::Duration;

use criterion::{BatchSize, Criterion, criterion_group, criterion_main};
use screencap::audio::{AudioBlock, AudioEvent, AudioRouter, SourceInfo, SourceKey, SourceKind};
use screencap::config::{ResolvedTrack, Selector};

fn block(source: &str, pts_ms: u64) -> AudioBlock {
    AudioBlock {
        source: SourceKey(source.to_string()),
        pts: Duration::from_millis(pts_ms),
        sample_rate: 48000,
        channels: 2,
        samples: vec![0.5; 1920],
    }
}

fn source(i: u32) -> SourceInfo {
    SourceInfo {
        key: SourceKey(format!("process:{i}")),
        kind: SourceKind::Process,
        tags: Vec::new(),
        executable: None,
    }
}

fn tracks() -> Vec<ResolvedTrack> {
    vec![
        ResolvedTrack {
            number: 1,
            name: "other".into(),
            include: vec![Selector::AllProcesses],
            exclude: vec![Selector::Tag("muted".into())],
        },
        ResolvedTrack {
            number: 2,
            name: "discord".into(),
            include: vec![Selector::Source("discord".into())],
            exclude: vec![],
        },
        ResolvedTrack {
            number: 3,
            name: "mic".into(),
            include: vec![Selector::Input("mic".into())],
            exclude: vec![],
        },
        ResolvedTrack {
            number: 5,
            name: "non_muted".into(),
            include: vec![Selector::AllNonMutedProcesses],
            exclude: vec![],
        },
    ]
}

/// Selector-heavy track set: several multi-selector include/exclude lists so
/// the per-window selector traversal (now cached) is the dominant cost.
fn selector_heavy_tracks() -> Vec<ResolvedTrack> {
    vec![
        ResolvedTrack {
            number: 1,
            name: "other".into(),
            include: vec![Selector::AllProcesses, Selector::Tag("tracked".into())],
            exclude: vec![
                Selector::Tag("muted".into()),
                Selector::Source("discord".into()),
            ],
        },
        ResolvedTrack {
            number: 2,
            name: "discord".into(),
            include: vec![
                Selector::Source("discord".into()),
                Selector::Source("spotify".into()),
            ],
            exclude: vec![Selector::Tag("muted".into())],
        },
        ResolvedTrack {
            number: 3,
            name: "mic".into(),
            include: vec![Selector::Input("mic".into())],
            exclude: vec![],
        },
        ResolvedTrack {
            number: 5,
            name: "non_muted".into(),
            include: vec![Selector::AllNonMutedProcesses],
            exclude: vec![
                Selector::Source("discord".into()),
                Selector::Tag("muted".into()),
            ],
        },
    ]
}

fn bench_mix(c: &mut Criterion) {
    let sources: Vec<SourceInfo> = (0..8).map(source).collect();
    let tracks = tracks();
    let mut group = c.benchmark_group("router");
    group.throughput(criterion::Throughput::Elements(1));
    group.bench_function("mix_window_8sources_4tracks", |b| {
        b.iter_batched(
            || {
                let mut router = AudioRouter::new(20, 48000, 2, tracks.clone(), sources.clone());
                for s in &sources {
                    for k in 0..100u64 {
                        router.apply_event(AudioEvent::Block(block(&s.key.0, k * 20)));
                    }
                }
                router
            },
            |mut router| {
                for s in &sources {
                    router.apply_event(AudioEvent::Block(block(&s.key.0, 2000)));
                }
                let out = router.mix();
                std::hint::black_box(out.len());
            },
            BatchSize::SmallInput,
        );
    });
    group.finish();
}

fn bench_selector_heavy(c: &mut Criterion) {
    let sources: Vec<SourceInfo> = (0..8).map(source).collect();
    let tracks = selector_heavy_tracks();
    let mut group = c.benchmark_group("router");
    group.throughput(criterion::Throughput::Elements(1));
    group.bench_function("mix_window_8sources_4tracks_selector_heavy", |b| {
        b.iter_batched(
            || {
                let mut router = AudioRouter::new(20, 48000, 2, tracks.clone(), sources.clone());
                for s in &sources {
                    for k in 0..100u64 {
                        router.apply_event(AudioEvent::Block(block(&s.key.0, k * 20)));
                    }
                }
                router
            },
            |mut router| {
                for s in &sources {
                    router.apply_event(AudioEvent::Block(block(&s.key.0, 2000)));
                }
                let out = router.mix();
                std::hint::black_box(out.len());
            },
            BatchSize::SmallInput,
        );
    });

    group.bench_function("mix_window_dynamic_source_add_remove", |b| {
        b.iter_batched(
            || {
                let mut router = AudioRouter::new(20, 48000, 2, tracks.clone(), sources.clone());
                for s in &sources {
                    for k in 0..100u64 {
                        router.apply_event(AudioEvent::Block(block(&s.key.0, k * 20)));
                    }
                }
                router
            },
            |mut router| {
                // A transient source appears between windows and is removed
                // again, exercising route cache insert + eviction per mix.
                let dyn_key = SourceKey("process:9999".into());
                router.apply_event(AudioEvent::SourceAdded(source(9999)));
                router.apply_event(AudioEvent::Block(block(&dyn_key.0, 2000)));
                let out = router.mix();
                router.apply_event(AudioEvent::SourceRemoved(dyn_key));
                let out2 = router.mix();
                std::hint::black_box(out.len() + out2.len());
            },
            BatchSize::SmallInput,
        );
    });
    group.finish();
}

criterion_group!(benches, bench_mix, bench_selector_heavy);
criterion_main!(benches);
