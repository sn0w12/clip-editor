//! The audio router: per-source timestamp-ordered queues, zero-fill for
//! missing sources, late-block dropping, selector-based track mixing, and
//! output clamping. Pure logic — no platform access — so it is fully unit
//! tested with synthetic blocks.

use std::collections::{HashMap, VecDeque};
use std::time::Duration;

use tracing::{debug, warn};

use crate::audio::{AudioBlock, AudioEvent, SourceInfo, SourceKey, SourceKind, TrackAudioBlock};
use crate::config::{ResolvedTrack, Selector};
use crate::util::RateLimiter;
/// Mixes per-source audio into per-track output.
pub struct AudioRouter {
    block_ms: u32,
    sample_rate: u32,
    channels: u16,
    tracks: Vec<ResolvedTrack>,
    sources: HashMap<SourceKey, SourceInfo>,
    queues: HashMap<SourceKey, VecDeque<AudioBlock>>,
    /// Reused per-source window buffers to avoid per-mix allocation.
    scratch: HashMap<SourceKey, Vec<f32>>,
    /// Cached per-track route decision per source, recomputed on
    /// registration so the 20 ms mix loop does no selector work.
    routes: HashMap<SourceKey, Vec<bool>>,
    mix_index: u64,
    late_drop: RateLimiter,
    mismatch_drop: RateLimiter,
    /// Diagnostics: drops per source since the last summary log.
    drop_counts: HashMap<SourceKey, u64>,
    last_summary: std::time::Instant,
}

impl AudioRouter {
    pub fn new(
        block_ms: u32,
        sample_rate: u32,
        channels: u16,
        tracks: Vec<ResolvedTrack>,
        sources: Vec<SourceInfo>,
    ) -> Self {
        let mut router = AudioRouter {
            block_ms,
            sample_rate,
            channels,
            tracks,
            sources: HashMap::new(),
            queues: HashMap::new(),
            scratch: HashMap::new(),
            routes: HashMap::new(),
            mix_index: 0,
            late_drop: RateLimiter::new(Duration::from_secs(5)),
            mismatch_drop: RateLimiter::new(Duration::from_secs(5)),
            drop_counts: HashMap::new(),
            last_summary: std::time::Instant::now(),
        };
        for info in sources {
            router.register_source(info);
        }
        router
    }

    fn register_source(&mut self, info: SourceInfo) {
        let key = info.key.clone();
        if !self.sources.contains_key(&key) {
            debug!(source = %key.0, "registered audio source");
        }
        self.sources.insert(key.clone(), info);
        self.queues.entry(key.clone()).or_default();
        self.scratch.entry(key.clone()).or_default();
        // Precompute the per-track route at registration so the 20 ms mix
        // loop does no selector traversal.
        let info = self.sources.get(&key).expect("source just registered");
        self.routes.insert(
            key,
            self.tracks
                .iter()
                .map(|t| Self::track_includes(t, info))
                .collect(),
        );
    }

    /// Apply an event from the audio workers.
    pub fn apply_event(&mut self, event: AudioEvent) {
        match event {
            AudioEvent::Block(block) => self.push_block(block),
            AudioEvent::SourceAdded(info) => self.register_source(info),
            AudioEvent::SourceRemoved(key) => {
                self.queues.remove(&key);
                self.scratch.remove(&key);
                self.routes.remove(&key);
                self.sources.remove(&key);
            }
        }
    }

    fn push_block(&mut self, block: AudioBlock) {
        if block.sample_rate != self.sample_rate || block.channels != self.channels {
            if self.mismatch_drop.should_emit() {
                warn!(
                    source = %block.source.0,
                    rate = block.sample_rate,
                    channels = block.channels,
                    "dropping block with unexpected format"
                );
            }
            return;
        }
        if block.samples.len() % block.channels.max(1) as usize != 0 {
            if self.mismatch_drop.should_emit() {
                warn!(source = %block.source.0, "dropping block with partial frame");
            }
            return;
        }
        let queue = self.queues.entry(block.source.clone()).or_default();
        // Timestamp-ordered insert: blocks are expected in order but a
        // reordered arrival must not corrupt the timeline.
        match queue.back() {
            Some(last) if last.pts <= block.pts => queue.push_back(block),
            _ => {
                let pos = queue.partition_point(|b| b.pts <= block.pts);
                queue.insert(pos, block);
            }
        }
    }

