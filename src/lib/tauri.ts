// Typed Tauri adapter: every privileged operation goes through these wrappers.
// Command args are camelCase (Tauri maps to snake_case Rust params).

import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
    ExportComplete,
    ExportOptions,
    ExportProgress,
    ExportedClip,
    ExportResult,
    ImportResult,
    LibraryChanged,
    ListGamesResult,
    OpResult,
    RecordingProfile,
    RecordingState,
    RenameResult,
    ScanResult,
    SettingsMap,
    SteamArtworkUpdated,
    SteamDataResult,
    SteamGame,
    VideoFile,
    VideoGroup,
    VideoMetadata,
} from "@/types";

export function onLibraryChanged(cb: (payload: LibraryChanged) => void): Promise<UnlistenFn> {
    return listen<LibraryChanged>("library-changed", (e) => cb(e.payload));
}

export function onExportProgress(cb: (payload: ExportProgress) => void): Promise<UnlistenFn> {
    return listen<ExportProgress>("export-progress", (e) => cb(e.payload));
}

export function onExportComplete(cb: (payload: ExportComplete) => void): Promise<UnlistenFn> {
    return listen<ExportComplete>("export-complete", (e) => cb(e.payload));
}

export function onExportError(cb: (payload: { message: string }) => void): Promise<UnlistenFn> {
    return listen<{ message: string }>("export-error", (e) => cb(e.payload));
}

export function onRecordingState(cb: (payload: RecordingState) => void): Promise<UnlistenFn> {
    return listen<RecordingState>("recording-state", (e) => cb(e.payload));
}

export function onRecordingProgress(
    cb: (payload: { availableSeconds: number; targetSeconds: number }) => void,
): Promise<UnlistenFn> {
    return listen<{ availableSeconds: number; targetSeconds: number }>("recording-progress", (e) =>
        cb(e.payload),
    );
}

export function onRecordingSaving(cb: () => void): Promise<UnlistenFn> {
    return listen("recording-saving", () => cb());
}

export function onRecordingSaved(cb: (payload: { path: string }) => void): Promise<UnlistenFn> {
    return listen<{ path: string }>("recording-saved", (e) => cb(e.payload));
}

export function onRecordingError(cb: (payload: { message: string }) => void): Promise<UnlistenFn> {
    return listen<{ message: string }>("recording-error", (e) => cb(e.payload));
}

export function onSteamArtworkUpdated(
    cb: (payload: SteamArtworkUpdated) => void,
): Promise<UnlistenFn> {
    return listen<SteamArtworkUpdated>("steam-artwork-updated", (e) => cb(e.payload));
}

export function onAppActivate(cb: () => void): Promise<UnlistenFn> {
    return listen("app-activate", () => cb());
}

/** Pick a single file (WAV for the save-success sound). */
export function selectFile(): Promise<string | null> {
    return import("@tauri-apps/plugin-dialog").then((dialog) => dialog.open({ multiple: false }));
}

export function selectDirectory(): Promise<string | null> {
    return invoke<string | null>("select_directory");
}

export function addLibraryRoot(path: string): Promise<ScanResult> {
    return invoke<ScanResult>("add_library_root", { path });
}

export function scanLibrary(): Promise<ScanResult> {
    return invoke<ScanResult>("scan_library");
}

export function getLibraryRoots(): Promise<string[]> {
    return invoke<string[]>("get_library_roots");
}

export function getClips(): Promise<VideoFile[]> {
    return invoke<VideoFile[]>("get_clips");
}

export function getClipMetadata(path: string): Promise<VideoMetadata> {
    return invoke<VideoMetadata>("get_clip_metadata", { path });
}

export function getThumbnail(path: string): Promise<string> {
    return invoke<string>("get_thumbnail", { path });
}

export function getPlayableVideo(path: string): Promise<string> {
    return invoke<string>("get_playable_video", { path });
}

export function getWaveform(
    path: string,
    sampleCount?: number,
    audioTrack?: number,
): Promise<number[]> {
    return invoke<number[]>("get_waveform", { path, sampleCount, audioTrack });
}

export function deleteClips(paths: string[]): Promise<OpResult> {
    return invoke<OpResult>("delete_clips", { paths });
}

export function renameClip(path: string, newGameName: string): Promise<RenameResult> {
    return invoke<RenameResult>("rename_clip", { path, newGameName });
}

export function showInFolder(path: string): Promise<void> {
    return invoke("show_in_folder", { path });
}

export function openFile(path: string): Promise<void> {
    return invoke("open_file", { path });
}

export function removeLibraryRoot(path: string): Promise<void> {
    return invoke("remove_library_root", { path });
}

export function exportClip(path: string, options: ExportOptions): Promise<ExportResult> {
    return invoke<ExportResult>("export_clip", { path, options });
}

