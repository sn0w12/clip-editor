//! Media pipeline around the FFmpeg binary resolved by screencap's ffmpeg
//! machinery (`resolve_ffmpeg`/`check_encoder` over ffmpeg-sidecar, with the
//! download fallback landing in the app data dir): ffprobe metadata (legacy
//! contract), thumbnail extraction, waveform extraction, and the export
//! pipeline (cuts, hardware codecs, atomic output).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::Runtime;

use screencap::ffmpeg_sidecar;
use tauri::Emitter;

use crate::types::{err, AudioTrackInfo, Cut, ExportOptions, ExportProgressPayload, VideoMetadata};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub output_path: String,
    pub file_already_exists: bool,
}

/// Sink for export pipeline events; `tauri::AppHandle` implements it, tests
/// use a no-op sink.
/// Spawn child processes without a visible console window on Windows.
/// Run ffmpeg with a hidden console and return the exit status.
pub fn run_ffmpeg_silent(ffmpeg: &Path, args: &[&str]) -> std::process::ExitStatus {
    let mut cmd = std::process::Command::new(ffmpeg);
    cmd.args(args);
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    no_window(&mut cmd)
        .status()
        .unwrap_or_else(|_| std::process::ExitStatus::default())
}

fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

pub trait ExportEvents {
    fn progress(&self, payload: &ExportProgressPayload);
    fn complete(&self, payload: &crate::types::ExportCompletePayload);
    fn error(&self, message: &str);
}

impl<R: Runtime> ExportEvents for tauri::AppHandle<R> {
    fn progress(&self, payload: &ExportProgressPayload) {
        let _ = self.emit("export-progress", payload);
    }
    fn complete(&self, payload: &crate::types::ExportCompletePayload) {
        let _ = self.emit("export-complete", payload);
    }
    fn error(&self, message: &str) {
        let _ = self.emit(
            "export-error",
            crate::types::ExportErrorPayload {
                message: message.to_string(),
            },
        );
    }
}

/// The directory FFmpeg is resolved from and downloaded into. The app points
/// this at its data dir during setup: `%APPDATA%\clip-editor` is writable
/// under both per-user NSIS and per-machine MSI installs, unlike the exe's own
/// directory under Program Files. When unset (unit/e2e tests, standalone use)
/// it falls back to the executable's own directory.
static FFMPEG_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Point the FFmpeg resolution/download at `dir`. Called once during app
/// setup; a no-op afterwards.
pub fn set_ffmpeg_dir(dir: PathBuf) {
    let _ = FFMPEG_DIR.set(dir);
}

/// The directory `resolve_ffmpeg` resolves and downloads FFmpeg into.
pub fn ffmpeg_dir() -> PathBuf {
    FFMPEG_DIR.get().cloned().unwrap_or_else(|| {
        ffmpeg_sidecar::paths::sidecar_dir().unwrap_or_else(|_| PathBuf::from("."))
    })
}

/// Resolve FFmpeg once per process: the sidecar beside the executable, the
/// previously-downloaded binary in the app data dir, a system FFmpeg on PATH,
/// then a one-time automatic download into the app data dir (which unpacks
/// ffprobe too). The result is cached, so every later call is free; if the
/// user replaces FFmpeg mid-run, a restart picks it up.
static FFMPEG: std::sync::OnceLock<Result<PathBuf, String>> = std::sync::OnceLock::new();

pub fn resolve_ffmpeg() -> Result<PathBuf, String> {
    FFMPEG.get_or_init(resolve_ffmpeg_uncached).clone()
}

fn resolve_ffmpeg_uncached() -> Result<PathBuf, String> {
    // 1. Sidecar beside the running executable (ffmpeg-sidecar convention).
    if let Ok(path) = ffmpeg_sidecar::paths::sidecar_path() {
        if path.is_file() {
            return Ok(path);
        }
    }
    // 2. A previous download in the app data dir (survives restarts, updater
    //    swaps, and installs into either per-user or Program Files locations).
    let dest = ffmpeg_dir();
    let cached = dest.join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX));
    if cached.is_file() {
        return Ok(cached);
    }
    // 3. System FFmpeg on PATH.
    if ffmpeg_sidecar::command::ffmpeg_is_installed() {
        return Ok(ffmpeg_sidecar::paths::ffmpeg_path());
    }
    // 4. Automatic download into the app data dir.
    let progress = |event: ffmpeg_sidecar::download::FfmpegDownloadProgressEvent| match event {
        ffmpeg_sidecar::download::FfmpegDownloadProgressEvent::Starting => {
            println!("[ffmpeg] download started");
        }
        ffmpeg_sidecar::download::FfmpegDownloadProgressEvent::Downloading {
            total_bytes,
            downloaded_bytes,
        } => {
            let pct = if total_bytes > 0 {
                downloaded_bytes as f64 / total_bytes as f64 * 100.0
            } else {
                0.0
            };
            println!("[ffmpeg] downloading: {pct:.0}%");
        }
        ffmpeg_sidecar::download::FfmpegDownloadProgressEvent::UnpackingArchive => {
            println!("[ffmpeg] unpacking archive");
        }
        ffmpeg_sidecar::download::FfmpegDownloadProgressEvent::Done => {
            println!("[ffmpeg] download complete");
        }
    };
    download_ffmpeg_into(&dest, progress)
        .map_err(|e| err("media.ffmpeg", format!("automatic download failed: {e}")))?;
    if cached.is_file() {
        return Ok(cached);
    }
    Err(err(
        "media.ffmpeg",
        "ffmpeg is not on PATH and the automatic download produced no binary in the app data dir",
    ))
}

