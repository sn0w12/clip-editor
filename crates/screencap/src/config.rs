//! Typed configuration: Figment extraction with embedded defaults, conditional
//! file merge, environment overrides, and semantic validation of the whole
//! contract (ranges, selector grammar, uniqueness).

use std::path::{Path, PathBuf};

use figment::providers::{Env, Format, Toml};
use figment::Figment;
use serde::Deserialize;

use crate::error::ConfigError;
pub use crate::video::MonitorSpec;

/// The embedded default configuration used when no config file exists: a
/// single track with all process audio, no per-app routing. See
/// [`SAMPLE_CONFIG`] (written by `init --example`) for the full multi-track
/// routing example.
pub const MINIMAL_CONFIG: &str = r#"[replay]
duration_seconds = 30
segment_seconds = 1
output_dir = "captures"
filename_base = "Replay"
monitor = "primary"
fps = 60
hotkey = "ctrl+shift+KeyQ"

[video]
codec = "auto"
quality = 23
cursor = true

[audio]
sample_rate = 48000
channels = 2
block_ms = 20

[[audio.tracks]]
number = 1
name = "all"
include = ["all_processes"]
exclude = []
"#;

/// The complete multi-track routing example (Spotify/browser muted, Discord
/// on track 2, microphone on track 3, everything else on track 5). Written by
/// `init --example` and documented in the README.
pub const SAMPLE_CONFIG: &str = r#"[replay]
duration_seconds = 30
segment_seconds = 1
output_dir = "captures"
filename_base = "Replay"
monitor = "primary"
fps = 60
hotkey = "ctrl+shift+KeyQ"
# Optional: rolling buffer location. Omit it to use the system temp directory
# (normally the fast system drive) automatically; set it to force a specific
# disk, e.g. buffer_dir = "D:\\screencap-buffer".

[video]
codec = "auto"
quality = 23
cursor = true

[audio]
sample_rate = 48000
channels = 2
block_ms = 20

[[audio.processes]]
id = "spotify"
executable = "Spotify.exe"
tags = ["muted"]
include_children = true

[[audio.processes]]
id = "browser"
executable = "chrome.exe"
tags = ["muted"]
include_children = true

[[audio.processes]]
id = "discord"
executable = "Discord.exe"
tags = ["tracked"]
include_children = true

[[audio.inputs]]
id = "mic"
kind = "microphone"
device = "default"

[[audio.tracks]]
number = 1
name = "other"
include = ["all_processes"]
exclude = ["tag:muted", "tag:tracked"]

[[audio.tracks]]
number = 2
name = "discord"
include = ["source:discord"]
exclude = []

[[audio.tracks]]
number = 3
name = "mic"
include = ["input:mic"]
exclude = []

[[audio.tracks]]
number = 5
name = "non_muted"
include = ["all_nonmuted_processes"]
exclude = []
"#;

/// The validated configuration consumed by the rest of the program.
#[derive(Debug, Clone)]
pub struct Config {
    pub replay: ReplayConfig,
    pub video: VideoConfig,
    pub audio: AudioConfig,
}

#[derive(Debug, Clone)]
pub struct ReplayConfig {
    pub duration_seconds: u32,
    pub segment_seconds: u32,
    pub output_dir: PathBuf,
    pub filename_base: String,
    pub monitor: MonitorSpec,
    pub fps: u32,
    pub hotkey: String,
    /// Path to a WAV played after a successful save; `None` for no sound.
    pub success_sound: Option<String>,
    /// Where the rolling buffer lives; `None` picks the system temp directory
    /// (normally the fast system drive) automatically.
    pub buffer_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoCodec {
    /// Probe the hardware encoders the resolved FFmpeg actually initializes on
    /// this machine (NVIDIA, then AMD, then Intel) and fall back to `libx264`.
    Auto,
    LibX264,
    H264Nvenc,
    /// AMD AMF; requires an AMD GPU with the AMF runtime installed.
    H264Amf,
    /// Intel Quick Sync; requires an Intel GPU with the MFX runtime.
    H264Qsv,
}

impl VideoCodec {
    pub fn ffmpeg_name(&self) -> &'static str {
        match self {
            VideoCodec::Auto => "auto",
            VideoCodec::LibX264 => "libx264",
            VideoCodec::H264Nvenc => "h264_nvenc",
            VideoCodec::H264Amf => "h264_amf",
            VideoCodec::H264Qsv => "h264_qsv",
        }
    }

    /// Resolve `Auto` against the FFmpeg binary; explicit choices pass through.
    ///
    /// `has_encoder` only proves an encoder is compiled into FFmpeg — a
    /// hardware encoder is listed even when its vendor's GPU is absent. Each
    /// candidate is therefore probed with a one-frame encode so users without
    /// an NVIDIA GPU pick a *working* hardware encoder (AMF on AMD, QSV on
    /// Intel) instead of being pushed onto the CPU.
    pub fn resolve(self, ffmpeg: &Path) -> Result<VideoCodec, crate::error::MediaError> {
        match self {
            VideoCodec::Auto => {
                const CANDIDATES: [(VideoCodec, &str); 3] = [
                    (VideoCodec::H264Nvenc, "h264_nvenc"),
                    (VideoCodec::H264Amf, "h264_amf"),
                    (VideoCodec::H264Qsv, "h264_qsv"),
                ];
                for (codec, name) in CANDIDATES {
                    if crate::media::ffmpeg::has_encoder(ffmpeg, name)?
                        && crate::media::ffmpeg::probe_encoder(ffmpeg, name)
                    {
                        return Ok(codec);
                    }
                }
                Ok(VideoCodec::LibX264)
            }
            other => Ok(other),
        }
    }
}

