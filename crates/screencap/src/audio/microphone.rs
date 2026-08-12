//! Microphone capture with CPAL: device selection by name, conversion to f32,
//! rubato resampling to `audio.sample_rate`, and deterministic channel
//! conversion. Device disappearance is a terminal capture error.

use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{Receiver, Sender};
use tracing::debug;

use crate::audio::resample::{convert_channels, StreamingResampler};
use crate::audio::{AudioBlock, AudioError, AudioEvent, SourceKey};
use crate::config::InputRule;
use crate::error::RunError;
use crate::util::{send_drop_oldest, RateLimiter};

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
                    let _ = err_tx.send(RunError::Capture(
                        crate::error::CaptureError::Audio(AudioError::Microphone(format!(
                            "input stream error: {err}"
                        ))),
                    ));
                }
            };

            let data_cb = {
                let key = key.clone();
                let event_tx = event_tx_thread.clone();
                let event_rx = event_rx_thread.clone();
                move |data: &cpal::Data, _info: &cpal::InputCallbackInfo| {
                    let mut samples = decode_to_f32(data);
                    if device_channels != channels {
                        samples = convert_channels(samples, device_channels, channels);
                    }
                    match resampler.as_mut() {
                        Some(r) => {
                            r.push(&samples);
                            pending.extend_from_slice(&r.take_output());
                        }
                        None => pending.extend_from_slice(&samples),
                    }
                    while pending.len() >= block_frames * channels as usize {
                        let block: Vec<f32> =
                            pending.drain(..block_frames * channels as usize).collect();
                        let block_pts = match next_pts {
                            Some(pts) => pts,
                            None => {
                                let start = origin.elapsed().saturating_sub(block_dur);
                                Duration::from_millis(
                                    ((start.as_millis() / block_ms as u128) * block_ms as u128) as u64,
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
                .build_input_stream_raw(
                    stream_config,
                    sample_format,
                    data_cb,
                    err_cb,
                    None,
                )
                .map_err(|e| {
                    AudioError::Microphone(format!("cannot build input stream: {e}"))
                });
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
                    let _ = err_tx_thread.send(RunError::Capture(
                        crate::error::CaptureError::Audio(e),
                    ));
                }
            }
        })
        .map_err(|e| AudioError::Microphone(format!("cannot spawn microphone thread: {e}")))?;

    Ok(())
}

/// Decode a raw CPAL data buffer to interleaved `f32` samples.
fn decode_to_f32(data: &cpal::Data) -> Vec<f32> {
    let bytes = data.bytes();
    match data.sample_format() {
        cpal::SampleFormat::F32 => {
            let bytes = data.bytes();
            #[cfg(target_endian = "little")]
            if bytes.as_ptr() as usize % 4 == 0 && bytes.len() % 4 == 0 {
                let mut out = Vec::with_capacity(bytes.len() / 4);
                // SAFETY: aligned f32-sized region; LE bytes are the encoding.
                unsafe {
                    out.extend_from_slice(std::slice::from_raw_parts(
                        bytes.as_ptr() as *const f32,
                        bytes.len() / 4,
                    ));
                }
                return out;
            }
            bytes
                .chunks_exact(4)
                .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                .collect()
        }
        cpal::SampleFormat::I16 => bytes
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect(),
        cpal::SampleFormat::I32 => bytes
            .chunks_exact(4)
            .map(|c| i32::from_le_bytes([c[0], c[1], c[2], c[3]]) as f32 / 2147483648.0)
            .collect(),
        cpal::SampleFormat::I64 => bytes
            .chunks_exact(8)
            .map(|c| {
                i64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]) as f32
                    / 9223372036854775808.0
            })
            .collect(),
        cpal::SampleFormat::I8 => bytes.iter().map(|&b| b as i8 as f32 / 128.0).collect(),
        cpal::SampleFormat::U8 => bytes.iter().map(|&b| (b as f32 - 128.0) / 128.0).collect(),
        cpal::SampleFormat::U16 => bytes
            .chunks_exact(2)
            .map(|c| (u16::from_le_bytes([c[0], c[1]]) as f32 - 32768.0) / 32768.0)
            .collect(),
        cpal::SampleFormat::F64 => bytes
            .chunks_exact(8)
            .map(|c| {
                f64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]) as f32
            })
            .collect(),
        cpal::SampleFormat::I24 => {
            // 24-bit samples stored in 4 bytes (little endian, sign-extended).
            bytes
                .chunks_exact(4)
                .map(|c| {
                    let raw = i32::from_le_bytes([c[0], c[1], c[2], c[3]]);
                    (raw >> 8) as f32 / 8388608.0
                })
                .collect()
        }
        cpal::SampleFormat::U24 => {
            bytes
                .chunks_exact(4)
                .map(|c| {
                    let raw = u32::from_le_bytes([c[0], c[1], c[2], c[3]]);
                    ((raw >> 8) as f32 - 8388608.0) / 8388608.0
                })
                .collect()
        }
        other => {
            debug!(format = ?other, "unsupported device sample format; treating as silence");
            vec![0.0; bytes.len()]
        }
    }
}

#[cfg(test)]
mod tests {
    // The decode paths are exercised end-to-end by the Windows integration
    // test; constructing a cpal::Data safely in a unit test is not feasible
    // (its constructor is unsafe and host-owned).
}
