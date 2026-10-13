/**
 * GENERATED FILE - do not edit by hand.
 *
 * Source of truth: crates/tauri/src/settings/schema.rs
 * Regenerate with: cargo run -p seraphis --bin export_settings
 * Freshness is verified by cargo test (settings::tests::generated_typescript_is_fresh).
 */

export interface SettingsValues {
    theme: "system" | "light" | "dark";
    steamDirectory: string;
    launchOnStartup: boolean;
    startReplayBufferOnStartup: boolean;
    reopenTabsOnLaunch: boolean;
    recentItems: string[];
    defaultExportFormat: "mp4" | "webm" | "mov" | "mkv" | "gif";
    defaultExportQuality: "low" | "medium" | "high" | "veryhigh";
    defaultAudioTrack: string;
    chooseExportLocation: boolean;
    alwaysCopyExport: boolean;
    seekIncrement: number;
    holdSpeed: number;
    pauseVideoShortcut: string;
    toggleFullscreenShortcut: string;
    muteSoundShortcut: string;
    volumeUpShortcut: string;
    volumeDownShortcut: string;
    skipForwardShortcut: string;
    skipBackwardShortcut: string;
    skipToStartShortcut: string;
    skipToEndShortcut: string;
    setStartMarkerShortcut: string;
    setEndMarkerShortcut: string;
    addCutShortcut: string;
    setEndCutShortcut: string;
    exportClipShortcut: string;
    selectAllShortcut: string;
    selectNoneShortcut: string;
    selectInvertShortcut: string;
    continueSelectionShortcut: string;
    goToNextVideoShortcut: string;
    goToPreviousVideoShortcut: string;
    goToSettingsShortcut: string;
    goToClipsShortcut: string;
    openShortcutsHelpShortcut: string;
    newTabShortcut: string;
    closeTabShortcut: string;
    reopenClosedTabShortcut: string;
    nextTabShortcut: string;
    previousTabShortcut: string;
}

export type SettingKey = keyof SettingsValues;
export type ThemeMode = SettingsValues["theme"];

export const SHORTCUT_SETTING_KEYS = [
    "pauseVideoShortcut",
    "toggleFullscreenShortcut",
    "muteSoundShortcut",
    "volumeUpShortcut",
    "volumeDownShortcut",
    "skipForwardShortcut",
    "skipBackwardShortcut",
    "skipToStartShortcut",
    "skipToEndShortcut",
    "setStartMarkerShortcut",
    "setEndMarkerShortcut",
    "addCutShortcut",
    "setEndCutShortcut",
    "exportClipShortcut",
    "selectAllShortcut",
    "selectNoneShortcut",
    "selectInvertShortcut",
    "goToNextVideoShortcut",
    "goToPreviousVideoShortcut",
    "goToSettingsShortcut",
    "goToClipsShortcut",
    "openShortcutsHelpShortcut",
    "newTabShortcut",
    "closeTabShortcut",
    "reopenClosedTabShortcut",
    "nextTabShortcut",
    "previousTabShortcut",
] as const;

export type ShortcutSettingKey = typeof SHORTCUT_SETTING_KEYS[number];
