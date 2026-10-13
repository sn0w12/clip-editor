import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { ClipHeader } from "@/components/video-editor/clip-header";
import { ClipVideoPlayer } from "@/components/video-editor/clip-video-player";
import { ExportSettings } from "@/components/video-editor/export-settings";
import { useSetting } from "@/lib/settings";
import {
    copyFileToClipboard,
    exportClip,
    getClipMetadata,
    videoSrc,
} from "@/lib/tauri";
import type { Cut, ExportOptions, TimeRange, VideoMetadata } from "@/types";

function isTruthySetting(value: unknown): boolean {
    return value === true || value === "true" || value === 1 || value === "1";
}

export function EditorPage() {
    const search = useSearch({ strict: false }) as {
        videoPath?: string;
        videoName?: string;
    };
    const videoPath = search.videoPath ?? "";
    const navigate = useNavigate();
    const [selectedClipPath, setSelectedClipPath] = useState<string | null>(
        null
    );
    const [selectedClipDuration, setSelectedClipDuration] = useState<
        number | null
    >(null);
    const [timeRange, setTimeRange] = useState<TimeRange>({ start: 0, end: 0 });
    const [cutsByClip, setCutsByClip] = useState<Record<string, Cut[]>>({});
    const [isExporting, setIsExporting] = useState(false);
    const [audioTracks, setAudioTracks] = useState<
        { index: number; label: string }[]
    >([]);
    const [metadataResult, setMetadataResult] = useState<{
        videoPath: string;
        metadata: VideoMetadata | null;
        error: string | null;
    } | null>(null);
    const [videoUrlResult, setVideoUrlResult] = useState<{
        target: string;
        url: string;
    } | null>(null);
    const alwaysCopyExport = useSetting("alwaysCopyExport");
    const chooseExportLocation = useSetting("chooseExportLocation");

    // Load metadata for the opened clip. State updates happen only in async
    // callbacks; the "current" metadata/error are derived so a clip switch
    // resets them immediately.
    useEffect(() => {
        let cancelled = false;
        if (!videoPath) {
            return () => {
                cancelled = true;
            };
        }

        getClipMetadata(videoPath)
            .then((meta) => {
                if (cancelled) return;
                setMetadataResult({ videoPath, metadata: meta, error: null });
                setAudioTracks(meta.audioTracks ?? []);
                setTimeRange({ start: 0, end: meta.duration ?? 0 });
            })
            .catch((err) => {
                if (cancelled) return;
                setMetadataResult({
                    videoPath,
                    metadata: null,
                    error: String(err),
                });
                setAudioTracks([]);
            });

        return () => {
            cancelled = true;
        };
    }, [videoPath]);

    const currentMetadata =
        metadataResult?.videoPath === videoPath ? metadataResult : null;
    const metadata = currentMetadata?.metadata ?? null;
    const error =
        currentMetadata?.error ??
        (!videoPath
            ? "Video path not found. Please return to the home page and select a video."
            : null);

    const handleExport = async (options: ExportOptions) => {
        if (!videoPath) return;
        setIsExporting(true);
        const exportToastId = toastManager.add({
            title: "Exporting clip…",
            type: "loading",
        });
        try {
            const result = await exportClip(videoPath, {
                ...options,
                chooseExportLocation: isTruthySetting(chooseExportLocation)
                    ? true
                    : options.chooseExportLocation,
            });
            toastManager.close(exportToastId);
            if (result.fileAlreadyExists) {
                toastManager.add({
                    title: "That export already exists — re-exporting would overwrite it.",
                    type: "info",
                });
            } else {
                window.dispatchEvent(new CustomEvent("video-exported"));
                const successId = toastManager.add({
                    title: "Export Successful",
                    type: "success",
                    actionProps: {
                        children: "Copy",
                        onClick: async () => {
                            copyFileToClipboard(result.outputPath)
                                .then(() => {
                                    toastManager.close(successId);
                                    toastManager.add({
                                        title: "Clip Copied",
                                        description:
                                            "The clip has been copied to the clipboard.",
                                        type: "info",
                                    });
                                })
                                .catch((e) => {
                                    toastManager.close(successId);
                                    toastManager.add({
                                        title: "Copy Failed",
                                        description: `Failed to copy the clip: ${String(e)}`,
                                        type: "error",
                                    });
                                });
                        },
                    },
                });
            }
            if (isTruthySetting(alwaysCopyExport)) {
                await toastManager
                    .promise(copyFileToClipboard(result.outputPath), {
                        loading: { title: "Copying to clipboard…" },
                        success: { title: "Copied to clipboard" },
                        error: (e) => ({ title: `Copy failed: ${String(e)}` }),
                    })
                    .catch(() => {});
            }
        } catch (e) {
            toastManager.close(exportToastId);
            toastManager.add({
                title: `Export failed: ${String(e)}`,
                type: "error",
            });
        } finally {
            setIsExporting(false);
        }
    };

    // The media server URL for the <video> element (async: port from Rust).
    // The current URL is derived from the latest result for the target clip.
    useEffect(() => {
        let cancelled = false;
        const target = selectedClipPath ?? videoPath;
        if (!target) {
            return () => {
                cancelled = true;
            };
        }
        videoSrc(target)
            .then((url) => {
                if (!cancelled) setVideoUrlResult({ target, url });
            })
            .catch(() => {
                if (!cancelled) setVideoUrlResult({ target, url: "" });
            });
        return () => {
            cancelled = true;
        };
    }, [videoPath, selectedClipPath]);

    const videoTarget = selectedClipPath ?? videoPath;
    const videoUrl =
        videoUrlResult !== null && videoUrlResult.target === videoTarget
            ? videoUrlResult.url
            : "";

    // Cuts belong to the clip being edited; keying them by clip resets them
    // (and restores each clip's own cuts) on a clip/export switch.
    const cuts = cutsByClip[videoTarget] ?? [];
    const setCuts = (next: Cut[]) =>
        setCutsByClip((m) => ({ ...m, [videoTarget]: next }));

    const handleSelectClip = (
        clipPath: string | null,
        clipDuration: number | null
    ) => {
        setSelectedClipPath(clipPath);
        setSelectedClipDuration(clipDuration);
        if (!clipPath) {
            // Returning from a collected previous export: restore the
            // original video's range so the progress bar is correct.
            setTimeRange({ start: 0, end: metadata?.duration ?? 0 });
        }
    };

    if (error) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <Alert variant="error" className="max-w-md">
                    <AlertTitle>Could not load the clip</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                    <Button
                        variant="outline"
                        className="mt-3"
                        onClick={() => void navigate({ to: "/" })}
                    >
                        Back to Clips
                    </Button>
                </Alert>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col gap-4 p-4">
            <ClipHeader />
            <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-3">
                <div className="min-h-0 lg:col-span-2">
                    <ClipVideoPlayer
                        videoSrc={videoUrl}
                        onTimeRangeChange={setTimeRange}
                        timeRange={timeRange}
                        duration={
                            selectedClipDuration ?? metadata?.duration ?? 0
                        }
                        audioTracks={audioTracks}
                        onAudioTracksChange={setAudioTracks}
                        cuts={cuts}
                        onCutsChange={setCuts}
                    />
                </div>
                <div className="min-h-0">
                    <ExportSettings
                        videoMetadata={metadata}
                        timeRange={timeRange}
                        onExport={(options) => void handleExport(options)}
                        isExporting={isExporting}
                        audioTracks={audioTracks}
                        videoPath={videoPath}
                        onSelectClip={handleSelectClip}
                        selectedClipPath={selectedClipPath}
                        cuts={cuts}
                    />
                </div>
            </div>
        </div>
    );
}
