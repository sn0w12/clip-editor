//! Microphone capture with CPAL: device selection by name, conversion to f32,
//! rubato resampling to `audio.sample_rate`, and deterministic channel
//! conversion. Device disappearance is a terminal capture error.

use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{Receiver, Sender};
use tracing::debug;

use crate::audio::resample::{StreamingResampler, convert_channels_into};
use crate::audio::{AudioBlock, AudioError, AudioEvent, SourceKey};
use crate::config::InputRule;
use crate::error::RunError;
use crate::util::{RateLimiter, send_drop_oldest};

/// Start the microphone producer on its own thread. Returns an error only if
/// the configured device cannot be opened at startup.
pub fn spawn_microphone(
    input: &InputRule,
    origin: std::time::Instant,
    event_tx: Sender<AudioEvent>,
    event_rx: Receiver<AudioEvent>,
    err_tx: Sender<RunError>,
    shutdown: Receiver<()>,
    sample_rate: u32,
    channels: u16,
    block_ms: u32,
) -> Result<(), AudioError> {
    let key = SourceKey::input(&input.id);
    let device_name = input.device.clone();

    let host = cpal::default_host();
    let device = if device_name == "default" {
        host.default_input_device()
            .ok_or_else(|| AudioError::Microphone("no default input device found".to_string()))?
    } else {
        host.devices()
            .map_err(|e| AudioError::Microphone(format!("cannot enumerate input devices: {e}")))?
            .find(|d| {
                d.description()
                    .map(|desc| desc.name() == device_name)
                    .unwrap_or(false)
            })
            .ok_or_else(|| {
                AudioError::Microphone(format!("input device `{device_name}` not found"))
            })?
    };
    let config = device
        .default_input_config()
        .map_err(|e| AudioError::Microphone(format!("cannot read device config: {e}")))?;
    let device_rate = config.sample_rate();
    let device_channels = config.channels();
    debug!(
        input = %key.0,
        device = %device_name,
        rate = device_rate,
        channels = device_channels,
        format = ?config.sample_format(),
        "microphone device resolved"
    );

    let stream_config: cpal::StreamConfig = config.config();
    let sample_format = config.sample_format();
    let err_tx_thread = err_tx.clone();
    let event_tx_thread = event_tx.clone();
    let event_rx_thread = event_rx.clone();

    thread::Builder::new()
        .name("audio-mic".to_string())
        .spawn(move || {
            let mut limiter = RateLimiter::new(Duration::from_secs(5));
            let mut resampler = StreamingResampler::new(device_rate, sample_rate, channels, 960);
            let block_frames = (sample_rate as u64 * block_ms as u64 / 1000) as usize;
            let block_dur = Duration::from_secs_f64(block_frames as f64 / sample_rate as f64);
            // Data-timeline PTS (see the loopback worker for why burst reads
            // must not stamp wall time per cut).
            let mut next_pts: Option<Duration> = None;
            let mut pending: Vec<f32> = Vec::new();

            let err_cb = {
                let err_tx = err_tx_thread.clone();
                move |err: cpal::Error| {
                    // Device disappearance is terminal: a silent microphone
                    // would silently violate the no-leak invariant.
                    let _ = err_tx.send(RunError::Capture(crate::error::CaptureError::Audio(
                        AudioError::Microphone(format!("input stream error: {err}")),
                    )));
                }
            };

            let data_cb = {
                let key = key.clone();
                let event_tx = event_tx_thread.clone();
                let event_rx = event_rx_thread.clone();
                // Reused decode/conversion scratch: the callback allocates
                // nothing in steady state.
                let mut samples: Vec<f32> = Vec::new();
                let mut converted: Vec<f32> = Vec::new();
                move |data: &cpal::Data, _info: &cpal::InputCallbackInfo| {
                    decode_to_f32_into(data, &mut samples);
                    let source: &[f32] = if device_channels != channels {
                        convert_channels_into(
                            &samples,
                            device_channels,
                            channels,
                            &mut converted,
                        );
                        &converted
                    } else {
                        &samples
                    };
                    match resampler.as_mut() {
                        Some(r) => {
                            r.push(source);
                            pending.extend_from_slice(&r.take_output());
                        }
                        None => pending.extend_from_slice(source),
                    }
                    while pending.len() >= block_frames * channels as usize {
                        let block: Vec<f32> =
                            pending.drain(..block_frames * channels as usize).collect();
                        let block_pts = match next_pts {
                            Some(pts) => pts,
                            None => {
                                let start = origin.elapsed().saturating_sub(block_dur);
                                Duration::from_millis(
                                    ((start.as_millis() / block_ms as u128) * block_ms as u128)
                                        as u64,
                                )
                            }
                        };
                        next_pts = Some(block_pts + block_dur);
                        send_drop_oldest(
                            &event_tx,
                            &event_rx,
                            AudioEvent::Block(AudioBlock {
                                source: key.clone(),
                                pts: block_pts,
                                sample_rate,
                                channels,
                                samples: block,
                            }),
                            &mut limiter,
                            "mic",
                        );
                    }
                }
            };

            let stream = device
                .build_input_stream_raw(stream_config, sample_format, data_cb, err_cb, None)
                .map_err(|e| AudioError::Microphone(format!("cannot build input stream: {e}")));
            match stream {
                Ok(stream) => {
                    if let Err(e) = stream.play() {
                        let _ = err_tx_thread.send(RunError::Capture(
                            crate::error::CaptureError::Audio(AudioError::Microphone(format!(
                                "cannot start input stream: {e}"
                            ))),
                        ));
                        return;
                    }
                    // Keep the stream alive until shutdown.
                    let _ = shutdown.recv();
                    let _ = stream.pause();
                }
                Err(e) => {
                    let _ =
                        err_tx_thread.send(RunError::Capture(crate::error::CaptureError::Audio(e)));
                }
            }
        })
        .map_err(|e| AudioError::Microphone(format!("cannot spawn microphone thread: {e}")))?;

    Ok(())
}

