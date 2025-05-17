"use client";

import React, { useRef, useState, useEffect } from "react";
import { cn } from "@/utils/tailwind";
import {
    getAudioContext,
    getMediaElementSource,
} from "@/contexts/audio-context";

interface AudioVisualizerProps {
    src?: string;
    externalAudioRef?: React.RefObject<HTMLAudioElement | HTMLVideoElement>;
    color?: string;
    height?: number;
    className?: string;
    barWidth?: number;
    barGap?: number;
    smoothing?: number;
    showPlayButton?: boolean;
    variant?: "bars" | "line" | "line-bars";
    lineWidth?: number;
}

export function AudioVisualizer({
    src,
    externalAudioRef,
    color = "var(--muted-foreground)",
    height = 80,
    className,
    barWidth = 2,
    barGap = 1,
    smoothing = 0.5,
    showPlayButton = true,
    variant = "bars",
    lineWidth = 1,
}: AudioVisualizerProps) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [audioData, setAudioData] = useState<number[]>([]);
    const [parsedColor, setParsedColor] = useState(color);
    const [canvasHeight, setCanvasHeight] = useState(height);

    const internalAudioRef = useRef<HTMLAudioElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const animationRef = useRef<number | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const analyserRef = useRef<AnalyserNode | null>(null);
    const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const resizeObserverRef = useRef<ResizeObserver | null>(null);
    const prevDataArrayRef = useRef<number[]>([]);
    const peaksRef = useRef<
        Array<{ x: number; y: number; time: number; opacity: number }>
    >([]);
    // Track if the current media element is already connected
    const connectedElementRef = useRef<HTMLMediaElement | null>(null);

    // Use either the external audio ref or the internal one
    const audioRef = externalAudioRef || internalAudioRef;

    // Parse CSS variables for color
    useEffect(() => {
        if (color && color.startsWith("var(--")) {
            // Get the actual color from CSS variable
            if (containerRef.current) {
                const computedStyle = getComputedStyle(containerRef.current);
                const variableName = color.match(/var\((.*?)\)/)?.[1];
                if (variableName) {
                    const actualColor = computedStyle
                        .getPropertyValue(variableName)
                        .trim();
                    setParsedColor(actualColor || "#5A67D8"); // Fallback to default if variable not found
                }
            }
        } else {
            setParsedColor(color);
        }
    }, [color]);

    // Ensure smoothing never reaches 1 (which would freeze the visualization)
    const effectiveSmoothing = Math.min(0.99, smoothing); // Initialize audio context and analyzer
    useEffect(() => {
        // Create audio context only on user interaction to comply with browser policies
        const setupAudio = () => {
            if (!audioRef.current) return;

            // If the analyzer is already connected to this audio element, no need to reconnect
            if (
                analyserRef.current &&
                connectedElementRef.current === audioRef.current
            ) {
                return;
            }

            // Clean up previous analyzer if it exists
            if (analyserRef.current) {
                try {
                    analyserRef.current.disconnect();
                } catch (e) {
                    console.log("Error disconnecting analyzer:", e);
                }
                analyserRef.current = null;
            }

            try {
                // Get the shared audio context
                audioContextRef.current = getAudioContext();

                // Create a new analyzer node
                analyserRef.current = audioContextRef.current.createAnalyser();

                // Different FFT sizes depending on visualization type
                analyserRef.current.fftSize = variant === "line" ? 2048 : 512;
                analyserRef.current.smoothingTimeConstant = effectiveSmoothing;

                // Get or create the media element source using our utility
                if (audioRef.current) {
                    // This will reuse an existing source if one already exists
                    sourceRef.current = getMediaElementSource(audioRef.current);

                    // Connect the shared source to our analyzer
                    sourceRef.current.connect(analyserRef.current);

                    // Connect analyzer to destination to hear the audio
                    // (The source is already connected to destination by the utility)
                    analyserRef.current.connect(
                        audioContextRef.current.destination,
                    );

                    // Track the connected element
                    connectedElementRef.current = audioRef.current;

                    // Generate initial static display
                    generateStaticVisualization();
                }
            } catch (error) {
                console.error("Error setting up audio context:", error);
                // If we encounter an error, try a fallback approach
                if (externalAudioRef && audioContextRef.current) {
                    try {
                        // Just create an analyzer without connecting to source
                        analyserRef.current =
                            audioContextRef.current.createAnalyser();
                        analyserRef.current.fftSize =
                            variant === "line" ? 2048 : 512;
                        analyserRef.current.smoothingTimeConstant =
                            effectiveSmoothing;
                        analyserRef.current.connect(
                            audioContextRef.current.destination,
                        );

                        // Since we can't connect directly, we'll rely on static visualization
                        generateStaticVisualization();
                    } catch (fallbackError) {
                        console.error(
                            "Fallback audio setup failed:",
                            fallbackError,
                        );
                    }
                }
            }
        };

        // Add event listeners for play/pause
        const audioElement = audioRef.current;
        if (audioElement) {
            const handlePlay = () => setIsPlaying(true);
            const handlePause = () => setIsPlaying(false);
            const handleEnded = () => setIsPlaying(false);
            const handleCanPlay = () => {
                // Only setup if not already connected to avoid duplication
                if (connectedElementRef.current !== audioElement) {
                    setupAudio();
                }
            };

            audioElement.addEventListener("play", handlePlay);
            audioElement.addEventListener("pause", handlePause);
            audioElement.addEventListener("ended", handleEnded);
            audioElement.addEventListener("canplay", handleCanPlay);

            // For external audio element that might already be playing
            if (externalAudioRef && !audioElement.paused) {
                setIsPlaying(true);
                // Force setup for external audio that's already playing
                setupAudio();
            }

            // If the audio is already loaded, set up immediately
            if (audioElement.readyState >= 2) {
                setupAudio();
            }
            return () => {
                audioElement.removeEventListener("play", handlePlay);
                audioElement.removeEventListener("pause", handlePause);
                audioElement.removeEventListener("ended", handleEnded);
                audioElement.removeEventListener("canplay", handleCanPlay);

                // Clean up connection tracking
                if (connectedElementRef.current === audioElement) {
                    connectedElementRef.current = null;
                }

                // Disconnect the analyzer node to prevent memory leaks
                // but keep the source node since it's shared between visualizers
                if (analyserRef.current) {
                    try {
                        analyserRef.current.disconnect();
                    } catch (e) {
                        console.log(
                            "Error disconnecting analyzer on cleanup:",
                            e,
                        );
                    }
                    analyserRef.current = null;
                }

                // Note: We don't close the audioContext or disconnect the source node
                // because it's shared between multiple visualizers
            };
        }
    }, [effectiveSmoothing, variant, audioRef, externalAudioRef]);

    // Generate completely flat static visualization
    const generateStaticVisualization = () => {
        if (!canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;

        // Clear canvas
        ctx.clearRect(0, 0, width, height);

        if (variant === "bars") {
            // Generate completely flat, minimal bars (all same height)
            const staticBars = [];
            const barCount = Math.floor(width / (barWidth + barGap));

            // Use a single, minimal value for all bars
            const minValue = 0.01; // Just enough to be visible

            for (let i = 0; i < barCount; i++) {
                staticBars.push(minValue);
            }

            // Save static data for display
            setAudioData(staticBars);

            // Draw static bars - all the same tiny height
            let x = 0;
            for (let i = 0; i < staticBars.length; i++) {
                ctx.fillStyle = parsedColor;
                ctx.fillRect(
                    x,
                    height / 2 - 0.5, // Center exactly
                    barWidth,
                    1, // Exactly 1px height
                );

                x += barWidth + barGap;
                if (x > width) break;
            }
        } else if (variant === "line") {
            // Generate completely flat line
            const dataPoints = [];
            const pointCount = width;

            // Use a value of 0 for all points (perfectly centered)
            for (let i = 0; i < pointCount; i++) {
                dataPoints.push(0); // Exactly centered
            }

            // Save static data for display
            setAudioData(dataPoints);

            // Draw a perfectly straight line in the middle
            ctx.beginPath();
            ctx.strokeStyle = parsedColor;
            ctx.lineWidth = lineWidth;

            // Draw a straight line exactly in the middle
            ctx.moveTo(0, height / 2);
            ctx.lineTo(width, height / 2);

            ctx.stroke();
        }
    };

    // Function to draw the visualization
    const drawVisualization = () => {
        if (!canvasRef.current) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;

        // Clear canvas
        ctx.clearRect(0, 0, width, height);

        if (variant === "bars") {
            let dataArray;
            let bufferLength;

            if (isPlaying && analyserRef.current) {
                try {
                    // Get frequency data for bars
                    bufferLength = analyserRef.current.frequencyBinCount;
                    dataArray = new Uint8Array(bufferLength);
                    analyserRef.current.getByteFrequencyData(dataArray);

                    // Process and save the waveform data for non-playing state
                    const processedData = Array.from(dataArray).map(
                        (value) => value / 255,
                    );
                    setAudioData(processedData);
                } catch (error) {
                    console.error("Error getting frequency data:", error);
                    // Fall back to stored data if there's an error
                    dataArray = audioData.map((val) => val * 255);
                    bufferLength = audioData.length;
                }
            } else {
                // Use stored data when not playing
                dataArray = audioData.map((val) => val * 255);
                bufferLength = audioData.length;
            }

            // Set fill style
            ctx.fillStyle = parsedColor;

            // Number of bars to draw
            const barCount = Math.floor(width / (barWidth + barGap));
            const step = Math.floor(bufferLength / barCount) || 1;

            // Scaling factor for visualizing with high smoothing - boost visual effect
            // The closer smoothing is to 1, the more we boost the visualization
            const smoothingBoost = 1 + effectiveSmoothing * 2;

            // Draw waveform as bars
            let x = 0;
            for (let i = 0; i < barCount; i++) {
                const dataIndex = i * step;
                if (dataIndex >= bufferLength) break;

                // Apply smoothing boost to make bars more visible with high smoothing
                const rawValue = dataArray[dataIndex] / 255;
                const boostedValue = Math.min(1, rawValue * smoothingBoost);

                const barHeight = boostedValue * height * 0.8; // Scale to 80% of height

                // Ensure minimum bar height for visibility
                const finalBarHeight = Math.max(1, barHeight);

                ctx.fillRect(
                    x,
                    height / 2 - finalBarHeight / 2,
                    barWidth,
                    finalBarHeight,
                );

                x += barWidth + barGap;
                if (x > width) break;
            }
        } else if (variant === "line") {
            let dataArray;
            let bufferLength;

            if (isPlaying && analyserRef.current) {
                // Get time domain data for line visualization
                bufferLength = analyserRef.current.fftSize;
                dataArray = new Uint8Array(bufferLength);
                analyserRef.current.getByteTimeDomainData(dataArray);

                // Process and save the waveform data for non-playing state
                const processedData = Array.from(dataArray).map(
                    (value) => (value - 128) / 128,
                );
                setAudioData(processedData);
            } else {
                // Use stored data when not playing
                bufferLength = audioData.length;
                dataArray = audioData.map((val) => val * 128 + 128);
            }

            // Begin drawing the line
            ctx.beginPath();
            ctx.strokeStyle = parsedColor;
            ctx.lineWidth = lineWidth;

            const sliceWidth = width / bufferLength;
            let x = 0;

            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i] / 255;
                const y = v * height;

                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }

                x += sliceWidth;
            }

            ctx.stroke();
        } else if (variant === "line-bars") {
            let dataArray;
            let bufferLength = 0; // Initialize with a default value

            // Force analyzer to be ready for line-bars variant
            if (isPlaying && analyserRef.current) {
                try {
                    // Ensure correct FFT size for line-bars visualization
                    if (analyserRef.current.fftSize !== 2048) {
                        analyserRef.current.fftSize = 2048;
                    }

                    // Get time domain data (like line visualization)
                    bufferLength = analyserRef.current.fftSize;
                    dataArray = new Uint8Array(bufferLength);
                    analyserRef.current.getByteTimeDomainData(dataArray);

                    // Process and save the data
                    const processedData = Array.from(dataArray).map(
                        (value) => (value - 128) / 128,
                    );
                    setAudioData(processedData);

                    // Store a copy for velocity calculation in next frame
                    if (prevDataArrayRef.current.length === 0) {
                        prevDataArrayRef.current = [...processedData];
                    }
                } catch (error) {
                    console.error(
                        "Error processing line-bars audio data:",
                        error,
                    );
                }
            } else {
                // Use stored data when not playing
                bufferLength = audioData.length;
                dataArray = audioData.map((val) => val * 128 + 128);

                // Initialize previous data if needed
                if (prevDataArrayRef.current.length === 0) {
                    prevDataArrayRef.current = [...audioData];
                }
            }

            // Set fill style
            ctx.fillStyle = parsedColor;

            // Calculate how many bars to show based on canvas width
            const barCount = Math.floor(width / (barWidth + barGap));
            const step = Math.floor(bufferLength / barCount) || 1;

            // Draw individual bars based on time domain data
            let x = 0;
            for (let i = 0; i < barCount; i++) {
                const dataIndex = i * step;
                if (dataIndex >= bufferLength) break;

                // Get normalized value (-1 to 1)
                if (!dataArray) return;
                const normalizedValue = (dataArray[dataIndex] - 128) / 128;

                // Calculate rate of change (velocity) if we have previous data
                let velocityFactor = 1;
                if (
                    prevDataArrayRef.current.length > 0 &&
                    dataIndex < prevDataArrayRef.current.length
                ) {
                    const prevValue = prevDataArrayRef.current[dataIndex];
                    const change = Math.abs(normalizedValue - prevValue);
                    // Scale the velocity effect (adjust the multiplier as needed)
                    velocityFactor = 1 + change * 5;
                }

                // Base height from the value's deviation from center
                const baseHeight = Math.abs(normalizedValue) * height * 0.6;

                // Apply velocity factor to make bars taller when changing quickly
                const barHeight = Math.min(
                    baseHeight * velocityFactor,
                    height * 0.9,
                );

                // Draw bar centered vertically, but shift based on signal bias
                const yPosition = height / 2;

                // Always draw the full bar regardless of direction, then apply shifting
                // This ensures continuity between positive and negative values

                // Calculate an exponential offset - the further from center, the more dramatic the shift
                // Using Math.sign to keep the direction, and Math.pow for exponential effect
                const normalizedAbs = Math.abs(normalizedValue);
                const exponent = 1.1; // Adjust for more/less dramatic exponential effect
                const exponentialFactor =
                    Math.pow(normalizedAbs, exponent) / Math.pow(1, exponent);

                // Apply the exponential factor to our offset calculation
                // Increased base multiplier to 0.3 for more visible effect
                const centerOffset =
                    -Math.sign(normalizedValue) *
                    exponentialFactor *
                    height *
                    0.3;

                // Draw a complete bar from top to bottom to ensure visual continuity
                const barTop = Math.min(
                    // For positive values - shift the top down
                    normalizedValue >= 0
                        ? yPosition - barHeight + centerOffset
                        : yPosition + centerOffset,
                    // For negative values - shift the top up (but never above the bar height)
                    normalizedValue < 0
                        ? yPosition - barHeight + centerOffset
                        : yPosition + centerOffset,
                );

                const barBottom = Math.max(
                    // For positive values - the bottom is at center + offset
                    normalizedValue >= 0
                        ? yPosition + centerOffset
                        : yPosition + barHeight + centerOffset,
                    // For negative values - the bottom is at center + bar height + offset
                    normalizedValue < 0
                        ? yPosition + barHeight + centerOffset
                        : yPosition + centerOffset,
                );

                // Calculate actual height dynamically based on the dynamically determined top and bottom
                const actualBarHeight = barBottom - barTop;

                // Draw a single, continuous bar
                ctx.fillRect(x, barTop, barWidth, actualBarHeight);

                // Track peaks - create a new peak if we detect a significant peak
                // Use a probability-based approach with reduced frequency
                if (isPlaying) {
                    // Calculate probability based on the bar height relative to max height
                    const heightRatio = barHeight / (height * 2);
                    const peakProbability = Math.max(
                        0.001,
                        Math.min(0.6, heightRatio * 0.8),
                    );

                    // Random check based on lower probability
                    if (Math.random() < peakProbability) {
                        const peakY = normalizedValue >= 0 ? barTop : barBottom;

                        // Add the peak to our collection with full opacity
                        peaksRef.current.push({
                            x: x, // Left edge of the bar
                            y: peakY,
                            time: Date.now(),
                            opacity: 1,
                        });
                    }
                }

                x += barWidth + barGap;
                if (x > width) break;
            }

            // Draw all existing peaks as small squares matching the bar width
            const currentTime = Date.now();
            ctx.fillStyle = parsedColor;

            // Process and draw each peak
            peaksRef.current = peaksRef.current.filter((peak) => {
                // Calculate how long the peak has existed (in milliseconds)
                const age = currentTime - peak.time;

                // Peaks fade out over 250ms (0.25 second) - faster fade
                const fadeOutDuration = 250;

                // Calculate opacity based on age (1.0 to 0.0 over fadeOutDuration)
                peak.opacity = Math.max(0, 1 - age / fadeOutDuration);

                // Only keep peaks that still have opacity
                if (peak.opacity > 0) {
                    // Set opacity for this peak
                    ctx.globalAlpha = peak.opacity;

                    // Draw the peak as a square with the same width as the bars
                    ctx.fillRect(
                        peak.x, // X position (left edge)
                        peak.y - barWidth / 2, // Center the square on the peak point
                        barWidth, // Same width as the bars
                        barWidth, // Square height equals width
                    );

                    return true; // Keep this peak
                }

                return false; // Remove this peak (fully faded out)
            });

            // Reset global alpha for subsequent drawing
            ctx.globalAlpha = 1;

            // Store current data as previous for next frame
            if (isPlaying) {
                prevDataArrayRef.current = audioData.slice();
            }
        }

        // Continue animation loop if playing
        if (isPlaying) {
            animationRef.current = requestAnimationFrame(drawVisualization);
        }
    };

    // Handle animation frame updates
    useEffect(() => {
        if (isPlaying) {
            animationRef.current = requestAnimationFrame(drawVisualization);
        } else if (canvasRef.current) {
            // Draw static visualization when paused
            drawVisualization();
        }

        return () => {
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
            }
        };
    }, [isPlaying, audioData.length, variant]);

    const togglePlay = () => {
        if (!audioRef.current) return;

        if (isPlaying) {
            audioRef.current.pause();
        } else {
            try {
                // Initialize audio context if it hasn't been yet
                if (!audioContextRef.current && audioRef.current) {
                    // Get shared audio context
                    audioContextRef.current = getAudioContext();
                    analyserRef.current =
                        audioContextRef.current.createAnalyser();

                    // Use larger FFT size for line-bars, same as line
                    if (variant === "line-bars") {
                        analyserRef.current.fftSize = 2048;
                    } else {
                        analyserRef.current.fftSize =
                            variant === "line" ? 2048 : 512;
                    }

                    analyserRef.current.smoothingTimeConstant =
                        effectiveSmoothing;

                    // Get or create the media element source using our utility
                    sourceRef.current = getMediaElementSource(audioRef.current);

                    // Connect to our analyzer
                    sourceRef.current.connect(analyserRef.current);
                    analyserRef.current.connect(
                        audioContextRef.current.destination,
                    );

                    // Track the connected element
                    connectedElementRef.current = audioRef.current;
                }

                // Resume audio context if it's suspended
                if (audioContextRef.current?.state === "suspended") {
                    audioContextRef.current.resume();
                }

                audioRef.current.play().catch((error) => {
                    console.error("Error playing audio:", error);
                });
            } catch (error) {
                console.error("Error in togglePlay:", error);
            }
        }
    };

    useEffect(() => {
        if (!containerRef.current) return;

        // Function to instantly update canvas dimensions
        const updateCanvasSize = () => {
            if (!canvasRef.current || !containerRef.current) return;

            const canvas = canvasRef.current;

            // Get container dimensions
            const containerWidth = containerRef.current.clientWidth;
            const containerHeight = containerRef.current.clientHeight;
            const newHeight = containerHeight - 25;

            // Get current canvas dimensions
            const currentHeight = canvas.height;

            // When shrinking, use a two-step process with animation frame in between
            if (newHeight < currentHeight) {
                // Step 1: Set height to 0 to force immediate reflow
                canvas.height = 0;
                canvas.width = containerWidth;

                // Step 2: Use requestAnimationFrame to set the final height after browser has processed the initial change
                requestAnimationFrame(() => {
                    // Now get the container height again in case it changed during processing
                    const updatedHeight =
                        containerRef.current?.clientHeight ?? containerHeight;
                    const finalHeight = updatedHeight - 25;

                    // Apply the final dimensions
                    canvas.height = finalHeight;

                    // Update React state to keep it in sync
                    setCanvasHeight(finalHeight);

                    // Redraw visualization immediately
                    drawVisualization();
                });
            } else {
                // For growing, we can do it in one step
                canvas.width = containerWidth;
                canvas.height = newHeight;
                setCanvasHeight(newHeight);

                // Redraw if not playing
                if (!isPlaying) {
                    requestAnimationFrame(() => drawVisualization());
                }
            }
        };

        // Create a ResizeObserver with immediate callback
        resizeObserverRef.current = new ResizeObserver(() => {
            // Call the size update function directly
            updateCanvasSize();
        });

        // Observe the container for size changes
        resizeObserverRef.current.observe(containerRef.current);

        // Initial immediate size update
        updateCanvasSize();

        // Cleanup
        return () => {
            if (resizeObserverRef.current) {
                resizeObserverRef.current.disconnect();
            }
        };
    }, [isPlaying]);

    // Initialize a static visualization after component mount
    useEffect(() => {
        if (canvasRef.current && !isPlaying && audioData.length === 0) {
            // Add a slight delay to ensure the canvas has proper dimensions
            setTimeout(generateStaticVisualization, 100);
        }
    }, [variant, parsedColor]);

    // Regenerate visualization when color changes
    useEffect(() => {
        if (canvasRef.current && !isPlaying) {
            drawVisualization();
        }
    }, [parsedColor]);

    return (
        <div
            ref={containerRef}
            className={cn("flex flex-col space-y-2 border", className)}
        >
            <div className="relative h-full max-h-full overflow-hidden">
                <canvas
                    ref={canvasRef}
                    height={canvasHeight}
                    className={cn(
                        "h-full w-full",
                        !externalAudioRef && "cursor-pointer",
                    )}
                    onClick={externalAudioRef ? undefined : togglePlay}
                />

                {showPlayButton && !externalAudioRef && (
                    <button
                        onClick={togglePlay}
                        className={cn(
                            "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 transform",
                            "bg-background/90 flex h-12 w-12 items-center justify-center rounded-full",
                            "hover:bg-background shadow-md transition-opacity",
                            isPlaying
                                ? "opacity-0 hover:opacity-80"
                                : "opacity-80",
                        )}
                        aria-label={isPlaying ? "Pause" : "Play"}
                    >
                        {isPlaying ? (
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="h-5 w-5"
                            >
                                <rect x="6" y="4" width="4" height="16" />
                                <rect x="14" y="4" width="4" height="16" />
                            </svg>
                        ) : (
                            <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="h-5 w-5"
                            >
                                <polygon points="5 3 19 12 5 21 5 3" />
                            </svg>
                        )}
                    </button>
                )}
            </div>

            {/* Only render internal audio element if not using external audio */}
            {!externalAudioRef && src && (
                <audio ref={internalAudioRef} src={src} preload="metadata" />
            )}
        </div>
    );
}
