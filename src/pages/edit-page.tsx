import React, { useState, useEffect } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ClipVideoPlayer } from "@/components/video-editor/clip-video-player";
import { ExportSettings } from "@/components/video-editor/export-settings";
import { TimeRange, ExportOptions } from "@/types/video-editor";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { EditVideoRoute } from "@/routes/routes";
import { useVideoStore } from "@/contexts/video-store-context";
import { ClipHeader } from "@/components/video-editor/clip-header";

export default function EditPage() {
    const { videoPath } = useSearch({ from: EditVideoRoute.id });
    const navigate = useNavigate();
    const { videoMetadata: storedMetadata } = useVideoStore();

    // Simply read from the store, no local loading
    const currentVideoMetadata = videoPath ? storedMetadata[videoPath] : null;
    const [timeRange, setTimeRange] = useState<TimeRange>({
        start: 0,
        end: 0,
    });

    const [isExporting, setIsExporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [audioTracks, setAudioTracks] = useState<
        { index: number; label: string }[]
    >([]);

    // Effect to update time range when metadata becomes available
    useEffect(() => {
        if (!videoPath) {
            setError(
                "Video path not found. Please return to the home page and select a video.",
            );
            setTimeRange({ start: 0, end: 0 });
            return;
        }

        setError(null);

        if (currentVideoMetadata) {
            setTimeRange({ start: 0, end: currentVideoMetadata.duration });
        } else {
            setTimeRange({ start: 0, end: 0 });
        }
    }, [videoPath, currentVideoMetadata]);

    // Handle export button click
    const handleExport = async (options: ExportOptions) => {
        if (!videoPath) return;

        setIsExporting(true);
        try {
            const result = await window.videoEditor.exportClip(
                videoPath,
                options,
            );

            if (result.success) {
                toast.success("Export completed successfully", {
                    action: {
                        label: "Copy to Clipboard",
                        onClick: async () => {
                            try {
                                const copyResult =
                                    await window.videoEditor.copyFileToClipboard(
                                        result.outputPath || "",
                                    );
                                if (copyResult.success) {
                                    toast.success("File copied to clipboard");
                                } else {
                                    toast.error("Failed to copy file", {
                                        description:
                                            copyResult.error || "Unknown error",
                                    });
                                }
                            } catch (error) {
                                toast.error("Failed to copy file to clipboard");
                                console.error("Error copying file:", error);
                            }
                        },
                    },
                });
            } else {
                toast.error("Export failed", {
                    description: result.error || "Unknown error occurred",
                });
            }
        } catch (error) {
            console.error("Export error:", error);
            toast.error("Export failed", {
                description: "An unexpected error occurred during export.",
            });
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <div className="h-full pt-2">
            <ClipHeader />
            <div className="h-[96%] p-4 pt-2">
                {error ? (
                    <div className="rounded-md border border-red-300 bg-red-50 p-6 text-center dark:bg-red-950/30">
                        <p className="mb-4 text-red-600 dark:text-red-400">
                            {error}
                        </p>
                        <Button onClick={() => navigate({ to: "/" })}>
                            Return to Home
                        </Button>
                    </div>
                ) : videoPath && currentVideoMetadata ? (
                    <div className="grid h-full grid-cols-1 gap-3 lg:grid-cols-3">
                        <div className="flex flex-col lg:col-span-2">
                            <ClipVideoPlayer
                                videoSrc={`clip-video:///${videoPath}`}
                                onTimeRangeChange={setTimeRange}
                                timeRange={timeRange}
                                duration={currentVideoMetadata.duration}
                                onAudioTracksChange={setAudioTracks}
                            />
                        </div>
                        <div className="flex h-full flex-col">
                            <ExportSettings
                                videoMetadata={currentVideoMetadata}
                                timeRange={timeRange}
                                onExport={handleExport}
                                isExporting={isExporting}
                                audioTracks={audioTracks}
                            />
                        </div>
                    </div>
                ) : (
                    <div className="flex h-full items-center justify-center">
                        <p className="text-lg text-gray-500">
                            Waiting for video data...
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
