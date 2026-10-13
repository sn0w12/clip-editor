//! The single place where application settings are declared. Adding a
//! setting here automatically exposes it to persistence, validation, the
//! typed frontend hooks, and (unless hidden) the settings UI.

use super::model::{
    SelectOption, SettingDefinition, SettingType, SettingValue, SettingsSchema, SettingsSection,
    SettingsTab,
};

fn boolean(key: &'static str, label: &'static str) -> SettingDefinition {
    SettingDefinition::new(key, label, SettingType::Boolean)
}

fn select(
    key: &'static str,
    label: &'static str,
    options: &[(&'static str, &'static str)],
) -> SettingDefinition {
    SettingDefinition::new(
        key,
        label,
        SettingType::Select {
            options: options
                .iter()
                .map(|(value, option_label)| SelectOption::new(value, option_label))
                .collect(),
        },
    )
}

fn shortcut(key: &'static str, label: &'static str) -> SettingDefinition {
    SettingDefinition::new(key, label, SettingType::Shortcut)
}

fn string(key: &'static str, label: &'static str) -> SettingDefinition {
    SettingDefinition::new(key, label, SettingType::String)
}

fn string_list(key: &'static str, label: &'static str) -> SettingDefinition {
    SettingDefinition::new(key, label, SettingType::StringList)
}

fn number(
    key: &'static str,
    label: &'static str,
    min: f64,
    max: f64,
    step: f64,
) -> SettingDefinition {
    SettingDefinition::new(
        key,
        label,
        SettingType::Number {
            min: Some(min),
            max: Some(max),
            step: Some(step),
        },
    )
}