    fn block_frames(&self) -> usize {
        (self.block_ms as u64 * self.sample_rate as u64 / 1000) as usize
    }

    fn block_duration(&self) -> Duration {
        Duration::from_millis(self.block_ms as u64)
    }

    /// Does the source satisfy the selector?
    fn selector_matches(selector: &Selector, info: &SourceInfo) -> bool {
        match selector {
            Selector::AllProcesses => info.kind == SourceKind::Process,
            Selector::AllNonMutedProcesses => info.kind == SourceKind::Process && !info.is_muted(),
            Selector::Source(id) => info.key == SourceKey::process(id),
            Selector::Input(id) => info.key == SourceKey::input(id),
            Selector::Tag(tag) => info.tags.iter().any(|t| t == tag),
        }
    }

    fn track_includes(track: &ResolvedTrack, info: &SourceInfo) -> bool {
        let included = track
            .include
            .iter()
            .any(|s| Self::selector_matches(s, info));
        let excluded = track
            .exclude
            .iter()
            .any(|s| Self::selector_matches(s, info));
        included && !excluded
    }

    /// Produce one mixed block per configured track for the next window.
    /// Missing or late sources contribute silence; selected sources are
    /// summed and clamped to `[-1.0, 1.0]`.
    pub fn mix(&mut self) -> Vec<TrackAudioBlock> {
        let frames = self.block_frames();
        let sample_count = frames * self.channels as usize;
        let win_start_dur = Duration::from_millis(self.mix_index as u64 * self.block_ms as u64);
        let win_end_dur = win_start_dur + self.block_duration();

        // Drop blocks that are entirely before this window (we fell behind).
        for (key, queue) in self.queues.iter_mut() {
            while let Some(front) = queue.front() {
                let block_end = front.pts + front.duration();
                if block_end <= win_start_dur {
                    *self.drop_counts.entry(key.clone()).or_insert(0) += 1;
                    if self.late_drop.should_emit() {
                        warn!(
                            source = %key.0,
                            pts_ms = front.pts.as_millis() as u64,
                            win_start_ms = win_start_dur.as_millis() as u64,
                            "dropping late audio block; source is falling behind"
                        );
                    }
                    queue.pop_front();
                } else {
                    break;
                }
            }
        }
        if self.last_summary.elapsed() >= Duration::from_secs(10) {
            for (key, count) in self.drop_counts.drain() {
                if count > 0 {
                    warn!(source = %key.0, dropped = count, "late-drop summary (10s window)");
                }
            }
            self.last_summary = std::time::Instant::now();
        }

        // Extract each source's window contribution.
        for (key, _info) in self.sources.iter() {
            let scratch = self
                .scratch
                .get_mut(key)
                .expect("scratch exists for registered source");
            scratch.clear();
            scratch.resize(sample_count, 0.0);
            let queue = self
                .queues
                .get_mut(key)
                .expect("queue exists for registered source");
            while let Some(front) = queue.front() {
                if front.pts >= win_end_dur {
                    break;
                }
                // `front` overlaps [win_start, win_end); pop and copy overlap.
                let block = queue.pop_front().expect("front exists");
                let block_end = block.pts + block.duration();
                let copy_from = block.pts.max(win_start_dur);
                let copy_to = block_end.min(win_end_dur);
                let src_frame_start = frame_offset(block.pts, copy_from, self.sample_rate);
                let dst_frame_start = frame_offset(win_start_dur, copy_from, self.sample_rate);
                let frames_to_copy = frame_offset(copy_from, copy_to, self.sample_rate);
                let ch = self.channels as usize;
                for frame in 0..frames_to_copy {
                    let src_off = (src_frame_start + frame) * ch;
                    let dst_off = (dst_frame_start + frame) * ch;
                    let block_samples = &block.samples[src_off..src_off + ch];
                    scratch[dst_off..dst_off + ch].copy_from_slice(block_samples);
                }
                if block_end > win_end_dur {
                    // The block spans the window boundary: keep the tail for
                    // the next window instead of dropping it.
                    let tail_start = frame_offset(block.pts, win_end_dur, self.sample_rate);
                    let tail = AudioBlock {
                        source: block.source,
                        pts: win_end_dur,
                        sample_rate: block.sample_rate,
                        channels: block.channels,
                        samples: block.samples[tail_start * ch..].to_vec(),
                    };
                    queue.push_front(tail);
                    break;
                }
            }
        }

        // Sum selected sources into each track and clamp. The per-track
        // route is cached per source (see `register_source`); a defensive
        // recompute covers any source registered without a cache entry
        // instead of silently excluding it.
        let mut output = Vec::with_capacity(self.tracks.len());
        for (track_index, track) in self.tracks.iter().enumerate() {
            let mut buf = vec![0.0f32; sample_count];
            for key in self.sources.keys() {
                let included = match self.routes.get(key) {
                    Some(routes) => routes[track_index],
                    None => {
                        let info = self.sources.get(key).expect("source exists");
                        let routes: Vec<bool> = self
                            .tracks
                            .iter()
                            .map(|t| Self::track_includes(t, info))
                            .collect();
                        self.routes.insert(key.clone(), routes);
                        self.routes.get(key).expect("route just cached")[track_index]
                    }
                };
                if !included {
                    continue;
                }
                let scratch = self.scratch.get(key).expect("scratch exists");
                for (acc, sample) in buf.iter_mut().zip(scratch.iter()) {
                    *acc += *sample;
                }
            }
            for sample in buf.iter_mut() {
                *sample = sample.clamp(-1.0, 1.0);
            }
            output.push(TrackAudioBlock {
                number: track.number,
                name: track.name.clone(),
                pts: win_start_dur,
                sample_rate: self.sample_rate,
                channels: self.channels,
                samples: buf,
            });
        }

        self.mix_index += 1;
        debug!(
            window_end_ms = win_end_dur.as_millis(),
            "mixed audio window"
        );
        output
    }
}

