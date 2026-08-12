//! End-to-end export verification against the resolved FFmpeg: cuts, atomic
//! output, temp cleanup, and a playable result. Uses a mock Tauri app for the
//! event sink. Ignored by default; run with `cargo test --test export_e2e -- --ignored`.

use std::path::PathBuf;
use std::process::Command;

use clip_editor_lib::media::{
    default_output_path, export_clip_with, resolve_ffprobe, ExportEvents,
};
use clip_editor_lib::types::{Cut, ExportCompletePayload, ExportOptions, ExportProgressPayload};

/// No-op event sink: the pipeline must succeed without any Tauri runtime.
struct NoopEvents;

impl ExportEvents for NoopEvents {
    fn progress(&self, _payload: &ExportProgressPayload) {}
    fn complete(&self, _payload: &ExportCompletePayload) {}
    fn error(&self, _message: &str) {}
}

#[test]
#[ignore = "requires the resolved FFmpeg (sidecar or PATH); run with --ignored"]
fn export_with_cuts_is_atomic_and_playable() {
    let events = NoopEvents;
    let ffmpeg = clip_editor_lib::media::resolve_ffmpeg().expect("ffmpeg resolves");
    let ffprobe = resolve_ffprobe().expect("ffprobe resolves");

    let work = std::env::temp_dir().join(format!("clip-export-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).unwrap();
    let source = work.join("Replay 2026-01-01 00-00-00_Test Game.mkv");

    // 4s clip so two cuts fit.
    let status = Command::new(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30:duration=4",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=4",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            source.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(status.success());

    let options = ExportOptions {
        start_time: 0.0,
        end_time: 4.0,
        output_format: "mp4".into(),
        quality: Some("medium".into()),
        target_size: None,
        quality_mode: "preset".into(),
        width: None,
        height: None,
        fps: None,
        audio_bitrate: Some(128),
        remove_audio: None,
        speed_factor: None,
        audio_tracks: Some(vec![0]),
        choose_export_location: None,
        cuts: Some(vec![
            Cut {
                start: 0.0,
                end: 1.0,
            },
            Cut {
                start: 2.0,
                end: 3.0,
            },
        ]),
    };

    let output = default_output_path(source.to_str().unwrap(), &options).expect("output path");
    let result = export_clip_with(&events, source.to_str().unwrap(), &options, &output)
        .expect("export succeeds");
    assert!(!result.file_already_exists);

    let output = PathBuf::from(&result.output_path);
    assert_eq!(
        output,
        default_output_path(source.to_str().unwrap(), &options).unwrap(),
        "deterministic naming"
    );
    assert!(output.is_file(), "output exists: {}", output.display());
    assert!(
        !output.with_extension("mp4.tmp").exists(),
        "no .tmp remains"
    );

    // Temp cuts directory must be cleaned up.
    let clips_dir = source
        .parent()
        .unwrap()
        .join("Replay 2026-01-01 00-00-00_Test Game_clips");
    let leftovers: Vec<_> = std::fs::read_dir(&clips_dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("__temp_cuts_"))
                .collect()
        })
        .unwrap_or_default();
    assert!(leftovers.is_empty(), "temp cuts dir cleaned: {leftovers:?}");

    // The output must be playable: one video stream, nonzero duration.
    let json = {
        let out = Command::new(&ffprobe)
            .args([
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
            ])
            .arg(&output)
            .output()
            .unwrap();
        assert!(out.status.success());
        serde_json::from_slice::<serde_json::Value>(&out.stdout).unwrap()
    };
    let streams = json["streams"].as_array().expect("streams");
    let video = streams
        .iter()
        .filter(|s| s["codec_type"] == "video")
        .count();
    assert_eq!(video, 1, "exactly one video stream");
    let duration: f64 = json["format"]["duration"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        (1.0..=3.0).contains(&duration),
        "cut duration ~2s: {duration}"
    );

    // A second export of identical options is an idempotent already-exists.
    let again = export_clip_with(&events, source.to_str().unwrap(), &options, &output)
        .expect("second export ok");
    assert!(again.file_already_exists);
    assert_eq!(again.output_path, result.output_path);

    let _ = std::fs::remove_dir_all(&work);
}
