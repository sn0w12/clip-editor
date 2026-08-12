//! Serializable domain contracts shared with the frontend. These shapes are
//! the IPC contract: rename here only together with `src/types.ts`.

use serde::{Deserialize, Serialize};

/// A clip row as shown in the library.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoFile {
    pub name: String,
    pub game: String,
    /// Canonical absolute path (the identity key).
    pub path: String,
    pub size: u64,
    /// ISO-8601 UTC.
    pub last_modified: String,
    pub metadata: Option<VideoMetadata>,
    pub scan_error: Option<String>,
    pub game_images: Option<GameImage>,
    pub group_ids: Vec<String>,
    /// Cached thumbnail path (precomputed by the warm pass), so the grid can
    /// render thumbnails without a per-card request.
    #[serde(default)]
    pub thumbnail: Option<String>,
    /// Base64 ThumbHash placeholder, rendered instantly while the JPEG loads.
    #[serde(default)]
    pub thumbhash: Option<String>,
}

/// ffprobe-derived metadata, kept optional-field shaped like the legacy
/// `VideoMetadata` so the editor can be ported without semantic drift.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoMetadata {
    pub duration: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub bitrate: Option<u64>,
    pub size: Option<u64>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub audio_tracks: Vec<AudioTrackInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackInfo {
    pub index: u32,
    pub label: String,
}

/// Editor export options; the literals mirror the legacy contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub start_time: f64,
    pub end_time: f64,
    pub output_format: String,
    pub quality: Option<String>,
    pub target_size: Option<f64>,
    pub quality_mode: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<u32>,
    pub audio_bitrate: Option<u32>,
    pub remove_audio: Option<bool>,
    pub speed_factor: Option<f64>,
    pub audio_tracks: Option<Vec<u32>>,
    pub choose_export_location: Option<bool>,
    pub cuts: Option<Vec<Cut>>,
}

/// Editor range selection. Part of the IPC contract; the Rust backend carries
/// the same fields directly in `ExportOptions`, so this exists for the
/// frontend shape and future commands.
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimeRange {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cut {
    pub start: f64,
    pub end: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportedClip {
    pub path: String,
    pub name: String,
    pub timestamp: String,
    pub duration: f64,
    pub thumbnail: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoGroup {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
}

/// A Steam game discovered from local manifests, with its best local artwork.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SteamGame {
    pub app_id: String,
    pub display_name: String,
    pub normalized_name: String,
    /// `steam` for discovered apps, `custom` for user-added games.
    pub source: String,
    pub artwork: Option<GameImage>,
    pub artwork_error: Option<String>,
    /// Which artwork roles still need a CDN fallback attempt (`header`,
    /// `library_600x900`), or an empty list when nothing is pending.
    pub pending_roles: Vec<String>,
}

/// Per-role artwork file paths (absolute, or cached CDN bytes on disk).
/// Field names keep the legacy underscore roles (`library_600x900`) — no
/// rename, the frontend contract uses them verbatim.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct GameImage {
    pub header: Option<String>,
    pub library_600x900: Option<String>,
    pub library_hero: Option<String>,
    pub library_hero_blur: Option<String>,
    pub logo: Option<String>,
    pub icon: Option<String>,
}

/// One configured process rule for the audio router (mirrors screencap's
/// `[[audio.processes]]`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioProcessConfig {
    pub id: String,
    pub executable: String,
    pub tags: Vec<String>,
    pub include_children: bool,
}

/// One output audio track (mirrors screencap's `[[audio.tracks]]`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrackConfig {
    #[serde(default)]
    pub number: u16,
    #[serde(default)]
    pub name: String,
    /// Selector strings: `all_processes`, `all_nonmuted_processes`,
    /// `source:<id>`, `input:<id>`, `tag:<tag>`.
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

/// The recording profile persisted in SQLite and validated before start.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordingProfile {
    pub duration_seconds: u32,
    pub segment_seconds: u32,
    /// `"primary"` or `"index:N"`.
    pub monitor: String,
    pub fps: u32,
    /// `"auto"`, `"libx264"`, `"h264_nvenc"`, `"h264_amf"`, `"h264_qsv"`.
    pub codec: String,
    pub quality: u8,
    pub cursor: bool,
    pub sample_rate: u32,
    pub channels: u16,
    pub hotkey: String,
    pub output_dir: String,
    pub filename_base: String,
    /// Path to a WAV played after a successful save; empty = none.
    #[serde(default)]
    pub success_sound: String,
    /// `"all"` (all processes) or `"all+mic"` (all processes + microphone).
    pub audio_routing: String,
    #[serde(default)]
    pub processes: Vec<AudioProcessConfig>,
    #[serde(default)]
    pub tracks: Vec<AudioTrackConfig>,
}

impl Default for RecordingProfile {
    fn default() -> Self {
        Self {
            duration_seconds: 30,
            segment_seconds: 1,
            monitor: "primary".to_string(),
            fps: 60,
            codec: "auto".to_string(),
            quality: 23,
            cursor: true,
            sample_rate: 48000,
            channels: 2,
            hotkey: "ctrl+shift+KeyQ".to_string(),
            output_dir: String::new(),
            filename_base: "Replay".to_string(),
            success_sound: String::new(),
            audio_routing: "all".to_string(),
            processes: Vec::new(),
            tracks: vec![AudioTrackConfig {
                number: 1,
                name: "all".to_string(),
                include: vec!["all_processes".to_string()],
                exclude: Vec::new(),
            }],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatePayload {
    pub running: bool,
    pub available_seconds: f64,
    pub target_seconds: u32,
    pub saving: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingProgressPayload {
    pub available_seconds: f64,
    pub target_seconds: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSavedPayload {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryChangedPayload {
    /// Root that changed; `None` means the whole library changed.
    pub root: Option<String>,
    /// `"full"`, `"incremental"`, or `"watcher-error"`.
    pub kind: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgressPayload {
    pub progress: f64,
    pub current_time: f64,
    pub total_duration: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportCompletePayload {
    pub output_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportErrorPayload {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamArtworkUpdatedPayload {
    pub app_id: String,
    pub roles: Vec<String>,
    pub error: Option<String>,
}

/// Result of a delete/rename operation; failures are listed, not fatal.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpResult {
    pub success: Vec<String>,
    pub failed: Vec<String>,
    pub error: Option<String>,
}

/// Result of importing legacy localStorage state (import-only compatibility).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: bool,
    pub warning: Option<String>,
    pub directory: Option<String>,
    pub groups: usize,
    pub assignments: usize,
    pub custom_games: usize,
    pub aliases: usize,
}

/// One skipped Steam library/manifest with the reason (never fails the scan).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanDiagnostic {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub roots: Vec<String>,
    pub clips: usize,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameResult {
    pub old_path: String,
    pub new_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameAlias {
    pub alias: String,
    pub app_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListGamesResult {
    pub games: Vec<SteamGame>,
    pub aliases: Vec<GameAlias>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamDataResult {
    pub games: Vec<SteamGame>,
    pub diagnostics: Vec<ScanDiagnostic>,
    pub aliases: Vec<GameAlias>,
}

pub fn err(operation: &str, message: impl std::fmt::Display) -> String {
    format!("{operation}: {message}")
}
