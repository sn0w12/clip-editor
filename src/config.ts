import { setTheme } from "./helpers/theme-helpers";
import { Setting } from "./utils/settings";

/**
 * Configuration object for the Electron application.
 * @property {string} name - The display name of the application.
 * @property {string} protocolName - The custom protocol name used for deep linking.
 * @property {boolean} useLoadingWindow - Whether to display a loading window during application startup.
 * @property {object} selectionOverlay - Configuration for the selection overlay.
 */
export const APP_CONFIG = {
    name: "Clip Editor",
    protocolName: "clip-editor",
    repo: "sn0w12/clip-editor",
    useLoadingWindow: true,
    selectionOverlay: {
        border: {
            width: "2px",
            style: "dashed",
            color: "var(--primary)",
        },
        background: {
            color: "color-mix(in srgb, var(--primary) 10%, transparent)",
        },
        borderRadius: "0.5rem",
        zIndex: 50,
    },
};

/**
 * Application settings configuration with categorized groups
 */
export const APP_SETTINGS = {
    general: {
        label: "General",
        settings: {
            theme: {
                label: "Theme",
                type: "select",
                options: [
                    { label: "Light", value: "light" },
                    { label: "Dark", value: "dark" },
                    { label: "System", value: "system" },
                ],
                default: "system",
                onChange: (value) => {
                    setTheme(value as "light" | "dark" | "system");
                },
                description: "Choose the theme for the application",
                groups: ["Appearance"],
            },
            purgeWaveformCache: {
                label: "Purge Waveform Cache",
                type: "button",
                default: "Purge",
                confirmation:
                    "Are you sure you want to clear the waveform cache?",
                confirmPositive: false,
                onClick: () => {
                    window.audioWaveform.clearWaveformCache();
                },
                description:
                    "Clear the waveform cache to free up disk space and regenerate waveforms.",
                groups: ["Cache"],
            },
            windowIconsStyle: {
                label: "Window Controls Style",
                type: "select",
                options: [
                    { label: "Custom", value: "custom" },
                    { label: "Traditional", value: "traditional" },
                ],
                default: "custom",
                description:
                    "Choose between custom or traditional window control icons",
                groups: ["Appearance"],
            },
            steamDirectory: {
                label: "Steam Directory",
                type: "directory",
                default: "C:\\Program Files (x86)\\Steam",
                description: "Path to your Steam installation directory",
            },
            positiveAccentColor: {
                label: "Positive Accent Color",
                type: "color",
                default: "#74c4c9",
                description:
                    "Choose the positive accent color for the application",
                groups: ["Appearance", "Color"],
            },
            warningAccentColor: {
                label: "Warning Accent Color",
                type: "color",
                default: "#f6b93b",
                description:
                    "Choose the warning accent color for the application",
                groups: ["Appearance", "Color"],
            },
            negativeAccentColor: {
                label: "Negative Accent Color",
                type: "color",
                default: "#f72650",
                description:
                    "Choose the negative accent color for the application",
                groups: ["Appearance", "Color"],
            },
        },
    },
    editor: {
        label: "Editor",
        settings: {
            defaultAudioTrack: {
                label: "Default Audio Track",
                type: "select",
                options: [
                    { label: "Track 1", value: "0" },
                    { label: "Track 2", value: "1" },
                    { label: "Track 3", value: "2" },
                    { label: "Track 4", value: "3" },
                    { label: "Track 5", value: "4" },
                ],
                default: "0",
                description:
                    "Choose the default audio track for video playback",
            },
            defaultExportFormat: {
                label: "Default Export Format",
                type: "select",
                options: [
                    { label: "MP4 (H.264)", value: "mp4" },
                    { label: "WebM", value: "webm" },
                    { label: "GIF", value: "gif" },
                ],
                default: "mp4",
                description: "Default format when exporting clips",
                groups: ["Export"],
            },
            defaultExportQuality: {
                label: "Default Export Quality",
                type: "select",
                options: [
                    { label: "Low", value: "low" },
                    { label: "Medium", value: "medium" },
                    { label: "High", value: "high" },
                    { label: "Original", value: "original" },
                ],
                default: "medium",
                description: "Default quality setting when exporting clips",
                groups: ["Export"],
            },
            chooseExportLocation: {
                label: "Choose Export Location",
                type: "checkbox",
                default: false,
                description: "Enable custom export location",
                groups: ["Export"],
            },
            alwaysCopyExport: {
                label: "Always Copy Export",
                type: "checkbox",
                default: false,
                description:
                    "Enable automatic copying of the exported file to clipboard",
                groups: ["Export"],
            },
            seekIncrement: {
                label: "Seek Increment",
                type: "slider",
                min: 1,
                max: 60,
                default: "5",
                step: 1,
                description:
                    "Set the time increment for skip forward/backward buttons",
                groups: ["Playback"],
            },
            holdSpeed: {
                label: "Hold Speed",
                type: "slider",
                min: 1,
                max: 10,
                default: "2",
                step: 0.1,
                description:
                    "Set the speed multiplier when holding down the video",
                groups: ["Playback"],
            },
        },
    },
    shortcuts: {
        label: "Shortcuts",
        settings: {
            toggleSidebar: {
                label: "Toggle Sidebar",
                type: "shortcut",
                default: "Ctrl+B",
                description: "Shortcut to toggle the sidebar.",
                groups: ["UI Control"],
            },
            goToNextVideo: {
                label: "Go to Next Video",
                type: "shortcut",
                default: "Ctrl+Shift+ARROWRIGHT",
                description: "Shortcut to navigate to the next video.",
                groups: ["UI Control", "Navigation"],
            },
            goToPreviousVideo: {
                label: "Go to Previous Video",
                type: "shortcut",
                default: "Ctrl+Shift+ARROWLEFT",
                description: "Shortcut to navigate to the previous video.",
                groups: ["UI Control", "Navigation"],
            },
            selectAll: {
                label: "Select All",
                type: "shortcut",
                default: "Ctrl+A",
                description: "Shortcut to select all.",
                groups: ["Selection"],
            },
            selectNone: {
                label: "Select None",
                type: "shortcut",
                default: "Ctrl+D",
                description: "Shortcut to deselect all.",
                groups: ["Selection"],
            },
            selectInvert: {
                label: "Select Invert",
                type: "shortcut",
                default: "Ctrl+I",
                description: "Shortcut to invert selection.",
                groups: ["Selection"],
            },
            continueSelection: {
                label: "Continue Selection",
                type: "shortcut",
                default: "Shift",
                description: "Shortcut to continue selection.",
                groups: ["Selection", "Drag"],
                allowOverlap: ["selectBetween"],
            },
            selectBetween: {
                label: "Select Between",
                type: "shortcut",
                default: "Shift",
                description: "Shortcut to select between two items.",
                groups: ["Selection", "Click"],
                allowOverlap: ["continueSelection"],
            },
            pauseVideo: {
                label: "Pause Video",
                type: "shortcut",
                default: "Space",
                description: "Shortcut to pause the video.",
                groups: ["Playback"],
            },
            toggleFullscreen: {
                label: "Toggle Fullscreen",
                type: "shortcut",
                default: "F",
                description: "Shortcut to toggle fullscreen mode.",
                groups: ["Playback"],
            },
            muteSound: {
                label: "Mute Sound",
                type: "shortcut",
                default: "M",
                description: "Shortcut to toggle sound mute.",
                groups: ["Playback", "Audio"],
            },
            volumeUp: {
                label: "Volume Up",
                type: "shortcut",
                default: "ARROWUP",
                description: "Shortcut to increase volume.",
                groups: ["Playback", "Audio"],
            },
            volumeDown: {
                label: "Volume Down",
                type: "shortcut",
                default: "ARROWDOWN",
                description: "Shortcut to decrease volume.",
                groups: ["Playback", "Audio"],
            },
            skipForward: {
                label: "Skip Forward",
                type: "shortcut",
                default: "ARROWRIGHT",
                description: "Shortcut to skip forward in the video.",
                groups: ["Playback", "Navigation"],
            },
            skipBackward: {
                label: "Skip Backward",
                type: "shortcut",
                default: "ARROWLEFT",
                description: "Shortcut to skip backward in the video.",
                groups: ["Playback", "Navigation"],
            },
            skipToStart: {
                label: "Skip to Start",
                type: "shortcut",
                default: "Ctrl+ARROWLEFT",
                description: "Shortcut to skip to the start of the video.",
                groups: ["Playback", "Navigation"],
            },
            skipToEnd: {
                label: "Skip to End",
                type: "shortcut",
                default: "Ctrl+ARROWRIGHT",
                description: "Shortcut to skip to the end of the video.",
                groups: ["Playback", "Navigation"],
            },
            skipToStartMarker: {
                label: "Skip to Start Marker",
                type: "shortcut",
                default: "Shift+ARROWLEFT",
                description:
                    "Shortcut to skip to the start marker of the video.",
                groups: ["Playback", "Navigation"],
            },
            skipToEndMarker: {
                label: "Skip to End Marker",
                type: "shortcut",
                default: "Shift+ARROWRIGHT",
                description: "Shortcut to skip to the end marker of the video.",
                groups: ["Playback", "Navigation"],
            },
            setStartMarker: {
                label: "Set Start Marker",
                type: "shortcut",
                default: "Ctrl+J",
                description: "Shortcut to set the start marker in the video.",
                groups: ["Editing"],
            },
            setEndMarker: {
                label: "Set End Marker",
                type: "shortcut",
                default: "Ctrl+L",
                description: "Shortcut to set the end marker in the video.",
                groups: ["Editing"],
            },
            addCut: {
                label: "Cut Here",
                type: "shortcut",
                default: "Ctrl+K",
                description:
                    "Shortcut to start cutting the video at the current position.",
                groups: ["Editing"],
            },
            setEndCut: {
                label: "Set End Cut",
                type: "shortcut",
                default: "Ctrl+Shift+K",
                description:
                    "Shortcut to set the end of the cut at the current position.",
                groups: ["Editing"],
            },
            exportClip: {
                label: "Export Clip",
                type: "shortcut",
                default: "Ctrl+E",
                description: "Shortcut to export the current clip.",
                groups: ["Editing"],
            },
        },
    },
    search: {
        label: "Search",
        settings: {
            settingsSearch: {
                customRender: true,
            },
        },
    },
    about: {
        label: "About",
        settings: {
            appInfo: {
                customRender: true,
            },
        },
    },
} as const satisfies {
    [key: string]: {
        label: string;
        settings: {
            [key: string]: Setting | { customRender: boolean };
        };
    };
};
