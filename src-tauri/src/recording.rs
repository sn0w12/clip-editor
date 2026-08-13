//! Recording supervision: owns the screencap `ReplayController`, validates and
//! persists the recording profile, and forwards `ReplayEvent`s as Tauri
//! events (`recording-state`, `recording-progress`, `recording-saving`,
//! `recording-saved`, `recording-error`).

use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use screencap::config::{
    AudioConfig, Config, InputKind, InputRule, MonitorSpec, ReplayConfig, ResolvedTrack, Selector,
    VideoCodec, VideoConfig,
};
use screencap::replay::{ReplayController, ReplayEvent};
use tauri::Emitter;

use crate::types::{
    err, RecordingProfile, RecordingProgressPayload, RecordingSavedPayload, RecordingStatePayload,
};

#[derive(Debug, Clone, Default)]
pub struct RecordingStatus {
    pub running: bool,
    pub available_seconds: f64,
    pub target_seconds: u32,
    pub saving: bool,
    pub error: Option<String>,
}

/// Live recording state. The controller Arc is shared with the event
/// forwarder thread; commands take it out only on stop.
pub struct RecordingHandle {
    controller: Arc<Mutex<Option<ReplayController>>>,
    status: Arc<Mutex<RecordingStatus>>,
    stop_flag: Arc<AtomicBool>,
    forwarder: Mutex<Option<std::thread::JoinHandle<()>>>,
}

/// Build a validated screencap Config from the stored profile.
pub fn config_from_profile(p: &RecordingProfile) -> Result<Config, String> {
    if p.duration_seconds < 3 {
        return Err(err(
            "recording.validate",
            format!(
                "buffer duration must be at least 3 seconds (got {})",
                p.duration_seconds
            ),
        ));
    }
    if p.segment_seconds == 0 || p.duration_seconds < p.segment_seconds {
        return Err(err(
            "recording.validate",
            format!(
                "segment length must be between 1 and the buffer duration ({}s / {}s)",
                p.segment_seconds, p.duration_seconds
            ),
        ));
    }
    if p.fps == 0 || p.fps > 240 {
        return Err(err(
            "recording.validate",
            format!("fps must be 1..=240 (got {})", p.fps),
        ));
    }
    if p.quality > 51 {
        return Err(err(
            "recording.validate",
            format!("quality must be 0..=51 (got {})", p.quality),
        ));
    }
    if !matches!(p.sample_rate, 44100 | 48000) {
        return Err(err(
            "recording.validate",
            format!("sample rate must be 44100 or 48000 (got {})", p.sample_rate),
        ));
    }
    if !matches!(p.channels, 1 | 2) {
        return Err(err(
            "recording.validate",
            format!("channels must be 1 or 2 (got {})", p.channels),
        ));
    }
    if p.output_dir.trim().is_empty() {
        return Err(err("recording.validate", "output directory is required"));
    }
    let output_dir = std::path::PathBuf::from(p.output_dir.trim());
    if !output_dir.is_absolute() {
        return Err(err(
            "recording.validate",
            "output directory must be absolute",
        ));
    }
    let monitor = MonitorSpec::parse(&p.monitor)
        .map_err(|e| err("recording.validate", format!("monitor: {e}")))?;
    let codec = match p.codec.as_str() {
        "auto" => VideoCodec::Auto,
        "libx264" => VideoCodec::LibX264,
        "h264_nvenc" => VideoCodec::H264Nvenc,
        "h264_amf" => VideoCodec::H264Amf,
        "h264_qsv" => VideoCodec::H264Qsv,
        other => {
            return Err(err(
                "recording.validate",
                format!(
                    "codec `{other}` is not supported (auto | libx264 | h264_nvenc | h264_amf | h264_qsv)"
                ),
            ))
        }
    };
    if !matches!(p.audio_routing.as_str(), "all" | "all+mic") {
        return Err(err(
            "recording.validate",
            format!(
                "audio routing `{}` is not supported (all | all+mic)",
                p.audio_routing
            ),
        ));
    }
    let (processes, inputs, tracks) = build_audio_config(p)?;
    Ok(Config {
        replay: ReplayConfig {
            duration_seconds: p.duration_seconds,
            segment_seconds: p.segment_seconds,
            output_dir,
            filename_base: if p.filename_base.trim().is_empty() {
                "Replay".into()
            } else {
                p.filename_base.trim().into()
            },
            monitor,
            fps: p.fps,
            hotkey: p.hotkey.clone(),
            success_sound: if p.success_sound.trim().is_empty() {
                None
            } else {
                Some(p.success_sound.trim().to_string())
            },
            buffer_dir: None,
        },
        video: VideoConfig {
            codec,
            quality: p.quality,
            cursor: p.cursor,
        },
        audio: AudioConfig {
            sample_rate: p.sample_rate,
            channels: p.channels,
            block_ms: 20,
            processes,
            inputs,
            tracks,
        },
    })
}

