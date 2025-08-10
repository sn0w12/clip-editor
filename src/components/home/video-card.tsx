import React, { useRef, useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { VideoFile, VideoGroup } from "@/types/video";
import { FileVideo, Gamepad2 } from "lucide-react";
import { format } from "date-fns";
import { useNavigate } from "@tanstack/react-router";
import { useSteam } from "@/contexts/steam-context";
import { getGameId, imgSrc } from "@/utils/games";
import { Skeleton } from "../ui/skeleton";

interface VideoCardProps {
    video: VideoFile;
    thumbnailUrl?: string;
    isSelected: boolean;
    videoGroupMap: Record<string, string[]>;
    groups: VideoGroup[];
}

export function VideoCard({
    video,
    thumbnailUrl,
    isSelected,
    videoGroupMap,
    groups,
}: VideoCardProps) {
    const navigate = useNavigate();
    const { games, gameImages, loading } = useSteam();

    const [showVideo, setShowVideo] = useState(false);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [progress, setProgress] = useState(0);
    const [isHoveringProgressBar, setIsHoveringProgressBar] = useState(false);
    const hoverTimerRef = useRef<number | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const progressAnimationRef = useRef<number | null>(null);
    const progressBarRef = useRef<HTMLDivElement>(null);
    const lastPlaybackPositionRef = useRef<number>(0);

    const appId = getGameId(video.game, games, loading);
    const hasGameIcon = appId && gameImages[appId]?.icon;

    const handleCardClick = () => {
        navigate({
            to: "/clips/edit",
            search: {
                videoPath: video.path,
                videoName: video.name,
            },
        });
    };

    const handleMouseEnter = () => {
        hoverTimerRef.current = window.setTimeout(() => {
            setShowVideo(true);
        }, 700);
    };

    const handleMouseLeave = () => {
        // Clear the timer if the mouse leaves before the timeout
        if (hoverTimerRef.current) {
            clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }

        if (progressAnimationRef.current) {
            cancelAnimationFrame(progressAnimationRef.current);
            progressAnimationRef.current = null;
        }

        if (videoRef.current && videoLoaded) {
            lastPlaybackPositionRef.current = videoRef.current.currentTime;
        }

        setShowVideo(false);
        setVideoLoaded(false);
        setProgress(0);
        setIsHoveringProgressBar(false);
    };

    const handleVideoLoad = () => {
        setVideoLoaded(true);

        // Restore the previous playback position if it exists
        if (videoRef.current && lastPlaybackPositionRef.current > 0) {
            const duration = videoRef.current.duration || 0;
            if (lastPlaybackPositionRef.current < duration) {
                videoRef.current.currentTime = lastPlaybackPositionRef.current;
                setProgress((lastPlaybackPositionRef.current / duration) * 100);
            } else {
                // If we're past the end, reset to beginning
                lastPlaybackPositionRef.current = 0;
            }
        }

        // Start updating progress immediately after video is loaded
        if (videoRef.current && showVideo) {
            videoRef.current.play().catch((error) => {
                console.log("Video autoplay prevented:", error);
            });

            // Start progress animation if not already running
            if (!progressAnimationRef.current) {
                progressAnimationRef.current =
                    requestAnimationFrame(updateProgressBar);
            }
        }
    };

    const updateProgressBar = () => {
        if (videoRef.current && showVideo) {
            // Only update if video is actually loaded and has duration
            if (videoLoaded && videoRef.current.duration) {
                const currentTime = videoRef.current.currentTime;
                const duration = videoRef.current.duration || 1;
                const progressPercent = (currentTime / duration) * 100;
                setProgress(progressPercent);
            }

            progressAnimationRef.current =
                requestAnimationFrame(updateProgressBar);
        } else if (progressAnimationRef.current) {
            // If video is not showing anymore, cancel animation
            cancelAnimationFrame(progressAnimationRef.current);
            progressAnimationRef.current = null;
        }
    };

    const handleProgressBarClick = (e: React.MouseEvent<HTMLDivElement>) => {
        e.stopPropagation(); // Prevent card click
        if (!videoRef.current) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const clickPosition = e.clientX - rect.left;
        const percentage = (clickPosition / rect.width) * 100;
        const seekTime = (videoRef.current.duration || 0) * (percentage / 100);

        videoRef.current.currentTime = seekTime;
        lastPlaybackPositionRef.current = seekTime;
        setProgress(percentage);
    };

    const handleProgressBarMouseEnter = () => {
        setIsHoveringProgressBar(true);
    };

    const handleProgressBarMouseLeave = () => {
        setIsHoveringProgressBar(false);
    };

    // Handle video playback after the video is shown
    useEffect(() => {
        if (showVideo && videoLoaded && videoRef.current) {
            videoRef.current.play().catch((error) => {
                console.log("Video autoplay prevented:", error);
            });

            if (!progressAnimationRef.current) {
                progressAnimationRef.current =
                    requestAnimationFrame(updateProgressBar);
            }
        } else if ((!showVideo || !videoLoaded) && videoRef.current) {
            videoRef.current.pause();

            // Cancel progress animation
            if (progressAnimationRef.current) {
                cancelAnimationFrame(progressAnimationRef.current);
                progressAnimationRef.current = null;
            }
        }

        return () => {
            if (progressAnimationRef.current) {
                cancelAnimationFrame(progressAnimationRef.current);
                progressAnimationRef.current = null;
            }
        };
    }, [showVideo, videoLoaded]);

    // Clean up timer when component unmounts
    useEffect(() => {
        return () => {
            if (hoverTimerRef.current) {
                clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = null;
            }

            if (progressAnimationRef.current) {
                cancelAnimationFrame(progressAnimationRef.current);
                progressAnimationRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        return () => {
            // Reset stored position when component unmounts
            lastPlaybackPositionRef.current = 0;
        };
    }, [video.path]);

    return (
        <Card
            className={`selectable-item hover:border-primary/70 ease-snappy cursor-pointer gap-0 overflow-hidden py-0 transition-colors duration-200 ${
                isSelected ? "border-primary bg-accent" : ""
            }`}
            onClick={handleCardClick}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            data-video-path={video.path}
        >
            <div className="bg-muted relative aspect-video">
                {showVideo && (
                    <video
                        ref={videoRef}
                        src={`clip-video:///${video.path}`}
                        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ease-in-out ${
                            videoLoaded ? "opacity-100" : "opacity-0"
                        }`}
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        crossOrigin="anonymous"
                        onLoadedData={handleVideoLoad}
                    />
                )}

                {thumbnailUrl ? (
                    <img
                        src={thumbnailUrl}
                        alt={`Thumbnail for ${encodeURIComponent(video.name)}`}
                        className={`h-full w-full object-cover transition-opacity duration-300 ease-in-out ${
                            showVideo && videoLoaded
                                ? "opacity-0"
                                : "opacity-100"
                        }`}
                        loading="lazy"
                        draggable="false"
                        onDragStart={(e) => e.preventDefault()}
                    />
                ) : (
                    <div
                        className={`flex h-full w-full flex-col items-center justify-center gap-2 transition-opacity duration-300 ease-in-out ${
                            showVideo && videoLoaded
                                ? "opacity-0"
                                : "opacity-100"
                        }`}
                    >
                        <FileVideo
                            size={40}
                            className="text-muted-foreground opacity-50"
                        />
                        <p className="text-muted-foreground text-xs">
                            Generating thumbnail...
                        </p>
                    </div>
                )}

                {/* Interactive Progress bar */}
                {showVideo && videoLoaded && (
                    <div
                        ref={progressBarRef}
                        className={`absolute right-0 bottom-0 left-0 ${isHoveringProgressBar ? "h-3 cursor-pointer" : "h-1"} bg-background/20 transition-all duration-200`}
                        onClick={handleProgressBarClick}
                        onMouseEnter={handleProgressBarMouseEnter}
                        onMouseLeave={handleProgressBarMouseLeave}
                    >
                        <div
                            className={`bg-accent-positive h-full transition-all duration-100`}
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                )}
            </div>
            <div className="p-4">
                <div className="flex items-center justify-between">
                    <h3 className="group relative line-clamp-1 text-lg font-medium">
                        {video.name}
                    </h3>
                    {videoGroupMap[video.path]?.length > 0 && (
                        <div className="flex gap-1">
                            {videoGroupMap[video.path]
                                ?.slice(0, 3)
                                .map((groupId) => {
                                    const group = groups.find(
                                        (g) => g.id === groupId,
                                    );
                                    if (!group) return null;
                                    return (
                                        <span
                                            key={groupId}
                                            className="h-3 w-3 rounded-full"
                                            style={{
                                                backgroundColor: group.color,
                                            }}
                                            title={group.name}
                                        />
                                    );
                                })}
                            {videoGroupMap[video.path]?.length > 3 && (
                                <span className="text-muted-foreground text-xs">
                                    +{videoGroupMap[video.path].length - 3}
                                </span>
                            )}
                        </div>
                    )}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                    {video.game && (
                        <p className="bg-muted text-muted-foreground flex h-5 items-center gap-1 rounded py-0.5 pr-1 pl-0.5 text-xs">
                            {loading ? (
                                <Skeleton className="h-4 w-4 rounded" />
                            ) : (
                                <>
                                    {hasGameIcon ? (
                                        <img
                                            src={imgSrc(gameImages[appId].icon)}
                                            alt={`Icon for ${video.game}`}
                                            className="h-4 rounded"
                                            onError={(e) => {
                                                e.currentTarget.style.display =
                                                    "none";
                                                e.currentTarget.nextElementSibling?.classList.remove(
                                                    "hidden",
                                                );
                                            }}
                                        />
                                    ) : null}
                                    <Gamepad2
                                        className={`h-4 w-4 ${hasGameIcon ? "hidden" : ""}`}
                                    />
                                </>
                            )}
                            {video.game}
                        </p>
                    )}
                </div>
                <div className="mt-1 flex flex-wrap justify-between gap-1">
                    <p className="text-muted-foreground text-sm">
                        {(video.size / (1024 * 1024)).toFixed(1)} MB
                    </p>
                    <p className="text-muted-foreground text-sm">
                        {format(
                            new Date(video.lastModified),
                            "MMM d, yyyy, HH:mm",
                        )}
                    </p>
                </div>
            </div>
        </Card>
    );
}
