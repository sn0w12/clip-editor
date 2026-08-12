//! Human-readable documentation of every configuration key, printed by
//! `screencap keys` so users never have to guess key names or defaults.

struct KeyDoc {
    path: &'static str,
    kind: &'static str,
    default: &'static str,
    notes: &'static str,
}

const KEYS: &[KeyDoc] = &[
    KeyDoc { path: "replay.duration_seconds", kind: "u32", default: "30", notes: "Buffer length in seconds, 1..=3600" },
    KeyDoc { path: "replay.segment_seconds", kind: "u32", default: "1", notes: "Rolling segment length, 1..=10 and <= duration_seconds" },
    KeyDoc { path: "replay.output_dir", kind: "path", default: "captures", notes: "Where saved replays are written" },
    KeyDoc { path: "replay.filename_base", kind: "string", default: "Replay", notes: "Saved files are <base> <date> <time>_<window-title>.mp4; no Windows-invalid characters, no trailing space/period" },
    KeyDoc { path: "replay.monitor", kind: "string", default: "primary", notes: "\"primary\" or \"index:<one-based-index>\"" },
    KeyDoc { path: "replay.fps", kind: "u32", default: "60", notes: "Capture frame rate, 1..=240; the capture cost scales with this" },
    KeyDoc { path: "replay.hotkey", kind: "string", default: "ctrl+shift+KeyQ", notes: "Global hotkey, e.g. \"shift+alt+KeyQ\", \"ctrl+F12\"" },
    KeyDoc { path: "replay.success_sound", kind: "string", default: "—", notes: "Path to a WAV file played after a clip is saved; omit for no sound" },
    KeyDoc { path: "replay.buffer_dir", kind: "path", default: "system temp", notes: "Optional rolling-buffer location; omit to use the system temp directory (fast system drive) automatically — the save dir may sit on a slow secondary disk" },
    KeyDoc { path: "video.codec", kind: "string", default: "auto", notes: "\"auto\" probes the working hardware encoder (nvenc → amf → qsv, else libx264); explicit choices \"libx264\", \"h264_nvenc\", \"h264_amf\", or \"h264_qsv\" are verified against the resolved FFmpeg at startup" },
    KeyDoc { path: "video.quality", kind: "u8", default: "23", notes: "libx264 CRF / nvenc CQ / amf QP / qsv global quality, 0..=51" },
    KeyDoc { path: "video.cursor", kind: "bool", default: "true", notes: "Capture the cursor" },
    KeyDoc { path: "audio.sample_rate", kind: "u32", default: "48000", notes: "Mixed output rate, 8000..=384000" },
    KeyDoc { path: "audio.channels", kind: "u16", default: "2", notes: "Mixed output channels, 1..=8" },
    KeyDoc { path: "audio.block_ms", kind: "u32", default: "20", notes: "Mixing window, 1..=250" },
    KeyDoc { path: "audio.processes[].id", kind: "string", default: "—", notes: "Unique id referenced by source:<id> selectors" },
    KeyDoc { path: "audio.processes[].executable", kind: "string", default: "—", notes: "Executable file name, matched case-insensitively (see `screencap processes`)" },
    KeyDoc { path: "audio.processes[].tags", kind: "string[]", default: "[]", notes: "Routing tags; \"muted\" excludes the app from all_nonmuted_processes (never touches system volume)" },
    KeyDoc { path: "audio.processes[].include_children", kind: "bool", default: "true", notes: "Capture the process tree" },
    KeyDoc { path: "audio.inputs[].id", kind: "string", default: "—", notes: "Unique id referenced by input:<id> selectors" },
    KeyDoc { path: "audio.inputs[].kind", kind: "string", default: "—", notes: "\"microphone\"" },
    KeyDoc { path: "audio.inputs[].device", kind: "string", default: "—", notes: "\"default\" or the exact device name" },
    KeyDoc { path: "audio.tracks[].number", kind: "u16", default: "—", notes: ">= 1, unique; stored as screencap_track stream metadata" },
    KeyDoc { path: "audio.tracks[].name", kind: "string", default: "—", notes: "Stream title in the Matroska output" },
    KeyDoc { path: "audio.tracks[].include", kind: "selector[]", default: "—", notes: "ORed selectors: all_processes, all_nonmuted_processes, source:<id>, input:<id>, tag:<tag>" },
    KeyDoc { path: "audio.tracks[].exclude", kind: "selector[]", default: "[]", notes: "Subtracted after include" },
];

/// Render the key reference for `screencap keys`.
pub fn print_keys() -> String {
    let mut out = String::new();
    out.push_str("Configuration keys (TOML; SCREENCAP_* environment variables override, using __ for nesting):\n\n");
    for key in KEYS {
        out.push_str(&format!(
            "{:<34} {:<10} default: {:<10} {}\n",
            key.path, key.kind, key.default, key.notes
        ));
    }
    out.push_str("\nEnvironment example: SCREENCAP_REPLAY__DURATION_SECONDS=60 overrides replay.duration_seconds.\n");
    out
}
