import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useThumbnail } from "@/hooks/use-thumbnails";
import { rememberReturnToClip } from "@/lib/return-to-clip";
import { useShortcutSetting } from "@/lib/settings";
import { imgSrc } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import { editVideoRoute } from "@/routes/router";
import { useClipsStore } from "@/stores/clips-store";
import type { VideoFile } from "@/types";

const THUMB_WIDTH = 64;
const THUMB_GAP = 8;
/** Horizontal chrome (back button + prev/next) that the thumbs fit beside. */
const WIDTH_PADDING = 336;

function FilmstripThumb({
    video,
    current,
    onNavigate,
}: {
    video: VideoFile;
    current: boolean;
    onNavigate: (video: VideoFile) => void;
}) {
    const thumb = useThumbnail(video.path);

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <button
                        type="button"
                        className={cn(
                            "h-10 flex-shrink-0 overflow-hidden rounded border-2 opacity-70 transition-all",
                            current
                                ? "border-accent-positive opacity-100"
                                : "border-primary/70 hover:opacity-100",
                        )}
                        style={{ width: `${THUMB_WIDTH}px` }}
                        onClick={() => {
                            rememberReturnToClip(video.path);
                            onNavigate(video);
                        }}
                        disabled={current}
                        aria-label={`Open ${video.name}`}
                    />
                }
            >
                {thumb ? (
                    <img
                        src={imgSrc(thumb)}
                        alt={video.name}
                        className="h-full w-full object-cover"
                        onError={(e) => {
                            e.currentTarget.style.display = "none";
                        }}
                    />
                ) : (
                    <span className="bg-muted block h-full w-full" />
                )}
            </TooltipTrigger>
            <TooltipContent side="bottom">
                <p className="text-sm font-medium">
                    {video.game} |{" "}
                    {(() => {
                        const date = new Date(video.lastModified);
                        if (Number.isNaN(date.getTime())) return "Unknown date";
                        return `${date.toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                        })}, ${date.toLocaleTimeString("en-US", {
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                        })}, ${date.getFullYear()}`;
                    })()}
                </p>
            </TooltipContent>
        </Tooltip>
    );
}

function ClipHeaderLocal() {
    const containerRef = useRef<HTMLDivElement>(null);
    const [totalThumbs, setTotalThumbs] = useState(0);
    const { videoPath } = useSearch({ from: editVideoRoute.id });
    const { clips, reload } = useClipsStore();
    const navigate = useNavigate();

    // The editor can be opened directly (route restore); make sure the library
    // is loaded so the filmstrip has neighbours even if the home page never ran.
    useEffect(() => {
        if (!clips.length) void reload();
    }, [clips.length, reload]);

    const sortedVideos = useMemo(() => {
        return [...clips].sort((a, b) => {
            const timestampA = new Date(a.lastModified).getTime();
            const timestampB = new Date(b.lastModified).getTime();
            return timestampB - timestampA; // Newest first
        });
    }, [clips]);

    const calculateTotalThumbs = useCallback((w: number | undefined): number => {
        if (!w) return 0;
        return Math.floor((w - WIDTH_PADDING) / (THUMB_WIDTH + THUMB_GAP));
    }, []);

    useEffect(() => {
        if (!containerRef.current) return;

        const updateDimensions = () => {
            if (containerRef.current) {
                setTotalThumbs(calculateTotalThumbs(containerRef.current.clientWidth));
            }
        };

        updateDimensions();
        const resizeObserver = new ResizeObserver(updateDimensions);
        resizeObserver.observe(containerRef.current);
        window.addEventListener("resize", updateDimensions);

        return () => {
            resizeObserver.disconnect();
            window.removeEventListener("resize", updateDimensions);
        };
    }, [calculateTotalThumbs]);

    const normalize = useCallback((p: string) => p.replace(/^\\\\\?\\\\/, ""), []);

    const surroundingVideos = useMemo(() => {
        if (!sortedVideos.length) return { videos: [], currentIndex: -1 };

        const currentIndex = videoPath
            ? sortedVideos.findIndex((v) => normalize(v.path) === normalize(videoPath))
            : -1;
        if (currentIndex === -1) {
            // The opened clip is not in the library (direct open, renamed file, or
            // route restore): show the newest clips so the header never disappears.
            const count = Math.max(1, totalThumbs || 1);
            return {
                videos: sortedVideos.slice(0, Math.min(count, sortedVideos.length)),
                currentIndex: -1,
            };
        }

        const sideCount = Math.max(1, Math.floor(totalThumbs / 2));

        let startIndex = Math.max(0, currentIndex - sideCount);
        const endIndex = Math.min(sortedVideos.length - 1, startIndex + totalThumbs - 1);

        if (endIndex === sortedVideos.length - 1 && endIndex - startIndex + 1 < totalThumbs) {
            startIndex = Math.max(0, sortedVideos.length - totalThumbs);
        }

        return {
            videos: sortedVideos.slice(startIndex, endIndex + 1),
            currentIndex: currentIndex - startIndex,
        };
    }, [videoPath, sortedVideos, totalThumbs, normalize]);

    const handleNavigateToVideo = useCallback(
        (video: VideoFile) => {
            void navigate({
                to: editVideoRoute.id,
                search: {
                    videoPath: video.path,
                    videoName: video.name,
                },
            });
        },
        [navigate],
    );

    const handlePrevious = useCallback(() => {
        if (surroundingVideos.currentIndex > 0) {
            handleNavigateToVideo(surroundingVideos.videos[surroundingVideos.currentIndex - 1]);
        }
    }, [surroundingVideos, handleNavigateToVideo]);

    const handleNext = useCallback(() => {
        if (surroundingVideos.currentIndex < surroundingVideos.videos.length - 1) {
            handleNavigateToVideo(surroundingVideos.videos[surroundingVideos.currentIndex + 1]);
        }
    }, [surroundingVideos, handleNavigateToVideo]);

    useShortcutSetting("goToNextVideo", handleNext);
    useShortcutSetting("goToPreviousVideo", handlePrevious);

    const headerVideos = surroundingVideos.videos;
    const headerIndex = surroundingVideos.currentIndex;

    return (
        <div className="w-full pr-2 pl-4" ref={containerRef}>
            <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                    <div className="flex justify-end gap-2">
                        <Button
                            variant="secondary"
                            size="icon"
                            className="bg-sidebar group mr-auto h-8 max-w-48 min-w-12 flex-grow self-end"
                            onClick={() => navigate({ to: "/" })}
                            aria-label="Back to library"
                        >
                            <div className="bg-border group-hover:bg-secondary-foreground mx-6 h-0.5 w-full transition-colors duration-200" />
                        </Button>
                        <Button
                            variant="outline"
                            size="icon"
                            className="h-9.5 w-25 self-end sm:h-9.5 sm:w-25"
                            onClick={handlePrevious}
                            disabled={headerIndex <= 0}
                            aria-label="Previous video"
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        {headerVideos.map((video, index) => (
                            <FilmstripThumb
                                key={video.path}
                                video={video}
                                current={index === headerIndex}
                                onNavigate={handleNavigateToVideo}
                            />
                        ))}
                    </div>
                </div>

                <Button
                    variant="outline"
                    size="icon"
                    className="h-9.5 w-25 self-end sm:h-9.5 sm:w-25"
                    onClick={handleNext}
                    disabled={headerIndex < 0 || headerIndex >= headerVideos.length - 1}
                    aria-label="Next video"
                >
                    <ChevronRight className="h-3 w-3" />
                </Button>
            </div>
        </div>
    );
}

export const ClipHeader = memo(ClipHeaderLocal);
