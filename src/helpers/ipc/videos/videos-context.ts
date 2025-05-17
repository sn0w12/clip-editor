import { contextBridge, ipcRenderer } from "electron";
import { VideoFile } from "@/types/video";

/**
 * Exposes video-related functionality to the renderer process
 */
export function exposeVideosContext() {
    contextBridge.exposeInMainWorld("videos", {
        /**
         * Opens a directory selection dialog and returns the chosen path
         */
        selectDirectory: async (): Promise<string | null> => {
            return ipcRenderer.invoke("videos:select-directory");
        },

        /**
         * Gets all video files from a specific directory
         */
        getVideosFromDirectory: async (
            directoryPath: string,
        ): Promise<VideoFile[]> => {
            return ipcRenderer.invoke("videos:get-videos", directoryPath);
        },

        /**
         * Gets or generates a thumbnail for a video
         */
        getVideoThumbnail: async (videoPath: string): Promise<string> => {
            return ipcRenderer.invoke("videos:get-thumbnail", videoPath);
        },
    });
}