fn parse_selector(s: &str) -> Result<Selector, String> {
    match s {
        "all_processes" => Ok(Selector::AllProcesses),
        "all_nonmuted_processes" => Ok(Selector::AllNonMutedProcesses),
        other if other.starts_with("source:") => Ok(Selector::Source(other[7..].to_string())),
        other if other.starts_with("input:") => Ok(Selector::Input(other[6..].to_string())),
        other if other.starts_with("tag:") => Ok(Selector::Tag(other[4..].to_string())),
        other => Err(err(
            "recording.validate",
            format!("unknown audio selector `{other}`"),
        )),
    }
}

type AudioConfigParts = (
    Vec<screencap::config::ProcessRule>,
    Vec<InputRule>,
    Vec<ResolvedTrack>,
);

fn build_audio_config(p: &RecordingProfile) -> Result<AudioConfigParts, String> {
    let mut processes: Vec<screencap::config::ProcessRule> = Vec::new();
    for process in &p.processes {
        if process.executable.trim().is_empty() {
            return Err(err(
                "recording.validate",
                "audio process executable is required",
            ));
        }
        processes.push(screencap::config::ProcessRule {
            id: if process.id.trim().is_empty() {
                process.executable.clone()
            } else {
                process.id.clone()
            },
            executable: process.executable.clone(),
            tags: process.tags.clone(),
            include_children: process.include_children,
        });
    }
    let mut inputs: Vec<InputRule> = Vec::new();
    let mut tracks: Vec<ResolvedTrack> = Vec::new();
    let mut numbers = std::collections::HashSet::new();
    for track_cfg in &p.tracks {
        if track_cfg.name.trim().is_empty() {
            return Err(err("recording.validate", "audio track name is required"));
        }
        if track_cfg.number == 0 || !numbers.insert(track_cfg.number) {
            return Err(err(
                "recording.validate",
                format!(
                    "audio track number {} is invalid or duplicated",
                    track_cfg.number
                ),
            ));
        }
        let include: Vec<Selector> = track_cfg
            .include
            .iter()
            .map(|s| parse_selector(s))
            .collect::<Result<_, _>>()?;
        if include.is_empty() {
            return Err(err(
                "recording.validate",
                format!(
                    "audio track `{}` needs at least one include selector",
                    track_cfg.name
                ),
            ));
        }
        let exclude: Vec<Selector> = track_cfg
            .exclude
            .iter()
            .map(|s| parse_selector(s))
            .collect::<Result<_, _>>()?;
        for sel in &include {
            if let Selector::Input(id) = sel {
                if !inputs.iter().any(|i| &i.id == id) {
                    inputs.push(InputRule {
                        id: id.clone(),
                        kind: InputKind::Microphone,
                        device: "default".into(),
                    });
                }
            }
        }
        tracks.push(ResolvedTrack {
            number: track_cfg.number,
            name: track_cfg.name.clone(),
            include,
            exclude,
        });
    }
    if tracks.is_empty() {
        return Err(err(
            "recording.validate",
            "at least one audio track is required",
        ));
    }
    Ok((processes, inputs, tracks))
}

impl Default for RecordingHandle {
    fn default() -> Self {
        Self {
            controller: Arc::new(Mutex::new(None)),
            status: Arc::new(Mutex::new(RecordingStatus::default())),
            stop_flag: Arc::new(AtomicBool::new(false)),
            forwarder: Mutex::new(None),
        }
    }
}

impl RecordingHandle {
    /// An idle handle (no controller running).
    pub fn new() -> Self {
        Self::default()
    }

