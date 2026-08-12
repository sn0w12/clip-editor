//! Config extraction + validation cost (no file I/O; the sample config is the
//! heaviest realistic document).

use criterion::{Criterion, criterion_group, criterion_main};
use figment::providers::{Format, Toml};
use figment::Figment;
use screencap::config::Config;

fn bench_config(c: &mut Criterion) {
    let mut group = c.benchmark_group("config");
    group.bench_function("extract_and_validate_sample", |b| {
        b.iter(|| {
            let figment = Figment::new().merge(Toml::string(screencap::config::SAMPLE_CONFIG));
            std::hint::black_box(Config::from_figment(figment).unwrap());
        });
    });
    group.finish();
}

criterion_group!(benches, bench_config);
criterion_main!(benches);
