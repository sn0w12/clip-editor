import React from "react";
import { Card } from "@/components/ui/card";
import { VideoFile, VideoGroup } from "@/types/video";
import { FileVideo, Gamepad2 } from "lucide-react";
import { format } from "date-fns";
import { useNavigate } from "@tanstack/react-router";
import { useSteam } from "@/contexts/steam-context";
import { imgSrc, normalizeGameName } from "@/utils/games";
import { Skeleton } from "../ui/skeleton";

interface VideoCardProps {
    video: VideoFile;
    thumbnailUrl?: string;
    isSelected: boolean;
    videoGroupMap: Record<string, string[]>;
    groups: VideoGroup[];
}

/**
 * Card component to display a video with its thumbnail and metadata
 */
export function VideoCard({
    video,
    thumbnailUrl,
    isSelected,
    videoGroupMap,
    groups,
}: VideoCardProps) {
    const navigate = useNavigate();
    const { games, gameImages, loading } = useSteam();

    // Only attempt to get appId if we have game data and a game name
    const normalizedGameName = video.game ? normalizeGameName(video.game) : "";
    const appId =
        !loading && normalizedGameName ? games[normalizedGameName] : undefined;

    // Determine if we can show the game icon
    const hasGameIcon = appId && gameImages[appId]?.icon;

    const handleCardClick = () => {
        // Use search params to pass video data directly to the edit page
        navigate({
            to: "/clips/edit",
            search: {
                videoPath: video.path,
                videoName: video.name,
            },
        });
    };

    return (
        <Card
            className={`selectable-item hover:border-primary/70 ease-snappy cursor-pointer gap-0 overflow-hidden py-0 transition-colors duration-200 ${
                isSelected ? "border-primary bg-accent" : ""
            }`}
            onClick={handleCardClick}
            data-video-path={video.path}
        >
            <div className="bg-muted aspect-video">
                {thumbnailUrl ? (
                    <img
                        src={thumbnailUrl}
                        alt={`Thumbnail for ${encodeURIComponent(video.name)}`}
                        className="h-full w-full object-cover"
                        loading="lazy"
                        draggable="false"
                        onDragStart={(e) => e.preventDefault()}
                    />
                ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2">
                        <FileVideo
                            size={40}
                            className="text-muted-foreground opacity-50"
                        />
                        <p className="text-muted-foreground text-xs">
                            Generating thumbnail...
                        </p>
                    </div>
                )}
            </div>
            <div className="p-4">
                <div className="flex items-center justify-between">
                    <h3
                        className="line-clamp-1 text-lg font-medium"
                        title={video.name}
                    >
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
                        {format(new Date(video.lastModified), "MMM d, yyyy")}
                    </p>
                </div>
            </div>
        </Card>
    );
}