/// Download and unpack the ffmpeg-sidecar release archive (ffmpeg, ffprobe,
/// ffplay) into `dir`. Unlike `auto_download_with_progress`, the destination
/// is caller-controlled instead of pinned to the executable's directory.
fn download_ffmpeg_into(
    dir: &Path,
    progress: impl Fn(ffmpeg_sidecar::download::FfmpegDownloadProgressEvent),
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("create download dir: {e}"))?;
    let url = ffmpeg_sidecar::download::ffmpeg_download_url()
        .map_err(|e| format!("unsupported platform: {e}"))?;
    let archive =
        ffmpeg_sidecar::download::download_ffmpeg_package_with_progress(url, dir, progress)
            .map_err(|e| format!("download failed: {e}"))?;
    ffmpeg_sidecar::download::unpack_ffmpeg(&archive, dir)
        .map_err(|e| format!("unpack failed: {e}"))
}

/// ffprobe: beside the resolved FFmpeg binary, or on PATH when FFmpeg itself
/// came from PATH. Cached once per process like `resolve_ffmpeg`.
static FFPROBE: std::sync::OnceLock<Result<PathBuf, String>> = std::sync::OnceLock::new();

pub fn resolve_ffprobe() -> Result<PathBuf, String> {
    FFPROBE.get_or_init(resolve_ffprobe_uncached).clone()
}

fn resolve_ffprobe_uncached() -> Result<PathBuf, String> {
    let ffmpeg = resolve_ffmpeg()?;
    let sibling = ffmpeg.with_file_name(format!("ffprobe{}", std::env::consts::EXE_SUFFIX));
    if sibling.is_file() {
        return Ok(sibling);
    }
    if probe_runs("ffprobe") {
        return Ok(PathBuf::from("ffprobe"));
    }
    Err(err(
        "media.ffprobe",
        "ffprobe is not present beside FFmpeg and not on PATH",
    ))
}

