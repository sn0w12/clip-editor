//! Shared audio conversion helpers: deterministic channel conversion and a
//! streaming rubato resampler (passthrough when rates match).

use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Fft, FixedSync, Resampler};

/// Convert interleaved samples from `from` channels to `to` channels into
/// `out` (cleared first): mono→stereo duplicates, multi→mono averages,
/// otherwise channels cycle. Identity conversions copy no data — callers
/// pass the source slice straight through instead.
pub fn convert_channels_into(samples: &[f32], from: u16, to: u16, out: &mut Vec<f32>) {
    if from == to {
        return;
    }
    let from = from.max(1) as usize;
    let to = to.max(1) as usize;
    let frames = samples.len() / from;
    out.clear();
    out.reserve(frames * to);
    for frame in 0..frames {
        for ch in 0..to {
            let src = if to == 1 {
                // downmix to mono
                let sum: f32 = samples[frame * from..(frame + 1) * from].iter().sum();
                sum / from as f32
            } else {
                samples[frame * from + (ch % from)]
            };
            out.push(src);
        }
    }
}

/// A resampler that accepts arbitrary-length interleaved input chunks and
/// yields output on demand. Returns `None` when input and output rates match
/// (the caller then passes samples through untouched).
pub struct StreamingResampler {
    resampler: Fft<f32>,
    channels: usize,
    input_buf: Vec<f32>,
    output_buf: Vec<f32>,
    /// Reused output chunk scratch (avoids per-chunk allocation).
    out_scratch: Vec<f32>,
    delay_to_trim: usize,
}

impl StreamingResampler {
    /// `chunk_size` is a reference target for the internal FFT chunk; the
    /// actual fixed chunk is derived from the rate pair.
    pub fn new(
        sample_rate_in: u32,
        sample_rate_out: u32,
        channels: u16,
        chunk_size: usize,
    ) -> Option<Self> {
        if sample_rate_in == sample_rate_out {
            return None;
        }
        let channels = channels.max(1) as usize;
        let resampler = Fft::new(
            sample_rate_in as usize,
            sample_rate_out as usize,
            chunk_size,
            channels,
            FixedSync::Both,
        )
        .ok()?;
        let delay_to_trim = resampler.output_delay();
        Some(StreamingResampler {
            resampler,
            channels,
            input_buf: Vec::new(),
            output_buf: Vec::new(),
            out_scratch: Vec::new(),
            delay_to_trim,
        })
    }

    /// Feed interleaved input samples.
    pub fn push(&mut self, samples: &[f32]) {
        debug_assert_eq!(samples.len() % self.channels, 0);
        self.input_buf.extend_from_slice(samples);
        self.drain();
    }

    fn drain(&mut self) {
        let ch = self.channels;
        let mut consumed = 0usize;
        loop {
            let input_frames = self.resampler.input_frames_next();
            let needed = input_frames * ch;
            if self.input_buf.len() - consumed < needed {
                break;
            }
            // Process the chunk in place (disjoint field borrows), then drop
            // the consumed prefix in one `drain` instead of allocating a Vec
            // per chunk.
            let input = &self.input_buf[consumed..consumed + needed];
            let input_adapter =
                InterleavedSlice::new(input, ch, input_frames).expect("input adapter fits");
            let output_frames = self.resampler.output_frames_next();
            self.out_scratch.resize(output_frames * ch, 0.0);
            let mut out_adapter =
                InterleavedSlice::new_mut(&mut self.out_scratch, ch, output_frames)
                    .expect("output adapter fits");
            if let Err(e) =
                self.resampler
                    .process_into_buffer(&input_adapter, &mut out_adapter, None)
            {
                // Never expected for a fixed-chunk resampler; skip the chunk.
                tracing::warn!(error = %e, "resampler chunk failed");
                consumed += needed;
                continue;
            }
            self.output_buf.extend_from_slice(&self.out_scratch);
            consumed += needed;
        }
        if consumed > 0 {
            self.input_buf.drain(..consumed);
        }
    }

    /// Take the accumulated resampled output, trimming the initial filter
    /// delay once.
    pub fn take_output(&mut self) -> Vec<f32> {
        let mut out = std::mem::take(&mut self.output_buf);
        if self.delay_to_trim > 0 {
            let trim = self.delay_to_trim * self.channels;
            if out.len() > trim {
                out.drain(..trim);
            } else {
                out.clear();
            }
            self.delay_to_trim = 0;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_conversion_mono_to_stereo() {
        let mono = vec![0.25f32, -0.5];
        let mut out = Vec::new();
        convert_channels_into(&mono, 1, 2, &mut out);
        assert_eq!(out, vec![0.25, 0.25, -0.5, -0.5]);
    }

    #[test]
    fn channel_conversion_stereo_to_mono() {
        let stereo = vec![0.25f32, 0.75, -0.5, 0.5];
        let mut out = Vec::new();
        convert_channels_into(&stereo, 2, 1, &mut out);
        assert_eq!(out, vec![0.5, 0.0]);
    }

    #[test]
    fn channel_conversion_stereo_to_four() {
        let stereo = vec![0.1f32, 0.2];
        let mut out = Vec::new();
        convert_channels_into(&stereo, 2, 4, &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.1, 0.2]);
    }

    #[test]
    fn channel_conversion_same_is_identity() {
        // Identity conversions copy no data; callers pass the source slice.
        let s = vec![0.1f32, 0.2, 0.3, 0.4];
        let mut out = vec![9.9; 4];
        convert_channels_into(&s, 2, 2, &mut out);
        assert_eq!(out, vec![9.9; 4], "identity must not touch `out`");
    }

    #[test]
    fn channel_conversion_reuses_out_capacity() {
        let mut out = vec![7.0; 64];
        convert_channels_into(&[0.25f32, -0.5], 1, 2, &mut out);
        assert_eq!(
            out,
            vec![0.25, 0.25, -0.5, -0.5],
            "out is cleared before filling"
        );
    }

    #[test]
    fn passthrough_when_rates_match() {
        assert!(StreamingResampler::new(48000, 48000, 2, 960).is_none());
    }

    #[test]
    fn resamples_44100_to_48000() {
        let mut resampler =
            StreamingResampler::new(44100, 48000, 2, 960).expect("resampler exists");
        // Feed 1 second (44100 frames) of a 1 kHz sine; the fixed FFT chunk
        // leaves a sub-chunk remainder buffered, so assert a bounded range
        // around the expected 48000 output frames minus filter delay.
        let mut input = Vec::with_capacity(44100 * 2);
        for i in 0..44100 {
            let v = (i as f32 * 2.0 * std::f32::consts::PI * 1000.0 / 44100.0).sin();
            input.push(v);
            input.push(v);
        }
        resampler.push(&input);
        let out = resampler.take_output();
        // ~48000 output frames × 2 channels minus filter delay and the
        // sub-chunk remainder that stays buffered.
        assert!(out.len() >= 84_000, "output too short: {}", out.len());
        assert!(out.len() <= 100_000, "output too long: {}", out.len());
        assert!(
            out.iter().any(|s| s.abs() > 0.5),
            "sine should pass through"
        );
    }
}
