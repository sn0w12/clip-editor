import { useNavigate } from "@tanstack/react-router";
import { Gamepad2Icon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { Frame, FramePanel, FrameFooter } from "@/components/ui/frame";
import { useThumbnail } from "@/hooks/use-thumbnails";
import { rememberReturnToClip } from "@/lib/return-to-clip";
import { imgSrc, videoSrc } from "@/lib/tauri";
import { thumbHashBase64ToDataURL } from "@/lib/thumbhash";
import { cn } from "@/lib/utils";
import type { GameImage, VideoFile, VideoGroup, VideoMetadata } from "@/types";

import { GameIcon } from "../game-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

function previewDuration(
    video: HTMLVideoElement | null,
    metadata?: VideoMetadata | null
): number {
    const own = video?.duration;
    if (own != null && Number.isFinite(own) && own > 0) return own;
    const meta = metadata?.duration;
    if (meta != null && Number.isFinite(meta) && meta > 0) return meta;
    if (video && video.seekable.length > 0) {
        const end = video.seekable.end(video.seekable.length - 1);
        if (Number.isFinite(end) && end > 0) return end;
    }
    return 0;
}

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
    const fallbackThumb = useThumbnail(
        scanError ? undefined : inlineThumb ? undefined : path
    );
    const thumbUrl = inlineThumb ?? fallbackThumb ?? null;
    const [thumbFailedUrl, setThumbFailedUrl] = useState<string | null>(null);
    const showThumb = thumbUrl !== null && thumbFailedUrl !== thumbUrl;
    const thumbhashUrl = useMemo(
        () =>
            !showThumb && thumbhash
                ? thumbHashBase64ToDataURL(thumbhash)
                : null,
        [showThumb, thumbhash]
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

    const handleCardClick = () => {
        rememberReturnToClip(video.path);
        navigate({
            to: "/clips/edit",
            search: { videoPath: video.path, videoName: video.name },
        });
    };

    const handleMouseEnter = () => {
        if (video.scanError) return;
        hoverTimerRef.current = window.setTimeout(() => {
            setShowVideo(true);
        }, 700);
    };

    const handleMouseLeave = () => {
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
            const duration = previewDuration(videoRef.current, video.metadata);
            if (duration > 0 && lastPlaybackPositionRef.current < duration) {
                videoRef.current.currentTime = lastPlaybackPositionRef.current;
                setProgress((lastPlaybackPositionRef.current / duration) * 100);
            } else {
                lastPlaybackPositionRef.current = 0;
            }
        }
        videoRef.current?.play().catch(() => undefined);
    };

    const startProgressLoop = () => {
        if (progressAnimationRef.current) return;
        const tick = () => {
            const el = videoRef.current;
            if (!el || el.paused) {
                progressAnimationRef.current = null;
                return;
            }
            const duration = previewDuration(el, video.metadata);
            if (duration > 0) {
                setProgress(Math.min(100, (el.currentTime / duration) * 100));
            }
            progressAnimationRef.current = requestAnimationFrame(tick);
        };
        progressAnimationRef.current = requestAnimationFrame(tick);
    };

    const stopProgressLoop = () => {
        if (progressAnimationRef.current) {
            cancelAnimationFrame(progressAnimationRef.current);
            progressAnimationRef.current = null;
        }
    };

    useEffect(() => {
        return () => {
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
            if (progressAnimationRef.current)
                cancelAnimationFrame(progressAnimationRef.current);
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
                "selectable-item cursor-pointer scroll-mt-11 border-2 border-transparent transition-colors duration-150 ease-snappy select-none",
                isSelected
                    ? "border-primary/70 hover:border-primary/90"
                    : "hover:border-accent"
            )}
            onClick={handleCardClick}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            data-video-path={video.path}
        >
            <FramePanel className="relative aspect-video overflow-hidden p-0">
                {showVideo && videoUrl && (
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
                        onPlay={startProgressLoop}
                        onPause={stopProgressLoop}
                        onEnded={stopProgressLoop}
                    />
                )}

                {showThumb ? (
                    <img
                        src={imgSrc(thumbUrl)}
                        alt={`Thumbnail for ${encodeURIComponent(video.name)}`}
                        className={`h-full w-full object-cover transition-opacity duration-300 ease-in-out ${
                            showVideo && videoLoaded
                                ? "opacity-0"
                                : "opacity-100"
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
                            showVideo && videoLoaded
                                ? "opacity-0"
                                : "opacity-100"
                        }`}
                        draggable={false}
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
                        <Gamepad2Icon
                            size={40}
                            className="text-muted-foreground opacity-50"
                        />
                        <p className="text-xs text-muted-foreground">
                            {video.scanError
                                ? "Unreadable file"
                                : "Generating thumbnail..."}
                        </p>
                    </div>
                )}

                {showVideo && videoLoaded && (
                    <div
                        className={cn(
                            "hit-area-y-2 absolute right-0 bottom-0 left-0 h-1.5 bg-background/20 duration-200 ease-snappy",
                            isHoveringProgressBar &&
                                "hit-area-x-2 bottom-2 mx-2 cursor-pointer rounded-full bg-background/40"
                        )}
                        onClick={(e) => {
                            e.stopPropagation();
                            const el = videoRef.current;
                            if (!el) return;
                            const rect =
                                e.currentTarget.getBoundingClientRect();
                            const percentage =
                                ((e.clientX - rect.left) / rect.width) * 100;
                            const duration = previewDuration(
                                el,
                                video.metadata
                            );
                            if (duration <= 0) return;
                            const seekTime = duration * (percentage / 100);
                            el.currentTime = seekTime;
                            lastPlaybackPositionRef.current = seekTime;
                            setProgress(percentage);
                        }}
                        onMouseEnter={() => setIsHoveringProgressBar(true)}
                        onMouseLeave={() => setIsHoveringProgressBar(false)}
                    >
                        <div
                            className={cn(
                                "h-full bg-info transition-all duration-200 ease-snappy",
                                isHoveringProgressBar && "rounded-full"
                            )}
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                )}
            </FramePanel>
            <FrameFooter className="flex flex-col gap-1 p-2">
                <h3 className="ui-selectable group relative line-clamp-1 text-lg font-medium">
                    {video.name}
                </h3>
                <div className="flex items-center gap-1">
                    {groupDots.length > 0 && (
                        <div className="flex gap-1">
                            {groupDots.map((group) => (
                                <Tooltip key={group.id}>
                                    <TooltipTrigger
                                        render={
                                            <span
                                                className="h-3 w-3 rounded-full"
                                                style={{
                                                    backgroundColor:
                                                        group.color ??
                                                        "var(--muted-foreground)",
                                                }}
                                            />
                                        }
                                    />
                                    <TooltipContent>
                                        {group.name}
                                    </TooltipContent>
                                </Tooltip>
                            ))}
                            {groupIds.length > 3 && (
                                <span className="text-xs text-muted-foreground">
                                    +{groupIds.length - 3}
                                </span>
                            )}
                        </div>
                    )}
                    {video.game && (
                        <p className="flex h-5 w-fit items-center gap-1 rounded bg-muted py-0.5 pr-1 pl-0.5 text-xs text-muted-foreground">
                            <GameIcon game={video.game} gameImage={gameImage} />
                            {video.game}
                        </p>
                    )}
                </div>
                <div className="flex flex-wrap justify-between gap-1">
                    <p className="font-mono text-sm text-muted-foreground">
                        {(video.size / (1024 * 1024)).toFixed(1)} MB
                    </p>
                    <p className="font-mono text-sm text-muted-foreground">
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
