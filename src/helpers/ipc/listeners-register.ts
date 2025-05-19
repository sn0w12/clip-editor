import { BrowserWindow } from "electron";
import { addThemeEventListeners } from "./theme/theme-listeners";
import { addWindowEventListeners } from "./window/window-listeners";
import { addVideosEventListeners } from "./videos/videos-listeners";
import { addVideoEditorEventListeners } from "./videos/video-editor-listeners";
import { addAudioWaveformListeners } from "./videos/audio-waveform";
import { addSteamEventListeners } from "./steam/steam-listeners";
import { addDirectoryWatcherListeners } from "./videos/directory-watcher";
import { addPerformanceEventListeners } from "./performance/performance-listeners";

export default function registerListeners(mainWindow: BrowserWindow) {
    addWindowEventListeners(mainWindow);
    addThemeEventListeners();
    addVideosEventListeners();
    addVideoEditorEventListeners();
    addAudioWaveformListeners();
    addSteamEventListeners();
    addDirectoryWatcherListeners();
    addPerformanceEventListeners();
}
