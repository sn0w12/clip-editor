import { contextBridge, ipcRenderer } from "electron";

/**
 * Exposes audio waveform-related functionality to the renderer process
 */
export function exposeAudioWaveformContext() {
    contextBridge.exposeInMainWorld("audioWaveform", {
        /**
         * Extract waveform data from a video file
         * @param videoPath Path to the video file
         * @param sampleCount Number of samples to extract
         * @param audioTrack Index of the audio track to extract (default: 0)
         * @returns Float32Array of audio data or null on error
         */
        extractWaveform: async (
            videoPath: string,
            sampleCount: number = 1000,
            audioTrack: number = 0,
        ): Promise<Float32Array | null> => {
            return ipcRenderer.invoke(
                "audio:extract-waveform",
                videoPath,
                sampleCount,
                audioTrack,
            );
        },
    });
}
