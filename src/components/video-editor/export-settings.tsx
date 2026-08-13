import { useEffect, useMemo, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PreviousExports } from "@/components/video-editor/previous-exports";
import { useSetting } from "@/lib/settings";
import { getPreviousExports } from "@/lib/tauri";
import type { Cut, ExportedClip, ExportOptions, TimeRange, VideoMetadata } from "@/types";

import { ScrollArea } from "../ui/scroll-area";
import { formatTime } from "./clip-video-player";
import { ExportButton } from "./export-button";

const QUALITY_PRESETS = [
    { label: "High (4000kbps)", value: "high" },
    { label: "Medium (2500kbps)", value: "medium" },
    { label: "Low (1000kbps)", value: "low" },
];

const OUTPUT_FORMATS = [
    { label: "MP4", value: "mp4" },
    { label: "WebM", value: "webm" },
    { label: "MOV", value: "mov" },
    { label: "MKV", value: "mkv" },
    { label: "GIF", value: "gif" },
];

interface ExportSettingsProps {
    videoMetadata: VideoMetadata | null;
    timeRange: TimeRange;
    onExport: (options: ExportOptions) => void;
    isExporting: boolean;
    audioTracks?: { index: number; label: string }[];
    videoPath: string;
    onSelectClip: (clipPath: string | null, clipDuration: number | null) => void;
    selectedClipPath: string | null;
    cuts: Cut[];
}

