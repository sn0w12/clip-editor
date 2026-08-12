import { useNavigate } from "@tanstack/react-router";
import { Gamepad2Icon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { Frame, FramePanel, FrameFooter } from "@/components/ui/frame";
import { useBadge } from "@/contexts/badge-context";
import { useThumbnail } from "@/hooks/use-thumbnails";
import { rememberReturnToClip } from "@/lib/return-to-clip";
import { imgSrc, videoSrc } from "@/lib/tauri";
import { thumbHashBase64ToDataURL } from "@/lib/thumbhash";
import { cn } from "@/lib/utils";
import type { GameImage, VideoFile, VideoGroup } from "@/types";

import { GameIcon } from "../game-icon";

interface VideoCardProps {
    video: VideoFile;
    isSelected: boolean;
    gameImage?: GameImage | null;
    groups: VideoGroup[];
    groupIds: string[];
}

export const VideoCard = memo(function VideoCard({
    video,
    isSelected,
    gameImage,
    groups,
    groupIds,
}: VideoCardProps) {
    const navigate = useNavigate();
    const { scanError, path, thumbnail: inlineThumb, thumbhash } = video;
    // When the backend already returned the thumbnail inline, skip the
    // per-card request entirely; otherwise fall back to the async hook.
    const fallbackThumb = useThumbnail(scanError ? undefined : inlineThumb ? undefined : path);
    const thumbUrl = inlineThumb ?? fallbackThumb ?? null;
    // If the cached JPEG is gone (e.g. caches were moved), fall back to the
    // ThumbHash placeholder instead of showing a broken image. Track which URL
    // failed so a new URL automatically re-enables the thumbnail (no effect).
    const [thumbFailedUrl, setThumbFailedUrl] = useState<string | null>(null);
    // The ThumbHash renders instantly (it's a tiny base64 placeholder), so a
    // card never sits on a blank box while the JPEG thumbnail is generated.
    // Decode it on the main thread only when there's no real thumbnail yet —
    // cards with a cached JPEG skip the decode entirely (it's the biggest
    // per-card cost on the home grid).
    const showThumb = thumbUrl !== null && thumbFailedUrl !== thumbUrl;
    const thumbhashUrl = useMemo(
        () => (!showThumb && thumbhash ? thumbHashBase64ToDataURL(thumbhash) : null),
        [showThumb, thumbhash],
    );

    const [showVideo, setShowVideo] = useState(false);
    const [videoUrl, setVideoUrl] = useState("");
    useEffect(() => {
        let cancelled = false;
        videoSrc(video.path)
            .then((url) => {
                if (!cancelled) setVideoUrl(url);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [video.path]);
    const [videoLoaded, setVideoLoaded] = useState(false);
    const [progress, setProgress] = useState(0);
    const [isHoveringProgressBar, setIsHoveringProgressBar] = useState(false);
    const hoverTimerRef = useRef<number | null>(null);
    const videoRef = useRef<HTMLVideoElement>(null);
    const progressAnimationRef = useRef<number | null>(null);
    const lastPlaybackPositionRef = useRef<number>(0);

    const { setBadgeContent, setBadgeVisible } = useBadge();

    const handleCardClick = () => {
        rememberReturnToClip(video.path);
        navigate({
            to: "/clips/edit",
            search: { videoPath: video.path, videoName: video.name },
        });
    };

    const handleMouseEnter = () => {
        if (video.scanError) return;
        // Show the game icon + name in the window badge while hovering.
        setBadgeContent(
            <div className="flex items-center gap-1">
                <GameIcon game={video.game} gameImage={gameImage} />
                <span className="text-sm">{video.game || "Clip Editor"}</span>
            </div>,
        );
        setBadgeVisible(true);
        hoverTimerRef.current = window.setTimeout(() => {
            setShowVideo(true);
        }, 700);
    };

    const handleMouseLeave = () => {
        setBadgeVisible(false);
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
        if (videoRef.current && lastPlaybackPositionRef.current > 0) {
            const duration = videoRef.current.duration || 0;
            if (lastPlaybackPositionRef.current < duration) {
                videoRef.current.currentTime = lastPlaybackPositionRef.current;
                setProgress((lastPlaybackPositionRef.current / duration) * 100);
            } else {
                lastPlaybackPositionRef.current = 0;
            }
        }
        if (videoRef.current && showVideo) {
            videoRef.current.play().catch(() => undefined);
        }
    };

    // Drive the hover-preview progress bar with a self-contained rAF loop that
    // starts/stops with (showVideo, videoLoaded). Ref writes happen in the
    // effect; state updates happen in the animation frame callback.
    useEffect(() => {
        if (showVideo && videoLoaded) {
            if (videoRef.current) videoRef.current.play().catch(() => undefined);
            const tick = () => {
                const video = videoRef.current;
                if (!video) return;
                if (showVideo && videoLoaded && video.duration) {
                    setProgress((video.currentTime / video.duration) * 100);
                }
                progressAnimationRef.current = requestAnimationFrame(tick);
            };
            progressAnimationRef.current = requestAnimationFrame(tick);
        } else {
            if (videoRef.current) videoRef.current.pause();
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

    useEffect(() => {
        return () => {
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
            if (progressAnimationRef.current) cancelAnimationFrame(progressAnimationRef.current);
            lastPlaybackPositionRef.current = 0;
        };
    }, []);

    const groupDots = groupIds
        .slice(0, 3)
        .map((id) => groups.find((g) => g.id === id))
        .filter(Boolean) as VideoGroup[];

    return (
        <Frame
            className={cn(
                "selectable-item cursor-pointer border-2 border-transparent transition-colors duration-150 ease-snappy select-none scroll-mt-11",
                isSelected ? "border-primary/70 hover:border-primary/90" : "hover:border-accent",
            )}
            onClick={handleCardClick}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            data-video-path={video.path}
        >
            <FramePanel className="relative aspect-video overflow-hidden p-0">
                {showVideo && (
                    <video
                        ref={videoRef}
                        src={videoUrl}
                        className={`absolute inset-0 h-full w-full object-cover transition-opacity duration-300 ease-in-out ${
                            videoLoaded ? "opacity-100" : "opacity-0"
                        }`}
                        muted
                        loop
                        playsInline
                        preload="metadata"
                        onLoadedData={handleVideoLoad}
                    />
                )}

                {showThumb ? (
                    <img
                        src={imgSrc(thumbUrl)}
                        alt={`Thumbnail for ${encodeURIComponent(video.name)}`}
                        className={`h-full w-full object-cover transition-opacity duration-300 ease-in-out ${
                            showVideo && videoLoaded ? "opacity-0" : "opacity-100"
                        }`}
                        loading="lazy"
                        draggable={false}
                        onError={() => setThumbFailedUrl(thumbUrl)}
                        onDragStart={(e) => e.preventDefault()}
                    />
                ) : thumbhashUrl ? (
                    <img
                        src={thumbhashUrl}
                        alt={`Thumbnail for ${encodeURIComponent(video.name)}`}
                        className={`h-full w-full object-cover transition-opacity duration-300 ease-in-out ${
                            showVideo && videoLoaded ? "opacity-0" : "opacity-100"
                        }`}
                        draggable={false}
                        onDragStart={(e) => e.preventDefault()}
                    />
                ) : (
                    <div
                        className={`flex h-full w-full flex-col items-center justify-center gap-2 transition-opacity duration-300 ease-in-out ${
                            showVideo && videoLoaded ? "opacity-0" : "opacity-100"
                        }`}
                    >
                        <Gamepad2Icon size={40} className="text-muted-foreground opacity-50" />
                        <p className="text-muted-foreground text-xs">
                            {video.scanError ? "Unreadable file" : "Generating thumbnail..."}
                        </p>
                    </div>
                )}

                {showVideo && videoLoaded && (
                    <div
                        className={`absolute right-0 bottom-0 left-0 ${isHoveringProgressBar ? "h-3 cursor-pointer" : "h-1"} bg-background/20 transition-all duration-200`}
                        onClick={(e) => {
                            e.stopPropagation();
                            if (!videoRef.current) return;
                            const rect = e.currentTarget.getBoundingClientRect();
                            const percentage = ((e.clientX - rect.left) / rect.width) * 100;
                            const seekTime = (videoRef.current.duration || 0) * (percentage / 100);
                            videoRef.current.currentTime = seekTime;
                            lastPlaybackPositionRef.current = seekTime;
                            setProgress(percentage);
                        }}
                        onMouseEnter={() => setIsHoveringProgressBar(true)}
                        onMouseLeave={() => setIsHoveringProgressBar(false)}
                    >
                        <div
                            className="bg-accent-positive h-full transition-all duration-100"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                )}
            </FramePanel>
            <FrameFooter className="flex flex-col gap-1 px-4 py-2">
                <h3 className="group relative line-clamp-1 text-lg font-medium">{video.name}</h3>
                {groupDots.length > 0 && (
                    <div className="flex gap-1">
                        {groupDots.map((group) => (
                            <span
                                key={group.id}
                                className="h-3 w-3 rounded-full"
                                style={{
                                    backgroundColor: group.color ?? "var(--accent-color)",
                                }}
                            />
                        ))}
                        {groupIds.length > 3 && (
                            <span className="text-muted-foreground text-xs">
                                +{groupIds.length - 3}
                            </span>
                        )}
                    </div>
                )}
                {video.game && (
                    <p className="bg-muted text-muted-foreground flex h-5 w-fit items-center gap-1 rounded py-0.5 pr-1 pl-0.5 text-xs">
                        <GameIcon game={video.game} gameImage={gameImage} />
                        {video.game}
                    </p>
                )}
                <div className="flex flex-wrap justify-between gap-1">
                    <p className="text-muted-foreground text-sm">
                        {(video.size / (1024 * 1024)).toFixed(1)} MB
                    </p>
                    <p className="text-muted-foreground text-sm">
                        {formatDateTime(video.lastModified)}
                    </p>
                </div>
            </FrameFooter>
        </Frame>
    );
});

export function formatDateTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
    ];
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}, ${hh}:${mm}`;
}