/// True when the named binary runs successfully (PATH lookup).
fn probe_runs(name: &str) -> bool {
    no_window(&mut std::process::Command::new(name))
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn run_capture(binary: &Path, args: &[&str]) -> Result<String, String> {
    let output = no_window(&mut Command::new(binary))
        .args(args)
        .output()
        .map_err(|e| err("media.run", format!("{}: {e}", binary.display())))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(err(
            "media.run",
            format!("{} failed: {}", binary.display(), first_lines(&stderr, 6)),
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn first_lines(s: &str, n: usize) -> String {
    s.lines().take(n).collect::<Vec<_>>().join(" | ")
}

/// ffprobe JSON for a file.
pub fn ffprobe_json(ffprobe: &Path, path: &Path) -> Result<serde_json::Value, String> {
    let out = run_capture(
        ffprobe,
        &[
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            path.to_str()
                .ok_or_else(|| err("media.probe", "non-UTF-8 path"))?,
        ],
    )?;
    serde_json::from_str(&out).map_err(|e| err("media.probe", e))
}

fn parse_fraction(s: &str) -> f64 {
    let parts: Vec<&str> = s.split('/').collect();
    match parts.as_slice() {
        [num, den] => {
            let n: f64 = num.trim().parse().unwrap_or(0.0);
            let d: f64 = den.trim().parse().unwrap_or(1.0);
            if d > 0.0 {
                n / d
            } else {
                0.0
            }
        }
        [num] => num.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

/// Metadata with the legacy contract: duration/geometry/fps/codecs/size plus
/// the audio track list the editor needs.
pub fn get_metadata(ffprobe: &Path, path: &Path) -> Result<VideoMetadata, String> {
    let json = ffprobe_json(ffprobe, path)?;
    let streams = json
        .get("streams")
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();
    let mut video = VideoMetadata::default();
    let mut audio_tracks: Vec<AudioTrackInfo> = Vec::new();
    let mut first_audio_codec: Option<String> = None;

    for stream in &streams {
        let codec_type = stream
            .get("codec_type")
            .and_then(|c| c.as_str())
            .unwrap_or("");
        match codec_type {
            "video" => {
                video.width = stream.get("width").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                video.height = stream.get("height").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let fps = stream
                    .get("r_frame_rate")
                    .and_then(|v| v.as_str())
                    .map(parse_fraction)
                    .unwrap_or(0.0);
                video.fps = if fps > 0.0 {
                    fps
                } else {
                    stream
                        .get("avg_frame_rate")
                        .and_then(|v| v.as_str())
                        .map(parse_fraction)
                        .unwrap_or(0.0)
                };
                video.video_codec = stream
                    .get("codec_name")
                    .and_then(|v| v.as_str())
                    .map(String::from);
            }
            "audio" => {
                if first_audio_codec.is_none() {
                    first_audio_codec = stream
                        .get("codec_name")
                        .and_then(|v| v.as_str())
                        .map(String::from);
                }
                // The index is the 0-based audio-stream ordinal, NOT the
                // container stream index (a video stream shifts indices).
                // Downstream code maps it as `0:a:{index}`.
                let ordinal = audio_tracks.len() as u32;
                audio_tracks.push(AudioTrackInfo {
                    index: ordinal,
                    label: format!("Track {}", ordinal + 1),
                });
            }
            _ => {}
        }
    }

    video.duration = json
        .get("format")
        .and_then(|f| f.get("duration"))
        .and_then(|d| d.as_str())
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    video.bitrate = json
        .get("format")
        .and_then(|f| f.get("bit_rate"))
        .and_then(|b| b.as_str())
        .and_then(|s| s.parse::<u64>().ok());
    video.size = json
        .get("format")
        .and_then(|f| f.get("size"))
        .and_then(|s| s.as_str())
        .and_then(|v| v.parse::<u64>().ok());
    video.audio_codec = first_audio_codec;
    video.audio_tracks = audio_tracks;
    Ok(video)
}

/// Extract a thumbnail frame to `dst` as JPEG.
pub fn generate_thumbnail(
    ffmpeg: &Path,
    src: &Path,
    at_seconds: f64,
    dst: &Path,
) -> Result<(), String> {
    if let Some(dir) = dst.parent() {
        std::fs::create_dir_all(dir).map_err(|e| err("media.thumbnail", e))?;
    }
    let status = no_window(&mut Command::new(ffmpeg))
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-ss",
            &format!("{at_seconds:.3}"),
            "-i",
            src.to_str()
                .ok_or_else(|| err("media.thumbnail", "non-UTF-8 path"))?,
            "-frames:v",
            "1",
            "-vf",
            "scale=480:-2",
            "-q:v",
            "4",
            dst.to_str()
                .ok_or_else(|| err("media.thumbnail", "non-UTF-8 path"))?,
        ])
        .status()
        .map_err(|e| err("media.thumbnail", e))?;
    if !status.success() {
        return Err(err("media.thumbnail", "ffmpeg screenshot failed"));
    }
    Ok(())
}

/// Extract one tiny frame (≤100px) at `at_seconds` and encode it as a base64
/// ThumbHash placeholder. The hash is ~25 bytes and renders instantly, so it
/// can ride along with every clip's row in `get_clips`.
pub fn extract_thumbhash(
    ffmpeg: &Path,
    src: &Path,
    at_seconds: f64,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let max_dim = width.max(height).max(1) as f64;
    let scale = (100.0 / max_dim).min(1.0);
    let tw = ((width as f64 * scale).round() as usize).max(1);
    let th = ((height as f64 * scale).round() as usize).max(1);

    let mut child = no_window(&mut Command::new(ffmpeg))
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            &format!("{at_seconds:.3}"),
            "-i",
            src.to_str()
                .ok_or_else(|| err("media.thumbhash", "non-UTF-8 path"))?,
            "-frames:v",
            "1",
            "-vf",
            &format!("scale={tw}:{th}"),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgba",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| err("media.thumbhash", e))?;

    let mut bytes = vec![0u8; tw * th * 4];
    let read = child
        .stdout
        .as_mut()
        .and_then(|o| std::io::Read::read_exact(o, &mut bytes).ok());
    let _ = child.wait();
    if read.is_none() {
        return Err(err("media.thumbhash", "ffmpeg produced no frame"));
    }
    use base64::Engine as _;
    let hash = thumbhash::rgba_to_thumb_hash(tw, th, &bytes);
    Ok(base64::engine::general_purpose::STANDARD.encode(hash))
}

/// Extract the audio track as f32le on stdout and build a normalized
/// RMS/peak waveform with the legacy smoothing (3-sample smooth, 0.9
/// normalization).
pub fn extract_waveform(
    ffmpeg: &Path,
    src: &Path,
    sample_rate: u32,
    audio_track: u32,
    sample_count: usize,
) -> Result<Vec<f32>, String> {
    let child = no_window(&mut Command::new(ffmpeg))
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            src.to_str()
                .ok_or_else(|| err("media.waveform", "non-UTF-8 path"))?,
            "-map",
            &format!("0:a:{audio_track}"),
            "-vn",
            "-ac",
            "1",
            "-ar",
            &sample_rate.to_string(),
            "-acodec",
            "pcm_f32le",
            "-f",
            "f32le",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| err("media.waveform", e))?;
    let output = child
        .wait_with_output()
        .map_err(|e| err("media.waveform", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(err(
            "media.waveform",
            format!("extraction failed: {}", first_lines(&stderr, 4)),
        ));
    }
    let bytes = output.stdout;
    let samples: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    Ok(build_waveform(&samples, sample_count))
}

/// Downsample raw samples into `sample_count` bars using RMS/peak with a
/// 3-sample smoothing pass, normalized to 0.9.
pub fn build_waveform(samples: &[f32], sample_count: usize) -> Vec<f32> {
    if samples.is_empty() || sample_count == 0 {
        return Vec::new();
    }
    let mut bars = Vec::with_capacity(sample_count);
    let per = (samples.len() as f64 / sample_count as f64).max(1.0);
    for i in 0..sample_count {
        let start = (i as f64 * per) as usize;
        let end = (((i + 1) as f64 * per) as usize).min(samples.len());
        if start >= end {
            bars.push(0.0);
            continue;
        }
        let slice = &samples[start..end];
        let rms = (slice.iter().map(|s| s * s).sum::<f32>() / slice.len() as f32).sqrt();
        let peak = slice.iter().fold(0.0f32, |a, b| a.max(b.abs()));
        let combined = (rms * 0.6 + peak * 0.4).min(1.0);
        bars.push(combined);
    }
    // 3-sample smoothing (legacy contract).
    let smoothed: Vec<f32> = bars
        .iter()
        .enumerate()
        .map(|(i, &v)| {
            let left = bars.get(i.wrapping_sub(1)).copied().unwrap_or(v);
            let right = bars.get(i + 1).copied().unwrap_or(v);
            (left + v + right) / 3.0
        })
        .collect();
    let max = smoothed.iter().fold(0.0f32, |a, b| a.max(*b));
    let scale = if max > 0.0 { 0.9 / max } else { 0.0 };
    smoothed
        .into_iter()
        .map(|v| (v * scale).clamp(0.0, 1.0))
        .collect()
}

/// Detect the GPU vendor for hardware encoder selection (Windows registry
/// display-class devices). Off-Windows or unknown returns `unknown`.
pub fn gpu_vendor() -> String {
    #[cfg(windows)]
    {
        let mut vendors = std::collections::HashSet::new();
        for subkey in 0..12 {
            let path = format!(
                r"SYSTEM\CurrentControlSet\Control\Class\{{4d36e968-e325-11ce-bfc1-08002be10318}}\{subkey:04}"
            );
            if let Ok(value) = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
                .open_subkey(&path)
                .and_then(|k| k.get_value::<String, _>("DriverDesc"))
            {
                let lower = value.to_lowercase();
                if lower.contains("nvidia") {
                    vendors.insert("nvidia");
                } else if lower.contains("amd") || lower.contains("radeon") {
                    vendors.insert("amd");
                } else if lower.contains("intel") {
                    vendors.insert("intel");
                }
            }
        }
        for v in ["nvidia", "amd", "intel"] {
            if vendors.contains(v) {
                return v.to_string();
            }
        }
        "unknown".to_string()
    }
    #[cfg(not(windows))]
    {
        "unknown".to_string()
    }
}

/// Pick the H.264 encoder: vendor-matched hardware when the resolved binary
/// exposes it, otherwise libx264. Never silently changes the requested
/// quality; an explicitly requested encoder that is missing is an error.
pub fn pick_h264_encoder(ffmpeg: &Path) -> Result<&'static str, String> {
    let has = |name: &str| {
        screencap::media::ffmpeg::has_encoder(ffmpeg, name).map_err(|e| err("media.encoder", e))
    };
    match gpu_vendor().as_str() {
        "nvidia" => {
            if has("h264_nvenc")? {
                Ok("h264_nvenc")
            } else {
                Err(err(
                    "media.encoder",
                    "NVIDIA GPU detected but h264_nvenc is not available in the bundled FFmpeg",
                ))
            }
        }
        "amd" => {
            if has("h264_amf")? {
                Ok("h264_amf")
            } else {
                Err(err(
                    "media.encoder",
                    "AMD GPU detected but h264_amf is not available in the bundled FFmpeg",
                ))
            }
        }
        "intel" => {
            if has("h264_qsv")? {
                Ok("h264_qsv")
            } else {
                Err(err(
                    "media.encoder",
                    "Intel GPU detected but h264_qsv is not available in the bundled FFmpeg",
                ))
            }
        }
        _ => Ok("libx264"),
    }
}

pub struct EncodePlan {
    pub video_codec: String,
    pub video_args: Vec<String>,
    pub audio_codec: String,
}

fn plan_for_format(ffmpeg: &Path, format: &str) -> Result<EncodePlan, String> {
    match format {
        "webm" => Ok(EncodePlan {
            video_codec: "libvpx-vp9".to_string(),
            video_args: vec![
                "-deadline".into(),
                "good".into(),
                "-cpu-used".into(),
                "1".into(),
            ],
            audio_codec: "libopus".to_string(),
        }),
        "gif" => Ok(EncodePlan {
            video_codec: "gif".to_string(),
            video_args: vec![],
            audio_codec: String::new(),
        }),
        _ => {
            let encoder = pick_h264_encoder(ffmpeg)?;
            let video_args = if encoder == "libx264" {
                vec![
                    "-preset".into(),
                    "medium".into(),
                    "-profile:v".into(),
                    "main".into(),
                ]
            } else {
                vec![]
            };
            Ok(EncodePlan {
                video_codec: encoder.to_string(),
                video_args,
                audio_codec: "aac".to_string(),
            })
        }
    }
}

/// Compute the video bitrate for the quality mode (bits/sec).
fn video_bitrate(options: &ExportOptions, duration: f64) -> u64 {
    match options.quality_mode.as_str() {
        "targetSize" => {
            let mb = options.target_size.unwrap_or(10.0);
            let audio_bits = options
                .audio_bitrate
                .map(|kbps| kbps as u64 * 1000 * duration as u64)
                .unwrap_or(0);
            let total = (mb * 8.0 * 1024.0 * 1024.0) as u64;
            total.saturating_sub(audio_bits).max(500_000) / duration.max(0.1) as u64
        }
        // preset
        _ => match options.quality.as_deref() {
            Some("high") => 4_000_000,
            Some("low") => 1_000_000,
            _ => 2_500_000,
        },
    }
}

fn preset_audio_bitrate(options: &ExportOptions) -> u32 {
    if let Some(b) = options.audio_bitrate {
        return b;
    }
    match options.quality.as_deref() {
        Some("high") => 192,
        Some("low") => 96,
        _ => 128,
    }
}

/// `{dir}/{name}_clips/{name}_{hash}.{format}` per the legacy naming contract
/// (no dialog; used by the core pipeline and tests).
pub fn default_output_path(source_path: &str, options: &ExportOptions) -> Result<PathBuf, String> {
    let source = Path::new(source_path);
    let dir = source
        .parent()
        .ok_or_else(|| err("media.export", "no parent dir"))?;
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| err("media.export", "invalid filename"))?
        .to_string();
    let format = options.output_format.to_lowercase();
    let hash_input = serde_json::json!({
        "startTime": options.start_time,
        "endTime": options.end_time,
        "width": options.width,
        "height": options.height,
        "fps": options.fps,
        "qualityMode": options.quality_mode,
        "quality": options.quality,
        "targetSize": options.target_size,
        "audioBitrate": options.audio_bitrate,
        "audioTracks": options.audio_tracks,
        "outputFormat": format,
    });
    let hash = &crate::util::md5_hex(&hash_input.to_string())[..8];
    let clips_dir = dir.join(format!("{stem}_clips"));
    std::fs::create_dir_all(&clips_dir).map_err(|e| err("media.export", e))?;
    Ok(clips_dir.join(format!("{stem}_{hash}.{format}")))
}

/// Output path honoring `choose_export_location` (save dialog) via the app.
pub fn output_path_for<R: Runtime>(
    app: &tauri::AppHandle<R>,
    source_path: &str,
    options: &ExportOptions,
) -> Result<PathBuf, String> {
    if options.choose_export_location.unwrap_or(false) {
        use tauri_plugin_dialog::DialogExt;
        let source = Path::new(source_path);
        let stem = source
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| err("media.export", "invalid filename"))?
            .to_string();
        let format = options.output_format.to_lowercase();
        let dialog = app
            .dialog()
            .file()
            .set_file_name(format!("{stem}_clip.{format}"));
        let path = dialog
            .add_filter("Media", &[format.as_str()])
            .blocking_save_file();
        return match path {
            Some(path) => {
                let path_buf = path
                    .into_path()
                    .map_err(|e| err("media.export", format!("save dialog: {e}")))?;
                Ok(path_buf)
            }
            None => Err(err("media.export", "export canceled")),
        };
    }
    default_output_path(source_path, options)
}

/// One segment encode (used by the multi-cut concat path).
#[allow(clippy::too_many_arguments)]
fn encode_segment(
    ffmpeg: &Path,
    plan: &EncodePlan,
    source: &Path,
    cut: &Cut,
    duration: f64,
    fps: Option<u32>,
    scale: Option<(u32, u32)>,
    audio_tracks: &[u32],
    audio_bitrate: u32,
    video_bitrate: u64,
    speed: f64,
    output: &Path,
    on_progress: &mut dyn FnMut(f64),
) -> Result<(), String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-ss".into(),
        format!("{:.3}", cut.start),
        "-i".into(),
        source
            .to_str()
            .ok_or_else(|| err("media.export", "non-UTF-8 path"))?
            .into(),
    ];
    let mut vf: Vec<String> = Vec::new();
    if let Some((w, h)) = scale {
        vf.push(format!("scale={w}:{h}"));
    }
    if speed != 1.0 {
        vf.push(format!("setpts=PTS/{}", speed));
    }
    if !vf.is_empty() {
        args.push("-vf".into());
        args.push(vf.join(","));
    }
    if let Some(fps) = fps {
        args.push("-r".into());
        args.push(fps.to_string());
    }
    args.push("-map".into());
    args.push("0:v:0".into());
    args.push("-c:v".into());
    args.push(plan.video_codec.clone());
    for a in &plan.video_args {
        args.push(a.clone());
    }
    args.push("-b:v".into());
    args.push(video_bitrate.to_string());
    if plan.audio_codec.is_empty() {
        args.push("-an".into());
    } else {
        add_audio_args(&mut args, plan, audio_tracks, audio_bitrate, speed)?;
    }
    args.push("-t".into());
    args.push(format!("{duration:.3}"));
    args.push("-f".into());
    args.push("mpegts".into());
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());
    args.push(
        output
            .to_str()
            .ok_or_else(|| err("media.export", "non-UTF-8 path"))?
            .into(),
    );

    run_with_progress(ffmpeg, &args, duration, on_progress)
}