    /// Start the buffer with a validated profile. FFmpeg resolution and an
    /// explicitly requested encoder are preflighted synchronously so the
    /// command fails fast; monitor/capture failures arrive as
    /// `recording-error` events.
    pub fn start(&self, profile: &RecordingProfile, app: &tauri::AppHandle) -> Result<(), String> {
        if self.is_running() {
            return Err(err("recording.start", "a replay buffer is already running"));
        }
        let config = config_from_profile(profile)?;
        // Preflight: FFmpeg must resolve (this triggers the sidecar download)
        // and an explicitly requested encoder must exist.
        let ffmpeg = crate::media::resolve_ffmpeg()?;
        match config.video.codec {
            VideoCodec::Auto => {}
            codec => {
                screencap::media::ffmpeg::check_encoder(&ffmpeg, &codec)
                    .map_err(|e| err("recording.start", e))?;
            }
        }

        let controller = ReplayController::start(config, Some(crate::media::ffmpeg_dir()))
            .map_err(|e| err("recording.start", e))?;
        // Swap the shared state through the Arc fields (interior mutability),
        // then (re)spawn the forwarder against the new controller.
        *self.controller.lock() = Some(controller);
        {
            let mut status = self.status.lock();
            *status = RecordingStatus {
                target_seconds: profile.duration_seconds,
                ..Default::default()
            };
        }
        self.stop_flag.store(false, Ordering::SeqCst);
        let forwarder = spawn_forwarder(
            self.controller.clone(),
            self.status.clone(),
            self.stop_flag.clone(),
            app.clone(),
        );
        *self.forwarder.lock() = Some(forwarder);
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.controller.lock().as_ref().is_some()
    }

    /// Save the newest configured duration. Coalescing is handled by the
    /// supervisor (one save, at most one queued replay).
    pub fn save_now(&self) -> Result<(), String> {
        let guard = self.controller.lock();
        match guard.as_ref() {
            Some(controller) => controller.save_now().map_err(|e| err("recording.save", e)),
            None => Err(err("recording.save", "no replay buffer is running")),
        }
    }

    /// Stop the buffer: join the supervisor (final segment finalized, no
    /// workers remain) and the forwarder.
    pub fn stop(&self) -> Result<(), String> {
        let controller = self.controller.lock().take();
        let Some(controller) = controller else {
            return Ok(()); // already stopped
        };
        let result = controller.stop().map_err(|e| err("recording.stop", e));
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(forwarder) = self.forwarder.lock().take() {
            let _ = forwarder.join();
        }
        {
            let mut status = self.status.lock();
            status.running = false;
            status.saving = false;
        }
        result
    }

    /// Current status snapshot for `get_recording_state`.
    pub fn state(&self) -> RecordingStatePayload {
        let status = self.status.lock().clone();
        RecordingStatePayload {
            running: status.running || self.is_running(),
            available_seconds: status.available_seconds,
            target_seconds: status.target_seconds,
            saving: status.saving,
            error: status.error.clone(),
        }
    }
}

fn spawn_forwarder(
    controller: Arc<Mutex<Option<ReplayController>>>,
    status: Arc<Mutex<RecordingStatus>>,
    stop_flag: Arc<AtomicBool>,
    app: tauri::AppHandle,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("recording-forwarder".into())
        .spawn(move || loop {
            if stop_flag.load(Ordering::SeqCst) {
                break;
            }
            // try_lock: never block a stop() that is joining the supervisor.
            if let Some(guard) = controller.try_lock() {
                let mut drained = Vec::new();
                if let Some(c) = guard.as_ref() {
                    while let Some(event) = c.try_recv() {
                        drained.push(event);
                    }
                }
                drop(guard);
                for event in drained {
                    forward_event(&event, &status, &app);
                }
            }
            std::thread::sleep(Duration::from_millis(80));
        })
        .expect("forwarder thread spawns")
}