/// Frames from `start` to `end` at `rate`.
fn frame_offset(start: Duration, end: Duration, rate: u32) -> usize {
    let secs = end.as_secs_f64() - start.as_secs_f64();
    (secs * rate as f64).round() as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(source: &str, pts_ms: u64, frames: usize, channels: u16, rate: u32) -> AudioBlock {
        AudioBlock {
            source: SourceKey(source.to_string()),
            pts: Duration::from_millis(pts_ms),
            sample_rate: rate,
            channels,
            samples: vec![0.5; frames * channels as usize],
        }
    }

    fn info(key: &str, kind: SourceKind, tags: &[&str]) -> SourceInfo {
        SourceInfo {
            key: SourceKey(key.to_string()),
            kind,
            tags: tags.iter().map(|s| s.to_string()).collect(),
            executable: None,
        }
    }

    fn track(
        number: u16,
        name: &str,
        include: Vec<Selector>,
        exclude: Vec<Selector>,
    ) -> ResolvedTrack {
        ResolvedTrack {
            number,
            name: name.to_string(),
            include,
            exclude,
        }
    }

    const RATE: u32 = 48000;
    const CH: u16 = 2;
    const BLOCK_MS: u32 = 20;
    const FRAMES: usize = 960; // 20 ms at 48 kHz

    #[test]
    fn missing_source_is_zero_filled() {
        let sources = vec![info("source:a", SourceKind::Process, &[])];
        let tracks = vec![track(1, "all", vec![Selector::AllProcesses], vec![])];
        let mut router = AudioRouter::new(BLOCK_MS, RATE, CH, tracks, sources);
        // Only window 0 has data; windows 1 and 2 must be silence.
        router.apply_event(AudioEvent::Block(block("source:a", 0, FRAMES, CH, RATE)));
        let m0 = router.mix();
        assert_eq!(
            m0[0].samples.iter().filter(|s| **s != 0.0).count(),
            FRAMES * 2
        );
        let m1 = router.mix();
        assert!(m1[0].samples.iter().all(|s| *s == 0.0));
        let m2 = router.mix();
        assert!(m2[0].samples.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn late_block_is_dropped() {
        let sources = vec![info("source:a", SourceKind::Process, &[])];
        let tracks = vec![track(1, "all", vec![Selector::AllProcesses], vec![])];
        let mut router = AudioRouter::new(BLOCK_MS, RATE, CH, tracks, sources);
        router.mix();
        router.mix();
        // A block for window 0 arriving after window 0 was mixed: dropped.
        router.apply_event(AudioEvent::Block(block("source:a", 0, FRAMES, CH, RATE)));
        let m2 = router.mix();
        assert!(
            m2[0].samples.iter().all(|s| *s == 0.0),
            "late block must not leak into later windows"
        );
        assert_eq!(
            router
                .queues
                .get(&SourceKey("source:a".into()))
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn reordered_blocks_are_timestamp_ordered() {
        let sources = vec![info("source:a", SourceKind::Process, &[])];
        let tracks = vec![track(1, "all", vec![Selector::AllProcesses], vec![])];
        let mut router = AudioRouter::new(BLOCK_MS, RATE, CH, tracks, sources);
        // Arrive out of order: 40 ms first, then 20 ms.
        router.apply_event(AudioEvent::Block(block("source:a", 40, FRAMES, CH, RATE)));
        router.apply_event(AudioEvent::Block(block("source:a", 20, FRAMES, CH, RATE)));
        let queue = router.queues.get(&SourceKey("source:a".into())).unwrap();
        let pts: Vec<u64> = queue.iter().map(|b| b.pts.as_millis() as u64).collect();
        assert_eq!(pts, vec![20, 40]);
    }

    #[test]
    fn muted_and_tracked_routing() {
        // Spotify muted, Discord tracked, another app untagged.
        let sources = vec![
            info("source:spotify", SourceKind::Process, &["muted"]),
            info("source:discord", SourceKind::Process, &["tracked"]),
            info("source:other", SourceKind::Process, &[]),
        ];
        let tracks = vec![
            track(
                1,
                "other",
                vec![Selector::AllProcesses],
                vec![
                    Selector::Tag("muted".into()),
                    Selector::Tag("tracked".into()),
                ],
            ),
            track(
                2,
                "discord",
                vec![Selector::Source("discord".into())],
                vec![],
            ),
            track(5, "non_muted", vec![Selector::AllNonMutedProcesses], vec![]),
        ];
        let mut router = AudioRouter::new(BLOCK_MS, RATE, CH, tracks, sources);
        for (src, amp) in [
            ("source:spotify", 1.0f32),
            ("source:discord", 0.25),
            ("source:other", 0.5),
        ] {
            let mut b = block(src, 0, FRAMES, CH, RATE);
            for s in b.samples.iter_mut() {
                *s = amp;
            }
            router.apply_event(AudioEvent::Block(b));
        }
        let mixed = router.mix();

        // Track 1: only "other" (0.5).
        let t1 = &mixed[0];
        assert_eq!(t1.number, 1);
        assert!(
            t1.samples.iter().all(|s| (s - 0.5).abs() < 1e-6),
            "track1 must contain only `other`"
        );
        // Track 2: only discord (0.25).
        let t2 = &mixed[1];
        assert_eq!(t2.number, 2);
        assert!(
            t2.samples.iter().all(|s| (s - 0.25).abs() < 1e-6),
            "track2 must contain only discord"
        );
        // Track 5: non-muted processes only (discord 0.25 + other 0.5).
        let t5 = &mixed[2];
        assert_eq!(t5.number, 5);
        assert!(
            t5.samples.iter().all(|s| (s - 0.75).abs() < 1e-6),
            "track5 must contain discord + other"
        );
    }

    #[test]
    fn mixing_clamps_to_unit_range() {
        let sources = vec![
            info("source:a", SourceKind::Process, &[]),
            info("source:b", SourceKind::Process, &[]),
        ];
        let tracks = vec![track(1, "all", vec![Selector::AllProcesses], vec![])];
        let mut router = AudioRouter::new(BLOCK_MS, RATE, CH, tracks, sources);
        for src in ["source:a", "source:b"] {
            let mut b = block(src, 0, FRAMES, CH, RATE);
            for s in b.samples.iter_mut() {
                *s = 0.8;
            }
            router.apply_event(AudioEvent::Block(b));
        }
        let mixed = router.mix();
        // 0.8 + 0.8 = 1.6 -> clamped to 1.0.
        assert!(mixed[0].samples.iter().all(|s| *s <= 1.0));
        assert!(mixed[0].samples.iter().any(|s| *s == 1.0));
    }

    #[test]
    fn microphone_never_in_process_tracks() {
        let sources = vec![
            info("input:mic", SourceKind::Input, &[]),
            info("process:1234", SourceKind::Process, &[]),
        ];
        let tracks = vec![
            track(1, "processes", vec![Selector::AllProcesses], vec![]),
            track(3, "mic", vec![Selector::Input("mic".into())], vec![]),
        ];
        let mut router = AudioRouter::new(BLOCK_MS, RATE, CH, tracks, sources);
        for src in ["input:mic", "process:1234"] {
            router.apply_event(AudioEvent::Block(block(src, 0, FRAMES, CH, RATE)));
        }
        let mixed = router.mix();
        // Track 1 gets only the process source.
        assert!(mixed[0].samples.iter().all(|s| (s - 0.5).abs() < 1e-6));
        // Track 3 gets only the microphone.
        assert!(mixed[1].samples.iter().all(|s| (s - 0.5).abs() < 1e-6));
    }

    #[test]
    fn source_removal_stops_contribution() {
        let sources = vec![info("process:100", SourceKind::Process, &[])];
        let tracks = vec![track(
            5,
            "non_muted",
            vec![Selector::AllNonMutedProcesses],
            vec![],
        )];
        let mut router = AudioRouter::new(BLOCK_MS, RATE, CH, tracks, sources);
        router.apply_event(AudioEvent::Block(block("process:100", 0, FRAMES, CH, RATE)));
        assert!(router.mix()[0].samples.iter().any(|s| *s != 0.0));
        router.apply_event(AudioEvent::SourceRemoved(SourceKey("process:100".into())));
        let m = router.mix();
        assert!(
            m[0].samples.iter().all(|s| *s == 0.0),
            "removed source must be silent"
        );
    }

    #[test]
    fn format_mismatch_blocks_dropped() {
        let sources = vec![info("source:a", SourceKind::Process, &[])];
        let tracks = vec![track(1, "all", vec![Selector::AllProcesses], vec![])];
        let mut router = AudioRouter::new(BLOCK_MS, RATE, CH, tracks, sources);
        router.apply_event(AudioEvent::Block(block("source:a", 0, 480, CH, 24000)));
        let m = router.mix();
        assert!(m[0].samples.iter().all(|s| *s == 0.0));
        assert!(
            router
                .queues
                .get(&SourceKey("source:a".into()))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn partial_block_overlap_is_handled() {
        let sources = vec![info("source:a", SourceKind::Process, &[])];
        let tracks = vec![track(1, "all", vec![Selector::AllProcesses], vec![])];
        let mut router = AudioRouter::new(BLOCK_MS, RATE, CH, tracks, sources);
        // A block starting at 10 ms covers [10,30): half in window 0, half in window 1.
        let mut b = block("source:a", 10, FRAMES, CH, RATE);
        for s in b.samples.iter_mut() {
            *s = 1.0;
        }
        router.apply_event(AudioEvent::Block(b));
        let m0 = router.mix();
        // First half of window 0 (10..20 ms) is 1.0, the first 10 ms are silence.
        let ch = CH as usize;
        let frames = FRAMES;
        assert!(m0[0].samples[0..frames * ch / 2].iter().all(|s| *s == 0.0));
        assert!(m0[0].samples[frames * ch / 2..].iter().all(|s| *s == 1.0));
        let m1 = router.mix();
        // Second half of window 1 (0..10 ms) is 1.0, rest silence.
        assert!(m1[0].samples[0..frames * ch / 2].iter().all(|s| *s == 1.0));
        assert!(m1[0].samples[frames * ch / 2..].iter().all(|s| *s == 0.0));
    }
}
