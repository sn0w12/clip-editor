//! Replay save: concatenate the newest closed segments covering the
//! configured duration into `<base>_<sanitized-title>.mp4` with a stream copy,
//! via a private concat list, a `.tmp` file, and an atomic rename. The rolling
//! buffer stays MKV (live-safe), but the saved clip is MP4 so the editor can
//! play it directly (WebView2 cannot demux Matroska).

use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tracing::{info, warn};

use crate::error::MediaError;
use crate::media::segmenter::SegmentSnapshot;
use crate::naming::{pick_output_path, sanitize_title, timestamp_stem};

/// Save the replay. `foreground_title` is the window title captured when the
/// hotkey was pressed. Returns the final output path.
pub fn save_replay(
    ffmpeg: &Path,
    snapshot: SegmentSnapshot,
    buffer_dir: &Path,
    output_dir: &Path,
    filename_base: &str,
    foreground_title: &str,
    duration_seconds: u32,
) -> Result<PathBuf, MediaError> {
    let segments = snapshot.segments();
    if segments.is_empty() {
        return Err(MediaError::General(
            "buffer not ready: no completed segments yet".to_string(),
        ));
    }

    // Choose the smallest suffix covering `duration_seconds` (chronological
    // order: walk from the newest backward).
    let mut selected: Vec<usize> = Vec::new();
    let mut accumulated = 0.0f64;
    for (idx, segment) in segments.iter().enumerate().rev() {
        selected.push(idx);
        accumulated += segment.duration.as_secs_f64();
        if accumulated >= duration_seconds as f64 {
            break;
        }
    }
    selected.reverse();
    let selected_segments: Vec<&crate::media::SegmentInfo> =
        selected.iter().map(|&i| &segments[i]).collect();

    let actual: f64 = selected_segments.iter().map(|s| s.duration.as_secs_f64()).sum();
    if actual < duration_seconds as f64 {
        warn!(
            actual_seconds = format!("{actual:.1}"),
            requested_seconds = duration_seconds,
            "buffer not fully filled; saving all available material"
        );
    }

    std::fs::create_dir_all(output_dir).map_err(|e| {
        MediaError::General(format!("cannot create output dir {}: {e}", output_dir.display()))
    })?;

    // Private concat list in the buffer directory (forward slashes so FFmpeg
    // never treats backslashes as escapes).
    let list_path = buffer_dir.join(format!(
        "concat_{}_{}.txt",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let mut list = String::new();
    for segment in &selected_segments {
        let path = segment.path.to_string_lossy().replace('\\', "/");
        let escaped = path.replace('\'', "'\\''");
        list.push_str(&format!("file '{escaped}'\n"));
    }
    std::fs::write(&list_path, list).map_err(|e| {
        MediaError::General(format!("cannot write concat list {}: {e}", list_path.display()))
    })?;

    // Target name fixed up front (timestamp and title captured at hotkey time,
    // not when encoding finishes).
    let title = sanitize_title(foreground_title);
    let target = pick_output_path(output_dir, &timestamp_stem(filename_base), &title);
    let tmp = target.with_extension("mp4.tmp");

    let result = (|| -> Result<(), MediaError> {
        let output = Command::new(ffmpeg)
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW: no console flash
            .args(["-hide_banner", "-loglevel", "error", "-y"])
            .arg("-f")
            .arg("concat")
            .arg("-safe")
            .arg("0")
            .arg("-i")
            .arg(&list_path)
            .arg("-map")
            .arg("0")
            .arg("-c")
            .arg("copy")
            // `+faststart` writes the moov atom up front so the saved MP4
            // streams/seeks immediately in the editor's <video> element.
            .arg("-movflags")
            .arg("+faststart")
            .arg("-f")
            .arg("mp4")
            .arg(&tmp)
            .output()
            .map_err(|e| MediaError::Ffmpeg(format!("cannot run ffmpeg for save: {e}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(MediaError::Ffmpeg(format!(
                "concat failed ({}): {}",
                output.status,
                stderr.chars().take(400).collect::<String>()
            )));
        }
        // Atomic rename: the output either appears complete or not at all.
        std::fs::rename(&tmp, &target).map_err(|e| {
            MediaError::General(format!(
                "cannot rename {} to {}: {e}",
                tmp.display(),
                target.display()
            ))
        })
    })();

    let _ = std::fs::remove_file(&list_path);
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }

    result?;
    info!(
        path = %target.display(),
        seconds = format!("{actual:.1}"),
        tracks = selected_segments.len(),
        "replay saved"
    );
    Ok(target)
}

#[cfg(test)]
mod save_window_test {
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    use crate::media::SegmentInfo;

    /// Diagnostic: record a live buffer dir's closed segments into a store and
    /// save, measuring how old the clip's newest content is relative to the
    /// wall clock. Requires SAVE_TEST_BUFFER / SAVE_TEST_OUT / SAVE_TEST_FFMPEG;
    /// skips (does not fail) when they are absent so CI stays green.
    #[test]
    fn save_window_reaches_the_wall() {
        if std::env::var_os("SAVE_TEST_BUFFER").is_none() {
            eprintln!(
                "SKIP: set SAVE_TEST_BUFFER (and SAVE_TEST_OUT / SAVE_TEST_FFMPEG) to run the save-window diagnostic"
            );
            return;
        }
        let buffer_dir = PathBuf::from(
            std::env::var("SAVE_TEST_BUFFER").expect("SAVE_TEST_BUFFER must point at a live buffer dir"),
        );
        let store = Arc::new(crate::media::segmenter::SegmentStore::new(buffer_dir.clone()));
        let list = std::fs::read_to_string(buffer_dir.join("segments.txt")).unwrap();
        for line in list.lines() {
            let f: Vec<&str> = line.trim().split(',').collect();
            if f.len() != 3 {
                continue;
            }
            let Ok(start) = f[1].trim().parse::<f64>() else { continue };
            let Ok(end) = f[2].trim().parse::<f64>() else { continue };
            let dur = end - start;
            if dur <= 0.0 {
                continue;
            }
            store.record(SegmentInfo {
                name: f[0].to_string(),
                path: buffer_dir.join(f[0].trim()),
                duration: Duration::from_secs_f64(dur),
                stream_end: end,
            });
        }
        let snapshot = store.snapshot();
        // The saved file's newest content should be the newest recorded
        // segment. Compare its mtime against the wall clock: if the newest
        // recorded segment's file is N seconds old, the clip ends N seconds
        // before the save moment.
        let segs = snapshot.segments().to_vec();
        let newest = segs.last().expect("no segments");
        let newest_mtime = std::fs::metadata(&newest.path).unwrap().modified().unwrap();
        let now = std::time::SystemTime::now();
        let age = now.duration_since(newest_mtime).unwrap_or_default().as_secs_f64();
        println!("SAVE-WINDOW: newest recorded segment `{}` is {:.2}s old at save time", newest.name, age);
        let out_dir = PathBuf::from(std::env::var("SAVE_TEST_OUT").unwrap_or_else(|_| "savewindow".into()));
        std::fs::create_dir_all(&out_dir).unwrap();
        let out = super::save_replay(
            &PathBuf::from(std::env::var("SAVE_TEST_FFMPEG").unwrap_or_else(|_| "ffmpeg".into())),
            snapshot,
            &buffer_dir,
            &out_dir,
            "Replay",
            "window-test",
            30,
        )
        .expect("save_replay failed");
        println!("SAVE-WINDOW: saved to {}", out.display());
        println!("SAVE-WINDOW: selected {} segments", segs.len());
    }
}