fn add_audio_args(
    args: &mut Vec<String>,
    plan: &EncodePlan,
    audio_tracks: &[u32],
    audio_bitrate: u32,
    speed: f64,
) -> Result<(), String> {
    match audio_tracks {
        [] => {
            args.push("-an".into());
        }
        [track] => {
            args.push("-map".into());
            args.push(format!("0:a:{track}"));
            args.push("-c:a".into());
            args.push(plan.audio_codec.clone());
            args.push("-b:a".into());
            args.push(format!("{audio_bitrate}k"));
        }
        tracks => {
            // amerge with an explicit layout: keep all inputs, mix to stereo.
            let n = tracks.len();
            let mut filter = String::new();
            for t in tracks {
                filter.push_str(&format!("[0:a:{t}]"));
            }
            filter.push_str(&format!("amerge=inputs={n}[aout]"));
            let _ = speed;
            args.push("-filter_complex".into());
            args.push(filter);
            args.push("-map".into());
            args.push("[aout]".into());
            args.push("-c:a".into());
            args.push(plan.audio_codec.clone());
            args.push("-b:a".into());
            args.push(format!("{audio_bitrate}k"));
        }
    }
    Ok(())
}

/// Run ffmpeg with `-progress pipe:1` and translate out_time into `on_progress`
/// fractions of `total_duration`.
fn run_with_progress(
    ffmpeg: &Path,
    args: &[String],
    total_duration: f64,
    on_progress: &mut dyn FnMut(f64),
) -> Result<(), String> {
    let mut child = no_window(&mut Command::new(ffmpeg))
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| err("media.export", e))?;
    let stdout = child.stdout.take().expect("stdout piped");
    let reader = std::io::BufReader::new(stdout);
    let mut time_ms: f64 = 0.0;
    for line in std::io::BufRead::lines(reader) {
        let Ok(line) = line else { break };
        if let Some(v) = line.strip_prefix("out_time_ms=") {
            if let Ok(ms) = v.trim().parse::<f64>() {
                time_ms = ms;
            }
        } else if line.starts_with("progress=") {
            let frac = if total_duration > 0.0 {
                (time_ms / 1000.0 / total_duration).clamp(0.0, 1.0)
            } else {
                0.0
            };
            on_progress(frac);
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|e| err("media.export", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(err(
            "media.export",
            format!("ffmpeg failed: {}", first_lines(&stderr, 8)),
        ));
    }
    on_progress(1.0);
    Ok(())
}

/// Build the ffmpeg argument list for the direct (no cuts) encode path.
/// Pure and testable; `export_clip` runs it with progress piping.
#[allow(clippy::too_many_arguments)]
pub fn direct_encode_args(
    source: &Path,
    options: &ExportOptions,
    plan: &EncodePlan,
    start_time: f64,
    tmp: &Path,
    scale: Option<(u32, u32)>,
    audio_tracks: &[u32],
    speed: f64,
    effective_duration: f64,
    video_bps: u64,
    audio_kbps: u32,
) -> Result<Vec<String>, String> {
    let mut base: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-y".into(),
        "-ss".into(),
        format!("{start_time:.3}"),
        "-i".into(),
        source
            .to_str()
            .ok_or_else(|| err("media.export", "non-UTF-8 path"))?
            .into(),
    ];
    let mut vf: Vec<String> = Vec::new();
    if let Some((w, h)) = scale {
        vf.push(format!("scale={w}:{h}"));
    }
    let format = options.output_format.to_lowercase();
    if speed != 1.0 && format != "gif" {
        vf.push(format!("setpts=PTS/{}", speed));
    }
    if !vf.is_empty() {
        base.push("-vf".into());
        base.push(vf.join(","));
    }
    if let Some(fps) = options.fps {
        base.push("-r".into());
        base.push(fps.to_string());
    }
    base.push("-map".into());
    base.push("0:v:0".into());
    base.push("-c:v".into());
    base.push(plan.video_codec.clone());
    for a in &plan.video_args {
        base.push(a.clone());
    }
    if plan.video_codec != "gif" {
        base.push("-b:v".into());
        base.push(video_bps.to_string());
        if options.quality_mode == "targetSize" {
            // VBV-constrain so single-pass ABR stays near the target size
            // instead of overshooting (worse on short/cut clips).
            base.push("-maxrate".into());
            base.push(video_bps.to_string());
            base.push("-bufsize".into());
            base.push(video_bps.to_string());
        }
    }
    if format == "gif" {
        base.push("-an".into());
    } else if speed != 1.0 && !audio_tracks.is_empty() {
        // Speed up audio with atempo (chained for > 2.0).
        let mut atempo = String::new();
        let mut remaining = speed;
        while remaining > 2.0 {
            atempo.push_str("atempo=2.0,");
            remaining /= 2.0;
        }
        atempo.push_str(&format!("atempo={remaining:.4}"));
        base.push("-af".into());
        base.push(atempo);
        add_audio_args(&mut base, plan, audio_tracks, audio_kbps, speed)?;
    } else {
        add_audio_args(&mut base, plan, audio_tracks, audio_kbps, speed)?;
    }
    base.push("-t".into());
    base.push(format!("{effective_duration:.3}"));
    base.push("-f".into());
    base.push(format.clone());
    if matches!(format.as_str(), "mp4" | "mov") {
        // moov at the front so WebView2 can start playing without scanning the
        // file tail (which shows a stuck "Waiting for video data").
        base.push("-movflags".into());
        base.push("+faststart".into());
    }
    base.push("-progress".into());
    base.push("pipe:1".into());
    base.push("-nostats".into());
    base.push(
        tmp.to_str()
            .ok_or_else(|| err("media.export", "non-UTF-8 path"))?
            .into(),
    );
    Ok(base)
}