export function ExportSettings({
    videoMetadata,
    timeRange,
    onExport,
    isExporting,
    audioTracks = [],
    videoPath,
    onSelectClip,
    selectedClipPath,
    cuts = [],
}: ExportSettingsProps) {
    const [outputFormat, setOutputFormat] = useState<string>(
        useSetting<string>("defaultExportFormat") ?? "mp4",
    );
    const [quality, setQuality] = useState<string>(
        useSetting<string>("defaultExportQuality") ?? "medium",
    );
    const [qualityMode, setQualityMode] = useState<"preset" | "targetSize">("preset");
    const [targetSize, setTargetSize] = useState<number>(10);
    const [resolutionPercent, setResolutionPercent] = useState<number>(100);
    const [audioBitrate, setAudioBitrate] = useState<number>(128);
    const [trackOverrides, setTrackOverrides] = useState<number[] | null>(null);
    const [fpsOverride, setFpsOverride] = useState<number | undefined>(undefined);
    const [activeTab, setActiveTab] = useState<string>("settings");
    const [exports, setExports] = useState<ExportedClip[]>([]);
    const [isClipsLoading, setIsClipsLoading] = useState(true);
    const defaultAudioTrackSetting = useSetting<string>("defaultAudioTrack");

    useEffect(() => {
        async function fetchExports() {
            setIsClipsLoading(true);
            try {
                const result = await getPreviousExports(videoPath);
                setExports(result || []);
            } catch (error) {
                console.error("Error fetching exports:", error);
            } finally {
                setIsClipsLoading(false);
            }
        }

        if (videoPath) {
            void fetchExports();
        }

        const handleVideoExported = () => {
            void fetchExports();
        };

        window.addEventListener("video-exported", handleVideoExported);
        return () => {
            window.removeEventListener("video-exported", handleVideoExported);
        };
    }, [videoPath]);

    // Everything below is derived during render (no effect-driven state sync).
    const width = videoMetadata
        ? Math.round(videoMetadata.width * (resolutionPercent / 100))
        : undefined;
    const height = videoMetadata
        ? Math.round(videoMetadata.height * (resolutionPercent / 100))
        : undefined;
    const fps = fpsOverride ?? videoMetadata?.fps;

    // Default audio-track selection applies until the user overrides it.
    const defaultAudioTrackIndex =
        audioTracks.length > 0
            ? Math.min(
                  Math.max(Number.parseInt(defaultAudioTrackSetting ?? "0", 10) || 0, 0),
                  audioTracks.length - 1,
              )
            : 0;
    const selectedAudioTracks = useMemo(
        () => (audioTracks.length === 0 ? [] : (trackOverrides ?? [defaultAudioTrackIndex])),
        [audioTracks.length, trackOverrides, defaultAudioTrackIndex],
    );

    const handleAudioTrackChange = (trackIndex: number, checked: boolean) => {
        const current = selectedAudioTracks;
        setTrackOverrides(
            checked ? [...current, trackIndex] : current.filter((index) => index !== trackIndex),
        );
    };

    const clipDuration = timeRange.end - timeRange.start;

    // Estimate file size from duration, quality mode, and resolution.
    const { estimatedFileSize, estimatedBitrate } = useMemo(() => {
        if (!videoMetadata) {
            return { estimatedFileSize: "0 MB", estimatedBitrate: "0 kbps" };
        }

        let duration = clipDuration;

        if (cuts && cuts.length > 0) {
            const cutDuration = cuts.reduce((total, cut) => {
                const cutStart = Math.max(cut.start, timeRange.start);
                const cutEnd = Math.min(cut.end, timeRange.end);

                if (cutStart < cutEnd) {
                    return total + (cutEnd - cutStart);
                }
                return total;
            }, 0);

            duration = clipDuration - cutDuration;
            duration = Math.max(duration, 0);
        }

        let videoBitrate = 0;

        if (qualityMode === "preset") {
            const bitrates: Record<string, number> = {
                high: 4000000, // 4000kbps
                medium: 2500000, // 2500kbps
                low: 1000000, // 1000kbps
            };

            videoBitrate = bitrates[quality] ?? 2500000;
        } else {
            const targetSizeInBits = targetSize * 8 * 1024 * 1024;
            const hasAudio = selectedAudioTracks.length > 0;
            const audioBitrateToUse = hasAudio ? audioBitrate * 1000 : 0;
            const availableBitsForVideo = targetSizeInBits - audioBitrateToUse * duration;
            videoBitrate = availableBitsForVideo / duration;
            videoBitrate = Math.max(videoBitrate, 500000);
        }

        let resolutionFactor = 1;
        if (width && height && videoMetadata.width && videoMetadata.height) {
            const originalPixels = videoMetadata.width * videoMetadata.height;
            const newPixels = width * height;
            resolutionFactor = newPixels / originalPixels;
        }

        const hasAudio = selectedAudioTracks.length > 0;
        const audioBitrateValue = hasAudio ? audioBitrate * 1000 : 0;

        const totalBitrate = videoBitrate * resolutionFactor + audioBitrateValue;
        const sizeInBytes = (totalBitrate * duration) / 8;

        const sizeInMB = sizeInBytes / (1024 * 1024);
        return {
            estimatedFileSize: `${sizeInMB.toFixed(2)} MB`,
            estimatedBitrate: `${Math.floor(videoBitrate / 1000)} kbps`,
        };
    }, [
        timeRange,
        quality,
        qualityMode,
        targetSize,
        width,
        height,
        videoMetadata,
        audioBitrate,
        clipDuration,
        selectedAudioTracks,
        cuts,
    ]);

    const handleExport = (partialOptions?: Partial<ExportOptions>) => {
        const baseOptions: ExportOptions = {
            startTime: timeRange.start,
            endTime: timeRange.end,
            outputFormat,
            qualityMode,
            width,
            height,
            ...(qualityMode === "preset" ? { quality } : { targetSize }),
            fps,
            ...(selectedAudioTracks.length > 0 ? { audioBitrate } : {}),
            audioTracks: selectedAudioTracks,
            cuts: cuts,
        };

        if (partialOptions) {
            if (partialOptions.outputFormat && partialOptions.outputFormat !== outputFormat) {
                setOutputFormat(partialOptions.outputFormat);
            }
            if (partialOptions.qualityMode && partialOptions.qualityMode !== qualityMode) {
                setQualityMode(partialOptions.qualityMode);
            }
            if (partialOptions.quality && partialOptions.quality !== quality) {
                setQuality(partialOptions.quality);
            }
            if (partialOptions.targetSize && partialOptions.targetSize !== targetSize) {
                setTargetSize(partialOptions.targetSize);
            }

            onExport({
                ...baseOptions,
                ...partialOptions,
            });
        } else {
            onExport(baseOptions);
        }
    };

    return (
        <Card className="flex h-full flex-col pt-2 transition-none">
            <ScrollArea fill>
                <Tabs
                    value={activeTab}
                    onValueChange={(value) => {
                        setActiveTab(value);
                        // Returning to export settings de-selects any
                        // collected previous export so the settings apply to
                        // the original video again.
                        if (value === "settings" && selectedClipPath !== null) {
                            onSelectClip(null, null);
                        }
                    }}
                    className="flex h-full flex-1 flex-col gap-0"
                >
                    <div className="px-4 py-2">
                        <TabsList className="w-full">
                            <TabsTrigger value="settings" className="flex-1">
                                Export Settings
                            </TabsTrigger>
                            <TabsTrigger value="previous" className="flex-1">
                                Previous Exports
                            </TabsTrigger>
                        </TabsList>
                    </div>
                    <TabsContent value="settings" className="flex h-full flex-1 flex-col">
                        <CardContent className="flex h-full flex-grow flex-col justify-between overflow-hidden">
                            <div className="space-y-2">
                                <div className="bg-muted/30 grid grid-cols-2 gap-4 rounded-md p-3 xl:grid-cols-4">
                                    <div className="space-y-1">
                                        <Label className="text-muted-foreground text-xs">
                                            Start Time
                                        </Label>
                                        <div className="font-mono text-sm">
                                            {formatTime(timeRange.start)}
                                        </div>
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-muted-foreground text-xs">
                                            End Time
                                        </Label>
                                        <div className="font-mono text-sm">
                                            {formatTime(timeRange.end)}
                                        </div>
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-muted-foreground text-xs">
                                            Duration
                                        </Label>
                                        <div className="font-mono text-sm">
                                            {formatTime(clipDuration)}
                                        </div>
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-muted-foreground text-xs">
                                            Resolution
                                        </Label>
                                        <div className="font-mono text-sm">
                                            {videoMetadata
                                                ? `${videoMetadata.width}x${videoMetadata.height}`
                                                : "Unknown"}
                                        </div>
                                    </div>
                                </div>

                                <Separator />

                                <div className="space-y-2">
                                    <Tabs
                                        value={qualityMode}
                                        onValueChange={(value) =>
                                            setQualityMode(value as "preset" | "targetSize")
                                        }
                                    >
                                        <TabsList className="w-full">
                                            <TabsTrigger value="preset" className="flex-1">
                                                Quality Preset
                                            </TabsTrigger>
                                            <TabsTrigger value="targetSize" className="flex-1">
                                                Target Size
                                            </TabsTrigger>
                                        </TabsList>
                                        <TabsContent value="preset">
                                            <div className="space-y-2 pt-2">
                                                <Label htmlFor="quality">Quality Preset</Label>
                                                <Select
                                                    value={quality}
                                                    items={QUALITY_PRESETS}
                                                    onValueChange={(value) => {
                                                        if (value !== null) setQuality(value);
                                                    }}
                                                >
                                                    <SelectTrigger id="quality">
                                                        <SelectValue placeholder="Select quality" />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {QUALITY_PRESETS.map(({ label, value }) => (
                                                            <SelectItem key={value} value={value}>
                                                                {label}
                                                            </SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        </TabsContent>
                                        <TabsContent value="targetSize">
                                            <div className="space-y-4 pt-2">
                                                <div className="space-y-2">
                                                    <div className="flex justify-between">
                                                        <Label htmlFor="targetSize">
                                                            Target Size (MB)
                                                        </Label>
                                                        <span className="font-mono">
                                                            {estimatedBitrate}{" "}
                                                            {targetSize.toFixed(1)} MB
                                                        </span>
                                                    </div>
                                                    <Slider
                                                        id="targetSize"
                                                        min={1}
                                                        max={100}
                                                        step={0.1}
                                                        value={[targetSize]}
                                                        onValueChange={(value) =>
                                                            setTargetSize(
                                                                Array.isArray(value)
                                                                    ? value[0]
                                                                    : value,
                                                            )
                                                        }
                                                    />
                                                </div>
                                            </div>
                                        </TabsContent>
                                    </Tabs>
                                </div>

                                <div className="space-y-1">
                                    <Label>Estimated Size</Label>
                                    <div className="bg-muted/30 rounded-md p-2 font-mono text-sm">
                                        {estimatedFileSize}
                                    </div>
                                </div>

                                <Separator />

                                <div className="space-y-2">
                                    <div className="space-y-4">
                                        <div className="space-y-2">
                                            <div className="flex justify-between">
                                                <Label htmlFor="resolutionPercent">
                                                    Resolution Scale
                                                </Label>
                                                <span className="font-mono">
                                                    {width}x{height} {resolutionPercent}%
                                                </span>
                                            </div>
                                            <Slider
                                                id="resolutionPercent"
                                                min={10}
                                                max={100}
                                                step={5}
                                                value={[resolutionPercent]}
                                                onValueChange={(value) =>
                                                    setResolutionPercent(
                                                        Array.isArray(value) ? value[0] : value,
                                                    )
                                                }
                                            />
                                        </div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-2">
                                        <Label htmlFor="fps">Frame Rate (FPS)</Label>
                                        <Input
                                            id="fps"
                                            type="number"
                                            value={fps}
                                            onChange={(e) =>
                                                setFpsOverride(
                                                    e.target.value
                                                        ? Number.parseInt(e.target.value, 10)
                                                        : undefined,
                                                )
                                            }
                                            max={60}
                                            defaultValue={60}
                                            min={1}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="format">Output Format</Label>
                                        <Select
                                            value={outputFormat}
                                            items={OUTPUT_FORMATS}
                                            onValueChange={(value) => {
                                                if (value !== null) setOutputFormat(value);
                                            }}
                                        >
                                            <SelectTrigger id="format" className="w-full">
                                                <SelectValue placeholder="Select format" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                {OUTPUT_FORMATS.map(({ label, value }) => (
                                                    <SelectItem key={value} value={value}>
                                                        {label}
                                                    </SelectItem>
                                                ))}
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>

                                <Separator />

                                <div className="mb-4 space-y-4">
                                    {audioTracks.length > 0 && (
                                        <div className="space-y-2">
                                            <Label>Audio Tracks</Label>
                                            <p className="text-muted-foreground mb-2 text-xs">
                                                Selected tracks will be consolidated into a single
                                                audio track.
                                            </p>
                                            <div className="grid grid-cols-2 gap-2">
                                                {audioTracks.map((track) => (
                                                    <div
                                                        key={track.index}
                                                        className="flex items-center space-x-2"
                                                    >
                                                        <Checkbox
                                                            id={`track-${track.index}`}
                                                            checked={selectedAudioTracks.includes(
                                                                track.index,
                                                            )}
                                                            onCheckedChange={(checked) =>
                                                                handleAudioTrackChange(
                                                                    track.index,
                                                                    checked === true,
                                                                )
                                                            }
                                                        />
                                                        <Label
                                                            htmlFor={`track-${track.index}`}
                                                            className="text-sm"
                                                        >
                                                            {track.label}
                                                        </Label>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {selectedAudioTracks.length > 0 && (
                                        <div className="space-y-2">
                                            <div className="flex justify-between">
                                                <Label htmlFor="audioBitrate">
                                                    Audio Quality (kbps)
                                                </Label>
                                                <span className="font-mono">
                                                    {audioBitrate} kbps
                                                </span>
                                            </div>
                                            <Slider
                                                id="audioBitrate"
                                                min={64}
                                                max={320}
                                                step={16}
                                                value={[audioBitrate]}
                                                onValueChange={(value) =>
                                                    setAudioBitrate(
                                                        Array.isArray(value) ? value[0] : value,
                                                    )
                                                }
                                            />
                                        </div>
                                    )}
                                </div>
                            </div>
                            <ExportButton
                                onExport={handleExport}
                                isExporting={isExporting}
                                baseOptions={{
                                    startTime: timeRange.start,
                                    endTime: timeRange.end,
                                    outputFormat,
                                    qualityMode,
                                    width,
                                    height,
                                    ...(qualityMode === "preset" ? { quality } : { targetSize }),
                                    fps,
                                    ...(selectedAudioTracks.length > 0 ? { audioBitrate } : {}),
                                    audioTracks: selectedAudioTracks,
                                }}
                            />
                        </CardContent>
                    </TabsContent>
                    <TabsContent value="previous">
                        <PreviousExports
                            exports={exports}
                            setExports={setExports}
                            isLoading={isClipsLoading}
                            onSelectClip={onSelectClip}
                            selectedClipPath={selectedClipPath}
                        />
                    </TabsContent>
                </Tabs>
            </ScrollArea>
        </Card>
    );
}