#[derive(Debug, Clone)]
pub struct VideoConfig {
    pub codec: VideoCodec,
    /// libx264 CRF / nvenc CQ, validated to 0..=51.
    pub quality: u8,
    pub cursor: bool,
}

#[derive(Debug, Clone)]
pub struct AudioConfig {
    pub sample_rate: u32,
    pub channels: u16,
    pub block_ms: u32,
    pub processes: Vec<ProcessRule>,
    pub inputs: Vec<InputRule>,
    pub tracks: Vec<ResolvedTrack>,
}

/// A configured application audio source (process tree by executable name).
#[derive(Debug, Clone)]
pub struct ProcessRule {
    pub id: String,
    pub executable: String,
    pub tags: Vec<String>,
    pub include_children: bool,
}

/// A configured input device (currently only microphones).
#[derive(Debug, Clone)]
pub struct InputRule {
    pub id: String,
    pub kind: InputKind,
    pub device: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    Microphone,
}

impl InputKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            InputKind::Microphone => "microphone",
        }
    }
}

/// A track definition with parsed selectors. `include` is ORed; `exclude`
/// subtracts afterwards.
#[derive(Debug, Clone)]
pub struct ResolvedTrack {
    pub number: u16,
    pub name: String,
    pub include: Vec<Selector>,
    pub exclude: Vec<Selector>,
}

/// A parsed track selector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selector {
    AllProcesses,
    AllNonMutedProcesses,
    /// `source:<configured-process-id>`
    Source(String),
    /// `input:<configured-input-id>`
    Input(String),
    /// `tag:<configured-tag>`
    Tag(String),
}

impl Selector {
    pub fn describe(&self) -> String {
        match self {
            Selector::AllProcesses => "all_processes".to_string(),
            Selector::AllNonMutedProcesses => "all_nonmuted_processes".to_string(),
            Selector::Source(id) => format!("source:{id}"),
            Selector::Input(id) => format!("input:{id}"),
            Selector::Tag(tag) => format!("tag:{tag}"),
        }
    }
}


#[derive(Debug, Deserialize)]
struct RawConfig {
    #[serde(default)]
    replay: RawReplay,
    #[serde(default)]
    video: RawVideo,
    #[serde(default)]
    audio: RawAudio,
}

#[derive(Debug, Deserialize)]
struct RawReplay {
    #[serde(default = "default_duration")]
    duration_seconds: u32,
    #[serde(default = "default_segment")]
    segment_seconds: u32,
    #[serde(default = "default_output_dir")]
    output_dir: PathBuf,
    #[serde(default = "default_filename_base")]
    filename_base: String,
    #[serde(default = "default_monitor")]
    monitor: String,
    #[serde(default = "default_fps")]
    fps: u32,
    #[serde(default = "default_hotkey")]
    hotkey: String,
    #[serde(default)]
    success_sound: Option<String>,
    #[serde(default)]
    buffer_dir: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct RawVideo {
    #[serde(default = "default_codec")]
    codec: String,
    #[serde(default = "default_quality")]
    quality: u8,
    #[serde(default = "default_cursor")]
    cursor: bool,
}

#[derive(Debug, Deserialize)]
struct RawAudio {
    #[serde(default = "default_sample_rate")]
    sample_rate: u32,
    #[serde(default = "default_channels")]
    channels: u16,
    #[serde(default = "default_block_ms")]
    block_ms: u32,
    #[serde(default)]
    processes: Vec<RawProcessRule>,
    #[serde(default)]
    inputs: Vec<RawInputRule>,
    #[serde(default)]
    tracks: Vec<RawTrack>,
}

#[derive(Debug, Deserialize)]
struct RawProcessRule {
    #[serde(default)]
    id: String,
    #[serde(default)]
    executable: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default = "default_include_children")]
    include_children: bool,
}

#[derive(Debug, Deserialize)]
struct RawInputRule {
    #[serde(default)]
    id: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    device: String,
}

#[derive(Debug, Deserialize)]
struct RawTrack {
    #[serde(default)]
    number: u16,
    #[serde(default)]
    name: String,
    #[serde(default)]
    include: Vec<String>,
    #[serde(default)]
    exclude: Vec<String>,
}

