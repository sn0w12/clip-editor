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

        /**
         * Deletes a video file from the filesystem
         */
        deleteVideoFiles: async (
            videoPaths: string[],
        ): Promise<{
            success: boolean;
            failed: string[];
            error?: string;
        }> => {
            return ipcRenderer.invoke("videos:delete-files", videoPaths);
        },

        showInFolder: (videoPath: string) => {
            ipcRenderer.invoke("videos:show-in-folder", videoPath);
        },

        /**
         * Renames a video file when the game is updated
         */
        renameFile: async (
            oldPath: string,
            newGameName: string,
        ): Promise<{
            success: boolean;
            oldPath: string;
            newPath?: string;
            error?: string;
        }> => {
            return ipcRenderer.invoke(
                "videos:rename-file",
                oldPath,
                newGameName,
            );
        },
    });
}
