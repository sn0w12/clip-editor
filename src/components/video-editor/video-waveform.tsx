import { memo, useEffect, useRef, useState } from "react";

import { getWaveform } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * Loads normalized (0..1) waveform samples for a clip. Port of the legacy
 * `useAudioWaveform` hook, backed by the Tauri `get_waveform` command.
 */
export function useAudioWaveform(
    videoPath: string,
    sampleCount: number,
    audioTrack: number,
): {
    isLoading: boolean;
    error: string | null;
    waveformData: number[] | null;
    waveformKey: string;
} {
    const [result, setResult] = useState<{
        data: number[] | null;
        error: string | null;
        key: string;
        audioTrack: number;
    } | null>(null);

    useEffect(() => {
        let cancelled = false;
        if (!videoPath) {
            return () => {
                cancelled = true;
            };
        }

        getWaveform(videoPath, sampleCount, audioTrack)
            .then((data) => {
                if (cancelled) return;
                if (!data) throw new Error("Failed to extract waveform data");
                setResult({
                    data,
                    error: null,
                    key: `waveform-${audioTrack}-${Date.now()}`,
                    audioTrack,
                });
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setResult({
                    data: null,
                    error: err instanceof Error ? err.message : String(err),
                    key: `waveform-${audioTrack}-error`,
                    audioTrack,
                });
            });

        return () => {
            cancelled = true;
        };
    }, [videoPath, sampleCount, audioTrack]);

    // Derive the current view from the latest fetch result; while a fetch is in
    // flight (or the inputs changed) fall back to the pending state.
    const current = videoPath && result?.audioTrack === audioTrack ? result : null;
    const isLoading = Boolean(videoPath) && !current;
    const waveformData = current?.data ?? null;
    const error = current?.error ?? null;
    const waveformKey = current?.key ?? `waveform-${audioTrack}-pending`;

    return { isLoading, error, waveformData, waveformKey };
}

function resolveCssVar(colorValue: string): string {
    if (colorValue.startsWith("var(")) {
        const cssVarName = colorValue.match(/var\((.*?)\)/)?.[1];
        if (cssVarName) {
            const computed = getComputedStyle(document.documentElement)
                .getPropertyValue(cssVarName)
                .trim();
            if (computed) return computed;
        }
    }
    return colorValue;
}

interface VideoWaveformProps {
    waveformData: number[] | null;
    isLoading: boolean;
    error: string | null;
    height?: number;
    width?: number;
    color?: string;
    backgroundColor?: string;
    className?: string;
    minBarHeight?: number;
}

const VideoWaveformComponent = ({
    waveformData,
    isLoading,
    error,
    height = 100,
    width = 600,
    color = "#3b82f6",
    backgroundColor = "#f1f5f9",
    className = "",
    minBarHeight = 2,
}: VideoWaveformProps) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!waveformData || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const bgColor = resolveCssVar(backgroundColor);
        const waveColor = resolveCssVar(color);

        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, width, height);

        const barWidth = width / waveformData.length;
        const centerY = height / 2;

        ctx.fillStyle = waveColor;

        for (let i = 0; i < waveformData.length; i++) {
            const amplitude = waveformData[i];
            const barHeight = Math.max(minBarHeight, amplitude * height * 0.8);
            ctx.fillRect(
                i * barWidth,
                centerY - barHeight / 2,
                barWidth > 1 ? barWidth - 0.5 : barWidth,
                barHeight,
            );
        }
    }, [waveformData, backgroundColor, color, width, height, minBarHeight]);

    if (isLoading) {
        const varName = color.startsWith("var(")
            ? (color.match(/var\((.*?)\)/)?.[1] ?? null)
            : null;
        return (
            <div className={cn("relative h-full w-full", className)}>
                <div
                    className="absolute top-1/2 w-full"
                    style={{
                        height: `${minBarHeight / 3}px`,
                        backgroundColor: varName ? `var(${varName})` : color,
                        transform: "translateY(-50%)",
                    }}
                />
            </div>
        );
    }

    if (error) {
        return (
            <p className={cn("text-destructive text-sm", className)}>
                Failed to load waveform: {error}
            </p>
        );
    }

    if (!waveformData) {
        return <div className={cn("relative h-full w-full", className)} />;
    }

    return (
        <div className={cn("relative h-full", className)}>
            <canvas ref={canvasRef} width={width} height={height} className="h-full w-full" />
        </div>
    );
};

export const VideoWaveform = memo(VideoWaveformComponent);
