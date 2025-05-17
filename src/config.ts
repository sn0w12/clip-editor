import { setTheme } from "./helpers/theme-helpers";

/**
 * Configuration object for the Electron application.
 * @property {string} name - The display name of the application.
 * @property {string} protocolName - The custom protocol name used for deep linking.
 * @property {boolean} useLoadingWindow - Whether to display a loading window during application startup.
 */
export const APP_CONFIG = {
    name: "Clip Editor",
    protocolName: "clip-editor",
    useLoadingWindow: false,
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
                onChange: (value: "light" | "dark" | "system") => {
                    setTheme(value);
                },
                description: "Choose the theme for the application",
            },
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
            },
            warningAccentColor: {
                label: "Warning Accent Color",
                type: "color",
                default: "#f6b93b",
                description:
                    "Choose the warning accent color for the application",
            },
            negativeAccentColor: {
                label: "Negative Accent Color",
                type: "color",
                default: "#f72650",
                description:
                    "Choose the negative accent color for the application",
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
            },
            selectAll: {
                label: "Select All",
                type: "shortcut",
                default: "Ctrl+A",
                description: "Shortcut to select all.",
            },
            selectNone: {
                label: "Select None",
                type: "shortcut",
                default: "Ctrl+D",
                description: "Shortcut to deselect all.",
            },
            selectInvert: {
                label: "Select Invert",
                type: "shortcut",
                default: "Ctrl+I",
                description: "Shortcut to invert selection.",
            },
            pauseVideo: {
                label: "Pause Video",
                type: "shortcut",
                default: "Space",
                description: "Shortcut to pause the video.",
            },
        },
    },
    about: {
        label: "About",
        settings: {
            appInfo: {
                type: "button",
                default: "",
                customRender: true,
            },
        },
    },
};