fn default_duration() -> u32 {
    30
}
fn default_segment() -> u32 {
    1
}
fn default_output_dir() -> PathBuf {
    PathBuf::from("captures")
}
fn default_filename_base() -> String {
    "Replay".to_string()
}
fn default_monitor() -> String {
    "primary".to_string()
}
fn default_fps() -> u32 {
    60
}
fn default_hotkey() -> String {
    "ctrl+shift+KeyQ".to_string()
}
fn default_codec() -> String {
    "auto".to_string()
}
fn default_quality() -> u8 {
    23
}
fn default_cursor() -> bool {
    true
}
fn default_sample_rate() -> u32 {
    48000
}
fn default_channels() -> u16 {
    2
}
fn default_block_ms() -> u32 {
    20
}
fn default_include_children() -> bool {
    true
}

impl Default for RawReplay {
    fn default() -> Self {
        RawReplay {
            duration_seconds: default_duration(),
            segment_seconds: default_segment(),
            output_dir: default_output_dir(),
            filename_base: default_filename_base(),
            monitor: default_monitor(),
            fps: default_fps(),
            hotkey: default_hotkey(),
            success_sound: None,
            buffer_dir: None,
        }
    }
}

impl Default for RawVideo {
    fn default() -> Self {
        RawVideo { codec: default_codec(), quality: default_quality(), cursor: default_cursor() }
    }
}

impl Default for RawAudio {
    fn default() -> Self {
        RawAudio {
            sample_rate: default_sample_rate(),
            channels: default_channels(),
            block_ms: default_block_ms(),
            processes: Vec::new(),
            inputs: Vec::new(),
            tracks: Vec::new(),
        }
    }
}


/// The default configuration path: `<platform config dir>/screencap/config.toml`
/// (e.g. `%APPDATA%\screencap\config.toml` on Windows).
pub fn default_config_path() -> PathBuf {
    directories::ProjectDirs::from("", "", "screencap")
        .map(|dirs| {
            // ProjectDirs appends a `config` component; the app's own folder
            // holds the file directly.
            dirs.config_dir()
                .parent()
                .map(|p| p.join("config.toml"))
                .unwrap_or_else(|| dirs.config_dir().join("config.toml"))
        })
        .unwrap_or_else(|| PathBuf::from("screencap.toml"))
}

impl Config {
    /// Load, extract, and validate the configuration.
    ///
    /// A missing file is created with the embedded defaults so the config is
    /// always discoverable and editable. Precedence (later providers override
    /// earlier ones): embedded defaults, the file at `path` (when it exists),
    /// then `SCREENCAP_`-prefixed environment variables using `__` as a key
    /// separator.
    pub fn load(path: Option<&Path>) -> Result<Config, ConfigError> {
        let path = match path {
            Some(p) => p.to_path_buf(),
            None => default_config_path(),
        };
        if !path.exists() {
            tracing::info!(path = %path.display(), "creating default configuration");
            write_config(&path, MINIMAL_CONFIG)?;
        }
        let mut figment = Figment::new().merge(Toml::string(MINIMAL_CONFIG));
        if path.exists() {
            figment = figment.merge(Toml::file(&path));
        }
        figment = figment.merge(Env::prefixed("SCREENCAP_").split("__"));
        Config::from_figment(figment)
    }

    /// Extract and validate from an already-assembled Figment (used by tests).
    pub fn from_figment(figment: Figment) -> Result<Config, ConfigError> {
        let raw: RawConfig = figment.extract()?;
        raw.validate()
    }

    /// One-line-ish human summary for `validate`.
    pub fn describe(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "replay: {}s buffer, {}s segments, output `{}`, base `{}`, monitor {}, {} fps, hotkey `{}`\n",
            self.replay.duration_seconds,
            self.replay.segment_seconds,
            self.replay.output_dir.display(),
            self.replay.filename_base,
            self.replay.monitor.describe(),
            self.replay.fps,
            self.replay.hotkey
        ));
        out.push_str(&format!(
            "buffer: {} (auto: system temp)\n",
            self.replay.resolved_buffer_dir().display()
        ));
        out.push_str(&format!(
            "video: codec {}, quality {}, cursor {}\n",
            self.video.codec.ffmpeg_name(),
            self.video.quality,
            if self.video.cursor { "on" } else { "off" }
        ));
        out.push_str(&format!(
            "audio: {} Hz, {} ch, {} ms blocks\n",
            self.audio.sample_rate, self.audio.channels, self.audio.block_ms
        ));
        for p in &self.audio.processes {
            let tags = if p.tags.is_empty() {
                "no tags".to_string()
            } else {
                p.tags.join(",")
            };
            out.push_str(&format!(
                "process source `{}`: {} (children: {}, tags: {})\n",
                p.id, p.executable, p.include_children, tags
            ));
        }
        for i in &self.audio.inputs {
            out.push_str(&format!("input source `{}`: {} on `{}`\n", i.id, i.kind.as_str(), i.device));
        }
        for t in &self.audio.tracks {
            let incl: Vec<String> = t.include.iter().map(|s| s.describe()).collect();
            let excl: Vec<String> = t.exclude.iter().map(|s| s.describe()).collect();
            out.push_str(&format!(
                "track {} `{}`: include [{}] exclude [{}]\n",
                t.number,
                t.name,
                incl.join(", "),
                excl.join(", ")
            ));
        }
        out
    }
}


