import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { VideoContextMenu } from "@/pages/home-page";
import { useGamesStore } from "@/stores/games-store";
import type { GameImage, VideoFile, VideoGroup } from "@/types";

import { VideoCard } from "./video-card";
import { VideoList } from "./video-list";

interface VideoGridProps {
    isLoading: boolean;
    filteredVideos: VideoFile[];
    selectedVideos: string[];
    groups: VideoGroup[];
    videoGroupMap: Record<string, string[]>;
    gameImages: Record<string, GameImage | null>;
    games: ReturnType<typeof useGamesStore>;
    viewMode: "grid" | "list";
    onSelectDirectory: () => Promise<unknown>;
    onOpen: (video: VideoFile) => void;
    onDelete: (paths: string[]) => void;
    onRename: (video: VideoFile) => void;
    onAddToGroup: (video: VideoFile, groupId: string) => void;
    onRemoveFromGroup: (video: VideoFile, groupId: string) => void;
}

export function VideoGrid({
    isLoading,
    filteredVideos,
    selectedVideos,
    groups,
    videoGroupMap,
    gameImages,
    games,
    viewMode,
    onSelectDirectory,
    onOpen,
    onDelete,
    onRename,
    onAddToGroup,
    onRemoveFromGroup,
}: VideoGridProps) {
    const videosByDate = useMemo(() => {
        const grouped: Record<string, VideoFile[]> = {};
        for (const video of filteredVideos) {
            const dateString = new Date(video.lastModified).toISOString().split("T")[0];
            (grouped[dateString] ??= []).push(video);
        }
        const now = new Date();
        const todayString = now.toLocaleDateString("en-CA");
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayString = yesterday.toLocaleDateString("en-CA");
        return Object.entries(grouped)
            .map(([dateString, videos]) => {
                const date = new Date(dateString);
                let formattedDate: string;
                if (dateString === todayString) formattedDate = "Today";
                else if (dateString === yesterdayString) formattedDate = "Yesterday";
                else {
                    formattedDate = date.toLocaleDateString("en-US", {
                        weekday: "long",
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                    });
                }
                const sortedVideos = [...videos].sort(
                    (a, b) =>
                        new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
                );
                return {
                    date: dateString,
                    formattedDate,
                    videos: sortedVideos,
                };
            })
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }, [filteredVideos]);

    if (isLoading) {
        return (
            <div className="space-y-6">
                {[0, 1, 2].map((group) => (
                    <div key={group} className="space-y-4">
                        <Skeleton className="h-7 w-44" />
                        <div
                            className={
                                viewMode === "grid"
                                    ? "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                                    : "grid grid-cols-1"
                            }
                        >
                            {Array.from({
                                length: viewMode === "grid" ? 8 : 5,
                            }).map((_, i) => (
                                <div key={i} className="bg-muted rounded-lg">
                                    <Skeleton className="aspect-video w-full rounded-b-none" />
                                    <div className="space-y-2 p-4">
                                        <Skeleton className="h-5 w-3/4" />
                                        <Skeleton className="h-4 w-1/3" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        );
    }

    if (filteredVideos.length === 0) {
        return (
            <div className="flex h-64 flex-col items-center justify-center">
                <p className="text-muted-foreground">
                    No video files found in the selected directory.
                </p>
                <Button onClick={() => void onSelectDirectory()} variant="outline" className="mt-4">
                    Select Another Directory
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {videosByDate.map((dateGroup) => (
                <div key={dateGroup.date} className="mb-0 space-y-4">
                    <div className="bg-background time-header sticky top-0 z-10 mb-0 flex items-center py-2">
                        <h3 className="pr-2 text-lg font-medium text-nowrap">
                            {dateGroup.formattedDate}
                        </h3>
                        <Separator className="from-border via-border/20 bg-gradient-to-r to-transparent" />
                        <svg
                            className="pointer-events-none absolute top-full left-0 size-3"
                            viewBox="0 0 12 12"
                            aria-hidden="true"
                        >
                            <path d="M0 0 L0 12 A12 12 0 0 1 12 0 Z" fill="var(--background)" />
                        </svg>
                        <svg
                            className="pointer-events-none absolute top-full right-0 size-3 -scale-x-100"
                            viewBox="0 0 12 12"
                            aria-hidden="true"
                        >
                            <path d="M0 0 L0 12 A12 12 0 0 1 12 0 Z" fill="var(--background)" />
                        </svg>
                    </div>
                    <div
                        className={
                            viewMode === "grid"
                                ? "grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
                                : "grid grid-cols-1"
                        }
                    >
                        {dateGroup.videos.map((video) => {
                            const groupIds = videoGroupMap[video.path] ?? [];
                            return (
                                <VideoContextMenu
                                    key={video.path}
                                    video={video}
                                    groupIds={groupIds}
                                    groups={groups}
                                    games={games}
                                    onOpen={onOpen}
                                    onDelete={onDelete}
                                    onRename={onRename}
                                    onAddToGroup={onAddToGroup}
                                    onRemoveFromGroup={onRemoveFromGroup}
                                >
                                    {viewMode === "grid" ? (
                                        <VideoCard
                                            video={video}
                                            isSelected={selectedVideos.includes(video.path)}
                                            gameImage={gameImages[video.game] ?? null}
                                            groups={groups}
                                            groupIds={groupIds}
                                        />
                                    ) : (
                                        <VideoList
                                            video={video}
                                            isSelected={selectedVideos.includes(video.path)}
                                            gameImage={gameImages[video.game] ?? null}
                                            groups={groups}
                                            groupIds={groupIds}
                                        />
                                    )}
                                </VideoContextMenu>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}
