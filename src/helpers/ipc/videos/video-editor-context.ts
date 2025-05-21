import { contextBridge, ipcRenderer } from "electron";
import {
    ExportedClip,
    ExportOptions,
    VideoMetadata,
} from "@/types/video-editor";

/**
 * Exposes video editor-related functionality to the renderer process
 */
export function exposeVideoEditorContext() {
    contextBridge.exposeInMainWorld("videoEditor", {
        /**
         * Get metadata of a video file
         */
        getVideoMetadata: async (
            videoPath: string,
        ): Promise<VideoMetadata | null> => {
            return ipcRenderer.invoke("video-editor:get-metadata", videoPath);
        },

        /**
         * Export a clip from a video
         */
        exportClip: async (
            videoPath: string,
            options: ExportOptions,
        ): Promise<{
            success: boolean;
            outputPath?: string;
            error?: string;
        }> => {
            return ipcRenderer.invoke(
                "video-editor:export-clip",
                videoPath,
                options,
            );
        },

        copyFileToClipboard: (
            filePath: string,
        ): Promise<{ success: boolean; error?: string }> =>
            ipcRenderer.invoke("video-editor:copy-file-to-clipboard", filePath),

        getPreviousExports: (videoPath: string): Promise<ExportedClip[]> =>
            ipcRenderer.invoke("video-editor:get-previous-exports", videoPath),
    });
}
