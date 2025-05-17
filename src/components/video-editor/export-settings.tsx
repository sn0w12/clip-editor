import React, { useEffect } from "react";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ExportOptions, TimeRange, VideoMetadata } from "@/types/video-editor";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { getSetting } from "@/utils/settings";

interface ExportSettingsProps {
    videoMetadata: VideoMetadata | null;
    timeRange: TimeRange;
    onExport: (options: ExportOptions) => void;
    isExporting: boolean;
    audioTracks?: { index: number; label: string }[];
}

export function ExportSettings({
    videoMetadata,
    timeRange,
    onExport,
    isExporting,
    audioTracks = [],
}: ExportSettingsProps) {
    const [outputFormat, setOutputFormat] = React.useState<string>("mp4");
    const [quality, setQuality] = React.useState<string>("medium");
    const [qualityMode, setQualityMode] = React.useState<
        "preset" | "targetSize"
    >("preset");
    const [targetSize, setTargetSize] = React.useState<number>(10);
    const [resolutionPercent, setResolutionPercent] =
        React.useState<number>(100);
    const [estimatedFileSize, setEstimatedFileSize] =
        React.useState<string>("0 MB");
    const [estimatedBitrate, setEstimatedBitrate] =
        React.useState<string>("0 kbps");
    const [width, setWidth] = React.useState<number | undefined>(
        videoMetadata?.width,
    );
    const [height, setHeight] = React.useState<number | undefined>(
        videoMetadata?.height,
    );
    const [fps, setFps] = React.useState<number | undefined>(
        videoMetadata?.fps,
    );
    const [audioBitrate, setAudioBitrate] = React.useState<number>(128);
    const [selectedAudioTracks, setSelectedAudioTracks] = React.useState<
        number[]
    >([]);

    // Initialize selected audio tracks with all tracks selected
    React.useEffect(() => {
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

    // Update dimensions when metadata changes
    React.useEffect(() => {
        if (videoMetadata) {
            setWidth(videoMetadata.width);
            setHeight(videoMetadata.height);
            setFps(videoMetadata.fps);
        }
    }, [videoMetadata]);

    // Calculate clip duration
    const clipDuration = timeRange.end - timeRange.start;

    // Calculate actual width and height based on resolution percentage
    React.useEffect(() => {
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
        const duration = clipDuration;

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
    ]);

    // Format time in MM:SS format
    const formatTime = (seconds: number): string => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, "0")}`;
    };

    // Handle export button click
    const handleExport = () => {
        const options: ExportOptions = {
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
        };

        onExport(options);
    };
    return (
        <Card className="flex h-full flex-col transition-none">
            <CardHeader className="pb-2">
                <CardTitle>Export Settings</CardTitle>
                <CardDescription>
                    Configure how your clip will be exported
                </CardDescription>
            </CardHeader>
            <CardContent className="h-full flex-grow overflow-auto pb-0">
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
                    {/* Quality mode selector */}
                    <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                            <Button
                                variant={
                                    qualityMode === "preset"
                                        ? "default"
                                        : "outline"
                                }
                                onClick={() => setQualityMode("preset")}
                                className="justify-start"
                            >
                                <span className="text-left">
                                    Quality Preset
                                </span>
                            </Button>
                            <Button
                                variant={
                                    qualityMode === "targetSize"
                                        ? "default"
                                        : "outline"
                                }
                                onClick={() => setQualityMode("targetSize")}
                                className="justify-start"
                            >
                                <span className="text-left">Target Size</span>
                            </Button>
                        </div>
                    </div>
                    {qualityMode === "preset" ? (
                        <div className="space-y-2">
                            <Label htmlFor="quality">Quality Preset</Label>
                            <Select value={quality} onValueChange={setQuality}>
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
                    ) : (
                        <div className="space-y-4">
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
                                        setTargetSize(value[0])
                                    }
                                />
                            </div>
                        </div>
                    )}
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
                                        setResolutionPercent(value[0])
                                    }
                                />
                            </div>
                        </div>
                    </div>
                    {/* Frame Rate */}
                    <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-2">
                            <Label htmlFor="fps">Frame Rate (FPS)</Label>
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
                            <Label htmlFor="format">Output Format</Label>
                            <Select
                                value={outputFormat}
                                onValueChange={setOutputFormat}
                            >
                                <SelectTrigger id="format" className="w-full">
                                    <SelectValue placeholder="Select format" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="mp4">MP4</SelectItem>
                                    <SelectItem value="webm">WebM</SelectItem>
                                    <SelectItem value="mov">MOV</SelectItem>
                                    <SelectItem value="mkv">MKV</SelectItem>
                                    <SelectItem value="gif">GIF</SelectItem>
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
                                    Selected tracks will be consolidated into a
                                    single audio track.
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
                <Button
                    className="w-full"
                    onClick={handleExport}
                    disabled={isExporting}
                    size="lg"
                >
                    {isExporting ? "Exporting..." : "Export Clip"}
                </Button>
            </div>
        </Card>
    );
}
