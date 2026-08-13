//! Settings defaults. The keys and values mirror the legacy `src/config.ts`
//! `APP_SETTINGS` so SQLite import keeps the same contract; v0.4 adds
//! `launchOnStartup` and `startReplayBufferOnStartup`.

/// (key, JSON-encoded value) pairs seeded on first run and restored by reset.
pub fn default_settings() -> Vec<(String, String)> {
    let s = |key: &str, value: serde_json::Value| (key.to_string(), value.to_string());
    vec![
        s("theme", serde_json::json!("system")),
        s(
            "steamDirectory",
            serde_json::json!("C:\\Program Files (x86)\\Steam"),
        ),
        s("defaultAudioTrack", serde_json::json!("0")),
        s("defaultExportFormat", serde_json::json!("mp4")),
        s("defaultExportQuality", serde_json::json!("medium")),
        s("chooseExportLocation", serde_json::json!(false)),
        s("alwaysCopyExport", serde_json::json!(false)),
        s("seekIncrement", serde_json::json!(5)),
        s("holdSpeed", serde_json::json!(2)),
        s("launchOnStartup", serde_json::json!(true)),
        s("startReplayBufferOnStartup", serde_json::json!(true)),
        s("shortcut_toggleSidebar", serde_json::json!("Ctrl+B")),
        s(
            "shortcut_goToNextVideo",
            serde_json::json!("Ctrl+Shift+ARROWRIGHT"),
        ),
        s(
            "shortcut_goToPreviousVideo",
            serde_json::json!("Ctrl+Shift+ARROWLEFT"),
        ),
        s("shortcut_selectAll", serde_json::json!("Ctrl+A")),
        s("shortcut_selectNone", serde_json::json!("Ctrl+D")),
        s("shortcut_selectInvert", serde_json::json!("Ctrl+I")),
        s("shortcut_continueSelection", serde_json::json!("Shift")),
        s("shortcut_pauseVideo", serde_json::json!("Space")),
        s("shortcut_toggleFullscreen", serde_json::json!("F")),
        s("shortcut_muteSound", serde_json::json!("M")),
        s("shortcut_volumeUp", serde_json::json!("ARROWUP")),
        s("shortcut_volumeDown", serde_json::json!("ARROWDOWN")),
        s("shortcut_skipForward", serde_json::json!("ARROWRIGHT")),
        s("shortcut_skipBackward", serde_json::json!("ARROWLEFT")),
        s("shortcut_skipToStart", serde_json::json!("Ctrl+ARROWLEFT")),
        s("shortcut_skipToEnd", serde_json::json!("Ctrl+ARROWRIGHT")),
        s(
            "shortcut_skipToStartMarker",
            serde_json::json!("Shift+ARROWLEFT"),
        ),
        s(
            "shortcut_skipToEndMarker",
            serde_json::json!("Shift+ARROWRIGHT"),
        ),
        s("shortcut_setStartMarker", serde_json::json!("Ctrl+J")),
        s("shortcut_setEndMarker", serde_json::json!("Ctrl+L")),
        s("shortcut_addCut", serde_json::json!("Ctrl+K")),
        s("shortcut_setEndCut", serde_json::json!("Ctrl+Shift+K")),
        s("shortcut_exportClip", serde_json::json!("Ctrl+E")),
    ]
}

/// Typed convenience accessors used by the backend.
pub mod keys {
    pub const LAUNCH_ON_STARTUP: &str = "launchOnStartup";
    pub const START_REPLAY_BUFFER_ON_STARTUP: &str = "startReplayBufferOnStartup";
    pub const STEAM_DIRECTORY: &str = "steamDirectory";
}
