import React, { useCallback } from "react";
import { useEffect, useRef, useState } from "react";

interface AudioWaveformProps {
    videoPath: string;
    height?: number;
    width?: number;
    color?: string;
    backgroundColor?: string;
    sampleCount?: number;
    className?: string;
    audioTrack?: number;
    minBarHeight?: number;
}

function useAudioWaveform(
    videoPath: string,
    sampleCount: number,
    audioTrack: number,
) {
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [waveformKey, setWaveformKey] = useState(`waveform-${audioTrack}`);
    const [waveformData, setWaveformData] = useState<Float32Array | null>(null);

    const fetchWaveformData = useCallback(async () => {
        if (!videoPath) return;

        setIsLoading(true);
        setError(null);

        try {
            const data = await window.audioWaveform.extractWaveform(
                videoPath,
                sampleCount,
                audioTrack,
            );

            if (!data) {
                throw new Error("Failed to extract waveform data");
            }

            setWaveformData(data);
            setWaveformKey(`waveform-${audioTrack}-${Date.now()}`);
            setIsLoading(false);
        } catch (err) {
            console.error("Error generating waveform:", err);
            setError(
                err instanceof Error ? err.message : "Unknown error occurred",
            );
            setIsLoading(false);
        }
    }, [videoPath, sampleCount, audioTrack]);

    useEffect(() => {
        fetchWaveformData();
    }, [fetchWaveformData]);

    return { isLoading, error, waveformData, waveformKey };
}

const VideoWaveformComponent = ({
    videoPath,
    height = 100,
    width = 600,
    color = "#3b82f6",
    backgroundColor = "#f1f5f9",
    sampleCount = 1000,
    className = "",
    audioTrack = 0,
    minBarHeight = 2,
}: AudioWaveformProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const { isLoading, error, waveformData, waveformKey } = useAudioWaveform(
        videoPath,
        sampleCount,
        audioTrack,
    );

    // Effect to render waveform data to canvas when data changes
    useEffect(() => {
        if (!waveformData || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Parse CSS variables if needed
        const getComputedColor = (colorValue: string) => {
            if (colorValue.startsWith("var(")) {
                // Extract the CSS variable name
                const cssVarName = colorValue.match(/var\((.*?)\)/)?.[1];
                if (cssVarName) {
                    // Get the computed value
                    const computedColor = getComputedStyle(
                        document.documentElement,
                    )
                        .getPropertyValue(cssVarName)
                        .trim();
                    return computedColor || colorValue;
                }
            }
            return colorValue;
        };

        const bgColor = getComputedColor(backgroundColor);
        const waveColor = getComputedColor(color);

        // Clear canvas
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, width, height);

        // Calculate dimensions
        const barWidth = width / waveformData.length;
        const centerY = height / 2;

        // Draw waveform
        ctx.fillStyle = waveColor;

        for (let i = 0; i < waveformData.length; i++) {
            const amplitude = waveformData[i];
            const barHeight = Math.max(minBarHeight, amplitude * height * 0.8); // Use minBarHeight prop

            // Draw bar
            ctx.fillRect(
                i * barWidth,
                centerY - barHeight / 2,
                barWidth > 1 ? barWidth - 0.5 : barWidth,
                barHeight,
            );
        }
    }, [
        waveformData,
        canvasRef,
        backgroundColor,
        color,
        width,
        height,
        minBarHeight,
    ]);

    if (isLoading) {
        return (
            <div className={`relative h-full w-full ${className}`}>
                <div
                    className="absolute top-1/2 w-full"
                    style={{
                        height: `${minBarHeight / 3}px`,
                        backgroundColor: color.startsWith("var(")
                            ? `var(${color.match(/var\((.*?)\)/)?.[1]})`
                            : color,
                        transform: "translateY(-50%)",
                    }}
                />
            </div>
        );
    }

    if (error) {
        return (
            <p className="text-destructive text-sm">
                Failed to load waveform: {error}
            </p>
        );
    }

    // Apply a container with adjusted position to match the time indicator offset
    return (
        <div ref={containerRef} className="relative h-full" key={waveformKey}>
            <canvas
                ref={canvasRef}
                width={width}
                height={height}
                className={`h-full w-full ${className}`}
            />
        </div>
    );
};

export const VideoWaveform = React.memo(VideoWaveformComponent);
