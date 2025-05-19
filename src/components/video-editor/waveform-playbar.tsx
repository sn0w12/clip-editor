import React, { useRef, useState, useEffect, memo } from "react";
import { useAudioWaveform, VideoWaveform } from "./video-waveform";
import { TimeRange } from "@/types/video-editor";
import { cn } from "@/utils/tailwind";

interface WaveformPlaybarProps {
    videoPath: string;
    currentTime: number;
    duration: number;
    timeRange: TimeRange;
    onTimeChange: (time: number) => void;
    onTimeRangeChange: (range: TimeRange) => void;
    audioTrack?: number;
    waveformHeight?: number;
}

// Memoize the component to prevent unnecessary re-renders
export const WaveformPlaybar = memo(function WaveformPlaybar({
    videoPath,
    currentTime,
    duration,
    timeRange,
    onTimeChange,
    onTimeRangeChange,
    audioTrack = 0,
    waveformHeight = 50,
}: WaveformPlaybarProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [isDraggingStart, setIsDraggingStart] = useState(false);
    const [isDraggingEnd, setIsDraggingEnd] = useState(false);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [key, setKey] = useState(`${videoPath}-${audioTrack}`);

    // Update the key when videoPath or audioTrack changes to force re-render of waveform
    useEffect(() => {
        setKey(`${videoPath}-${audioTrack}`);
    }, [videoPath, audioTrack]);

    const {
        isLoading: waveformIsLoading,
        error: waveformError,
        waveformData,
    } = useAudioWaveform(videoPath, 5000, audioTrack);

    // Calculate positions for current time and markers
    const currentTimePercent = (currentTime / Math.max(0.1, duration)) * 100;
    const startMarkerPercent =
        (timeRange.start / Math.max(0.1, duration)) * 100;
    const endMarkerPercent = (timeRange.end / Math.max(0.1, duration)) * 100;

    // Handle clicking on the waveform to change time
    const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (isDraggingStart || isDraggingEnd) return;

        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const x = e.clientX - rect.left;
        const percentage = Math.max(0, Math.min(1, x / rect.width));
        const newTime = percentage * duration;
        onTimeChange(newTime);
    };

    // Start scrubbing
    const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        if (isDraggingStart || isDraggingEnd) return;

        setIsScrubbing(true);

        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const x = e.clientX - rect.left;
        const percentage = Math.max(0, Math.min(1, x / rect.width));
        const newTime = percentage * duration;
        onTimeChange(newTime);
    };

    // Handle range marker changes
    const handleRangeMarkerChange = (type: "start" | "end", value: number) => {
        if (type === "start") {
            const newStart = Math.min(value, timeRange.end - 0.1);
            onTimeRangeChange({ ...timeRange, start: Math.max(0, newStart) });
        } else {
            const newEnd = Math.max(value, timeRange.start + 0.1);
            onTimeRangeChange({
                ...timeRange,
                end: Math.min(duration, newEnd),
            });
        }
    };

    // Set up mouse move and mouse up event listeners
    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (
                !containerRef.current ||
                (!isDraggingStart &&
                    !isDraggingEnd &&
                    !isDragging &&
                    !isScrubbing)
            )
                return;

            const rect = containerRef.current.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const percentage = Math.max(0, Math.min(1, x / rect.width));
            const newValue = percentage * duration;

            if (isDraggingStart) {
                handleRangeMarkerChange("start", newValue);
            } else if (isDraggingEnd) {
                handleRangeMarkerChange("end", newValue);
            } else if (isDragging || isScrubbing) {
                onTimeChange(newValue);
            }
        };

        const handleMouseUp = () => {
            setIsDragging(false);
            setIsDraggingStart(false);
            setIsDraggingEnd(false);
            setIsScrubbing(false);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);

        return () => {
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };
    }, [
        isDragging,
        isDraggingStart,
        isDraggingEnd,
        isScrubbing,
        duration,
        onTimeChange,
        onTimeRangeChange,
        timeRange,
    ]);

    // Prepare clipping mask for the selected region
    const selectedClipStyles = {
        clipPath: `polygon(
            ${startMarkerPercent}% 0%,
            ${endMarkerPercent}% 0%,
            ${endMarkerPercent}% 100%,
            ${startMarkerPercent}% 100%
        )`,
    };

    return (
        <div
            ref={containerRef}
            className={cn(
                "relative h-10 w-full cursor-pointer transition-all duration-200 hover:brightness-110",
                isScrubbing && "cursor-grabbing",
            )}
            onClick={handleContainerClick}
            onMouseDown={handleMouseDown}
        >
            {/* Base waveform (unselected areas) */}
            <div className="relative h-full w-full">
                <VideoWaveform
                    key={`base-${key}`}
                    waveformData={waveformData}
                    isLoading={waveformIsLoading}
                    error={waveformError}
                    height={waveformHeight}
                    width={4000}
                    color="rgba(255, 255, 255, 0.6)"
                    backgroundColor="transparent"
                    minBarHeight={3}
                />
            </div>
            {/* Overlay for selected area (colored waveform) */}
            <div
                className="absolute top-0 left-0 h-full w-full"
                style={selectedClipStyles}
            >
                <VideoWaveform
                    key={`selected-${key}`}
                    waveformData={waveformData}
                    isLoading={waveformIsLoading}
                    error={waveformError}
                    height={waveformHeight}
                    width={4000}
                    color="var(--accent-positive)"
                    backgroundColor="transparent"
                    minBarHeight={3}
                />
            </div>
            {/* Current time indicator */}
            <div
                className={cn(
                    "bg-primary absolute top-0 z-10 h-full w-0.5",
                    isScrubbing && "bg-accent-warning",
                )}
                style={{ left: `${currentTimePercent}%` }}
            />
            {/* Start marker */}
            <div
                className={cn(
                    "border-primary/70 absolute top-0 z-20 h-full w-0.5 -translate-x-1/2 cursor-col-resize border-r border-l",
                    isDraggingStart &&
                        "border-opacity-100 border-primary w-[2px]",
                )}
                style={{ left: `${startMarkerPercent}%` }}
                onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDraggingStart(true);
                }}
            >
                <div className="bg-primary absolute top-0 left-0 h-0.5 w-1.5 -translate-x-1/2" />
                <div className="bg-primary absolute bottom-0 left-0 h-0.5 w-1.5 -translate-x-1/2" />
            </div>
            {/* End marker */}
            <div
                className={cn(
                    "border-primary/70 absolute top-0 z-20 h-full w-0.5 -translate-x-1/2 cursor-col-resize border-r border-l",
                    isDraggingEnd &&
                        "border-opacity-100 border-primary w-[2px]",
                )}
                style={{ left: `${endMarkerPercent}%` }}
                onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setIsDraggingEnd(true);
                }}
            >
                <div className="bg-primary absolute top-0 left-0 h-0.5 w-1.5 -translate-x-1/2" />
                <div className="bg-primary absolute bottom-0 left-0 h-0.5 w-1.5 -translate-x-1/2" />
            </div>
        </div>
    );
});
