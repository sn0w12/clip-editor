import React from "react";
import { useNavigate } from "@tanstack/react-router";
import { useSteam } from "@/contexts/steam-context";
import { getGameId, imgSrc } from "@/utils/games";
import { VideoFile, VideoGroup } from "@/types/video";
import { Separator } from "../ui/separator";
import { format } from "date-fns";
import { cn } from "@/utils/tailwind";

interface VideoListProps {
    video: VideoFile;
    isSelected: boolean;
    videoGroupMap: Record<string, string[]>;
    groups: VideoGroup[];
}

export function VideoList({
    video,
    isSelected,
    videoGroupMap,
    groups,
}: VideoListProps) {
    const navigate = useNavigate();
    const { games, gameImages, loading } = useSteam();

    const appId = getGameId(video.game, games, loading);
    const hasGameIcon = appId && gameImages[appId]?.icon;

    return (
        <div
            className={cn(
                "hover:bg-muted selectable-item flex h-9 cursor-pointer flex-row items-center gap-1 rounded-md px-2 transition-colors duration-200",
                {
                    "bg-muted": isSelected,
                },
            )}
            onClick={() => {
                navigate({
                    to: "/clips/edit",
                    search: {
                        videoPath: video.path,
                        videoName: video.name,
                    },
                });
            }}
        >
            {hasGameIcon && (
                <img
                    src={imgSrc(gameImages[appId].icon)}
                    alt={video.name}
                    className="h-6 w-auto rounded"
                />
            )}
            <Separator orientation="vertical" className="h-8!" />
            {videoGroupMap[video.path]?.length > 0 && (
                <div className="flex gap-1">
                    {videoGroupMap[video.path]?.slice(0, 3).map((groupId) => {
                        const group = groups.find((g) => g.id === groupId);
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
            <div className="flex w-full items-center justify-between gap-1">
                <h3>{video.name}</h3>
                <div className="flex items-center gap-1">
                    <p className="text-muted-foreground text-sm">
                        {(video.size / (1024 * 1024)).toFixed(1)} MB
                    </p>
                    <Separator orientation="vertical" className="h-8!" />
                    <p className="text-muted-foreground w-38 text-sm">
                        {format(
                            new Date(video.lastModified),
                            "MMM d, yyyy, HH:mm",
                        )}
                    </p>
                </div>
            </div>
        </div>
    );
}