impl RawConfig {
    fn validate(self) -> Result<Config, ConfigError> {
        let fail = |msg: String| Err(ConfigError::Validation(msg));

        // replay ranges
        if !(1..=3600).contains(&self.replay.duration_seconds) {
            return fail(format!(
                "replay.duration_seconds must be between 1 and 3600, got {}",
                self.replay.duration_seconds
            ));
        }
        if !(1..=10).contains(&self.replay.segment_seconds) {
            return fail(format!(
                "replay.segment_seconds must be between 1 and 10, got {}",
                self.replay.segment_seconds
            ));
        }
        if self.replay.segment_seconds > self.replay.duration_seconds {
            return fail(format!(
                "replay.segment_seconds ({}) must not exceed replay.duration_seconds ({})",
                self.replay.segment_seconds, self.replay.duration_seconds
            ));
        }
        if !(1..=240).contains(&self.replay.fps) {
            return fail(format!("replay.fps must be between 1 and 240, got {}", self.replay.fps));
        }
        if self.replay.output_dir.as_os_str().is_empty() {
            return fail("replay.output_dir must not be empty".to_string());
        }

        // filename base: nonempty, no Windows-invalid characters, no trailing
        // space or period. Reject rather than silently rewrite.
        let base = &self.replay.filename_base;
        if base.is_empty() {
            return fail("replay.filename_base must not be empty".to_string());
        }
        if base.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()) {
            return fail(format!(
                "replay.filename_base contains Windows-invalid characters: `{base}`"
            ));
        }
        if base.ends_with(' ') || base.ends_with('.') {
            return fail(format!(
                "replay.filename_base must not end in a space or period: `{base}`"
            ));
        }

        // monitor
        let monitor =
            MonitorSpec::parse(&self.replay.monitor).map_err(ConfigError::Validation)?;

        // hotkey (standard global-hotkey syntax or extended keys such as
        // ContextMenu)
        crate::hotkey::parse_hotkey_extended(&self.replay.hotkey)
            .map_err(ConfigError::Validation)?;

        // video
        let codec = match self.video.codec.as_str() {
            "auto" => VideoCodec::Auto,
            "libx264" => VideoCodec::LibX264,
            "h264_nvenc" => VideoCodec::H264Nvenc,
            "h264_amf" => VideoCodec::H264Amf,
            "h264_qsv" => VideoCodec::H264Qsv,
            other => {
                return fail(format!(
                    "video.codec must be `auto`, `libx264`, `h264_nvenc`, `h264_amf`, or \
                     `h264_qsv`, got `{other}`"
                ))
            }
        };
        if self.video.quality > 51 {
            return fail(format!(
                "video.quality must be between 0 and 51, got {}",
                self.video.quality
            ));
        }

        // audio basics
        if !(8000..=384_000).contains(&self.audio.sample_rate) {
            return fail(format!(
                "audio.sample_rate must be between 8000 and 384000, got {}",
                self.audio.sample_rate
            ));
        }
        if !(1..=8).contains(&self.audio.channels) {
            return fail(format!(
                "audio.channels must be between 1 and 8, got {}",
                self.audio.channels
            ));
        }
        if !(1..=250).contains(&self.audio.block_ms) {
            return fail(format!(
                "audio.block_ms must be between 1 and 250, got {}",
                self.audio.block_ms
            ));
        }

        // process rules
        let mut process_ids: Vec<String> = Vec::new();
        let mut processes = Vec::new();
        for p in &self.audio.processes {
            validate_id(&p.id, "audio.processes[].id")?;
            validate_executable(&p.executable)?;
            for tag in &p.tags {
                validate_tag(tag)?;
            }
            if process_ids.iter().any(|id| id == &p.id) {
                return fail(format!("duplicate audio.processes[].id: `{}`", p.id));
            }
            process_ids.push(p.id.clone());
            processes.push(ProcessRule {
                id: p.id.clone(),
                executable: p.executable.clone(),
                tags: p.tags.clone(),
                include_children: p.include_children,
            });
        }

        // input rules
        let mut input_ids: Vec<String> = Vec::new();
        let mut inputs = Vec::new();
        for i in &self.audio.inputs {
            validate_id(&i.id, "audio.inputs[].id")?;
            if i.kind != "microphone" {
                return fail(format!(
                    "audio.inputs[].kind must be `microphone`, got `{}`",
                    i.kind
                ));
            }
            if i.device.is_empty() {
                return fail(format!("audio.inputs[].device must not be empty for `{}`", i.id));
            }
            if input_ids.iter().any(|id| id == &i.id) {
                return fail(format!("duplicate audio.inputs[].id: `{}`", i.id));
            }
            input_ids.push(i.id.clone());
            inputs.push(InputRule { id: i.id.clone(), kind: InputKind::Microphone, device: i.device.clone() });
        }

        // all configured tags (from process rules)
        let configured_tags: Vec<&str> = self
            .audio
            .processes
            .iter()
            .flat_map(|p| p.tags.iter().map(|t| t.as_str()))
            .collect();