fn forward_event(event: &ReplayEvent, status: &Mutex<RecordingStatus>, app: &tauri::AppHandle) {
    let mut status = status.lock();
    match event {
        ReplayEvent::Started { width, height, fps } => {
            status.running = true;
            status.error = None;
            let _ = app.emit(
                "recording-state",
                RecordingStatePayload {
                    running: true,
                    available_seconds: 0.0,
                    target_seconds: status.target_seconds,
                    saving: status.saving,
                    error: None,
                },
            );
            let _ = app.emit(
                "recording-started",
                serde_json::json!({ "width": width, "height": height, "fps": fps }),
            );
        }
        ReplayEvent::BufferProgress {
            available_seconds,
            target_seconds,
        } => {
            status.available_seconds = *available_seconds;
            status.target_seconds = *target_seconds;
            let _ = app.emit(
                "recording-progress",
                RecordingProgressPayload {
                    available_seconds: *available_seconds,
                    target_seconds: *target_seconds,
                },
            );
        }
        ReplayEvent::Saving => {
            status.saving = true;
            let _ = app.emit("recording-saving", ());
        }
        ReplayEvent::Saved { path } => {
            status.saving = false;
            let _ = app.emit(
                "recording-saved",
                RecordingSavedPayload {
                    path: path.to_string_lossy().into_owned(),
                },
            );
        }
        ReplayEvent::Error { message } => {
            status.saving = false;
            status.running = false;
            status.error = Some(message.clone());
            let _ = app.emit("recording-error", serde_json::json!({ "message": message }));
            let _ = app.emit(
                "recording-state",
                RecordingStatePayload {
                    running: false,
                    available_seconds: status.available_seconds,
                    target_seconds: status.target_seconds,
                    saving: false,
                    error: Some(message.clone()),
                },
            );
        }
        ReplayEvent::Stopped => {
            status.running = false;
            status.saving = false;
            let _ = app.emit(
                "recording-state",
                RecordingStatePayload {
                    running: false,
                    available_seconds: status.available_seconds,
                    target_seconds: status.target_seconds,
                    saving: false,
                    error: None,
                },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::RecordingProfile;

    fn base_profile() -> RecordingProfile {
        RecordingProfile {
            output_dir: std::env::temp_dir().to_string_lossy().into_owned(),
            ..Default::default()
        }
    }

    #[test]
    fn default_profile_validates() {
        assert!(config_from_profile(&base_profile()).is_ok());
    }

    #[test]
    fn invalid_combinations_are_actionable_errors() {
        let mut p = base_profile();
        p.duration_seconds = 1;
        assert!(config_from_profile(&p)
            .unwrap_err()
            .contains("at least 3 seconds"));

        let mut p = base_profile();
        p.segment_seconds = 60;
        assert!(config_from_profile(&p)
            .unwrap_err()
            .contains("segment length"));

        let mut p = base_profile();
        p.fps = 0;
        assert!(config_from_profile(&p).unwrap_err().contains("fps"));

        let mut p = base_profile();
        p.quality = 99;
        assert!(config_from_profile(&p).unwrap_err().contains("quality"));

        let mut p = base_profile();
        p.sample_rate = 12345;
        assert!(config_from_profile(&p).unwrap_err().contains("sample rate"));

        let mut p = base_profile();
        p.output_dir = "relative/path".into();
        assert!(config_from_profile(&p).unwrap_err().contains("absolute"));

        let mut p = base_profile();
        p.codec = "h264_whatever".into();
        assert!(config_from_profile(&p).unwrap_err().contains("codec"));

        let mut p = base_profile();
        p.audio_routing = "stereo-ultra".into();
        assert!(config_from_profile(&p)
            .unwrap_err()
            .contains("audio routing"));
    }

    #[test]
    fn profile_maps_to_screencap_config() {
        let mut p = base_profile();
        p.duration_seconds = 60;
        p.segment_seconds = 2;
        p.monitor = "index:1".into();
        p.fps = 30;
        p.codec = "h264_nvenc".into();
        p.quality = 28;
        p.cursor = false;
        p.audio_routing = "all+mic".into();
        p.tracks = vec![
            crate::types::AudioTrackConfig {
                number: 1,
                name: "all".into(),
                include: vec!["all_processes".into()],
                exclude: vec!["tag:muted".into()],
            },
            crate::types::AudioTrackConfig {
                number: 2,
                name: "mic".into(),
                include: vec!["input:mic".into()],
                exclude: vec![],
            },
        ];
        p.processes = vec![crate::types::AudioProcessConfig {
            id: "discord".into(),
            executable: "Discord.exe".into(),
            tags: vec!["tracked".into()],
            include_children: true,
        }];
        let config = config_from_profile(&p).unwrap();
        assert_eq!(config.replay.duration_seconds, 60);
        assert_eq!(config.replay.segment_seconds, 2);
        assert_eq!(config.replay.fps, 30);
        assert_eq!(config.video.codec, VideoCodec::H264Nvenc);
        assert_eq!(config.video.quality, 28);
        assert!(!config.video.cursor);
        assert_eq!(config.audio.tracks.len(), 2, "all + mic");
        assert_eq!(config.audio.tracks[0].name, "all");
        assert_eq!(
            config.audio.tracks[0].exclude,
            vec![Selector::Tag("muted".into())]
        );
        assert_eq!(config.audio.tracks[1].name, "mic");
        assert_eq!(config.audio.inputs.len(), 1, "mic input auto-added");
        assert!(matches!(config.audio.inputs[0].kind, InputKind::Microphone));
        assert_eq!(config.audio.processes.len(), 1);
        assert_eq!(config.audio.processes[0].executable, "Discord.exe");
        assert_eq!(config.audio.processes[0].tags, vec!["tracked".to_string()]);
        assert!(config.audio.processes[0].include_children);
    }
}
