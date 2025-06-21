import React, { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Cut,
    ExportedClip,
    ExportOptions,
    TimeRange,
    VideoMetadata,
} from "@/types/video-editor";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { getSetting } from "@/utils/settings";
import { ExportButton } from "./export-button";
import { formatTime } from "@/utils/format";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PreviousExports } from "@/components/video-editor/previous-exports";

interface ExportSettingsProps {
    videoMetadata: VideoMetadata | null;
    timeRange: TimeRange;
    onExport: (options: ExportOptions) => void;
    isExporting: boolean;
    audioTracks?: { index: number; label: string }[];
    videoPath: string;
    onSelectClip: (
        clipPath: string | null,
        clipDuration: number | null,
    ) => void;
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
        getSetting("defaultExportFormat") || "mp4",
    );
    const [quality, setQuality] = useState<string>(
        getSetting("defaultExportQuality") || "medium",
    );
    const [qualityMode, setQualityMode] = useState<"preset" | "targetSize">(
        "preset",
    );
    const [targetSize, setTargetSize] = useState<number>(10);
    const [resolutionPercent, setResolutionPercent] = useState<number>(100);
    const [estimatedFileSize, setEstimatedFileSize] = useState<string>("0 MB");
    const [estimatedBitrate, setEstimatedBitrate] = useState<string>("0 kbps");
    const [width, setWidth] = useState<number | undefined>(
        videoMetadata?.width,
    );
    const [height, setHeight] = useState<number | undefined>(
        videoMetadata?.height,
    );
    const [fps, setFps] = useState<number | undefined>(videoMetadata?.fps);
    const [audioBitrate, setAudioBitrate] = useState<number>(128);
    const [selectedAudioTracks, setSelectedAudioTracks] = useState<number[]>(
        [],
    );
    const [activeTab, setActiveTab] = useState<string>("settings");
    const [exports, setExports] = useState<ExportedClip[]>([]);
    const [isClipsLoading, setIsClipsLoading] = useState(true);

    useEffect(() => {
        async function fetchExports() {
            setIsClipsLoading(true);
            try {
                const result =
                    await window.videoEditor.getPreviousExports(videoPath);
                setExports(result || []);
            } catch (error) {
                console.error("Error fetching exports:", error);
            } finally {
                setIsClipsLoading(false);
            }
        }

        if (videoPath) {
            fetchExports();
        }

        window.addEventListener("video-exported", () => {
            fetchExports();
        });
    }, [videoPath]);

    // Initialize selected audio tracks with all tracks selected
    useEffect(() => {
        if (audioTracks.length > 0) {
            const defaultAudioTrack = parseInt(
                getSetting("defaultAudioTrack") || "0",
                10,
            );
            if (audioTracks.length >= defaultAudioTrack) {
                setSelectedAudioTracks([defaultAudioTrack]);
            } else {
                setSelectedAudioTracks([0]);
            }
        }
    }, [audioTracks]);

    // Handle audio track selection
    const handleAudioTrackChange = (trackIndex: number, checked: boolean) => {
        setSelectedAudioTracks((prevTracks) => {
            if (checked) {
                return [...prevTracks, trackIndex];
            } else {
                return prevTracks.filter((index) => index !== trackIndex);
            }
        });
    };

    useEffect(() => {
        if (videoMetadata) {
            setWidth(videoMetadata.width);
            setHeight(videoMetadata.height);
            setFps(videoMetadata.fps);
        }
    }, [videoMetadata]);
    const clipDuration = timeRange.end - timeRange.start;

    useEffect(() => {
        if (videoMetadata) {
            const newWidth = Math.round(
                videoMetadata.width * (resolutionPercent / 100),
            );
            const newHeight = Math.round(
                videoMetadata.height * (resolutionPercent / 100),
            );
            setWidth(newWidth);
            setHeight(newHeight);
        }
    }, [resolutionPercent, videoMetadata]);

    // Calculate estimated file size based on duration, quality, and resolution
    useEffect(() => {
        if (!videoMetadata) return;

        // Calculate duration in seconds
        let duration = clipDuration;

        if (cuts && cuts.length > 0) {
            // Calculate total duration of cut segments
            const cutDuration = cuts.reduce((total, cut) => {
                // Ensure cut times are within the clip range
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
            // Base bitrates in bits per second
            const bitrates = {
                high: 4000000, // 4000kbps
                medium: 2500000, // 2500kbps
                low: 1000000, // 1000kbps
            };

            // Get the selected bitrate
            videoBitrate = bitrates[quality as keyof typeof bitrates];
        } else {
            // Calculate bitrate from target size
            // Convert target size from MB to bits
            const targetSizeInBits = targetSize * 8 * 1024 * 1024;
            // Subtract audio size if audio is included
            const hasAudio = selectedAudioTracks.length > 0;
            const audioBitrateToUse = hasAudio ? audioBitrate * 1000 : 0;
            const availableBitsForVideo =
                targetSizeInBits - audioBitrateToUse * duration;
            // Calculate video bitrate
            videoBitrate = availableBitsForVideo / duration;
            // Set a minimum bitrate to avoid extremely low quality
            videoBitrate = Math.max(videoBitrate, 500000);
        }

        // Adjust for resolution if custom size is enabled
        let resolutionFactor = 1;
        if (width && height && videoMetadata.width && videoMetadata.height) {
            const originalPixels = videoMetadata.width * videoMetadata.height;
            const newPixels = width * height;
            resolutionFactor = newPixels / originalPixels;
        }

        // Audio bitrate - only if audio tracks are selected
        const hasAudio = selectedAudioTracks.length > 0;
        const audioBitrateValue = hasAudio ? audioBitrate * 1000 : 0; // Convert kbps to bps

        // Calculate size in bytes: (video bitrate + audio bitrate) * duration / 8
        const totalBitrate =
            videoBitrate * resolutionFactor + audioBitrateValue;
        const sizeInBytes = (totalBitrate * duration) / 8;

        // Convert to MB for display
        const sizeInMB = sizeInBytes / (1024 * 1024); // Format to 2 decimal places
        setEstimatedFileSize(`${sizeInMB.toFixed(2)} MB`);
        setEstimatedBitrate(`${Math.floor(videoBitrate / 1000)} kbps`);
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
            if (
                partialOptions.outputFormat &&
                partialOptions.outputFormat !== outputFormat
            ) {
                setOutputFormat(partialOptions.outputFormat);
            }
            if (
                partialOptions.qualityMode &&
                partialOptions.qualityMode !== qualityMode
            ) {
                setQualityMode(
                    partialOptions.qualityMode as "preset" | "targetSize",
                );
            }
            if (partialOptions.quality && partialOptions.quality !== quality) {
                setQuality(partialOptions.quality);
            }
            if (
                partialOptions.targetSize &&
                partialOptions.targetSize !== targetSize
            ) {
                setTargetSize(partialOptions.targetSize);
            }

            // Merge options
            const mergedOptions = {
                ...baseOptions,
                ...partialOptions,
            };

            onExport(mergedOptions);
        } else {
            onExport(baseOptions);
        }
    };

    return (
        <Card className="flex h-full flex-col pt-2 transition-none">
            <Tabs
                value={activeTab}
                onValueChange={setActiveTab}
                className="flex flex-1 flex-col"
            >
                <div className="px-4 py-2">
                    <TabsList className="w-full">
                        <TabsTrigger
                            value="settings"
                            className="flex-1"
                            disabled={selectedClipPath !== null}
                        >
                            Export Settings
                        </TabsTrigger>
                        <TabsTrigger value="previous" className="flex-1">
                            Previous Exports
                        </TabsTrigger>
                    </TabsList>
                </div>
                <TabsContent value="settings" className="flex flex-1 flex-col">
                    <CardContent className="flex-grow overflow-auto px-4 pb-0">
                        <div className="space-y-6">
                            {/* Clip info */}
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
                            {/* Separator */}
                            <Separator />
                            {/* Quality mode selector using Tabs */}
                            <div className="space-y-2">
                                <Tabs
                                    defaultValue={qualityMode}
                                    onValueChange={(value) =>
                                        setQualityMode(
                                            value as "preset" | "targetSize",
                                        )
                                    }
                                    value={qualityMode}
                                >
                                    <TabsList className="w-full">
                                        <TabsTrigger
                                            value="preset"
                                            className="flex-1"
                                        >
                                            Quality Preset
                                        </TabsTrigger>
                                        <TabsTrigger
                                            value="targetSize"
                                            className="flex-1"
                                        >
                                            Target Size
                                        </TabsTrigger>
                                    </TabsList>
                                    <TabsContent value="preset">
                                        <div className="space-y-2 pt-2">
                                            <Label htmlFor="quality">
                                                Quality Preset
                                            </Label>
                                            <Select
                                                value={quality}
                                                onValueChange={setQuality}
                                            >
                                                <SelectTrigger id="quality">
                                                    <SelectValue placeholder="Select quality" />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="high">
                                                        High (4000kbps)
                                                    </SelectItem>
                                                    <SelectItem value="medium">
                                                        Medium (2500kbps)
                                                    </SelectItem>
                                                    <SelectItem value="low">
                                                        Low (1000kbps)
                                                    </SelectItem>
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
                                                        {targetSize.toFixed(1)}{" "}
                                                        MB
                                                    </span>
                                                </div>
                                                <Slider
                                                    id="targetSize"
                                                    min={1}
                                                    max={100}
                                                    step={0.1}
                                                    value={[targetSize]}
                                                    onValueChange={(value) =>
                                                        setTargetSize(value[0])
                                                    }
                                                />
                                            </div>
                                        </div>
                                    </TabsContent>
                                </Tabs>
                            </div>
                            {/* Estimated file size */}
                            <div className="space-y-1">
                                <Label>Estimated Size</Label>
                                <div className="bg-muted/30 rounded-md p-2 font-mono text-sm">
                                    {estimatedFileSize}
                                </div>
                            </div>
                            {/* Separator */}
                            <Separator />
                            {/* Resolution percentage */}
                            <div className="space-y-2">
                                <div className="space-y-4">
                                    <div className="space-y-2">
                                        <div className="flex justify-between">
                                            <Label htmlFor="resolutionPercent">
                                                Resolution Scale
                                            </Label>
                                            <span className="font-mono">
                                                {width}x{height}{" "}
                                                {resolutionPercent}%
                                            </span>
                                        </div>
                                        <Slider
                                            id="resolutionPercent"
                                            min={10}
                                            max={100}
                                            step={5}
                                            value={[resolutionPercent]}
                                            onValueChange={(value) =>
                                                setResolutionPercent(value[0])
                                            }
                                        />
                                    </div>
                                </div>
                            </div>
                            {/* Frame Rate */}
                            <div className="grid grid-cols-2 gap-2">
                                <div className="space-y-2">
                                    <Label htmlFor="fps">
                                        Frame Rate (FPS)
                                    </Label>
                                    <Input
                                        id="fps"
                                        type="number"
                                        value={fps}
                                        onChange={(e) =>
                                            setFps(parseInt(e.target.value))
                                        }
                                        max={60}
                                        min={1}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="format">
                                        Output Format
                                    </Label>
                                    <Select
                                        value={outputFormat}
                                        onValueChange={setOutputFormat}
                                    >
                                        <SelectTrigger
                                            id="format"
                                            className="w-full"
                                        >
                                            <SelectValue placeholder="Select format" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="mp4">
                                                MP4
                                            </SelectItem>
                                            <SelectItem value="webm">
                                                WebM
                                            </SelectItem>
                                            <SelectItem value="mov">
                                                MOV
                                            </SelectItem>
                                            <SelectItem value="mkv">
                                                MKV
                                            </SelectItem>
                                            <SelectItem value="gif">
                                                GIF
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                            {/* Separator */}
                            <Separator />
                            {/* Audio settings */}
                            <div className="space-y-4">
                                {/* Audio Track Selection */}
                                {audioTracks.length > 0 && (
                                    <div className="space-y-2">
                                        <Label>Audio Tracks</Label>
                                        <p className="text-muted-foreground mb-2 text-xs">
                                            Selected tracks will be consolidated
                                            into a single audio track.
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
                                                        onCheckedChange={(
                                                            checked,
                                                        ) =>
                                                            handleAudioTrackChange(
                                                                track.index,
                                                                checked as boolean,
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
                                                setAudioBitrate(value[0])
                                            }
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                    </CardContent>

                    <div className="mt-auto p-6 py-0">
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
                                ...(qualityMode === "preset"
                                    ? { quality }
                                    : { targetSize }),
                                fps,
                                ...(selectedAudioTracks.length > 0
                                    ? { audioBitrate }
                                    : {}),
                                audioTracks: selectedAudioTracks,
                            }}
                        />
                    </div>
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
        </Card>
    );
}
