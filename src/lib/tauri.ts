import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type {
    ExportOptions,
    ExportResult,
    ExportedClip,
    ImportResult,
    ListGamesResult,
    OpResult,
    RecordingProfile,
    RecordingState,
    RenameResult,
    ScanResult,
    SteamDataResult,
    SteamGame,
    VideoFile,
    VideoGroup,
    VideoMetadata,
} from "@/lib/backend/domain";
import {
    onAppActivate,
    onExportComplete,
    onExportError,
    onExportProgress,
    onLibraryChanged,
    onRecordingError,
    onRecordingHealth,
    onRecordingProgress,
    onRecordingSaved,
    onRecordingSaving,
    onRecordingState,
    onSteamArtworkUpdated,
} from "@/lib/backend/events";
import { expectOk } from "@/lib/backend/transport/result";
import { getAppRuntime } from "@/lib/bootstrap/app-runtime";
import { imgSrc, videoSrc } from "@/lib/media-src";

const backend = () => getAppRuntime().backend;

export {
    onAppActivate,
    onExportComplete,
    onExportError,
    onExportProgress,
    onLibraryChanged,
    onRecordingError,
    onRecordingHealth,
    onRecordingProgress,
    onRecordingSaved,
    onRecordingSaving,
    onRecordingState,
    onSteamArtworkUpdated,
    videoSrc,
    imgSrc,
};

/** Pick a single file (WAV for the save-success sound). */
export async function selectFile(): Promise<string | null> {
    const dialog = await import("@tauri-apps/plugin-dialog");
    return dialog.open({ multiple: false });
}

export function selectDirectory(): Promise<string | null> {
    return backend().library.selectDirectory().then(expectOk);
}

export function addLibraryRoot(path: string): Promise<ScanResult> {
    return backend().library.addRoot(path).then(expectOk);
}

export function scanLibrary(): Promise<ScanResult> {
    return backend().library.scan().then(expectOk);
}

export function getLibraryRoots(): Promise<string[]> {
    return backend().library.getRoots().then(expectOk);
}

export function getClips(): Promise<VideoFile[]> {
    return backend().clips.list().then(expectOk);
}

export function getClipMetadata(path: string): Promise<VideoMetadata> {
    return backend().clips.metadata(path).then(expectOk);
}

export function getThumbnail(path: string): Promise<string> {
    return backend().clips.thumbnail(path).then(expectOk);
}

export function getPlayableVideo(path: string): Promise<string> {
    return backend().clips.playableVideo(path).then(expectOk);
}

export function getWaveform(
    path: string,
    sampleCount?: number,
    audioTrack?: number
): Promise<number[]> {
    return backend()
        .clips.waveform(path, sampleCount, audioTrack)
        .then(expectOk);
}

export function deleteClips(paths: string[]): Promise<OpResult> {
    return backend().clips.remove(paths).then(expectOk);
}

export function renameClip(
    path: string,
    newGameName: string
): Promise<RenameResult> {
    return backend().clips.rename(path, newGameName).then(expectOk);
}

export function showInFolder(path: string): Promise<void> {
    return backend().clips.reveal(path).then(expectOk);
}

export function openFile(path: string): Promise<void> {
    return backend().clips.open(path).then(expectOk);
}

export function removeLibraryRoot(path: string): Promise<void> {
    return backend().library.removeRoot(path).then(expectOk);
}

export function exportClip(
    path: string,
    options: ExportOptions
): Promise<ExportResult> {
    return backend().clips.export(path, options).then(expectOk);
}

export function getPreviousExports(path: string): Promise<ExportedClip[]> {
    return backend().clips.previousExports(path).then(expectOk);
}

export function removeExport(outputPath: string): Promise<void> {
    return backend().clips.removeExport(outputPath).then(expectOk);
}

export function copyFileToClipboard(path: string): Promise<void> {
    return backend().clips.copyToClipboard(path).then(expectOk);
}

export function listGroups(): Promise<VideoGroup[]> {
    return backend().groups.list().then(expectOk);
}

export function createGroup(
    name: string,
    color?: string | null
): Promise<VideoGroup> {
    return backend().groups.create(name, color).then(expectOk);
}

export function deleteGroup(id: string): Promise<void> {
    return backend().groups.remove(id).then(expectOk);
}

export function getGroupClips(groupId: string): Promise<VideoFile[]> {
    return backend().groups.clips(groupId).then(expectOk);
}

export function assignClipsToGroup(
    clipPaths: string[],
    groupId: string
): Promise<void> {
    return backend().groups.assign(clipPaths, groupId).then(expectOk);
}

export function removeClipsFromGroup(
    clipPaths: string[],
    groupId: string
): Promise<void> {
    return backend().groups.unassign(clipPaths, groupId).then(expectOk);
}

export function importLegacyState(path?: string | null): Promise<ImportResult> {
    return backend().legacy.importState(path).then(expectOk);
}

export function startReplayBuffer(): Promise<void> {
    return backend().recording.start().then(expectOk);
}

export function saveReplay(): Promise<void> {
    return backend().recording.save().then(expectOk);
}

export function stopReplayBuffer(): Promise<void> {
    return backend().recording.stop().then(expectOk);
}

export function getRecordingState(): Promise<RecordingState> {
    return backend().recording.state().then(expectOk);
}

export function getRecordingProfile(): Promise<RecordingProfile> {
    return backend().recording.profile().then(expectOk);
}

export function setRecordingProfile(profile: RecordingProfile): Promise<void> {
    return backend().recording.setProfile(profile).then(expectOk);
}

export function refreshSteamData(): Promise<SteamDataResult> {
    return backend().steam.refresh().then(expectOk);
}

export function getGames(): Promise<ListGamesResult> {
    return backend().steam.listGames().then(expectOk);
}

export function refreshSteamArtwork(appId: string): Promise<void> {
    return backend().steam.refreshArtwork(appId).then(expectOk);
}

export function addCustomGame(name: string): Promise<SteamGame> {
    return backend().steam.addCustomGame(name).then(expectOk);
}

export function removeCustomGame(appId: string): Promise<void> {
    return backend().steam.removeCustomGame(appId).then(expectOk);
}

export function setCustomGameImage(
    appId: string,
    role: string,
    pathOrUrl: string
): Promise<void> {
    return backend()
        .steam.setCustomImage(appId, role, pathOrUrl)
        .then(expectOk);
}

export function setGameAlias(alias: string, appId: string): Promise<void> {
    return backend().steam.setAlias(alias, appId).then(expectOk);
}

export function removeGameAlias(alias: string): Promise<void> {
    return backend().steam.removeAlias(alias).then(expectOk);
}

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

export { convertFileSrc };
