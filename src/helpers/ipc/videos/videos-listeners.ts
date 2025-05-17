import { app, dialog, ipcMain } from "electron";
import fs from "fs/promises";
import path from "path";
import { VideoFile } from "@/types/video";
import ffmpeg from "fluent-ffmpeg";
import { promisify } from "util";
import crypto from "crypto";

// Directory to store thumbnails
const THUMBNAIL_DIR = path.join(app.getPath("userData"), "thumbnails");

/**
 * Creates the thumbnails directory if it doesn't exist
 */
async function ensureThumbnailDirectory() {
    try {
        await fs.mkdir(THUMBNAIL_DIR, { recursive: true });
    } catch (error) {
        console.error("Error creating thumbnail directory:", error);
    }
}

/**
 * Generate a thumbnail filename based on the video path
 */
function getThumbnailFilename(videoPath: string): string {
    const hash = crypto.createHash("md5").update(videoPath).digest("hex");
    return `${hash}.jpg`;
}

/**
 * Add video-related event listeners
 */
export function addVideosEventListeners() {
    // Ensure thumbnail directory exists
    ensureThumbnailDirectory();

    // Handle directory selection
    ipcMain.handle("videos:select-directory", async () => {
        const result = await dialog.showOpenDialog({
            properties: ["openDirectory"],
        });

        if (result.canceled) {
            return null;
        }

        return result.filePaths[0];
    });

    // Handle fetching videos from a directory
    ipcMain.handle("videos:get-videos", async (_, directoryPath) => {
        try {
            const files = await fs.readdir(directoryPath);
            const videoFiles: VideoFile[] = [];

            const videoExtensions = [".mp4", ".mov", ".avi", ".mkv", ".webm"];

            for (const file of files) {
                const filePath = path.join(directoryPath, file);
                const stats = await fs.stat(filePath);

                if (
                    stats.isFile() &&
                    videoExtensions.includes(path.extname(file).toLowerCase())
                ) {
                    let game = "Unknown";
                    const parts = file.split("_");
                    if (parts.length > 1) {
                        game = parts[1].split(".")[0];
                    }

                    videoFiles.push({
                        name: file,
                        game: game,
                        path: filePath,
                        size: stats.size,
                        lastModified: stats.mtime.toISOString(),
                    });
                }
            }

            return videoFiles;
        } catch (error) {
            console.error("Error getting videos:", error);
            return [];
        }
    }); // Handle thumbnail generation
    ipcMain.handle("videos:get-thumbnail", async (_, videoPath) => {
        const thumbnailFilename = getThumbnailFilename(videoPath);
        const thumbnailPath = path.join(THUMBNAIL_DIR, thumbnailFilename);

        try {
            // Check if thumbnail already exists
            await fs.access(thumbnailPath);
            // Return just the path to be used with the custom protocol
            return thumbnailPath;
        } catch {
            // Thumbnail doesn't exist, generate it
            try {
                const screenshot = promisify(
                    (
                        input: string,
                        output: string,
                        callback: (error: Error | null) => void,
                    ) => {
                        ffmpeg(input)
                            .screenshots({
                                count: 1,
                                folder: path.dirname(output),
                                filename: path.basename(output),
                                timemarks: ["00:00:02"], // Take screenshot at 2 seconds
                                size: "720x?",
                            })
                            .on("end", () => callback(null))
                            .on("error", (err) => callback(err));
                    },
                );

                await screenshot(videoPath, thumbnailPath);
                // Return just the path to be used with the custom protocol
                return thumbnailPath;
            } catch (thumbnailError) {
                console.error("Error generating thumbnail:", thumbnailError);
                return "";
            }
        }
    });
}