/// The segments within `[start_time, end_time]` not covered by any cut, in
/// chronological order. Cuts are sections to REMOVE.
fn compute_keep_segments(options: &ExportOptions) -> Vec<Cut> {
    let mut sorted_cuts: Vec<Cut> = options
        .cuts
        .clone()
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.end > c.start)
        .collect();
    sorted_cuts.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut keep: Vec<Cut> = Vec::new();
    let mut last = options.start_time;
    for cut in &sorted_cuts {
        let cs = cut.start.max(options.start_time);
        let ce = cut.end.min(options.end_time);
        if ce <= cs {
            continue;
        }
        if cs > last {
            keep.push(Cut {
                start: last,
                end: cs,
            });
        }
        last = last.max(ce);
    }
    if last < options.end_time {
        keep.push(Cut {
            start: last,
            end: options.end_time,
        });
    }
    keep
}

/// The output duration of an export: total keep-segment length divided by the
/// speed factor. Mirrors `export_clip_with`.
pub fn export_duration(options: &ExportOptions) -> f64 {
    let speed = options.speed_factor.unwrap_or(1.0).max(0.1);
    let total: f64 = compute_keep_segments(options)
        .iter()
        .map(|c| c.end - c.start)
        .sum();
    (total / speed).max(0.05)
}

