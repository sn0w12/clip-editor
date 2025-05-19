import { ipcMain, app } from "electron";
import fs from "fs";
import path from "path";
import ffmpeg from "@/helpers/ffmpeg";
import { promisify } from "util";
import { v4 as uuidv4 } from "uuid";
import { createPerformanceLogger } from "@/helpers/performance";

const readFile = promisify(fs.readFile);
const access = promisify(fs.access);
const mkdir = promisify(fs.mkdir);

/**
 * Extract waveform data from a video file using ffmpeg
 */
export function addAudioWaveformListeners() {
    ipcMain.handle(
        "audio:extract-waveform",
        async (
            _,
            videoPath: string,
            sampleCount: number = 1000,
            audioTrack: number = 0,
        ): Promise<Float32Array | null> => {
            const perfLogger = createPerformanceLogger();

            try {
                // Convert protocol URL to file path if needed
                let resolvedPath = videoPath;

                // Handle clip-video and clip-editor protocols
                if (
                    videoPath.startsWith("clip-video:///") ||
                    videoPath.startsWith("clip-editor:///")
                ) {
                    try {
                        const url = new URL(videoPath);
                        const encodedPath = url.pathname.substring(1);
                        resolvedPath =
                            decodeURIComponent(encodedPath).split("?")[0];
                    } catch (e) {
                        console.warn("Failed to parse protocol URL:", e);
                    }
                }

                if (!fs.existsSync(resolvedPath)) {
                    throw new Error(
                        `Video file not found: ${videoPath} (resolved to ${resolvedPath})`,
                    );
                }

                // Use the resolved path for all further operations
                videoPath = resolvedPath;
                perfLogger.addStep("path-resolution");

                // Create a temporary WAV file with a UUID to avoid filename issues
                const tmpDir = path.join(
                    app.getPath("temp"),
                    "clip-compression-ui",
                );

                // Use a UUID for the temp file name to avoid any issues with special characters
                const uniqueId = uuidv4();
                const audioFile = path.join(tmpDir, `${uniqueId}-audio.wav`);

                // Ensure temp directory exists
                try {
                    await access(tmpDir);
                } catch {
                    await mkdir(tmpDir, { recursive: true });
                }
                perfLogger.addStep("temp-dir-creation");

                // Extract audio to WAV file with mono audio and 44.1kHz sample rate
                await new Promise<void>((resolve, reject) => {
                    ffmpeg(videoPath)
                        .outputOptions([
                            "-ac 1", // Mono
                            "-ar 44100", // 44.1kHz sample rate
                            `-map 0:a:${audioTrack}`,
                        ])
                        .audioFilter("highpass=f=20") // High-pass filter to remove low rumble
                        .audioFilter("dynaudnorm=f=150:g=15:n=0:p=0.95") // Dynamic audio normalization
                        .output(audioFile)
                        .on("end", () => resolve())
                        .on("error", (err) => reject(err))
                        .run();
                });
                perfLogger.addStep("ffmpeg-audio-extraction");

                // Read the WAV file as a buffer
                const buffer = await readFile(audioFile);
                perfLogger.addStep("read-audio-file");

                // Parse WAV and extract PCM data (simplified handling)
                // Skip the header (44 bytes) and read the audio data
                const headerSize = 44;
                const audioData = buffer.slice(headerSize);
                const dataLength = audioData.length / 2; // 16-bit samples = 2 bytes per sample

                // Create a Float32Array to store the normalized samples
                const samples = new Float32Array(dataLength);

                // Convert the raw buffer to float values (-1.0 to 1.0)
                for (let i = 0; i < dataLength; i++) {
                    const sampleValue = audioData.readInt16LE(i * 2);
                    samples[i] = sampleValue / 32768.0; // Normalize to -1.0 to 1.0
                }
                perfLogger.addStep("parse-audio-data");

                // Skip the first ~100ms of audio to avoid initial spike artifacts
                const sampleRate = 44100;
                const skipSamples = Math.min(
                    Math.floor(sampleRate * 0.1), // Skip 100ms (increased from 50ms)
                    Math.floor(samples.length * 0.02), // Or 2% of total samples
                );

                // Create a working copy without the initial spike
                const workingSamples = samples.slice(skipSamples);

                // Downsample to requested number of samples
                const result = new Float32Array(sampleCount);
                const blockSize = Math.floor(
                    workingSamples.length / sampleCount,
                );

                if (blockSize <= 0) {
                    throw new Error(
                        "Sample count is too high for the audio length",
                    );
                }

                // Calculate the downsampled values
                for (let i = 0; i < sampleCount; i++) {
                    const startIdx = i * blockSize;
                    let sum = 0;
                    let max = 0;
                    let count = 0;

                    // Find both peak value and RMS in this block
                    for (
                        let j = 0;
                        j < blockSize && startIdx + j < workingSamples.length;
                        j++
                    ) {
                        const value = Math.abs(workingSamples[startIdx + j]);
                        sum += value * value; // For RMS calculation
                        max = Math.max(max, value); // For peak detection
                        count++;
                    }

                    // Use a combination of RMS and peak for better representation
                    const rms = count > 0 ? Math.sqrt(sum / count) : 0;

                    // Blend RMS and peak values (gives more natural looking waveforms)
                    // Use more RMS and less peak to reduce spikes
                    result[i] = Math.max(rms * 1.6, max * 0.4);
                }
                perfLogger.addStep("downsampling");

                // Apply a gentle smoothing filter to avoid extreme spikes
                const smoothedResult = new Float32Array(sampleCount);
                const smoothingWindow = 3;

                for (let i = 0; i < sampleCount; i++) {
                    let sum = 0;
                    let count = 0;

                    // Simple moving average
                    for (let j = -smoothingWindow; j <= smoothingWindow; j++) {
                        const idx = i + j;
                        if (idx >= 0 && idx < sampleCount) {
                            sum += result[idx];
                            count++;
                        }
                    }

                    smoothedResult[i] = sum / count;
                }

                // Normalize the output to ensure we have good amplitude range
                let maxValue = 0;
                let avgValue = 0;

                for (let i = 0; i < smoothedResult.length; i++) {
                    maxValue = Math.max(maxValue, smoothedResult[i]);
                    avgValue += smoothedResult[i];
                }

                avgValue /= smoothedResult.length;

                // Calculate dynamic threshold to avoid over-amplifying noise
                const threshold = avgValue * 0.1;

                // Only normalize if we have non-zero values
                if (maxValue > threshold) {
                    const scaleFactor = 0.9 / maxValue; // Leave a small margin
                    for (let i = 0; i < smoothedResult.length; i++) {
                        // Apply soft-knee compression to reduce extreme differences
                        const value = smoothedResult[i];
                        if (value < threshold) {
                            smoothedResult[i] = value * 0.5 * scaleFactor;
                        } else {
                            smoothedResult[i] = value * scaleFactor;
                        }
                    }
                }
                perfLogger.addStep("smoothing-and-normalization");

                // Clean up the temporary audio file
                try {
                    fs.unlinkSync(audioFile);
                } catch (e) {
                    console.warn("Failed to clean up temporary audio file:", e);
                }
                perfLogger.addStep("cleanup");

                perfLogger.end({ sampleCount, audioTrackIndex: audioTrack });
                return smoothedResult;
            } catch (error) {
                console.error("Error extracting waveform data:", error);
                perfLogger.end({ error: error });
                return null;
            }
        },
    );
}
