import { BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import path from "path";
import crypto from "crypto";
import fs from "fs";
import * as fsP from "fs/promises";
import ffmpeg from "@/helpers/ffmpeg";
import { promisify } from "util";
import { createPerformanceLogger } from "@/helpers/performance";
import { ExportedClip, ExportOptions } from "@/types/video-editor";
import {
    getThumbnailFilename,
    screenshot,
    THUMBNAIL_DIR,
} from "./videos-listeners";

/**
 * Safely calculates FPS from a frame rate string (typically in the format "numerator/denominator")
 */
function calculateFps(frameRateStr: string): number {
    try {
        // Handle the common case of a fraction like "24/1"
        const parts = frameRateStr.split("/");
        if (parts.length === 2) {
            const numerator = parseFloat(parts[0]);
            const denominator = parseFloat(parts[1]);
            if (!isNaN(numerator) && !isNaN(denominator) && denominator !== 0) {
                return numerator / denominator;
            }
        }

        // If it's not a fraction, try parsing it directly
        const fps = parseFloat(frameRateStr);
        return isNaN(fps) ? 0 : fps;
    } catch {
        return 0;
    }
}

/**
 * Add video editor-related event listeners
 */
export function addVideoEditorEventListeners(mainWindow: BrowserWindow) {
    // Handle video metadata retrieval
    ipcMain.handle(
        "video-editor:get-metadata",
        async (_, videoPath: string) => {
            const perfLog = createPerformanceLogger(
                "video-editor:get-metadata",
                {
                    videoPath,
                },
            );

            try {
                perfLog.addStep("prepareFFProbePromise");
                const getMetadata = promisify<string, ffmpeg.FfprobeData>(
                    (input, callback) => {
                        ffmpeg.ffprobe(input, (err, metadata) => {
                            if (err) callback(err, {} as ffmpeg.FfprobeData);
                            else callback(null, metadata);
                        });
                    },
                );

                perfLog.addStep("runFFProbe");
                const metadata = await getMetadata(videoPath);

                perfLog.addStep("processMetadata");
                const videoStream = metadata.streams.find(
                    (stream) => stream.codec_type === "video",
                );
                const audioStream = metadata.streams.find(
                    (stream) => stream.codec_type === "audio",
                );

                const result = {
                    duration: metadata.format.duration || 0,
                    width: videoStream?.width || 0,
                    height: videoStream?.height || 0,
                    fps: calculateFps(videoStream?.r_frame_rate || "0"),
                    bitrate: metadata.format.bit_rate,
                    size: metadata.format.size,
                    videoCodec: videoStream?.codec_name,
                    audioCodec: audioStream?.codec_name,
                };

                perfLog.end({
                    success: true,
                    hasAudio: !!audioStream,
                    hasVideo: !!videoStream,
                });

                return result;
            } catch (error) {
                console.error("Error getting video metadata:", error);

                perfLog.end({
                    success: false,
                    error:
                        error instanceof Error
                            ? error.message
                            : "Unknown error",
                });

                return null;
            }
        },
    );

    // Handle video export
    ipcMain.handle(
        "video-editor:export-clip",
        async (_, videoPath: string, options: ExportOptions) => {
            const perfLog = createPerformanceLogger(
                "video-editor:export-clip",
                {
                    videoPath,
                    options,
                },
            );

            try {
                perfLog.addStep("showSaveDialog");
                let outputPath: string | undefined;

                if (options.chooseExportLocation) {
                    const saveResult = await dialog.showSaveDialog({
                        title: "Save Exported Clip",
                        defaultPath: path.join(
                            path.dirname(videoPath),
                            `${path.basename(videoPath, path.extname(videoPath))}_clip.${options.outputFormat}`,
                        ),
                        filters: [
                            {
                                name: "Video Files",
                                extensions: [options.outputFormat],
                            },
                            { name: "All Files", extensions: ["*"] },
                        ],
                    });

                    if (saveResult.canceled || !saveResult.filePath) {
                        perfLog.end({ success: false, canceled: true });
                        return { success: false, error: "Export cancelled" };
                    }
                    outputPath = saveResult.filePath;
                } else {
                    const optionsToHash = {
                        startTime: options.startTime,
                        endTime: options.endTime,
                        width: options.width,
                        height: options.height,
                        fps: options.fps,
                        qualityMode: options.qualityMode,
                        quality: options.quality,
                        targetSize: options.targetSize,
                        audioBitrate: options.audioBitrate,
                        audioTracks: options.audioTracks,
                        outputFormat: options.outputFormat,
                    };

                    const optionsHash = crypto
                        .createHash("md5")
                        .update(JSON.stringify(optionsToHash))
                        .digest("hex")
                        .substring(0, 8); // Use first 8 characters of hash

                    const originalFileName = path.basename(
                        videoPath,
                        path.extname(videoPath),
                    );
                    const originalDir = path.dirname(videoPath);
                    const outputDir = path.join(
                        originalDir,
                        `${originalFileName}_clips`,
                    );
                    try {
                        if (!fs.existsSync(outputDir)) {
                            fs.mkdirSync(outputDir, { recursive: true });
                        }
                    } catch (err) {
                        console.error("Error creating output directory:", err);
                        perfLog.end({
                            success: false,
                            error: "Failed to create output directory",
                        });
                        return {
                            success: false,
                            error: "Failed to create output directory",
                        };
                    }

                    outputPath = path.join(
                        outputDir,
                        `${originalFileName}_${optionsHash}.${options.outputFormat}`,
                    );
                    if (fs.existsSync(outputPath)) {
                        perfLog.end({
                            success: true,
                            outputPath,
                            fileAlreadyExists: true,
                        });
                        return {
                            success: true,
                            outputPath,
                            fileAlreadyExists: true,
                        };
                    }
                }

                perfLog.addStep("prepareExportSettings");
                let videoBitrate: string;
                let audioBitrate: string;

                if (options.qualityMode === "preset") {
                    switch (options.quality) {
                        case "high":
                            videoBitrate = "4000k";
                            audioBitrate = "192k";
                            break;
                        case "medium":
                            videoBitrate = "2500k";
                            audioBitrate = "128k";
                            break;
                        case "low":
                            videoBitrate = "1000k";
                            audioBitrate = "96k";
                            break;
                        default:
                            videoBitrate = "2500k";
                            audioBitrate = "128k";
                    }
                } else if (options.targetSize) {
                    // Calculate bitrate based on target size
                    const duration = options.endTime - options.startTime;
                    // Convert target size from MB to bits (MB * 8 * 1024 * 1024)
                    const targetSizeInBits =
                        options.targetSize * 8 * 1024 * 1024;
                    // Reserve some bits for audio (if tracks are selected)
                    const hasAudio =
                        options.audioTracks && options.audioTracks.length > 0;
                    const audioBitsReserved = hasAudio
                        ? (options.audioBitrate || 128) * 1000 * duration
                        : 0;
                    // Calculate video bitrate
                    const videoBitrateValue = Math.max(
                        (targetSizeInBits - audioBitsReserved) / duration,
                        500000,
                    );
                    videoBitrate = `${Math.floor(videoBitrateValue / 1000)}k`;
                    audioBitrate = options.audioBitrate
                        ? `${options.audioBitrate}k`
                        : "128k";
                } else {
                    videoBitrate = "2500k";
                    audioBitrate = options.audioBitrate
                        ? `${options.audioBitrate}k`
                        : "128k";
                }

                perfLog.addStep("runFFMPEGExport");

                const cuts = options.cuts || [];
                let keepSegments: { start: number; end: number }[] = [];

                if (cuts.length > 0) {
                    // Sort cuts and build keep segments
                    let last = options.startTime;
                    const sortedCuts = [...cuts].sort(
                        (a, b) => a.start - b.start,
                    );
                    for (const cut of sortedCuts) {
                        if (cut.start > last) {
                            keepSegments.push({ start: last, end: cut.start });
                        }
                        last = Math.max(last, cut.end);
                    }
                    if (last < options.endTime) {
                        keepSegments.push({
                            start: last,
                            end: options.endTime,
                        });
                    }
                } else {
                    keepSegments = [
                        { start: options.startTime, end: options.endTime },
                    ];
                }

                if (keepSegments.length === 1) {
                    // Convert promise-based
                    const exportClip = () => {
                        return new Promise((resolve, reject) => {
                            let command = ffmpeg(videoPath)
                                .inputOptions(["-hwaccel", "auto"])
                                .setStartTime(options.startTime)
                                .setDuration(
                                    options.endTime - options.startTime,
                                )
                                .videoBitrate(videoBitrate)
                                .format(options.outputFormat);

                            if (options.outputFormat === "mp4") {
                                command = command.outputOptions([
                                    "-c:v",
                                    "h264_nvenc",
                                ]);
                            } else if (options.outputFormat === "webm") {
                                command = command.outputOptions([
                                    "-c:v",
                                    "vp9_nvenc",
                                ]);
                            }

                            // Apply optional settings if provided
                            if (options.width && options.height) {
                                command = command.size(
                                    `${options.width}x${options.height}`,
                                );
                            }

                            if (options.fps) {
                                command = command.fps(options.fps);
                            }

                            // Handle audio options
                            const hasAudio =
                                options.audioTracks &&
                                options.audioTracks.length > 0;

                            if (!hasAudio) {
                                command = command.noAudio();
                            } else {
                                // Set audio bitrate
                                command = command.audioBitrate(audioBitrate);

                                // Handle audio track selection
                                // First, map the video stream
                                command = command.outputOptions([`-map 0:v:0`]);

                                // Create a consolidated audio filter chain for the selected tracks
                                if (
                                    options.audioTracks &&
                                    options.audioTracks.length === 1
                                ) {
                                    // If only one track, map it directly
                                    command = command.outputOptions([
                                        `-map 0:a:${options.audioTracks[0]}`,
                                    ]);
                                } else if (options.audioTracks) {
                                    const inputs = options.audioTracks
                                        .map((track) => `[0:a:${track}]`)
                                        .join("");

                                    // Define the amerge filter with the correct number of inputs
                                    const filterComplex = `${inputs}amerge=inputs=${options.audioTracks.length}[aout]`;

                                    // Apply the filter complex and map the output
                                    command = command
                                        .complexFilter(filterComplex)
                                        .outputOptions(["-map [aout]"]);
                                }
                            }

                            command.on("progress", (progress) => {
                                const timemarkToSeconds = (
                                    timemark: string,
                                ): number => {
                                    const parts = timemark.split(":");
                                    if (parts.length !== 3) return 0;

                                    const hours = parseInt(parts[0], 10);
                                    const minutes = parseInt(parts[1], 10);
                                    const seconds = parseFloat(parts[2]);

                                    return (
                                        hours * 3600 + minutes * 60 + seconds
                                    );
                                };

                                const currentTime = timemarkToSeconds(
                                    progress.timemark,
                                );

                                // Calculate overall progress as a value between 0 and 1
                                const progressValue = Math.min(
                                    currentTime /
                                        (options.endTime - options.startTime),
                                    1,
                                );

                                if (mainWindow) {
                                    mainWindow.setProgressBar(progressValue);
                                    mainWindow.webContents.send(
                                        "export-progress",
                                        {
                                            progress: progressValue,
                                            currentTime,
                                            totalDuration:
                                                options.endTime -
                                                options.startTime,
                                        },
                                    );
                                }
                            });

                            command
                                .on("end", () => {
                                    if (mainWindow) {
                                        mainWindow.setProgressBar(-1); // -1 removes the progress bar
                                    }
                                    resolve({ success: true, outputPath });
                                })
                                .on("error", (err) => {
                                    if (mainWindow) {
                                        mainWindow.setProgressBar(-1);
                                    }
                                    reject(err);
                                })
                                .save(outputPath);
                        });
                    };

                    const result = await exportClip();

                    perfLog.end({
                        success: true,
                        outputPath,
                        duration: options.endTime - options.startTime,
                        hasAudio:
                            options.audioTracks &&
                            options.audioTracks.length > 0,
                    });

                    return result;
                } else {
                    // Multiple segments: export each, then concat
                    const tempDir = path.join(
                        path.dirname(outputPath),
                        `__temp_cuts_${Date.now()}`,
                    );
                    fs.mkdirSync(tempDir, { recursive: true });
                    const segmentFiles: string[] = [];

                    try {
                        // Export each segment with highest quality settings to minimize quality loss
                        for (let i = 0; i < keepSegments.length; i++) {
                            const seg = keepSegments[i];
                            const segPath = path.join(tempDir, `seg${i}.ts`);
                            await new Promise((resolve, reject) => {
                                let cmd = ffmpeg(videoPath)
                                    .inputOptions(["-hwaccel", "auto"])
                                    .setStartTime(seg.start)
                                    .setDuration(seg.end - seg.start)
                                    .format("mpegts");

                                // Use high quality settings for intermediate segments
                                // Use h264 for compatibility regardless of final format
                                cmd = cmd.outputOptions([
                                    "-c:v",
                                    "libx264",
                                    "-crf",
                                    "18", // High quality CRF value
                                    "-preset",
                                    "medium",
                                ]);

                                // Apply resolution and fps changes at segment level to avoid double processing
                                if (options.width && options.height) {
                                    cmd = cmd.size(
                                        `${options.width}x${options.height}`,
                                    );
                                }
                                if (options.fps) {
                                    cmd = cmd.fps(options.fps);
                                }

                                const hasAudio =
                                    options.audioTracks &&
                                    options.audioTracks.length > 0;
                                if (!hasAudio) {
                                    cmd = cmd.noAudio();
                                } else {
                                    // Use high quality audio for intermediate segments
                                    cmd = cmd.audioBitrate("320k");
                                    cmd = cmd.outputOptions([`-map 0:v:0`]);
                                    if (
                                        options.audioTracks &&
                                        options.audioTracks.length === 1
                                    ) {
                                        cmd = cmd.outputOptions([
                                            `-map 0:a:${options.audioTracks[0]}`,
                                        ]);
                                    } else if (options.audioTracks) {
                                        const inputs = options.audioTracks
                                            .map((track) => `[0:a:${track}]`)
                                            .join("");
                                        const filterComplex = `${inputs}amerge=inputs=${options.audioTracks.length}[aout]`;
                                        cmd = cmd
                                            .complexFilter(filterComplex)
                                            .outputOptions(["-map [aout]"]);
                                    }
                                }

                                cmd.on("end", resolve)
                                    .on("error", reject)
                                    .save(segPath);
                            });
                            segmentFiles.push(segPath);
                        }

                        // Create concat file list
                        const concatListPath = path.join(tempDir, "concat.txt");
                        fs.writeFileSync(
                            concatListPath,
                            segmentFiles
                                .map(
                                    (f) => `file '${f.replace(/'/g, "'\\''")}'`,
                                )
                                .join("\n"),
                        );

                        // Concat segments and apply final quality settings
                        await new Promise((resolve, reject) => {
                            let concatCmd = ffmpeg()
                                .input(concatListPath)
                                .inputOptions(["-f", "concat", "-safe", "0"])
                                .format(options.outputFormat)
                                .videoBitrate(videoBitrate);

                            // Apply final codec settings for the output format
                            if (options.outputFormat === "mp4") {
                                concatCmd = concatCmd.outputOptions([
                                    "-c:v",
                                    "h264_nvenc",
                                    "-c:a",
                                    "aac",
                                ]);
                            } else if (options.outputFormat === "webm") {
                                concatCmd = concatCmd.outputOptions([
                                    "-c:v",
                                    "vp9_nvenc",
                                    "-c:a",
                                    "libopus",
                                ]);
                            } else {
                                // For other formats, use software encoding
                                concatCmd = concatCmd.outputOptions([
                                    "-c:v",
                                    "libx264",
                                    "-c:a",
                                    "aac",
                                ]);
                            }

                            // Apply final audio bitrate if audio is present
                            const hasAudio =
                                options.audioTracks &&
                                options.audioTracks.length > 0;
                            if (hasAudio) {
                                concatCmd =
                                    concatCmd.audioBitrate(audioBitrate);
                            }

                            concatCmd
                                .output(outputPath)
                                .on("end", resolve)
                                .on("error", reject)
                                .run();
                        });

                        // Clean up temp files
                        segmentFiles.forEach((f) => fs.unlinkSync(f));
                        fs.unlinkSync(concatListPath);
                        fs.rmdirSync(tempDir);

                        perfLog.end({
                            success: true,
                            outputPath,
                            duration: options.endTime - options.startTime,
                            hasAudio:
                                options.audioTracks &&
                                options.audioTracks.length > 0,
                        });

                        return { success: true, outputPath };
                    } catch (err) {
                        // Clean up on error
                        try {
                            segmentFiles.forEach(
                                (f) => fs.existsSync(f) && fs.unlinkSync(f),
                            );
                            if (fs.existsSync(tempDir)) {
                                fs.rmdirSync(tempDir, { recursive: true });
                            }
                        } catch {
                            // Ignore errors during cleanup
                        }
                        perfLog.end({
                            success: false,
                            error:
                                err instanceof Error
                                    ? err.message
                                    : String(err),
                        });
                        return {
                            success: false,
                            error:
                                err instanceof Error
                                    ? err.message
                                    : String(err),
                        };
                    }
                }
            } catch (error: unknown) {
                console.error("Error exporting video clip:", error);

                const result = {
                    success: false,
                    error:
                        error instanceof Error
                            ? error.message
                            : "Unknown error occurred during export",
                };

                perfLog.end({
                    success: false,
                    error: result.error,
                });

                return result;
            }
        },
    );

    ipcMain.handle(
        "video-editor:get-previous-exports",
        async (_, videoPath: string) => {
            try {
                const originalFileName = path.basename(
                    videoPath,
                    path.extname(videoPath),
                );
                const originalDir = path.dirname(videoPath);
                const outputDir = path.join(
                    originalDir,
                    `${originalFileName}_clips`,
                );

                // Check if directory exists
                if (!fs.existsSync(outputDir)) {
                    return [];
                }

                const files = fs.readdirSync(outputDir);
                const exports = await Promise.all(
                    files
                        .filter((file) => {
                            // Filter for video files
                            const ext = path.extname(file).toLowerCase();
                            return [
                                ".mp4",
                                ".webm",
                                ".mov",
                                ".mkv",
                                ".gif",
                            ].includes(ext);
                        })
                        .map(async (file) => {
                            const filePath = path.join(outputDir, file);
                            const stats = fs.statSync(filePath);

                            // Get metadata from the video file using ffprobe
                            try {
                                const getMetadata = promisify<
                                    string,
                                    ffmpeg.FfprobeData
                                >((input, callback) => {
                                    ffmpeg.ffprobe(input, (err, metadata) => {
                                        if (err)
                                            callback(
                                                err,
                                                {} as ffmpeg.FfprobeData,
                                            );
                                        else callback(null, metadata);
                                    });
                                });

                                const metadata = await getMetadata(filePath);
                                const duration = metadata.format.duration || 0;

                                const thumbnailFilename =
                                    getThumbnailFilename(filePath);
                                const thumbnailPath = path.join(
                                    THUMBNAIL_DIR,
                                    thumbnailFilename,
                                );
                                let thumbnail = "";

                                try {
                                    await fsP.access(thumbnailPath);
                                    thumbnail = thumbnailPath;
                                } catch {
                                    // Thumbnail doesn't exist, generate it
                                    try {
                                        await screenshot(
                                            filePath,
                                            thumbnailPath,
                                        );
                                        thumbnail = thumbnailPath;
                                    } catch (thumbnailError) {
                                        console.error(
                                            "Error generating thumbnail:",
                                            thumbnailError,
                                        );
                                    }
                                }

                                return {
                                    path: filePath,
                                    name: path.basename(filePath),
                                    timestamp: stats.mtime.getTime(),
                                    duration,
                                    size: stats.size,
                                    thumbnail,
                                };
                            } catch (error) {
                                console.error(
                                    `Error getting metadata for ${filePath}:`,
                                    error,
                                );
                                return {
                                    path: filePath,
                                    timestamp: stats.mtime.getTime(),
                                    duration: 0,
                                    size: stats.size,
                                };
                            }
                        }),
                );

                const validExports = exports.filter(
                    (item): item is ExportedClip =>
                        typeof item !== "string" &&
                        item !== null &&
                        item !== undefined,
                );
                validExports.sort((a, b) => b.timestamp - a.timestamp);

                return validExports;
            } catch (error) {
                console.error("Error getting previous exports:", error);
                return {
                    success: false,
                    error:
                        error instanceof Error
                            ? error.message
                            : "Unknown error",
                };
            }
        },
    );

    ipcMain.handle(
        "video-editor:copy-file-to-clipboard",
        async (_, filePath: string) => {
            const perfLog = createPerformanceLogger(
                "video-editor:copy-file-to-clipboard",
                {
                    filePath,
                },
            );

            try {
                perfLog.addStep("writeToClipboard");
                clipboard.writeBuffer(
                    "FileNameW",
                    Buffer.concat([
                        Buffer.from(filePath, "ucs-2"),
                        Buffer.from([0, 0]),
                    ]),
                );

                perfLog.end({ success: true });
                return { success: true };
            } catch (error) {
                console.error("Error copying file to clipboard:", error);

                const result = {
                    success: false,
                    error:
                        error instanceof Error
                            ? error.message
                            : "Unknown error occurred",
                };

                perfLog.end({
                    success: false,
                    error: result.error,
                });

                return result;
            }
        },
    );
}