/// The builtin settings tree. Hidden entries live alongside visible ones so
/// they persist and validate identically; they are for app state the user
/// never edits by hand.
pub fn builtin() -> SettingsSchema {
    let schema = SettingsSchema {
        tabs: vec![
            SettingsTab {
                id: "general",
                label: "General",
                sections: vec![
                    SettingsSection {
                        id: "appearance",
                        title: "Appearance",
                        settings: vec![select(
                            "theme",
                            "Theme",
                            &[("system", "System"), ("light", "Light"), ("dark", "Dark")],
                        )
                        .description("Color scheme used across the app.")
                        .default_value(SettingValue::Str("system".to_owned()))],
                    },
                    SettingsSection {
                        id: "library",
                        title: "Library",
                        settings: vec![
                            string("steamDirectory", "Steam directory")
                                .description("Steam install root, scanned for games and artwork.")
                                .default_value(SettingValue::Str(
                                    "C:\\Program Files (x86)\\Steam".to_owned(),
                                )),
                            boolean("launchOnStartup", "Launch on startup")
                                .description("Start Seraphis when you sign in.")
                                .default_value(SettingValue::Bool(true)),
                            boolean("startReplayBufferOnStartup", "Start replay buffer on startup")
                                .description("Begin buffering as soon as the app launches.")
                                .default_value(SettingValue::Bool(true)),
                        ],
                    },
                    SettingsSection {
                        id: "behavior",
                        title: "Behavior",
                        settings: vec![boolean("reopenTabsOnLaunch", "Reopen tabs on launch")
                            .description("Restore the previous session's tabs when the app starts.")
                            .default_value(SettingValue::Bool(true))],
                    },
                    SettingsSection {
                        id: "appState",
                        title: "App state",
                        settings: vec![string_list("recentItems", "Recent items")
                            .description("Most recently opened items, newest first. Hidden settings persist and stay readable from code, they are just never rendered.")
                            .default_value(SettingValue::StringList(Vec::new()))
                            .hidden()],
                    },
                ],
            },
            SettingsTab {
                id: "export",
                label: "Export",
                sections: vec![SettingsSection {
                    id: "defaults",
                    title: "Export defaults",
                    settings: vec![
                        select(
                            "defaultExportFormat",
                            "Format",
                            &[
                                ("mp4", "MP4"),
                                ("webm", "WebM"),
                                ("mov", "MOV"),
                                ("mkv", "MKV"),
                                ("gif", "GIF"),
                            ],
                        )
                        .description("Container used when the editor opens.")
                        .default_value(SettingValue::Str("mp4".to_owned())),
                        select(
                            "defaultExportQuality",
                            "Quality",
                            &[
                                ("low", "Low"),
                                ("medium", "Medium"),
                                ("high", "High"),
                                ("veryhigh", "Very high"),
                            ],
                        )
                        .description("Bitrate preset used when the editor opens.")
                        .default_value(SettingValue::Str("medium".to_owned())),
                        string("defaultAudioTrack", "Default audio track")
                            .description("Audio track index pre-selected for exports.")
                            .default_value(SettingValue::Str("0".to_owned())),
                        boolean("chooseExportLocation", "Ask where to save")
                            .description("Prompt for a destination on every export.")
                            .default_value(SettingValue::Bool(false)),
                        boolean("alwaysCopyExport", "Copy exports to clipboard")
                            .description("Copy the finished file to the clipboard automatically.")
                            .default_value(SettingValue::Bool(false)),
                    ],
                }],
            },
            SettingsTab {
                id: "editor",
                label: "Editor",
                sections: vec![
                    SettingsSection {
                        id: "playback",
                        title: "Playback",
                        settings: vec![
                            number("seekIncrement", "Seek step", 1.0, 60.0, 1.0)
                                .description("Seconds moved by a single seek.")
                                .default_value(SettingValue::Number(5.0)),
                            number("holdSpeed", "Hold speed", 1.0, 8.0, 0.5)
                                .description("Playback rate while a speed key is held.")
                                .default_value(SettingValue::Number(2.0)),
                        ],
                    },
                    SettingsSection {
                        id: "shortcuts",
                        title: "Editor shortcuts",
                        settings: vec![
                            shortcut("pauseVideoShortcut", "Play / pause")
                                .default_value(SettingValue::Str("Space".to_owned())),
                            shortcut("toggleFullscreenShortcut", "Toggle fullscreen")
                                .default_value(SettingValue::Str("F".to_owned())),
                            shortcut("muteSoundShortcut", "Mute")
                                .default_value(SettingValue::Str("M".to_owned())),
                            shortcut("volumeUpShortcut", "Volume up")
                                .default_value(SettingValue::Str("ArrowUp".to_owned())),
                            shortcut("volumeDownShortcut", "Volume down")
                                .default_value(SettingValue::Str("ArrowDown".to_owned())),
                            shortcut("skipForwardShortcut", "Skip forward")
                                .default_value(SettingValue::Str("ArrowRight".to_owned())),
                            shortcut("skipBackwardShortcut", "Skip backward")
                                .default_value(SettingValue::Str("ArrowLeft".to_owned())),
                            shortcut("skipToStartShortcut", "Skip to start")
                                .default_value(SettingValue::Str("Mod+ArrowLeft".to_owned())),
                            shortcut("skipToEndShortcut", "Skip to end")
                                .default_value(SettingValue::Str("Mod+ArrowRight".to_owned())),
                            shortcut("setStartMarkerShortcut", "Set start marker")
                                .default_value(SettingValue::Str("Mod+J".to_owned())),
                            shortcut("setEndMarkerShortcut", "Set end marker")
                                .default_value(SettingValue::Str("Mod+L".to_owned())),
                            shortcut("addCutShortcut", "Add cut")
                                .default_value(SettingValue::Str("Mod+K".to_owned())),
                            shortcut("setEndCutShortcut", "Set cut end")
                                .default_value(SettingValue::Str("Mod+Shift+K".to_owned())),
                            shortcut("exportClipShortcut", "Export clip")
                                .default_value(SettingValue::Str("Mod+E".to_owned())),
                        ],
                    },
                ],
            },
            SettingsTab {
                id: "library",
                label: "Library",
                sections: vec![
                    SettingsSection {
                        id: "selection",
                        title: "Selection",
                        settings: vec![
                            shortcut("selectAllShortcut", "Select all")
                                .default_value(SettingValue::Str("Mod+A".to_owned())),
                            shortcut("selectNoneShortcut", "Clear selection")
                                .default_value(SettingValue::Str("Mod+D".to_owned())),
                            shortcut("selectInvertShortcut", "Invert selection")
                                .default_value(SettingValue::Str("Mod+I".to_owned())),
                            string("continueSelectionShortcut", "Extend selection")
                                .description("Modifier held to add to a drag selection.")
                                .default_value(SettingValue::Str("Shift".to_owned())),
                        ],
                    },
                    SettingsSection {
                        id: "navigation",
                        title: "Navigation",
                        settings: vec![
                            shortcut("goToNextVideoShortcut", "Next clip")
                                .default_value(SettingValue::Str(
                                    "Mod+Shift+ArrowRight".to_owned(),
                                )),
                            shortcut("goToPreviousVideoShortcut", "Previous clip")
                                .default_value(SettingValue::Str(
                                    "Mod+Shift+ArrowLeft".to_owned(),
                                )),
                        ],
                    },
                ],
            },
            SettingsTab {
                id: "tabs",
                label: "Tabs",
                sections: vec![SettingsSection {
                    id: "navigation",
                    title: "Navigation",
                    settings: vec![
                        shortcut("goToSettingsShortcut", "Go to Settings")
                            .description("Opens the settings page.")
                            .default_value(SettingValue::Str("Mod+,".to_owned())),
                        shortcut("goToClipsShortcut", "Go to Clips")
                            .description("Returns to the clip library.")
                            .default_value(SettingValue::Str("Mod+Shift+H".to_owned())),
                        shortcut("openShortcutsHelpShortcut", "Open shortcut list")
                            .description("Toggles the keyboard shortcut list.")
                            .default_value(SettingValue::Str("F1".to_owned())),
                        shortcut("newTabShortcut", "New tab")
                            .description("Open a new tab on the clip library.")
                            .default_value(SettingValue::Str("Mod+T".to_owned())),
                        shortcut("closeTabShortcut", "Close tab")
                            .description("Close the active tab.")
                            .default_value(SettingValue::Str("Mod+W".to_owned())),
                        shortcut("reopenClosedTabShortcut", "Reopen closed tab")
                            .description("Reopen the most recently closed tab.")
                            .default_value(SettingValue::Str("Mod+Shift+T".to_owned())),
                        shortcut("nextTabShortcut", "Next tab")
                            .description("Switch to the next tab.")
                            .default_value(SettingValue::Str("Mod+Tab".to_owned())),
                        shortcut("previousTabShortcut", "Previous tab")
                            .description("Switch to the previous tab.")
                            .default_value(SettingValue::Str("Mod+Shift+Tab".to_owned())),
                    ],
                }],
            },
        ],
    };

    if let Err(reason) = schema.validate_invariants() {
        panic!("builtin settings schema invalid: {reason}");
    }
    schema
}
