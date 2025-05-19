import { ipcMain } from "electron";
import fs from "fs";
import ffmpeg from "@/helpers/ffmpeg";
import { createPerformanceLogger } from "@/helpers/performance";

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
            const perfLogger = createPerformanceLogger("extract-waveform", {
                videoPath,
                sampleCount,
                audioTrack,
            });

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

                const sampleRate = sampleCount;
                const buffer = await new Promise<Buffer>((resolve, reject) => {
                    const ffmpegCommand = ffmpeg(videoPath);
                    const chunks: Buffer[] = [];

                    ffmpegCommand
                        .outputOptions([
                            "-ac 1", // Mono
                            `-ar ${sampleRate}`,
                            `-map 0:a:${audioTrack}`,
                            "-vn", // No video
                            "-acodec pcm_s16le", // Uncompressed audio
                            "-loglevel error", // Reduce logging overhead
                            "-threads 0", // Auto-detect optimal threads
                            "-fflags +fastseek", // Fast seeking
                            "-probesize 32768", // Smaller probe size
                            "-analyzeduration 0", // Skip lengthy analysis
                        ])
                        .toFormat("wav") // Output format for the stream
                        .on("error", (err) => {
                            reject(
                                new Error(
                                    `ffmpeg command error: ${err.message}`,
                                ),
                            );
                        })
                        .pipe() // Returns a PassThrough stream
                        .on("data", (chunk: Buffer) => {
                            chunks.push(chunk);
                        })
                        .on("end", () => {
                            resolve(Buffer.concat(chunks));
                        })
                        .on("error", (err) => {
                            reject(
                                new Error(
                                    `ffmpeg stream error: ${err.message}`,
                                ),
                            );
                        });
                });
                perfLogger.addStep("ffmpeg-audio-extraction-to-buffer");

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

                // Normalize the smoothed output to a peak of 0.9
                let maxSmoothedValue = 0;
                for (let i = 0; i < smoothedResult.length; i++) {
                    // Ensure we are working with positive values for peak detection,
                    // though smoothing of positive values should yield positive results.
                    const currentValue = Math.abs(smoothedResult[i]);
                    if (currentValue > maxSmoothedValue) {
                        maxSmoothedValue = currentValue;
                    }
                }

                // Only normalize if there's a significant peak to avoid amplifying silence or division by zero
                if (maxSmoothedValue > 1e-5) {
                    // Using a small epsilon
                    const scaleFactor = 0.9 / maxSmoothedValue;
                    for (let i = 0; i < smoothedResult.length; i++) {
                        smoothedResult[i] *= scaleFactor;
                    }
                }
                perfLogger.addStep("smoothing-and-peak-normalization");
                perfLogger.end();
                return smoothedResult;
            } catch (error) {
                console.error("Error extracting waveform data:", error);
                perfLogger.end({ error: error });
                return null;
            }
        },
    );
}