export function getPreviousExports(path: string): Promise<ExportedClip[]> {
    return invoke<ExportedClip[]>("get_previous_exports", { path });
}

export function removeExport(outputPath: string): Promise<void> {
    return invoke("remove_export", { outputPath });
}

export function copyFileToClipboard(path: string): Promise<void> {
    return invoke("copy_file_to_clipboard", { path });
}

export function listGroups(): Promise<VideoGroup[]> {
    return invoke<VideoGroup[]>("list_groups");
}

export function createGroup(name: string, color?: string | null): Promise<VideoGroup> {
    return invoke<VideoGroup>("create_group", { name, color });
}

export function deleteGroup(id: string): Promise<void> {
    return invoke("delete_group", { id });
}

export function getGroupClips(groupId: string): Promise<VideoFile[]> {
    return invoke<VideoFile[]>("get_group_clips", { groupId });
}

export function assignClipsToGroup(clipPaths: string[], groupId: string): Promise<void> {
    return invoke("assign_clips_to_group", { clipPaths, groupId });
}

export function removeClipsFromGroup(clipPaths: string[], groupId: string): Promise<void> {
    return invoke("remove_clips_from_group", { clipPaths, groupId });
}

export function getSettings(): Promise<SettingsMap> {
    return invoke<SettingsMap>("get_settings");
}

export function setSetting(key: string, value: unknown): Promise<void> {
    return invoke("set_setting", { key, value });
}

export function resetSettings(): Promise<void> {
    return invoke("reset_settings");
}

export function importLegacyState(path?: string | null): Promise<ImportResult> {
    return invoke<ImportResult>("import_legacy_state", { path });
}

export function startReplayBuffer(): Promise<void> {
    return invoke("start_replay_buffer");
}

export function saveReplay(): Promise<void> {
    return invoke("save_replay");
}

export function stopReplayBuffer(): Promise<void> {
    return invoke("stop_replay_buffer");
}

export function getRecordingState(): Promise<RecordingState> {
    return invoke<RecordingState>("get_recording_state");
}

export function getRecordingProfile(): Promise<RecordingProfile> {
    return invoke<RecordingProfile>("get_recording_profile");
}

export function setRecordingProfile(profile: RecordingProfile): Promise<void> {
    return invoke("set_recording_profile", { profile });
}

export function refreshSteamData(): Promise<SteamDataResult> {
    return invoke<SteamDataResult>("refresh_steam_data");
}

export function getGames(): Promise<ListGamesResult> {
    return invoke<ListGamesResult>("get_games");
}

export function refreshSteamArtwork(appId: string): Promise<void> {
    return invoke("refresh_steam_artwork", { appId });
}

export function addCustomGame(name: string): Promise<SteamGame> {
    return invoke<SteamGame>("add_custom_game", { name });
}

export function removeCustomGame(appId: string): Promise<void> {
    return invoke("remove_custom_game", { appId });
}

export function setCustomGameImage(appId: string, role: string, pathOrUrl: string): Promise<void> {
    return invoke("set_custom_game_image", { appId, role, pathOrUrl });
}

export function setGameAlias(alias: string, appId: string): Promise<void> {
    return invoke("set_game_alias", { alias, appId });
}

export function removeGameAlias(alias: string): Promise<void> {
    return invoke("remove_game_alias", { alias });
}

import { getCurrentWindow } from "@tauri-apps/api/window";

export const appWindow = getCurrentWindow();

export function minimizeWindow(): Promise<void> {
    return appWindow.minimize();
}

export function toggleMaximizeWindow(): Promise<void> {
    return appWindow.toggleMaximize();
}

export function closeWindow(): Promise<void> {
    return appWindow.close();
}

export function isWindowMaximized(): Promise<boolean> {
    return appWindow.isMaximized();
}

let mediaServerPort: Promise<number> | null = null;

/** Port of the embedded localhost media server (started in Rust setup). */
function getMediaServerPort(): Promise<number> {
    if (!mediaServerPort) {
        mediaServerPort = invoke<number>("get_media_server_port").catch((e) => {
            mediaServerPort = null;
            throw e;
        });
    }
    return mediaServerPort;
}

/** Local file URL for the `<video>` element. WebView2's intercepted protocols
 * (asset/custom schemes) play video but drop audio, so clips are streamed from
 * the embedded localhost HTTP server, which plays with sound. */
export async function videoSrc(path: string): Promise<string> {
    const port = await getMediaServerPort();
    return `http://127.0.0.1:${port}/${encodeURIComponent(path)}`;
}

/** Local file via the asset protocol (thumbnails, artwork, exports). */
export function imgSrc(path: string): string {
    return convertFileSrc(path);
}

export type { UnlistenFn };