        // tracks
        let mut track_numbers: Vec<u16> = Vec::new();
        let mut tracks = Vec::new();
        for t in &self.audio.tracks {
            if t.number == 0 {
                return fail("audio.tracks[].number must be >= 1 (0 is reserved)".to_string());
            }
            if track_numbers.iter().any(|n| n == &t.number) {
                return fail(format!("duplicate audio.tracks[].number: {}", t.number));
            }
            track_numbers.push(t.number);
            if t.name.is_empty() {
                return fail(format!("audio.tracks[].name must not be empty for track {}", t.number));
            }
            if t.name.chars().any(|c| c.is_control()) {
                return fail(format!(
                    "audio.tracks[].name contains control characters for track {}",
                    t.number
                ));
            }
            if t.include.is_empty() {
                return fail(format!("track {} has no selectors in include", t.number));
            }
            let include = t
                .include
                .iter()
                .map(|s| parse_selector(s, &process_ids, &input_ids, &configured_tags))
                .collect::<Result<Vec<Selector>, String>>()
                .map_err(ConfigError::Validation)?;
            let exclude = t
                .exclude
                .iter()
                .map(|s| parse_selector(s, &process_ids, &input_ids, &configured_tags))
                .collect::<Result<Vec<Selector>, String>>()
                .map_err(ConfigError::Validation)?;
            tracks.push(ResolvedTrack { number: t.number, name: t.name.clone(), include, exclude });
        }

        if tracks.is_empty() {
            return fail("audio.tracks must define at least one track".to_string());
        }

        Ok(Config {
            replay: ReplayConfig {
                duration_seconds: self.replay.duration_seconds,
                segment_seconds: self.replay.segment_seconds,
                output_dir: self.replay.output_dir,
                filename_base: self.replay.filename_base,
                monitor,
                fps: self.replay.fps,
                hotkey: self.replay.hotkey,
                success_sound: validated_success_sound(self.replay.success_sound)?,
                buffer_dir: validated_buffer_dir(self.replay.buffer_dir)?,
            },
            video: VideoConfig { codec, quality: self.video.quality, cursor: self.video.cursor },
            audio: AudioConfig {
                sample_rate: self.audio.sample_rate,
                channels: self.audio.channels,
                block_ms: self.audio.block_ms,
                processes,
                inputs,
                tracks,
            },
        })
    }
}

/// A success-sound path must be nonempty when present.
fn validated_success_sound(sound: Option<String>) -> Result<Option<String>, ConfigError> {
    match sound {
        Some(s) if s.trim().is_empty() => Err(ConfigError::Validation(
            "replay.success_sound must be a file path, not empty".to_string(),
        )),
        other => Ok(other),
    }
}

/// An explicit buffer dir must be nonempty when present; `None` is fine and
/// resolves to the system temp directory at runtime.
fn validated_buffer_dir(dir: Option<PathBuf>) -> Result<Option<PathBuf>, ConfigError> {
    match dir {
        Some(d) if d.as_os_str().is_empty() => Err(ConfigError::Validation(
            "replay.buffer_dir must be a directory path, not empty".to_string(),
        )),
        other => Ok(other),
    }
}

impl ReplayConfig {
    /// Where the rolling buffer lives: `replay.buffer_dir` when set, else the
    /// system temp directory — normally the fast system drive, unlike a save
    /// dir that may point at a slow secondary disk. A per-process subdir keeps
    /// concurrent instances from colliding in the shared temp root.
    pub fn resolved_buffer_dir(&self) -> PathBuf {
        match &self.buffer_dir {
            Some(dir) => dir.clone(),
            None => std::env::temp_dir().join(format!("screencap-buffer-{}", std::process::id())),
        }
    }
}

fn validate_id(id: &str, what: &str) -> Result<(), ConfigError> {    if id.is_empty() {
        return Err(ConfigError::Validation(format!("{what} must not be empty")));
    }
    if id.chars().any(|c| c == ':' || c.is_whitespace() || c.is_control()) {
        return Err(ConfigError::Validation(format!(
            "{what} contains invalid characters (no `:`, whitespace, or control chars): `{id}`"
        )));
    }
    Ok(())
}

fn validate_executable(exe: &str) -> Result<(), ConfigError> {
    if exe.is_empty() {
        return Err(ConfigError::Validation(
            "audio.processes[].executable must not be empty".to_string(),
        ));
    }
    if exe.contains('/') || exe.contains('\\') {
        return Err(ConfigError::Validation(format!(
            "audio.processes[].executable must be a file name, not a path: `{exe}`"
        )));
    }
    Ok(())
}

fn validate_tag(tag: &str) -> Result<(), ConfigError> {
    if tag.is_empty() {
        return Err(ConfigError::Validation("process rule tags must not be empty".to_string()));
    }
    if tag.chars().any(|c| c == ':' || c.is_whitespace() || c.is_control()) {
        return Err(ConfigError::Validation(format!(
            "tag contains invalid characters (no `:`, whitespace, or control chars): `{tag}`"
        )));
    }
    Ok(())
}

