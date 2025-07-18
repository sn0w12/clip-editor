import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useVideoStore } from "@/contexts/video-store-context";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { EditVideoRoute } from "@/routes/routes";
import { Button } from "../ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/utils/tailwind";
import { VideoFile } from "@/types/video";
import { useMainElement } from "@/layouts/base-layout";
import {
    Tooltip,
    TooltipContent,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSteam } from "@/contexts/steam-context";
import { getGameId, imgSrc } from "@/utils/games";
import { useSetting, useShortcutSetting } from "@/utils/settings";

function ClipHeaderLocal() {
    const [width, setWidth] = useState<number | undefined>(undefined);
    const [thumbWidth] = useState(64);
    const { videoPath } = useSearch({ from: EditVideoRoute.id });
    const { videos, thumbnails } = useVideoStore();
    const { games, gameImages, loading } = useSteam();
    const isCustomWindow = useSetting("windowIconsStyle") === "custom";
    const mainElement = useMainElement();
    const navigate = useNavigate();

    const calculateTotalThumbs = useCallback(
        (width: number | undefined): number => {
            if (!width) return 0;
            const widthPadding = 336;
            const thumbPadding = 8;
            return Math.floor(
                (width - widthPadding) / (thumbWidth + thumbPadding),
            );
        },
        [thumbWidth],
    );
    const [totalThumbs, setTotalThumbs] = useState(calculateTotalThumbs(width));

    useEffect(() => {
        if (!mainElement.current) return;

        const updateDimensions = () => {
            console.log(
                "Updating dimensions",
                mainElement.current?.clientWidth,
            );
            if (mainElement.current) {
                const newWidth = mainElement.current.clientWidth;
                setWidth(newWidth);
                setTotalThumbs(calculateTotalThumbs(newWidth));
            }
        };

        updateDimensions();
        const resizeObserver = new ResizeObserver(updateDimensions);
        resizeObserver.observe(mainElement.current);
        window.addEventListener("resize", updateDimensions);

        // Clean up
        return () => {
            resizeObserver.disconnect();
            window.removeEventListener("resize", updateDimensions);
        };
    }, [calculateTotalThumbs, mainElement]);

    const sortedVideos = useMemo(() => {
        return [...videos].sort((a, b) => {
            // Convert lastModified to timestamp numbers if they're strings
            const timestampA =
                typeof a.lastModified === "string"
                    ? new Date(a.lastModified).getTime()
                    : a.lastModified;

            const timestampB =
                typeof b.lastModified === "string"
                    ? new Date(b.lastModified).getTime()
                    : b.lastModified;

            return timestampB - timestampA; // Newest first
        });
    }, [videos]);

    const surroundingVideos = useMemo(() => {
        if (!videoPath || !sortedVideos.length)
            return { videos: [], currentIndex: -1 };

        // Find current video index in sorted array
        const currentIndex = sortedVideos.findIndex(
            (v) => v.path === videoPath,
        );
        if (currentIndex === -1) return { videos: [], currentIndex: -1 };

        // Calculate how many thumbnails to show on each side of current
        const sideCount = Math.floor(totalThumbs / 2);

        // Calculate start and end indices
        let startIndex = Math.max(0, currentIndex - sideCount);
        const endIndex = Math.min(
            sortedVideos.length - 1,
            startIndex + totalThumbs - 1,
        );

        // If we hit the end, adjust the start to show full width
        if (
            endIndex === sortedVideos.length - 1 &&
            endIndex - startIndex + 1 < totalThumbs
        ) {
            startIndex = Math.max(0, sortedVideos.length - totalThumbs);
        }

        const videosInRange = sortedVideos.slice(startIndex, endIndex + 1);
        const adjustedCurrentIndex = currentIndex - startIndex;

        videosInRange.forEach((video) => {
            const appId = getGameId(video.game, games, loading);
            if (loading || appId === null) return;

            if (appId === undefined) return;

            video.gameImages = gameImages[appId];
        });

        return {
            videos: videosInRange,
            currentIndex: adjustedCurrentIndex,
        };
    }, [videoPath, sortedVideos, totalThumbs]);

    const handleNavigateToVideo = (video: VideoFile) => {
        navigate({
            to: EditVideoRoute.id,
            search: {
                videoPath: video.path,
                videoName: video.name,
            },
        });
    };

    const handlePrevious = () => {
        if (surroundingVideos.currentIndex > 0) {
            const previousVideo =
                surroundingVideos.videos[surroundingVideos.currentIndex - 1];
            handleNavigateToVideo(previousVideo);
        }
    };

    const handleNext = () => {
        if (
            surroundingVideos.currentIndex <
            surroundingVideos.videos.length - 1
        ) {
            const nextVideo =
                surroundingVideos.videos[surroundingVideos.currentIndex + 1];
            handleNavigateToVideo(nextVideo);
        }
    };

    useShortcutSetting("goToNextVideo", handleNext);
    useShortcutSetting("goToPreviousVideo", handlePrevious);

    if (surroundingVideos.videos.length === 0) {
        return null;
    }

    return (
        <div className="w-full px-4">
            <div className="flex items-center gap-2">
                <div className="flex-1 overflow-auto">
                    <div className="flex justify-end gap-2">
                        <Button
                            variant="secondary"
                            size="icon"
                            className="bg-sidebar group mr-auto h-8 max-w-48 min-w-12 flex-grow self-end"
                            onClick={() => navigate({ to: "/" })}
                        >
                            <div className="bg-border group-hover:bg-secondary-foreground mx-6 h-0.5 w-full transition-colors duration-200"></div>
                        </Button>
                        <Button
                            variant="outline"
                            size="icon"
                            className="h-9 w-25 self-end"
                            onClick={handlePrevious}
                            disabled={surroundingVideos.currentIndex <= 0}
                        >
                            <ChevronLeft className="h-4 w-4" />
                        </Button>
                        {surroundingVideos.videos.map((video, index) => (
                            <Tooltip key={video.path}>
                                <TooltipTrigger asChild>
                                    <button
                                        className={cn(
                                            "h-auto flex-shrink-0 overflow-hidden rounded border-2 opacity-70 transition-all",
                                            index ===
                                                surroundingVideos.currentIndex
                                                ? "border-accent-positive opacity-100"
                                                : "border-primary/70 hover:opacity-100",
                                        )}
                                        style={{ width: `${thumbWidth}px` }}
                                        onClick={() =>
                                            handleNavigateToVideo(video)
                                        }
                                        disabled={
                                            index ===
                                            surroundingVideos.currentIndex
                                        }
                                    >
                                        <img
                                            src={thumbnails[video.path]}
                                            alt={video.name}
                                            className="h-full w-full object-cover"
                                            onError={() => {
                                                console.error(
                                                    "Failed to load thumbnail:",
                                                    video.path,
                                                );
                                            }}
                                        />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p className="flex items-center gap-1 text-sm font-medium">
                                        {video.gameImages?.icon && (
                                            <img
                                                src={imgSrc(
                                                    video.gameImages?.icon,
                                                )}
                                                alt={`Icon for ${video.game}`}
                                                className="h-4 rounded"
                                            />
                                        )}
                                        {video.game} |{" "}
                                        {(() => {
                                            const date = new Date(
                                                video.lastModified,
                                            );
                                            return `${date.toLocaleDateString(
                                                "en-US",
                                                {
                                                    month: "short",
                                                    day: "numeric",
                                                },
                                            )}, ${date.toLocaleTimeString(
                                                "en-US",
                                                {
                                                    hour: "2-digit",
                                                    minute: "2-digit",
                                                    hour12: false,
                                                },
                                            )}, ${date.getFullYear()}`;
                                        })()}
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        ))}
                    </div>
                </div>

                <Button
                    variant="outline"
                    size="icon"
                    className={`${isCustomWindow ? "relative top-2.5 h-5 w-32" : "h-9.5 w-25 self-end"}`}
                    onClick={handleNext}
                    disabled={
                        surroundingVideos.currentIndex >=
                        surroundingVideos.videos.length - 1
                    }
                >
                    <ChevronRight className="h-3 w-3" />
                </Button>
            </div>
        </div>
    );
}

export const ClipHeader = React.memo(ClipHeaderLocal);
