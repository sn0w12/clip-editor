import { useNavigate } from "@tanstack/react-router";
import { memo } from "react";

import { Separator } from "@/components/ui/separator";
import { rememberReturnToClip } from "@/lib/return-to-clip";
import { cn } from "@/lib/utils";
import type { GameImage, VideoFile, VideoGroup } from "@/types";

import { GameIcon } from "../game-icon";
import { formatDateTime } from "./video-card";

interface VideoListProps {
    video: VideoFile;
    isSelected: boolean;
    gameImage?: GameImage | null;
    groups: VideoGroup[];
    groupIds: string[];
}

export const VideoList = memo(function VideoList({
    video,
    isSelected,
    gameImage,
    groups,
    groupIds,
}: VideoListProps) {
    const navigate = useNavigate();
    const groupDots = groupIds
        .slice(0, 3)
        .map((id) => groups.find((g) => g.id === id))
        .filter(Boolean) as VideoGroup[];

    return (
        <div
            className={cn(
                "selectable-item flex h-9 cursor-pointer scroll-mt-10 flex-row items-center gap-1 rounded-md px-2 transition-colors duration-200 hover:bg-muted",
                { "bg-muted": isSelected }
            )}
            onClick={() => {
                rememberReturnToClip(video.path);
                navigate({
                    to: "/clips/edit",
                    search: { videoPath: video.path, videoName: video.name },
                });
            }}
            data-video-path={video.path}
        >
            <GameIcon
                game={video.game}
                gameImage={gameImage}
                className="size-6"
            />
            <Separator orientation="vertical" className="h-8!" />
            {groupDots.length > 0 && (
                <div className="flex gap-1">
                    {groupDots.map((group) => (
                        <span
                            key={group.id}
                            className="h-3 w-3 rounded-full"
                            style={{
                                backgroundColor:
                                    group.color ?? "var(--muted-foreground)",
                            }}
                        />
                    ))}
                    {groupIds.length > 3 && (
                        <span className="text-xs text-muted-foreground">
                            +{groupIds.length - 3}
                        </span>
                    )}
                </div>
            )}
            <div className="flex w-full min-w-0 items-center justify-between gap-1">
                <h3 className="ui-selectable truncate">{video.name}</h3>
                <div className="flex items-center gap-1">
                    <p className="font-mono text-sm text-muted-foreground">
                        {(video.size / (1024 * 1024)).toFixed(1)} MB
                    </p>
                    <Separator orientation="vertical" className="h-8!" />
                    <p className="w-38 font-mono text-sm text-muted-foreground">
                        {formatDateTime(video.lastModified)}
                    </p>
                </div>
            </div>
        </div>
    );
});
