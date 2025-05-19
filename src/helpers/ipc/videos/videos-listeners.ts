import { app, dialog, ipcMain, shell } from "electron";
import fs from "fs/promises";
import path from "path";
import { VideoFile } from "@/types/video";
import ffmpeg from "@/helpers/ffmpeg";
import { promisify } from "util";
import crypto from "crypto";
import { getWaveformCacheFiles } from "./audio-waveform";
import { createPerformanceLogger } from "@/helpers/performance";

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
        const perfLog = createPerformanceLogger("videos:select-directory");

        perfLog.addStep("showOpenDialog");
        const result = await dialog.showOpenDialog({
            properties: ["openDirectory"],
        });

        perfLog.end({
            canceled: result.canceled,
            hasPath: result.canceled ? false : Boolean(result.filePaths[0]),
        });

        if (result.canceled) {
            return null;
        }

        return result.filePaths[0];
    });

    // Handle fetching videos from a directory
    ipcMain.handle("videos:get-videos", async (_, directoryPath) => {
        const perfLog = createPerformanceLogger("videos:get-videos", {
            directoryPath,
        });

        try {
            perfLog.addStep("readDirectory");
            const files = await fs.readdir(directoryPath);

            perfLog.addStep("processFiles");
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
                        const gameName = parts[1].split(".")[0];
                        // Make sure we don't return an empty string as game name
                        game = gameName.trim() ? gameName : "Unknown";
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

            perfLog.end({
                found: videoFiles.length,
            });

            return videoFiles;
        } catch (error) {
            console.error("Error getting videos:", error);

            perfLog.end({
                error: error instanceof Error ? error.message : "Unknown error",
                success: false,
            });

            return [];
        }
    });

    // Handle thumbnail generation
    ipcMain.handle("videos:get-thumbnail", async (_, videoPath) => {
        const perfLog = createPerformanceLogger("videos:get-thumbnail", {
            videoPath,
        });

        perfLog.addStep("getThumbnailPath");
        const thumbnailFilename = getThumbnailFilename(videoPath);
        const thumbnailPath = path.join(THUMBNAIL_DIR, thumbnailFilename);

        try {
            perfLog.addStep("checkExistingThumbnail");
            // Check if thumbnail already exists
            await fs.access(thumbnailPath);

            perfLog.addStep("returnExistingThumbnail");
            perfLog.end({ fromCache: true });
            // Return just the path to be used with the custom protocol
            return thumbnailPath;
        } catch {
            // Thumbnail doesn't exist, generate it
            try {
                perfLog.addStep("generateNewThumbnail");
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

                perfLog.addStep("returnNewThumbnail");
                perfLog.end({ fromCache: false });
                // Return just the path to be used with the custom protocol
                return thumbnailPath;
            } catch (thumbnailError) {
                console.error("Error generating thumbnail:", thumbnailError);

                perfLog.end({
                    error:
                        thumbnailError instanceof Error
                            ? thumbnailError.message
                            : "Unknown error",
                    success: false,
                });

                return "";
            }
        }
    });

    ipcMain.handle("videos:delete-files", async (_, videoPaths: string[]) => {
        const perfLog = createPerformanceLogger("videos:delete-files", {
            videoPaths,
        });

        const failed: string[] = [];

        try {
            perfLog.addStep("deleteFiles");
            for (const videoPath of videoPaths) {
                try {
                    // Also delete the thumbnail if it exists
                    const thumbnailFilename = getThumbnailFilename(videoPath);
                    const thumbnailPath = path.join(
                        THUMBNAIL_DIR,
                        thumbnailFilename,
                    );

                    try {
                        await fs.access(thumbnailPath);
                        await fs.unlink(thumbnailPath);
                    } catch (error) {
                        // Thumbnail doesn't exist or cannot be deleted, continue anyway
                        console.warn(
                            `Could not delete thumbnail for ${videoPath}:`,
                            error,
                        );
                    }

                    // Delete any waveform cache files
                    const waveformFiles = getWaveformCacheFiles(videoPath);
                    for (const waveformFile of waveformFiles) {
                        try {
                            await fs.unlink(waveformFile);
                        } catch (error) {
                            console.warn(
                                `Could not delete waveform cache file ${waveformFile}:`,
                                error,
                            );
                        }
                    }

                    // Delete the video file
                    await fs.unlink(videoPath);
                } catch (error) {
                    console.error(`Failed to delete ${videoPath}:`, error);
                    failed.push(videoPath);
                }
            }

            const result = {
                success: failed.length === 0,
                failed,
            };

            perfLog.end({
                success: result.success,
                failed,
                totalDeleted: videoPaths.length - failed.length,
            });

            return result;
        } catch (error: unknown) {
            console.error("Error deleting video files:", error);
            const errorMessage =
                error instanceof Error
                    ? error.message
                    : "Unknown error occurred while deleting files";

            const result = {
                success: false,
                failed: videoPaths,
                error: errorMessage,
            };

            perfLog.end(result);

            return result;
        }
    });

    // Handle revealing a file in file explorer
    ipcMain.handle("videos:show-in-folder", (_, filePath: string) => {
        const perfLog = createPerformanceLogger("videos:show-in-folder", {
            filePath,
        });

        try {
            perfLog.addStep("showItemInFolder");
            shell.showItemInFolder(filePath);

            perfLog.end({ success: true });
            return true;
        } catch (error) {
            console.error("Error showing file in folder:", error);

            perfLog.end({
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            });

            return false;
        }
    });

    // Handle renaming a file when game is updated
    ipcMain.handle(
        "videos:rename-file",
        async (_, oldPath: string, newGameName: string) => {
            const perfLog = createPerformanceLogger("videos:rename-file", {
                oldPath,
                newGameName,
            });

            try {
                perfLog.addStep("preparePaths");
                const dirPath = path.dirname(oldPath);
                const fileName = path.basename(oldPath);
                const extension = path.extname(fileName);

                const nameMatch = fileName.match(/^(.+?)_(.+?)(\..+)$/);
                let newFileName;
                if (nameMatch) {
                    // File already has a game - replace it
                    // nameMatch[1] is the prefix with date (e.g., "Replay 2025-05-17 00-39-49")
                    const prefix = nameMatch[1];
                    newFileName = `${prefix}_${newGameName}${extension}`;
                } else {
                    // File doesn't have a game yet - we need to add it
                    // Try to isolate the prefix from the name (assuming it's the filename without extension)
                    const nameWithoutExt = path.basename(fileName, extension);
                    newFileName = `${nameWithoutExt}_${newGameName}${extension}`;
                }

                const newPath = path.join(dirPath, newFileName);
                if (newPath === oldPath) {
                    const result = { success: true, oldPath, newPath };
                    perfLog.end({ ...result, unchanged: true });
                    return result;
                }

                perfLog.addStep("renameFile");
                await fs.rename(oldPath, newPath);

                perfLog.addStep("handleThumbnail");
                // Also rename the thumbnail if it exists
                const thumbnailFilename = getThumbnailFilename(oldPath);
                const newThumbnailFilename = getThumbnailFilename(newPath);
                const thumbnailPath = path.join(
                    THUMBNAIL_DIR,
                    thumbnailFilename,
                );
                const newThumbnailPath = path.join(
                    THUMBNAIL_DIR,
                    newThumbnailFilename,
                );

                try {
                    await fs.access(thumbnailPath);
                    await fs.rename(thumbnailPath, newThumbnailPath);
                } catch (error) {
                    // Thumbnail doesn't exist or can't be renamed, continue anyway
                    console.warn(
                        `Could not rename thumbnail for ${oldPath}:`,
                        error,
                    );
                }

                const result = { success: true, oldPath, newPath };
                perfLog.end(result);
                return result;
            } catch (error) {
                console.error(
                    `Error renaming file from ${oldPath} to game ${newGameName}:`,
                    error,
                );

                const result = {
                    success: false,
                    oldPath,
                    error:
                        error instanceof Error
                            ? error.message
                            : "Unknown error during rename",
                };

                perfLog.end(result);
                return result;
            }
        },
    );
}