/// Export a clip with the legacy semantics (quality modes, cuts, audio maps,
/// atomic rename, temp cleanup) and emit `export-progress` events.
pub fn export_clip<R: Runtime>(
    app: &tauri::AppHandle<R>,
    source_path: &str,
    options: &ExportOptions,
) -> Result<ExportResult, String> {
    let output = output_path_for(app, source_path, options)?;
    export_clip_with(app, source_path, options, &output)
}

/// Core export pipeline with a pluggable event sink and a fixed output path.
pub fn export_clip_with(
    events: &dyn ExportEvents,
    source_path: &str,
    options: &ExportOptions,
    output: &Path,
) -> Result<ExportResult, String> {
    let ffmpeg = resolve_ffmpeg()?;
    let source = Path::new(source_path);
    let format = options.output_format.to_lowercase();
    if !["mp4", "webm", "mov", "mkv", "gif"].contains(&format.as_str()) {
        return Err(err(
            "media.export",
            format!("unsupported output format: {format}"),
        ));
    }
    if output.exists() {
        return Ok(ExportResult {
            output_path: output.to_string_lossy().into_owned(),
            file_already_exists: true,
        });
    }

    let plan = plan_for_format(&ffmpeg, &format)?;
    let speed = options.speed_factor.unwrap_or(1.0).max(0.1);
    let output_duration = export_duration(options);
    let video_bps = video_bitrate(options, output_duration);
    let audio_kbps = preset_audio_bitrate(options);
    let audio_tracks: Vec<u32> = match options.remove_audio.unwrap_or(false) {
        true => vec![],
        false => options
            .audio_tracks
            .clone()
            .unwrap_or_else(|| vec![0])
            .into_iter()
            .filter(|i| *i < 16)
            .collect(),
    };
    let scale = match (options.width, options.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => Some((w, h)),
        _ => None,
    };

    let mut progress: f64 = 0.0;
    let mut emit = |frac: f64| {
        progress = progress.max(frac);
        events.progress(&ExportProgressPayload {
            progress,
            current_time: progress * output_duration,
            total_duration: output_duration,
        });
    };

    let tmp = output.with_extension(format!("{format}.tmp"));
    let result = (|| -> Result<(), String> {
        let keep_segments = compute_keep_segments(options);
        match keep_segments.len() {
            0 => Err(err("media.export", "no content remains after cuts")),
            1 => {
                let seg = &keep_segments[0];
                let seg_duration = (seg.end - seg.start) / speed;
                let args = direct_encode_args(
                    source,
                    options,
                    &plan,
                    seg.start,
                    &tmp,
                    scale,
                    &audio_tracks,
                    speed,
                    seg_duration,
                    video_bps,
                    audio_kbps,
                )?;
                run_with_progress(&ffmpeg, &args, seg_duration, &mut emit)?;
                Ok(())
            }
            _ => {
                // Multiple keep segments: encode each to mpegts, then re-encode
                // the concatenation into the final format.
                let temp_dir = output.parent().unwrap_or(Path::new(".")).join(format!(
                    "__temp_cuts_{}",
                    crate::util::time_now().replace([':', '.'], "-")
                ));
                std::fs::create_dir_all(&temp_dir).map_err(|e| err("media.export", e))?;
                let cleanup = || {
                    let _ = std::fs::remove_dir_all(&temp_dir);
                };
                let seg_result = (|| -> Result<Vec<PathBuf>, String> {
                    let mut segments = Vec::new();
                    let total: f64 = keep_segments
                        .iter()
                        .map(|c| (c.end - c.start) / speed)
                        .sum();
                    let mut done: f64 = 0.0;
                    for (i, seg) in keep_segments.iter().enumerate() {
                        let seg_path = temp_dir.join(format!("seg_{i:03}.ts"));
                        let seg_duration = (seg.end - seg.start) / speed;
                        let mut seg_progress = |frac: f64| {
                            emit((done + frac * seg_duration) / total);
                        };
                        encode_segment(
                            &ffmpeg,
                            &plan,
                            source,
                            seg,
                            seg_duration,
                            options.fps,
                            scale,
                            &audio_tracks,
                            audio_kbps,
                            video_bps,
                            speed,
                            &seg_path,
                            &mut seg_progress,
                        )?;
                        done += seg_duration;
                        segments.push(seg_path);
                    }
                    Ok(segments)
                })();
                let segments = match seg_result {
                    Ok(segs) => segs,
                    Err(e) => {
                        cleanup();
                        return Err(e);
                    }
                };
                let list = temp_dir.join("concat.txt");
                let mut list_text = String::new();
                for seg in &segments {
                    let escaped = seg
                        .to_string_lossy()
                        .replace('\\', "/")
                        .replace('\'', "\\'");
                    list_text.push_str(&format!("file '{escaped}'\n"));
                }
                std::fs::write(&list, list_text).map_err(|e| err("media.export", e))?;

                let total: f64 = keep_segments
                    .iter()
                    .map(|c| (c.end - c.start) / speed)
                    .sum();
                let mut concat_args: Vec<String> = vec![
                    "-hide_banner".into(),
                    "-loglevel".into(),
                    "error".into(),
                    "-y".into(),
                    "-f".into(),
                    "concat".into(),
                    "-safe".into(),
                    "0".into(),
                    "-i".into(),
                    list.to_string_lossy().into_owned(),
                    "-map".into(),
                    "0:v:0".into(),
                    "-c:v".into(),
                    plan.video_codec.clone(),
                ];
                for a in &plan.video_args {
                    concat_args.push(a.clone());
                }
                if plan.video_codec != "gif" {
                    concat_args.push("-b:v".into());
                    concat_args.push(video_bps.to_string());
                    if options.quality_mode == "targetSize" {
                        concat_args.push("-maxrate".into());
                        concat_args.push(video_bps.to_string());
                        concat_args.push("-bufsize".into());
                        concat_args.push(video_bps.to_string());
                    }
                }
                if plan.audio_codec.is_empty() || audio_tracks.is_empty() {
                    concat_args.push("-an".into());
                } else {
                    // The concat input has exactly one audio stream (each segment
                    // carries the selected source track), so map `0:a:0`.
                    add_audio_args(&mut concat_args, &plan, &[0], audio_kbps, 1.0)?;
                }
                if matches!(format.as_str(), "mp4" | "mov") {
                    concat_args.push("-movflags".into());
                    concat_args.push("+faststart".into());
                }
                concat_args.push("-f".into());
                concat_args.push(format.clone());
                concat_args.push("-progress".into());
                concat_args.push("pipe:1".into());
                concat_args.push("-nostats".into());
                concat_args.push(tmp.to_string_lossy().into_owned());
                let concat_result = run_with_progress(&ffmpeg, &concat_args, total, &mut emit);
                cleanup();
                concat_result?;
                Ok(())
            }
        }
    })();

    if let Err(e) = result {
        let _ = std::fs::remove_file(&tmp);
        events.error(&e);
        return Err(e);
    }
    std::fs::rename(&tmp, output)
        .map_err(|e| err("media.export", format!("atomic rename: {e}")))?;
    emit(1.0);
    events.complete(&crate::types::ExportCompletePayload {
        output_path: output.to_string_lossy().into_owned(),
    });
    Ok(ExportResult {
        output_path: output.to_string_lossy().into_owned(),
        file_already_exists: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waveform_downsample_normalizes() {
        // A silent track must produce all zeros.
        let silent = build_waveform(&[0.0; 1000], 50);
        assert_eq!(silent.len(), 50);
        assert!(silent.iter().all(|v| *v == 0.0));
        // A full-scale track normalizes to ~0.9 and stays clamped.
        let loud = build_waveform(&[1.0; 1000], 50);
        assert!(loud.iter().all(|v| (0.85..=1.0).contains(v)));
        // Half-scale input normalizes upward to the same ceiling.
        let half = build_waveform(&[0.5; 1000], 50);
        assert!(half.iter().all(|v| (0.85..=1.0).contains(v)));
        // Mixed content: relative peaks are preserved.
        let mut mixed_input = vec![0.0f32; 1000];
        mixed_input[..500].fill(1.0);
        let mixed = build_waveform(&mixed_input, 50);
        // First half louder than second half.
        let first_half = mixed[..25].iter().fold(0.0f32, |a, b| a.max(*b));
        let second_half = mixed[25..].iter().fold(0.0f32, |a, b| a.max(*b));
        assert!(first_half > second_half, "relative amplitude preserved");
    }

    #[test]
    fn fps_fraction_parsing() {
        assert_eq!(parse_fraction("30000/1001"), 29.97002997002997);
        assert_eq!(parse_fraction("60/1"), 60.0);
        assert_eq!(parse_fraction("0/0"), 0.0);
        assert_eq!(parse_fraction("30"), 30.0);
    }

    #[test]
    fn target_size_bitrate_math() {
        let options = ExportOptions {
            start_time: 0.0,
            end_time: 10.0,
            output_format: "mp4".into(),
            quality: None,
            target_size: Some(10.0),
            quality_mode: "targetSize".into(),
            width: None,
            height: None,
            fps: None,
            audio_bitrate: Some(128),
            remove_audio: None,
            speed_factor: None,
            audio_tracks: None,
            choose_export_location: None,
            cuts: None,
        };
        // 10 MB total minus 128kbps audio over 10s, per second.
        let bps = video_bitrate(&options, 10.0);
        assert!(bps > 500_000, "floored at 500k, got {bps}");
        assert_eq!(
            bps,
            ((10.0 * 8.0 * 1024.0 * 1024.0 - 128.0 * 1000.0 * 10.0) / 10.0) as u64
        );
    }

    #[test]
    fn preset_bitrates() {
        let mut options = ExportOptions {
            start_time: 0.0,
            end_time: 1.0,
            output_format: "mp4".into(),
            quality: Some("high".into()),
            target_size: None,
            quality_mode: "preset".into(),
            width: None,
            height: None,
            fps: None,
            audio_bitrate: None,
            remove_audio: None,
            speed_factor: None,
            audio_tracks: None,
            choose_export_location: None,
            cuts: None,
        };
        assert_eq!(video_bitrate(&options, 1.0), 4_000_000);
        assert_eq!(preset_audio_bitrate(&options), 192);
        options.quality = Some("low".into());
        assert_eq!(video_bitrate(&options, 1.0), 1_000_000);
        assert_eq!(preset_audio_bitrate(&options), 96);
        options.quality = Some("medium".into());
        assert_eq!(video_bitrate(&options, 1.0), 2_500_000);
        assert_eq!(preset_audio_bitrate(&options), 128);
    }

    #[test]
    fn direct_encode_args_contract() {
        let options = ExportOptions {
            start_time: 1.5,
            end_time: 6.5,
            output_format: "mp4".into(),
            quality: Some("medium".into()),
            target_size: None,
            quality_mode: "preset".into(),
            width: Some(1280),
            height: Some(720),
            fps: Some(30),
            audio_bitrate: Some(128),
            remove_audio: None,
            speed_factor: Some(2.0),
            audio_tracks: Some(vec![0]),
            choose_export_location: None,
            cuts: None,
        };
        let plan = EncodePlan {
            video_codec: "libx264".into(),
            video_args: vec!["-preset".into(), "medium".into()],
            audio_codec: "aac".into(),
        };
        let args = direct_encode_args(
            Path::new("C:/clips/in.mkv"),
            &options,
            &plan,
            1.5,
            Path::new("C:/clips/out.mp4.tmp"),
            Some((1280, 720)),
            &[0],
            2.0,
            2.5,
            2_500_000,
            128,
        )
        .unwrap();
        let text = args.join(" ");
        assert!(text.contains("-ss 1.500"), "input seek: {text}");
        assert!(text.contains("C:/clips/in.mkv"));
        assert!(text.contains("scale=1280:720"));
        assert!(text.contains("setpts=PTS/2"));
        assert!(text.contains("atempo=2.0000"), "audio speed: {text}");
        assert!(text.contains("-r 30"));
        assert!(text.contains("-map 0:v:0"));
        assert!(text.contains("-c:v libx264 -preset medium"));
        assert!(text.contains("-b:v 2500000"));
        assert!(text.contains("-map 0:a:0 -c:a aac -b:a 128k"));
        assert!(
            text.contains("-t 2.500"),
            "duration = range / speed: {text}"
        );
        assert!(text.contains("C:/clips/out.mp4.tmp"));
    }

    #[test]
    fn gif_encode_plan_has_no_audio() {
        let plan = plan_for_format(Path::new("unused"), "gif").unwrap();
        assert_eq!(plan.video_codec, "gif");
        assert!(plan.audio_codec.is_empty());
    }

    #[test]
    fn webm_encode_plan_uses_vp9_and_opus() {
        let plan = plan_for_format(Path::new("unused"), "webm").unwrap();
        assert_eq!(plan.video_codec, "libvpx-vp9");
        assert_eq!(plan.audio_codec, "libopus");
    }

    #[test]
    fn amerge_combines_multiple_tracks() {
        let mut args = Vec::new();
        let plan = EncodePlan {
            video_codec: "libx264".into(),
            video_args: vec![],
            audio_codec: "aac".into(),
        };
        add_audio_args(&mut args, &plan, &[0, 1], 128, 1.0).unwrap();
        let text = args.join(" ");
        assert!(text.contains("amerge=inputs=2"), "{text}");
        assert!(text.contains("[aout]"), "{text}");
        assert!(text.contains("-c:a aac"));
    }
}
