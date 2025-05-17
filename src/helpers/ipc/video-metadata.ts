import { VideoMetadata } from "@/types/video-editor";

/**
 * Provides methods for video metadata operations
 */
export const videoMetadataIpc = {
    /**
     * Retrieves metadata for a single video
     * @param path Path to the video file
     */
    getVideoMetadata: (path: string): Promise<VideoMetadata | null> => {
        return window.videoEditor.getVideoMetadata(path);
    },

    /**
     * Retrieves metadata for multiple videos in parallel
     * @param paths Array of paths to video files
     * @returns Object mapping video paths to their metadata
     */
    getBatchVideoMetadata: async (
        paths: string[],
    ): Promise<Record<string, VideoMetadata>> => {
        const results: Record<string, VideoMetadata> = {};

        // Process in batches to avoid overloading the system
        const batchSize = 5;
        for (let i = 0; i < paths.length; i += batchSize) {
            const batch = paths.slice(i, i + batchSize);

            // Process this batch in parallel
            const batchResults = await Promise.all(
                batch.map(async (path) => {
                    try {
                        const metadata =
                            await window.videoEditor.getVideoMetadata(path);
                        return { path, metadata };
                    } catch (error) {
                        console.error(
                            `Error loading metadata for ${path}:`,
                            error,
                        );
                        return { path, metadata: null };
                    }
                }),
            );

            // Add successful results to our mapping
            batchResults.forEach(({ path, metadata }) => {
                if (metadata) {
                    results[path] = metadata;
                }
            });
        }

        return results;
    },

    /**
     * Ensures metadata for a video is loaded
     * @param path Video path
     * @param existingMetadata Optional existing metadata store
     * @returns Video metadata if available or newly loaded
     */
    ensureMetadataLoaded: async (
        path: string,
        existingMetadata?: Record<string, VideoMetadata>,
    ): Promise<VideoMetadata | null> => {
        // Check if we already have this metadata
        if (existingMetadata && existingMetadata[path]) {
            return existingMetadata[path];
        }

        // Otherwise load it
        return await window.videoEditor.getVideoMetadata(path);
    },
};
