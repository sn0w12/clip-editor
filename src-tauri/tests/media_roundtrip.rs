//! End-to-end media assertions against the resolved FFmpeg sidecar: generate
//! a short test clip, then exercise metadata/thumbnail/waveform contracts.
//!
//! Resolution goes through the same ffmpeg-sidecar machinery the app uses
//! (`resolve_ffmpeg`/`resolve_ffprobe`): the sidecar beside the test binary,
//! or ffmpeg-sidecar's automatic download on first run. Never a system
//! FFmpeg. Ignored by default; run with
//! `cargo test --test media_roundtrip -- --ignored`.

use std::process::Command;

#[test]
#[ignore = "requires the resolved FFmpeg sidecar (downloads on first run); run with --ignored"]
fn media_roundtrip_metadata_thumbnail_waveform() {
    let ffmpeg = clip_editor_lib::media::resolve_ffmpeg().expect("ffmpeg resolves");
    let ffprobe = clip_editor_lib::media::resolve_ffprobe().expect("ffprobe resolves");

    let work = std::env::temp_dir().join(format!("clip-media-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&work).unwrap();
    let clip = work.join("Replay 2026-01-01 00-00-00_Test Game.mkv");

    // 2s testsrc + sine audio.
    let status = Command::new(&ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=640x360:rate=30:duration=2",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-c:a",
            "aac",
            clip.to_str().unwrap(),
        ])
        .status()
        .unwrap();
    assert!(status.success(), "test clip generated");

    // Metadata contract: duration/geometry/fps/codecs/audio tracks.
    let meta = clip_editor_lib::media::get_metadata(&ffprobe, &clip).unwrap();
    assert!(
        (meta.duration - 2.0).abs() < 0.2,
        "duration ~2s: {}",
        meta.duration
    );
    assert_eq!((meta.width, meta.height), (640, 360));
    assert!((29.0..=31.0).contains(&meta.fps), "fps ~30: {}", meta.fps);
    assert_eq!(meta.video_codec.as_deref(), Some("h264"));
    assert_eq!(meta.audio_tracks.len(), 1);
    // Labels are 1-based audio-stream ordinals.
    assert_eq!(meta.audio_tracks[0].label, "Track 1");

    // Thumbnail extraction produces a real jpeg.
    let thumb = work.join("thumb.jpg");
    clip_editor_lib::media::generate_thumbnail(&ffmpeg, &clip, 0.5, &thumb).unwrap();
    assert!(
        thumb.metadata().unwrap().len() > 100,
        "thumbnail is a real jpeg"
    );

    // Waveform: normalized samples from the sine track, legacy smoothing.
    let waveform = clip_editor_lib::media::extract_waveform(&ffmpeg, &clip, 22050, 0, 500).unwrap();
    assert_eq!(waveform.len(), 500);
    assert!(waveform.iter().all(|v| (0.0..=1.0).contains(v)));
    let peak = waveform.iter().fold(0.0f32, |a, b| a.max(*b));
    assert!(peak > 0.5, "sine track has strong signal: {peak}");

    let _ = std::fs::remove_dir_all(&work);
}
