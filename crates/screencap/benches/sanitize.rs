//! Filename sanitization throughput.

use criterion::{Criterion, criterion_group, criterion_main};
use screencap::naming::sanitize_title;

fn bench_sanitize(c: &mut Criterion) {
    let titles = [
        "My/Game:Clip",
        "Counter-Strike 2 - Match #12345",
        "A very long window title that goes on and on and on and on and on and on and on",
        "Discord | General | #voice-chat",
        "",
        "   trailing spaces   ",
    ];
    let mut group = c.benchmark_group("sanitize");
    group.bench_function("typical_titles", |b| {
        b.iter(|| {
            for t in &titles {
                std::hint::black_box(sanitize_title(t));
            }
        });
    });
    group.finish();
}

criterion_group!(benches, bench_sanitize);
criterion_main!(benches);
