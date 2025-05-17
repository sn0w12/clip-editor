import { contextBridge, ipcRenderer } from "electron";
import { VideoFile } from "@/types/video";

/**
 * Start watching a directory for new video files
 * @param directoryPath Directory path to watch
 * @returns Promise that resolves to true if successful
 */
export async function watchDirectory(directoryPath: string): Promise<boolean> {
    return await ipcRenderer.invoke("videos:watch-directory", directoryPath);
}

/**
 * Stop watching a directory
 * @param directoryPath Directory path to stop watching
 * @returns Promise that resolves to true if successful
 */
export async function stopWatchingDirectory(
    directoryPath: string,
): Promise<boolean> {
    return await ipcRenderer.invoke("videos:stop-watching", directoryPath);
}

/**
 * Register a callback to be called when a new video is found
 * @param callback Function to call when a new video is found
 * @returns Function to unregister the callback
 */
export function onNewVideoFound(
    callback: (videoFile: VideoFile) => void,
): () => void {
    const handler = (_: Electron.IpcRendererEvent, videoFile: VideoFile) => {
        callback(videoFile);
    };

    ipcRenderer.on("videos:new-video-found", handler);

    return () => {
        ipcRenderer.removeListener("videos:new-video-found", handler);
    };
}

export function exposeDirectoryWatcherContext() {
    contextBridge.exposeInMainWorld("directoryWatcher", {
        watchDirectory,
        stopWatchingDirectory,
        onNewVideoFound,
    });
}
