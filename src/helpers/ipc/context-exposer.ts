import { exposeThemeContext } from "./theme/theme-context";
import { exposeWindowContext } from "./window/window-context";
import { exposeVideosContext } from "./videos/videos-context";
import { exposeVideoEditorContext } from "./videos/video-editor-context";
import { exposeAudioWaveformContext } from "./videos/audio-waveform-context";
import { exposeSteamContext } from "./steam/steam-context";
import { exposeDirectoryWatcherContext } from "./videos/directory-watcher-context";

export default function exposeContexts() {
    exposeWindowContext();
    exposeThemeContext();
    exposeVideosContext();
    exposeVideoEditorContext();
    exposeAudioWaveformContext();
    exposeSteamContext();
    exposeDirectoryWatcherContext();
}
