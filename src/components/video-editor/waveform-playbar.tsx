import {
    ChevronRight,
    SkipForward,
    SkipBack,
    ChevronLast,
    ChevronFirst,
    Scissors,
    X,
} from "lucide-react";
import { Fragment, memo, useEffect, useRef, useState } from "react";
import type * as React from "react";

import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuSeparator,
    ContextMenuShortcutItem,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useSetting, useShortcutSetting } from "@/lib/settings";
import { cn } from "@/lib/utils";
import type { Cut, TimeRange } from "@/types";

import { useAudioWaveform, VideoWaveform } from "./video-waveform";

interface WaveformPlaybarProps {
    videoPath: string;
    currentTime: number;
    duration: number;
    timeRange: TimeRange;
    onTimeChange: (time: number) => void;
    onTimeRangeChange: (range: TimeRange) => void;
    cuts: Cut[];
    onCutsChange: (cuts: Cut[]) => void;
    audioTrack?: number;
    waveformHeight?: number;
}

export const WaveformPlaybar = memo(function WaveformPlaybar({
    videoPath,
    currentTime,
    duration,
    timeRange,
    onTimeChange,
    onTimeRangeChange,
    cuts = [],
    onCutsChange,
    audioTrack = 0,
    waveformHeight = 50,
}: WaveformPlaybarProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [isDraggingStart, setIsDraggingStart] = useState(false);
    const [isDraggingEnd, setIsDraggingEnd] = useState(false);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [contextMenuPoint, setContextMenuPoint] = useState<number | null>(null);
    const [cutDragIndex, setCutDragIndex] = useState<{
        idx: number;
        edge: "start" | "end";
    } | null>(null);

    // Shortcut labels for the context menu (settings-driven).
    const shortcutSkipToStart = useSetting("shortcut_skipToStart");
    const shortcutSkipToStartMarker = useSetting("shortcut_skipToStartMarker");
    const shortcutSkipToEndMarker = useSetting("shortcut_skipToEndMarker");
    const shortcutSkipToEnd = useSetting("shortcut_skipToEnd");
    const shortcutSetStartMarker = useSetting("shortcut_setStartMarker");
    const shortcutSetEndMarker = useSetting("shortcut_setEndMarker");
    const shortcutAddCut = useSetting("shortcut_addCut");

    // Derived during render so the waveform remounts the moment the clip or
    // audio track changes (no effect-driven state sync).
    const waveformKey = `${videoPath}-${audioTrack}`;

    const {
        isLoading: waveformIsLoading,
        error: waveformError,
        waveformData,
    } = useAudioWaveform(videoPath, 5000, audioTrack);

    const currentTimePercent = (currentTime / Math.max(0.1, duration)) * 100;
    const startMarkerPercent = (timeRange.start / Math.max(0.1, duration)) * 100;
    const endMarkerPercent = (timeRange.end / Math.max(0.1, duration)) * 100;

    const handleContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (isDraggingStart || isDraggingEnd || cutDragIndex) return;

        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const x = e.clientX - rect.left;
        const percentage = Math.max(0, Math.min(1, x / rect.width));
        onTimeChange(percentage * duration);
    };

    const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.button === 2 || isDraggingStart || isDraggingEnd || cutDragIndex) return;

        setIsScrubbing(true);

        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const x = e.clientX - rect.left;
        const percentage = Math.max(0, Math.min(1, x / rect.width));
        onTimeChange(percentage * duration);
    };

    const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const x = e.clientX - rect.left;
        const percentage = Math.max(0, Math.min(1, x / rect.width));
        setContextMenuPoint(percentage * duration);
    };

    const goToStart = () => onTimeChange(0);
    const goToEnd = () => onTimeChange(duration);
    const goToStartMarker = () => onTimeChange(timeRange.start);
    const goToEndMarker = () => onTimeChange(timeRange.end);

    useShortcutSetting("skipToStartMarker", goToStartMarker);
    useShortcutSetting("skipToEndMarker", goToEndMarker);

    const setStartMarkerFromContextMenu = () => {
        if (contextMenuPoint === null) return;
        const newStart = Math.min(contextMenuPoint, timeRange.end - 0.1);
        onTimeRangeChange({ ...timeRange, start: Math.max(0, newStart) });
    };

    const setEndMarkerFromContextMenu = () => {
        if (contextMenuPoint === null) return;
        const newEnd = Math.max(contextMenuPoint, timeRange.start + 0.1);
        onTimeRangeChange({ ...timeRange, end: Math.min(duration, newEnd) });
    };

    const handleRangeMarkerChange = (type: "start" | "end", value: number) => {
        if (type === "start") {
            const newStart = Math.min(value, timeRange.end - 0.1);
            onTimeRangeChange({ ...timeRange, start: Math.max(0, newStart) });
        } else {
            const newEnd = Math.max(value, timeRange.start + 0.1);
            onTimeRangeChange({ ...timeRange, end: Math.min(duration, newEnd) });
        }
    };

    const handleRemoveCut = (idx: number) => {
        onCutsChange(cuts.filter((_, i) => i !== idx));
    };

    const handleCutEdgeChange = (idx: number, edge: "start" | "end", value: number) => {
        const cut = cuts[idx];
        let newStart = cut.start;
        let newEnd = cut.end;
        if (edge === "start") {
            newStart = Math.max(timeRange.start, Math.min(value, cut.end - 0.05));
        } else {
            newEnd = Math.min(timeRange.end, Math.max(value, cut.start + 0.05));
        }
        for (let i = 0; i < cuts.length; i++) {
            if (i === idx) continue;
            const other = cuts[i];
            if (newStart < other.end && newEnd > other.start) {
                return;
            }
        }
        const updated = cuts.map((c, i) => (i === idx ? { start: newStart, end: newEnd } : c));
        onCutsChange(updated);
    };

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (
                !containerRef.current ||
                (!isDraggingStart && !isDraggingEnd && !isDragging && !isScrubbing && !cutDragIndex)
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
            } else if (cutDragIndex) {
                handleCutEdgeChange(cutDragIndex.idx, cutDragIndex.edge, newValue);
            }
        };

        const handleMouseUp = () => {
            setIsDragging(false);
            setIsDraggingStart(false);
            setIsDraggingEnd(false);
            setIsScrubbing(false);
            setCutDragIndex(null);
        };

        window.addEventListener("mousemove", handleMouseMove);
        window.addEventListener("mouseup", handleMouseUp);

        return () => {
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
        };
    });

    const selectedClipStyles = {
        clipPath: `polygon(
      ${startMarkerPercent}% 0%,
      ${endMarkerPercent}% 0%,
      ${endMarkerPercent}% 100%,
      ${startMarkerPercent}% 100%
    )`,
    };

    const isSetStartMarkerDisabled =
        contextMenuPoint !== null &&
        (contextMenuPoint >= timeRange.end - 0.1 || contextMenuPoint < 0);

    const isSetEndMarkerDisabled =
        contextMenuPoint !== null &&
        (contextMenuPoint <= timeRange.start + 0.1 || contextMenuPoint > duration);

    const getCutPercent = (t: number) => (t / Math.max(0.1, duration)) * 100;

    const handleAddCut = () => {
        if (
            contextMenuPoint === null ||
            contextMenuPoint <= timeRange.start + 0.05 ||
            contextMenuPoint >= timeRange.end - 0.05
        )
            return;
        const cutWidth = 0.5;
        const cutStart = Math.max(
            timeRange.start,
            Math.min(contextMenuPoint - cutWidth / 2, timeRange.end - cutWidth),
        );
        const cutEnd = Math.min(timeRange.end, cutStart + cutWidth);
        for (const c of cuts) {
            if (
                (cutStart >= c.start && cutStart < c.end) ||
                (cutEnd > c.start && cutEnd <= c.end)
            ) {
                return;
            }
        }
        onCutsChange([...cuts, { start: cutStart, end: cutEnd }]);
    };

    useShortcutSetting("addCut", () => {
        const cutWidth = 0.5;
        const cutEnd = Math.min(timeRange.end, currentTime + cutWidth);
        onCutsChange([...cuts, { start: currentTime, end: cutEnd }]);
    });

    useShortcutSetting("setEndCut", () => {
        if (cuts.length === 0) return;

        let bestIdx = -1;
        let bestStart = -Infinity;
        for (let i = 0; i < cuts.length; i++) {
            const cut = cuts[i];
            if (cut.start <= currentTime && cut.start > bestStart) {
                bestStart = cut.start;
                bestIdx = i;
            }
        }
        if (bestIdx === -1) return;

        const newEnd = Math.max(Math.min(currentTime, timeRange.end), cuts[bestIdx].start + 0.05);
        if (bestIdx < cuts.length - 1 && newEnd > cuts[bestIdx + 1].start) {
            return;
        }

        const updated = cuts.map((c, i) => (i === bestIdx ? { ...c, end: newEnd } : c));
        onCutsChange(updated);
    });

    useShortcutSetting("setStartMarker", () => {
        if (currentTime >= timeRange.end - 0.1 || currentTime < 0) return;
        const newStart = Math.min(currentTime, timeRange.end - 0.1);
        onTimeRangeChange({ ...timeRange, start: Math.max(0, newStart) });
    });

    useShortcutSetting("setEndMarker", () => {
        if (currentTime <= timeRange.start + 0.1 || currentTime > duration) return;
        const newEnd = Math.max(currentTime, timeRange.start + 0.1);
        onTimeRangeChange({ ...timeRange, end: Math.min(duration, newEnd) });
    });

    return (
        <ContextMenu>
            <ContextMenuTrigger>
                <div
                    ref={containerRef}
                    className={cn(
                        "relative h-10 w-full cursor-pointer transition-all duration-200 hover:brightness-110",
                        isScrubbing && "cursor-grabbing",
                    )}
                    onClick={handleContainerClick}
                    onMouseDown={handleMouseDown}
                    onContextMenu={handleContextMenu}
                >
                    <div className="relative h-full w-full">
                        <VideoWaveform
                            key={`base-${waveformKey}`}
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
                    <div className="absolute top-0 left-0 h-full w-full" style={selectedClipStyles}>
                        <VideoWaveform
                            key={`selected-${waveformKey}`}
                            waveformData={waveformData}
                            isLoading={waveformIsLoading}
                            error={waveformError}
                            height={waveformHeight}
                            width={4000}
                            color="var(--accent-color)"
                            backgroundColor="transparent"
                            minBarHeight={3}
                        />
                    </div>
                    <div
                        className={cn(
                            "bg-primary absolute top-0 z-10 h-full w-0.5",
                            isScrubbing && "bg-primary/80",
                        )}
                        style={{ left: `${currentTimePercent}%` }}
                    />
                    <div
                        className={cn(
                            "border-primary/70 absolute top-0 z-20 h-full w-0.5 -translate-x-1/2 cursor-col-resize border-r border-l",
                            isDraggingStart && "border-opacity-100 border-primary w-[2px]",
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
                    <div
                        className={cn(
                            "border-primary/70 absolute top-0 z-20 h-full w-0.5 -translate-x-1/2 cursor-col-resize border-r border-l",
                            isDraggingEnd && "border-opacity-100 border-primary w-[2px]",
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
                    {cuts.map((cut, idx) => {
                        const cutStartPercent = getCutPercent(cut.start);
                        const cutEndPercent = getCutPercent(cut.end);
                        const isDraggingCutStart =
                            cutDragIndex?.idx === idx && cutDragIndex?.edge === "start";
                        const isDraggingCutEnd =
                            cutDragIndex?.idx === idx && cutDragIndex?.edge === "end";

                        return (
                            <Fragment key={idx}>
                                <div
                                    className="pointer-events-none absolute top-0 z-15 h-full bg-red-500/30"
                                    style={{
                                        left: `${cutStartPercent}%`,
                                        width: `${cutEndPercent - cutStartPercent}%`,
                                    }}
                                />
                                <div
                                    className={cn(
                                        "absolute top-0 z-25 h-full w-0.5 -translate-x-1/2 cursor-col-resize border-r border-l border-red-500/70",
                                        isDraggingCutStart &&
                                            "border-opacity-100 w-[2px] border-red-500",
                                    )}
                                    style={{ left: `${cutStartPercent}%` }}
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setCutDragIndex({ idx, edge: "start" });
                                    }}
                                >
                                    <div className="absolute top-0 left-0 h-0.5 w-1.5 -translate-x-1/2 bg-red-500" />
                                    <div className="absolute bottom-0 left-0 h-0.5 w-1.5 -translate-x-1/2 bg-red-500" />
                                </div>
                                <div
                                    className={cn(
                                        "absolute top-0 z-25 h-full w-0.5 -translate-x-1/2 cursor-col-resize border-r border-l border-red-500/70",
                                        isDraggingCutEnd &&
                                            "border-opacity-100 w-[2px] border-red-500",
                                    )}
                                    style={{ left: `${cutEndPercent}%` }}
                                    onMouseDown={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        setCutDragIndex({ idx, edge: "end" });
                                    }}
                                >
                                    <div className="absolute top-0 left-0 h-0.5 w-1.5 -translate-x-1/2 bg-red-500" />
                                    <div className="absolute bottom-0 left-0 h-0.5 w-1.5 -translate-x-1/2 bg-red-500" />
                                </div>
                                <div
                                    className="absolute top-2 z-40"
                                    style={{
                                        left: `calc(${(cutStartPercent + cutEndPercent) / 2}% - 8px)`,
                                    }}
                                >
                                    <button
                                        type="button"
                                        className="rounded-full bg-red-600/80 p-0.5 text-white shadow transition-colors hover:bg-red-700/90"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            handleRemoveCut(idx);
                                        }}
                                    >
                                        <X className="h-2.5 w-2.5" />
                                    </button>
                                </div>
                            </Fragment>
                        );
                    })}
                </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-auto">
                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <ChevronRight className="mr-2 h-4 w-4" />
                        Go to
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                        <ContextMenuShortcutItem
                            onClick={goToStart}
                            keys={shortcutSkipToStart as string}
                        >
                            <ChevronFirst className="h-4 w-4" />
                            Start
                        </ContextMenuShortcutItem>
                        <ContextMenuShortcutItem
                            onClick={goToStartMarker}
                            keys={shortcutSkipToStartMarker as string}
                        >
                            <SkipBack className="h-4 w-4" />
                            Start marker
                        </ContextMenuShortcutItem>
                        <ContextMenuShortcutItem
                            onClick={goToEndMarker}
                            keys={shortcutSkipToEndMarker as string}
                        >
                            <SkipForward className="h-4 w-4" />
                            End marker
                        </ContextMenuShortcutItem>
                        <ContextMenuShortcutItem
                            onClick={goToEnd}
                            keys={shortcutSkipToEnd as string}
                        >
                            <ChevronLast className="h-4 w-4" />
                            End
                        </ContextMenuShortcutItem>
                    </ContextMenuSubContent>
                </ContextMenuSub>
                <ContextMenuSeparator />
                <ContextMenuShortcutItem
                    onClick={setStartMarkerFromContextMenu}
                    keys={shortcutSetStartMarker as string}
                    disabled={isSetStartMarkerDisabled}
                >
                    <SkipBack className="h-4 w-4" />
                    Set start marker
                </ContextMenuShortcutItem>
                <ContextMenuShortcutItem
                    onClick={setEndMarkerFromContextMenu}
                    keys={shortcutSetEndMarker as string}
                    disabled={isSetEndMarkerDisabled}
                >
                    <SkipForward className="h-4 w-4" />
                    Set end marker
                </ContextMenuShortcutItem>
                <ContextMenuShortcutItem
                    onClick={handleAddCut}
                    keys={shortcutAddCut as string}
                    disabled={
                        contextMenuPoint === null ||
                        contextMenuPoint <= timeRange.start + 0.05 ||
                        contextMenuPoint >= timeRange.end - 0.05
                    }
                >
                    <Scissors className="h-4 w-4 text-red-500" />
                    Add cut here
                </ContextMenuShortcutItem>
            </ContextMenuContent>
        </ContextMenu>
    );
});