fn parse_selector(
    s: &str,
    process_ids: &[String],
    input_ids: &[String],
    configured_tags: &[&str],
) -> Result<Selector, String> {
    match s {
        "all_processes" => Ok(Selector::AllProcesses),
        "all_nonmuted_processes" => Ok(Selector::AllNonMutedProcesses),
        _ => {
            if let Some(id) = s.strip_prefix("source:") {
                if !id.is_empty() && process_ids.iter().any(|p| p == id) {
                    return Ok(Selector::Source(id.to_string()));
                }
                return Err(format!("unknown configured process id in selector `{s}`"));
            }
            if let Some(id) = s.strip_prefix("input:") {
                if !id.is_empty() && input_ids.iter().any(|p| p == id) {
                    return Ok(Selector::Input(id.to_string()));
                }
                return Err(format!("unknown configured input id in selector `{s}`"));
            }
            if let Some(tag) = s.strip_prefix("tag:") {
                if !tag.is_empty() && configured_tags.iter().any(|t| *t == tag) {
                    return Ok(Selector::Tag(tag.to_string()));
                }
                return Err(format!("unknown tag in selector `{s}`"));
            }
            Err(format!(
                "unknown selector `{s}`; expected all_processes, all_nonmuted_processes, \
                 source:<process-id>, input:<input-id>, or tag:<tag>"
            ))
        }
    }
}


