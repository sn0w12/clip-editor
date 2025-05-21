import { ipcMain, BrowserWindow } from "electron";
import * as chokidar from "chokidar";
import path from "path";
import fs from "fs/promises";
import { VideoFile } from "@/types/video";

// Store active watchers by directory path
const activeWatchers = new Map<string, chokidar.FSWatcher>();

// Common video extensions to watch for
const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
const FILE_PROCESSING_DELAY = 1000;
const pendingFiles = new Map<string, NodeJS.Timeout>();

/**
 * Determines if a file is a video based on its extension
 */
function isVideoFile(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return VIDEO_EXTENSIONS.includes(ext);
}

/**
 * Extract game name from filename (matches the existing pattern in videos-listeners.ts)
 */
function extractGameFromFilename(filename: string): string {
    const parts = filename.split("_");
    if (parts.length > 1) {
        const gameName = parts[1].split(".")[0];
        // Make sure we don't return an empty string as game name
        return gameName.trim() ? gameName : "Unknown";
    }
    return "Unknown";
}

/**
 * Add directory watcher event listeners
 */
export function addDirectoryWatcherListeners() {
    // Start watching a directory
    ipcMain.handle("videos:watch-directory", async (_, directoryPath) => {
        // Stop any existing watcher for this directory
        if (activeWatchers.has(directoryPath)) {
            await stopWatcher(directoryPath);
        }

        try {
            // Create a new watcher
            const watcher = chokidar.watch(directoryPath, {
                ignored: /(^|[/\\])\../, // ignore dotfiles
                persistent: true,
                ignoreInitial: true, // don't fire add events for existing files
            });

            // Store the watcher
            activeWatchers.set(directoryPath, watcher);

            // Setup event handlers
            const mainWindow = BrowserWindow.getAllWindows()[0];

            watcher.on("add", (filePath) => {
                if (
                    isVideoFile(filePath) &&
                    path.dirname(filePath) === directoryPath
                ) {
                    // Cancel any existing timer for this file
                    if (pendingFiles.has(filePath)) {
                        clearTimeout(pendingFiles.get(filePath));
                    }

                    // Set a new timer to process the file after delay
                    const timerId = setTimeout(async () => {
                        try {
                            // Check if the file still exists and can be accessed
                            const stats = await fs.stat(filePath);
                            const fileName = path.basename(filePath);
                            const videoFile: VideoFile = {
                                name: fileName,
                                game: extractGameFromFilename(fileName),
                                path: filePath,
                                size: stats.size,
                                lastModified: stats.mtime.toISOString(),
                            };

                            // Send the new video to the renderer process
                            if (mainWindow && !mainWindow.isDestroyed()) {
                                mainWindow.webContents.send(
                                    "videos:new-video-found",
                                    videoFile,
                                );
                            }
                        } catch (error) {
                            console.error("Error processing new video:", error);
                        } finally {
                            // Clean up the pending file entry
                            pendingFiles.delete(filePath);
                        }
                    }, FILE_PROCESSING_DELAY);

                    pendingFiles.set(filePath, timerId);
                }
            });

            return true;
        } catch (error) {
            console.error("Error setting up directory watcher:", error);
            return false;
        }
    });

    // Stop watching a directory
    ipcMain.handle("videos:stop-watching", async (_, directoryPath) => {
        return await stopWatcher(directoryPath);
    });
}

/**
 * Helper to stop a directory watcher
 */
async function stopWatcher(directoryPath: string): Promise<boolean> {
    const watcher = activeWatchers.get(directoryPath);
    if (watcher) {
        try {
            // Clear any pending file timers for this directory
            for (const [filePath, timerId] of pendingFiles.entries()) {
                if (filePath.startsWith(directoryPath)) {
                    clearTimeout(timerId);
                    pendingFiles.delete(filePath);
                }
            }

            await watcher.close();
            activeWatchers.delete(directoryPath);
            return true;
        } catch (error) {
            console.error("Error stopping directory watcher:", error);
            return false;
        }
    }
    return false;
}