/// Decode a raw CPAL data buffer to interleaved `f32` samples in `out`
/// (cleared first; reused across callbacks).
fn decode_to_f32_into(data: &cpal::Data, out: &mut Vec<f32>) {
    out.clear();
    let bytes = data.bytes();
    match data.sample_format() {
        cpal::SampleFormat::F32 => {
            #[cfg(target_endian = "little")]
            if bytes.as_ptr() as usize % 4 == 0 && bytes.len() % 4 == 0 {
                // SAFETY: aligned f32-sized region; LE bytes are the encoding.
                unsafe {
                    out.extend_from_slice(std::slice::from_raw_parts(
                        bytes.as_ptr() as *const f32,
                        bytes.len() / 4,
                    ));
                }
                return;
            }
            for c in bytes.chunks_exact(4) {
                out.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
            }
        }
        cpal::SampleFormat::I16 => {
            for c in bytes.chunks_exact(2) {
                out.push(i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0);
            }
        }
        cpal::SampleFormat::I32 => {
            for c in bytes.chunks_exact(4) {
                out.push(i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f32 / 2147483648.0);
            }
        }
        cpal::SampleFormat::I64 => {
            for c in bytes.chunks_exact(8) {
                out.push(
                    i64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]) as f32
                        / 9223372036854775808.0,
                );
            }
        }
        cpal::SampleFormat::I8 => {
            for &b in bytes.iter() {
                out.push(b as i8 as f32 / 128.0);
            }
        }
        cpal::SampleFormat::U8 => {
            for &b in bytes.iter() {
                out.push((b as f32 - 128.0) / 128.0);
            }
        }
        cpal::SampleFormat::U16 => {
            for c in bytes.chunks_exact(2) {
                out.push((u16::from_le_bytes([c[0], c[1]]) as f32 - 32768.0) / 32768.0);
            }
        }
        cpal::SampleFormat::F64 => {
            for c in bytes.chunks_exact(8) {
                out.push(f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]])
                    as f32);
            }
        }
        cpal::SampleFormat::I24 => {
            // 24-bit samples stored in 4 bytes (little endian, sign-extended).
            for c in bytes.chunks_exact(4) {
                let raw = i32::from_le_bytes([c[0], c[1], c[2], c[3]]);
                out.push((raw >> 8) as f32 / 8388608.0);
            }
        }
        cpal::SampleFormat::U24 => {
            for c in bytes.chunks_exact(4) {
                let raw = u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
                out.push(((raw >> 8) as f32 - 8388608.0) / 8388608.0);
            }
        }
        other => {
            debug!(format = ?other, "unsupported device sample format; treating as silence");
            out.resize(bytes.len(), 0.0);
        }
    }
}

#[cfg(test)]
mod tests {
    // The decode paths are exercised end-to-end by the Windows integration
    // test; constructing a cpal::Data safely in a unit test is not feasible
    // (its constructor is unsafe and host-owned).
}