/// Write a configuration file, failing if the destination already exists.
pub fn write_config(path: &Path, content: &str) -> Result<(), ConfigError> {
    if path.exists() {
        return Err(ConfigError::Validation(format!(
            "refusing to overwrite existing configuration at {}",
            path.display()
        )));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ConfigError::Validation(format!("cannot create {}: {e}", parent.display())))?;
    }
    std::fs::write(path, content)
        .map_err(|e| ConfigError::Validation(format!("cannot write {}: {e}", path.display())))
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::SystemTime;

    /// Serializes tests that mutate process-global environment variables.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn temp_dir(tag: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("screencap_test_{tag}_{}_{}", std::process::id(), stamp));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn clear_screencap_env() {
        // Collect first, then remove: mutating the process environment while
        // iterating `std::env::vars()` corrupts the env block on Windows.
        let keys: Vec<String> = std::env::vars()
            .filter(|(k, _)| k.starts_with("SCREENCAP_"))
            .map(|(k, _)| k)
            .collect();
        for k in keys {
            unsafe { std::env::remove_var(&k) };
        }
    }

    fn load_from_str(toml: &str) -> Result<Config, ConfigError> {
        // All tests that read the environment (load applies SCREENCAP_ env
        // overrides) must run under the lock so parallel test threads cannot
        // observe each other's env mutations.
        let _guard = ENV_LOCK.lock();
        clear_screencap_env();
        let dir = temp_dir("cfg");
        let path = dir.join("config.toml");
        std::fs::write(&path, toml).unwrap();
        let result = Config::load(Some(&path));
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    #[test]
    fn buffer_dir_is_optional_and_validated() {
        // omitted -> auto (None)
        assert!(load_from_str("[replay]\nfps = 30\n").unwrap().replay.buffer_dir.is_none());
        // explicit path passes through
        let cfg = load_from_str("[replay]\nbuffer_dir = \"D:\\\\screencap-buffer\"\n").unwrap();
        assert_eq!(
            cfg.replay.buffer_dir.as_deref(),
            Some(std::path::Path::new("D:\\screencap-buffer"))
        );
        // empty is rejected
        assert!(load_from_str("[replay]\nbuffer_dir = \"\"\n").is_err());
        // resolved default is a per-process subdir of the system temp
        let cfg = load_from_str("[replay]\nfps = 30\n").unwrap();
        let resolved = cfg.replay.resolved_buffer_dir();
        assert_eq!(resolved.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            resolved.file_name().unwrap().to_string_lossy().starts_with("screencap-buffer-"),
            "auto buffer dir is per-process: {resolved:?}"
        );
    }

    #[test]
    fn success_sound_is_optional_path() {
        assert!(load_from_str("[replay]\nsuccess_sound = \"\"\n").is_err());
        assert_eq!(
            load_from_str("[replay]\nsuccess_sound = \"C:/sounds/save.wav\"\n")
                .unwrap()
                .replay
                .success_sound
                .as_deref(),
            Some("C:/sounds/save.wav")
        );
        // omitted -> no sound
        assert!(load_from_str("[replay]\nfps = 30\n").unwrap().replay.success_sound.is_none());
    }

    #[test]
    fn embedded_defaults_load() {
        let _guard = ENV_LOCK.lock();
        clear_screencap_env();
        let dir = temp_dir("defaults");
        let path = dir.join("missing.toml");
        // path does not exist: embedded defaults must apply
        let cfg = Config::load(Some(&path)).unwrap();
        assert_eq!(cfg.replay.duration_seconds, 30);
        assert_eq!(cfg.replay.segment_seconds, 1);
        assert_eq!(cfg.replay.filename_base, "Replay");
        assert_eq!(cfg.replay.fps, 60);
        assert_eq!(cfg.replay.monitor, MonitorSpec::Primary);
        assert_eq!(cfg.video.codec, VideoCodec::Auto);
        assert_eq!(cfg.video.quality, 23);
        assert!(cfg.video.cursor);
        assert_eq!(cfg.audio.sample_rate, 48000);
        assert_eq!(cfg.audio.channels, 2);
        assert_eq!(cfg.audio.block_ms, 20);
        assert_eq!(cfg.audio.processes.len(), 0, "minimal default has no process rules");
        assert_eq!(cfg.audio.inputs.len(), 0, "minimal default has no inputs");
        assert_eq!(cfg.audio.tracks.len(), 1);
        assert_eq!(cfg.audio.tracks[0].number, 1);
        assert_eq!(cfg.audio.tracks[0].name, "all");
        assert_eq!(cfg.audio.tracks[0].include, vec![Selector::AllProcesses]);
        assert!(cfg.replay.success_sound.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_creates_missing_config_file() {
        let _guard = ENV_LOCK.lock();
        clear_screencap_env();
        let dir = temp_dir("autocreate");
        let path = dir.join("nested").join("config.toml");
        assert!(!path.exists());
        let cfg = Config::load(Some(&path)).unwrap();
        assert_eq!(cfg.replay.fps, 60);
        // The file is written so the user can find and edit it.
        assert!(path.exists(), "missing config should be auto-created");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), MINIMAL_CONFIG);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_overrides_embedded_defaults_keywise() {
        let cfg = load_from_str(
            r#"
[replay]
duration_seconds = 60
fps = 30
"#,
        )
        .unwrap();
        assert_eq!(cfg.replay.duration_seconds, 60);
        assert_eq!(cfg.replay.fps, 30);
        // untouched keys keep embedded defaults
        assert_eq!(cfg.replay.segment_seconds, 1);
        assert_eq!(cfg.replay.filename_base, "Replay");
        assert_eq!(cfg.replay.hotkey, "ctrl+shift+KeyQ");
        assert_eq!(cfg.audio.sample_rate, 48000);
    }

    #[test]
    fn env_overrides_file_and_defaults() {
        let _guard = ENV_LOCK.lock();
        clear_screencap_env();
        let dir = temp_dir("env");
        let path = dir.join("config.toml");
        std::fs::write(&path, "[replay]\nduration_seconds = 60\n").unwrap();
        unsafe {
            std::env::set_var("SCREENCAP_REPLAY__DURATION_SECONDS", "120");
            std::env::set_var("SCREENCAP_REPLAY__FPS", "144");
        }
        let cfg = Config::load(Some(&path)).unwrap();
        unsafe {
            std::env::remove_var("SCREENCAP_REPLAY__DURATION_SECONDS");
            std::env::remove_var("SCREENCAP_REPLAY__FPS");
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(cfg.replay.duration_seconds, 120);
        assert_eq!(cfg.replay.fps, 144);
    }

    #[test]
    fn malformed_toml_names_offending_key() {
        let err = load_from_str("[replay]\nduration_seconds = \"not a number\"\n").unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("duration_seconds"),
            "error should name the offending key, got: {msg}"
        );
        assert!(matches!(err, ConfigError::Figment(_)), "expected a Figment error");
    }

    #[test]
    fn malformed_toml_syntax_is_figment_error() {
        let err = load_from_str("[replay\nduration_seconds = 30\n").unwrap_err();
        assert!(matches!(err, ConfigError::Figment(_)), "expected a Figment error");
    }

    #[test]
    fn validates_ranges() {
        assert!(load_from_str("[replay]\nduration_seconds = 0\n").is_err());
        assert!(load_from_str("[replay]\nduration_seconds = 3601\n").is_err());
        assert!(load_from_str("[replay]\nsegment_seconds = 11\n").is_err());
        assert!(load_from_str("[replay]\nduration_seconds = 5\nsegment_seconds = 6\n").is_err());
        assert!(load_from_str("[replay]\nfps = 0\n").is_err());
        assert!(load_from_str("[replay]\nfps = 241\n").is_err());
        assert!(load_from_str("[video]\nquality = 52\n").is_err());
        assert!(load_from_str("[audio]\nsample_rate = 100\n").is_err());
        assert!(load_from_str("[audio]\nchannels = 0\n").is_err());
        assert!(load_from_str("[audio]\nblock_ms = 0\n").is_err());
        // boundary values are accepted
        assert!(load_from_str("[replay]\nduration_seconds = 1\nsegment_seconds = 1\n").is_ok());
        assert!(load_from_str("[replay]\nduration_seconds = 3600\n").is_ok());
        assert!(load_from_str("[replay]\nfps = 240\n").is_ok());
        assert!(load_from_str("[video]\nquality = 51\n").is_ok());
    }

    #[test]
    fn validates_filename_base() {
        for bad in ["", "My/Game", "Bad:Name", "Trailing ", "Trailing.", "a*b", "bad?name", "x\"y"] {
            assert!(
                load_from_str(&format!("[replay]\nfilename_base = {bad:?}\n")).is_err(),
                "expected rejection of filename_base {bad:?}"
            );
        }
        assert!(load_from_str("[replay]\nfilename_base = \"Replay Clip\"\n").is_ok());
    }

    #[test]
    fn validates_monitor_spec() {
        assert!(load_from_str("[replay]\nmonitor = \"index:0\"\n").is_err());
        assert!(load_from_str("[replay]\nmonitor = \"index:x\"\n").is_err());
        assert!(load_from_str("[replay]\nmonitor = \"banana\"\n").is_err());
        assert_eq!(
            load_from_str("[replay]\nmonitor = \"index:2\"\n")
                .unwrap()
                .replay
                .monitor,
            MonitorSpec::Index(2)
        );
        assert_eq!(
            load_from_str("[replay]\nmonitor = \"primary\"\n").unwrap().replay.monitor,
            MonitorSpec::Primary
        );
    }

    #[test]
    fn hotkey_parse_failure_is_validation_error() {
        let err = load_from_str("[replay]\nhotkey = \"not a hotkey\"\n").unwrap_err();
        assert!(
            matches!(err, ConfigError::Validation(_)),
            "expected validation error, got: {err}"
        );
        // valid hotkeys parse
        assert!(load_from_str("[replay]\nhotkey = \"shift+alt+KeyQ\"\n").is_ok());
        assert!(load_from_str("[replay]\nhotkey = \"ctrl+F12\"\n").is_ok());
    }

    #[test]
    fn rejects_unknown_codec() {
        let err = load_from_str("[video]\ncodec = \"x265\"\n").unwrap_err();
        assert!(err.to_string().contains("codec"));
    }

    #[test]
    fn selector_validation() {
        // unknown selector literal
        assert!(load_from_str(
            "[[audio.tracks]]\nnumber = 9\nname = \"x\"\ninclude = [\"banana\"]\n"
        )
        .is_err());
        // unknown source id
        assert!(load_from_str(
            "[[audio.tracks]]\nnumber = 9\nname = \"x\"\ninclude = [\"source:missing\"]\n"
        )
        .is_err());
        // unknown input id
        assert!(load_from_str(
            "[[audio.tracks]]\nnumber = 9\nname = \"x\"\ninclude = [\"input:missing\"]\n"
        )
        .is_err());
        // unknown tag
        assert!(load_from_str(
            "[[audio.tracks]]\nnumber = 9\nname = \"x\"\ninclude = [\"tag:nope\"]\n"
        )
        .is_err());
        // track with no selectors
        assert!(load_from_str("[[audio.tracks]]\nnumber = 9\nname = \"x\"\ninclude = []\n").is_err());
        // empty track name
        assert!(load_from_str("[[audio.tracks]]\nnumber = 9\nname = \"\"\ninclude = [\"all_processes\"]\n")
            .is_err());
        // duplicate track number
        assert!(load_from_str(
            "[[audio.tracks]]\nnumber = 1\nname = \"a\"\ninclude = [\"all_processes\"]\n\
             [[audio.tracks]]\nnumber = 1\nname = \"b\"\ninclude = [\"all_processes\"]\n"
        )
        .is_err());
        // track number 0
        assert!(load_from_str("[[audio.tracks]]\nnumber = 0\nname = \"x\"\ninclude = [\"all_processes\"]\n")
            .is_err());
        // duplicate process id
        assert!(load_from_str(
            "[[audio.processes]]\nid = \"a\"\nexecutable = \"a.exe\"\n\
             [[audio.processes]]\nid = \"a\"\nexecutable = \"b.exe\"\n"
        )
        .is_err());
        // executable with path separator
        assert!(load_from_str("[[audio.processes]]\nid = \"a\"\nexecutable = \"C:/a.exe\"\n").is_err());
        // tag with colon
        assert!(load_from_str(
            "[[audio.processes]]\nid = \"a\"\nexecutable = \"a.exe\"\ntags = [\"bad:tag\"]\n"
        )
        .is_err());
        // valid track referring to configured source and tag
        assert!(load_from_str(
            "[[audio.processes]]\nid = \"discord\"\nexecutable = \"Discord.exe\"\ntags = [\"tracked\"]\n\
             [[audio.tracks]]\nnumber = 9\nname = \"d\"\ninclude = [\"source:discord\"]\nexclude = [\"tag:tracked\"]\n"
        )
        .is_ok());
    }

    #[test]
    fn default_path_shape() {
        let p = default_config_path();
        assert!(p.ends_with("screencap") || p.to_string_lossy().contains("screencap"));
        assert!(p.ends_with("config.toml"));
    }

    #[test]
    fn write_config_refuses_overwrite() {
        let dir = temp_dir("init");
        let path = dir.join("config.toml");
        std::fs::write(&path, "existing").unwrap();
        assert!(write_config(&path, MINIMAL_CONFIG).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "existing");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_config_creates_file() {
        let dir = temp_dir("init2");
        let path = dir.join("nested").join("config.toml");
        write_config(&path, MINIMAL_CONFIG).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), MINIMAL_CONFIG);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sample_config_validates_and_writes() {
        // The example routing config must round-trip through validation.
        let dir = temp_dir("example");
        let path = dir.join("config.toml");
        write_config(&path, SAMPLE_CONFIG).unwrap();
        let cfg = Config::load(Some(&path)).unwrap();
        assert_eq!(cfg.audio.processes.len(), 3);
        assert_eq!(cfg.audio.tracks.len(), 4);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
