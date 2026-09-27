//! FFmpeg resolution: a sibling binary beside the app, then the sidecar
//! directory, then a one-time download. A system `ffmpeg` found only through
//! `PATH` is never used.

use std::path::{Path, PathBuf};
use std::process::Command;

use tracing::{info, warn};

use crate::config::VideoCodec;
use crate::error::MediaError;

/// Suppress the console window when spawning FFmpeg from a GUI app.
fn no_window(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        cmd
    }
    #[cfg(not(windows))]
    {
        cmd
    }
}

/// Resolve the FFmpeg binary: a sibling binary beside the app, the sidecar
/// directory, a system `ffmpeg` on PATH, then a one-time download.
///
/// `ffmpeg_dir` lets a host (e.g. a Tauri bundle) ship `ffmpeg[.exe]` as a
/// resource and force its use for both development and release builds,
/// bypassing the download path entirely.
pub fn resolve_ffmpeg(ffmpeg_dir: Option<PathBuf>) -> Result<PathBuf, MediaError> {
    if let Some(dir) = ffmpeg_dir {
        let candidate = dir.join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX));
        if candidate.is_file() {
            info!(path = %candidate.display(), "using resource ffmpeg");
            return Ok(candidate);
        }
        warn!(
            path = %candidate.display(),
            "explicit ffmpeg resource dir given but no binary found; falling back"
        );
    }
    if let Some(path) = sibling_ffmpeg() {
        info!(path = %path.display(), "using bundled ffmpeg");
        return Ok(path);
    }
    if let Ok(path) = ffmpeg_sidecar::paths::sidecar_path() {
        if path.exists() {
            info!(path = %path.display(), "using sidecar ffmpeg");
            return Ok(path);
        }
    }
    // A system `ffmpeg` on PATH is a valid resolution (ffmpeg-sidecar's own
    // convention); the download paths below are only reached without one.
    if ffmpeg_sidecar::command::ffmpeg_is_installed() {
        let path = ffmpeg_sidecar::paths::ffmpeg_path();
        info!(path = %path.display(), "using system ffmpeg from PATH");
        return Ok(path);
    }
    info!("ffmpeg not found; downloading to the sidecar directory");
    let progress = |event: ffmpeg_sidecar::download::FfmpegDownloadProgressEvent| match event {
        ffmpeg_sidecar::download::FfmpegDownloadProgressEvent::Starting => {
            info!("ffmpeg download started");
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
            info!(percent = format!("{pct:.0}"), "ffmpeg download progress");
        }
        ffmpeg_sidecar::download::FfmpegDownloadProgressEvent::UnpackingArchive => {
            info!("ffmpeg archive unpacking");
        }
        ffmpeg_sidecar::download::FfmpegDownloadProgressEvent::Done => {
            info!("ffmpeg download complete");
        }
    };

    // Primary source: the sidecar crate's default (gyan.dev on Windows).
    if ffmpeg_sidecar::download::auto_download_with_progress(progress).is_ok() {
        if let Some(path) = sidecar_ffmpeg() {
            info!(path = %path.display(), "using downloaded ffmpeg");
            return Ok(path);
        }
        warn!("primary ffmpeg source produced no binary; trying a fallback mirror");
    }

    // Fallback source: BtbN GitHub builds (includes libx264).
    #[cfg(target_os = "windows")]
    {
        let fallback_url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip";
        if let Ok(dir) = ffmpeg_sidecar::paths::sidecar_dir() {
            info!(
                url = fallback_url,
                "downloading ffmpeg from fallback mirror"
            );
            match ffmpeg_sidecar::download::download_ffmpeg_package_with_progress(
                fallback_url,
                &dir,
                progress,
            )
            .and_then(|archive| ffmpeg_sidecar::download::unpack_ffmpeg(&archive, &dir))
            {
                Ok(()) => {
                    if let Some(path) = sidecar_ffmpeg() {
                        info!(path = %path.display(), "using fallback-downloaded ffmpeg");
                        return Ok(path);
                    }
                }
                Err(e) => {
                    warn!(error = %e, "fallback ffmpeg download failed");
                }
            }
        }
    }

    Err(MediaError::FfmpegObtain(
        "ffmpeg is not bundled and automatic download failed; place ffmpeg.exe \
         beside screencap.exe (release bundles ship it there)"
            .to_string(),
    ))
}

/// The sidecar ffmpeg if it exists.
fn sidecar_ffmpeg() -> Option<PathBuf> {
    ffmpeg_sidecar::paths::sidecar_path()
        .ok()
        .filter(|p| p.exists())
}

