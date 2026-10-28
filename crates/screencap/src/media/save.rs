//! Replay save: concatenate the newest closed segments covering the
//! configured duration into `<base>_<sanitized-title>.mp4` with a stream copy,
//! via a private concat list, a `.tmp` file, and an atomic rename. The rolling
//! buffer stays MKV (live-safe), but the saved clip is MP4 so the editor can
//! play it directly (WebView2 cannot demux Matroska).

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;

use tracing::{info, warn};

use crate::error::MediaError;
use crate::media::segmenter::{SegmentSnapshot, probe_duration_seconds};
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

    let actual: f64 = selected_segments
        .iter()
        .map(|s| s.duration.as_secs_f64())
        .sum();
    if actual < duration_seconds as f64 {
        warn!(
            actual_seconds = format!("{actual:.1}"),
            requested_seconds = duration_seconds,
            "buffer not fully filled; saving all available material"
        );
    }

    std::fs::create_dir_all(output_dir).map_err(|e| {
        MediaError::General(format!(
            "cannot create output dir {}: {e}",
            output_dir.display()
        ))
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
        // The concat demuxer rebuilds the output timeline from each file's
        // *container* duration (the MKV Duration element), which the segment
        // muxer writes as the last packet's end time. With AAC the frame
        // straddling the boundary extends past the video end, so the container
        // duration overstates the segment's true span (~one AAC frame per
        // segment). Concat would then push every following segment late by
        // that amount, accumulating into an A/V offset that grows across the
        // whole clip. Overriding it with the segment list's true span keeps
        // the rebuilt timeline exact (and the output duration exact).
        list.push_str(&format!("duration {:.6}\n", segment.duration.as_secs_f64()));
        // The concat demuxer offsets every file's packets by
        // `file_start_time - file_inpoint`, where `file_inpoint` defaults to
        // the file's container start time. Our segments' AAC streams carry
        // priming (`initial_padding`) that the demuxer reflects as a
        // non-zero/negative container start, so every subsequent file lands
        // shifted (~one AAC frame) past its boundary — punching a hole in the
        // timeline (a missing video frame and the first ~20-40ms of audio) at
        // each segment join. Forcing `inpoint 0` makes the offset exactly the
        // accumulated duration, so joins are seamless.
        list.push_str("inpoint 0\n");
    }
    std::fs::write(&list_path, list).map_err(|e| {
        MediaError::General(format!(
            "cannot write concat list {}: {e}",
            list_path.display()
        ))
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
            // Segment files reset timestamps at their boundaries, so the
            // concat demuxer can concatenate them on a continuous timeline.
            // Do not preserve the capture-origin clock here: that would make
            // the output duration include the elapsed time since recording
            // started (e.g. a 39-second clip becoming 39 minutes).
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
        // A segment carrying a non-zero container timestamp makes the concat
        // demuxer keep that offset (the `inpoint 0` entry then cannot rebase
        // it), which turns a 90 s clip into a multi-hour file that seeks to
        // arbitrary frames. The concat exit code stays zero in that case, so
        // verify the timeline before the atomic rename and refuse to publish a
        // file the editor cannot seek.
        let probed = probe_duration_seconds(ffmpeg, &tmp).ok_or_else(|| {
            MediaError::General("cannot read the saved clip's duration after concat".to_string())
        })?;
        let tolerance = 2.0 + actual * 0.05;
        if (probed - actual).abs() > tolerance {
            return Err(MediaError::General(format!(
                "saved clip timeline is corrupt: expected {actual:.2}s but the container reports {probed:.2}s"
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
mod corrupt_segment_test {
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::Arc;
    use std::time::Duration;

    use crate::media::SegmentInfo;
    use crate::media::segmenter::SegmentStore;

    /// A segment whose container start is not zero must not be published as a
    /// clip: the concat demuxer keeps that offset (the list's `inpoint 0` does
    /// not rebase it), so a two-second segment becomes a two-minute file that
    /// seeks to arbitrary frames. This reproduces that shape and asserts the
    /// duration check refuses it.
    #[test]
    fn save_refuses_a_clip_with_a_nonzero_segment_start() {
        if std::env::var("SCREENCAP_CORRUPT_TEST").as_deref() != Ok("1") {
            eprintln!("SKIP: set SCREENCAP_CORRUPT_TEST=1 to run the corrupt-segment guard test");
            return;
        }
        let ffmpeg = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(if cfg!(debug_assertions) {
                "debug"
            } else {
                "release"
            })
            .join("ffmpeg.exe");
        assert!(
            ffmpeg.exists(),
            "ffmpeg.exe must sit at {}",
            ffmpeg.display()
        );
        let work = std::env::temp_dir().join(format!("screencap_corrupt_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        let buffer_dir = work.join("buffer");
        let out_dir = work.join("out");
        std::fs::create_dir_all(&buffer_dir).unwrap();
        std::fs::create_dir_all(&out_dir).unwrap();

        let plain = work.join("plain.mkv");
        let status = Command::new(&ffmpeg)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=320x180:rate=30:duration=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=2",
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-g",
                "30",
                "-bf",
                "0",
                "-c:a",
                "aac",
            ])
            .arg(&plain)
            .status()
            .expect("ffmpeg creates the source segment");
        assert!(status.success());

        let segment0 = buffer_dir.join("segment_00000.mkv");
        std::fs::copy(&plain, &segment0).unwrap();
        let segment1 = buffer_dir.join("segment_00001.mkv");
        let status = Command::new(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&plain)
            .args(["-map", "0", "-c", "copy", "-output_ts_offset", "100"])
            .arg(&segment1)
            .status()
            .expect("ffmpeg shifts the segment start");
        assert!(status.success());

        let store = Arc::new(SegmentStore::new(buffer_dir.clone()));
        for (name, path) in [
            ("segment_00000.mkv", segment0),
            ("segment_00001.mkv", segment1),
        ] {
            store.record(SegmentInfo {
                name: name.to_string(),
                path,
                duration: Duration::from_secs(2),
                stream_end: 2.0,
            });
        }
        let err = super::save_replay(
            &ffmpeg,
            store.snapshot(),
            &buffer_dir,
            &out_dir,
            "Corrupt",
            "guard",
            4,
        )
        .expect_err("a non-zero segment start must not be published");
        assert!(
            err.to_string().contains("timeline is corrupt"),
            "unexpected error: {err}"
        );
        let _ = std::fs::remove_dir_all(&work);
    }
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
            std::env::var("SAVE_TEST_BUFFER")
                .expect("SAVE_TEST_BUFFER must point at a live buffer dir"),
        );
        let store = Arc::new(crate::media::segmenter::SegmentStore::new(
            buffer_dir.clone(),
        ));
        let list = std::fs::read_to_string(buffer_dir.join("segments.txt")).unwrap();
        for line in list.lines() {
            let f: Vec<&str> = line.trim().split(',').collect();
            if f.len() != 3 {
                continue;
            }
            let Ok(start) = f[1].trim().parse::<f64>() else {
                continue;
            };
            let Ok(end) = f[2].trim().parse::<f64>() else {
                continue;
            };
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
        let age = now
            .duration_since(newest_mtime)
            .unwrap_or_default()
            .as_secs_f64();
        println!(
            "SAVE-WINDOW: newest recorded segment `{}` is {:.2}s old at save time",
            newest.name, age
        );
        let out_dir =
            PathBuf::from(std::env::var("SAVE_TEST_OUT").unwrap_or_else(|_| "savewindow".into()));
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