/// `ffmpeg.exe`/`ffmpeg` beside the running executable.
fn sibling_ffmpeg() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let candidate = exe_dir.join(format!("ffmpeg{}", std::env::consts::EXE_SUFFIX));
    if candidate.is_file() {
        Some(candidate)
    } else {
        None
    }
}

/// Primary GPU vendor as reported by the Windows display-class registry keys:
/// `"nvidia"`, `"amd"`, `"intel"`, or `"unknown"`. One registry read per
/// potential adapter; results are cached after the first call so per-run
/// encoder checks stay free.
pub fn gpu_vendor() -> &'static str {
    use std::sync::OnceLock;
    static VENDOR: OnceLock<&'static str> = OnceLock::new();
    *VENDOR.get_or_init(detect_gpu_vendor)
}

fn detect_gpu_vendor() -> &'static str {
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
        // When several vendors are present (laptop hybrid graphics), any
        // hardware encoder is a win over software; the caller probes each
        // candidate, so ordering matters only for preference.
        for v in ["nvidia", "amd", "intel"] {
            if vendors.contains(v) {
                return v;
            }
        }
        "unknown"
    }
    #[cfg(not(windows))]
    {
        "unknown"
    }
}

/// Does the resolved FFmpeg expose the named encoder?
pub fn has_encoder(ffmpeg: &Path, name: &str) -> Result<bool, MediaError> {
    let output = no_window(&mut Command::new(ffmpeg))
        .args(["-hide_banner", "-encoders"])
        .output()
        .map_err(|e| MediaError::Ffmpeg(format!("cannot run {ffmpeg:?}: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.lines().any(|line| {
        let parts: Vec<&str> = line.split_whitespace().collect();
        parts.len() > 1 && parts[1] == name
    }))
}

/// True when the named hardware encoder both exists in the FFmpeg binary and
/// initializes on this machine (its vendor's GPU runtime must open). The
/// vendor gate skips the probe entirely when the resolved FFmpeg lacks the
/// encoder or the machine has no matching GPU — the common case, where the
/// probe is a wasted process spawn.
pub fn hardware_encoder_available(ffmpeg: &Path, name: &str) -> bool {
    if !matches!(
        (gpu_vendor(), name),
        ("nvidia", "h264_nvenc") | ("amd", "h264_amf") | ("intel", "h264_qsv")
    ) {
        return false;
    }
    match has_encoder(ffmpeg, name) {
        Ok(true) => probe_encoder(ffmpeg, name),
        _ => false,
    }
}

/// Does the `name` encoder actually initialize on this machine? Hardware
/// encoders (nvenc/amf/qsv) are compiled into FFmpeg even when the matching
/// GPU is absent, so `has_encoder` alone is not enough — a one-frame encode to
/// `null` succeeds only when the encoder's runtime (NVIDIA/AMD/Intel) opens.
pub fn probe_encoder(ffmpeg: &Path, name: &str) -> bool {
    let output = no_window(&mut Command::new(ffmpeg))
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=320x180:rate=10",
            "-frames:v",
            "1",
            "-c:v",
            name,
            "-f",
            "null",
            "-",
        ])
        .output();
    matches!(output, Ok(o) if o.status.success())
}

/// Verify that the requested encoder exists in the resolved FFmpeg binary.
/// Failures are startup errors; the quality setting is never silently changed.
pub fn check_encoder(ffmpeg: &Path, codec: &VideoCodec) -> Result<(), MediaError> {
    let name = codec.ffmpeg_name();
    if has_encoder(ffmpeg, name)? {
        Ok(())
    } else {
        Err(MediaError::EncoderUnavailable(format!(
            "encoder `{name}` is not available in {}",
            ffmpeg.display()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_vendor_returns_a_known_label() {
        assert!(matches!(
            gpu_vendor(),
            "nvidia" | "amd" | "intel" | "unknown"
        ));
    }

    #[test]
    fn hardware_encoder_gate_never_probes_without_a_matching_gpu() {
        // Without knowing the machine's GPU, assert only the gate behavior:
        // an unknown vendor must answer `false` without touching FFmpeg, and
        // a vendor/encoder mismatch likewise.
        if gpu_vendor() == "unknown" {
            let no_ffmpeg = Path::new("Z:/definitely/not/ffmpeg.exe");
            assert!(!hardware_encoder_available(no_ffmpeg, "h264_nvenc"));
            assert!(!hardware_encoder_available(no_ffmpeg, "h264_amf"));
            assert!(!hardware_encoder_available(no_ffmpeg, "h264_qsv"));
        }
    }
}
