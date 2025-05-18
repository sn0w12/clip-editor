import { Button } from "@/components/ui/button";
import { VideoCard } from "@/components/home/video-card";
import { VideoContextMenu } from "@/components/home/video-context-menu";
import { VideoFile, VideoGroup } from "@/types/video";
import React, { useMemo } from "react";
import { Separator } from "@/components/ui/separator";
import { useSteam } from "@/contexts/steam-context";

interface VideoGridProps {
    isLoading: boolean;
    filteredVideos: VideoFile[];
    selectedVideos: string[];
    thumbnails: Record<string, string>;
    groups: VideoGroup[];
    videoGroupMap: Record<string, string[]>;
    onSelectDirectory: () => Promise<void>;
    onAddToGroup: (videoIds: string[], groupId: string) => void;
    onShowCreateGroup: () => void;
    onRemoveFromGroup: (videoIds: string[], groupId: string) => void;
}

/**
 * Grid component that displays videos or loading/empty states
 */
function VideoGridBase({
    isLoading,
    filteredVideos,
    selectedVideos,
    thumbnails,
    groups,
    videoGroupMap,
    onSelectDirectory,
    onAddToGroup,
    onShowCreateGroup,
    onRemoveFromGroup,
}: VideoGridProps) {
    const { games } = useSteam();

    const sortedGames = useMemo(() => {
        return Object.entries(games)
            .map(([slug, { appid, displayName }]) => ({
                id: appid,
                slug,
                name: displayName,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [games]);

    const videosByDate = useMemo(() => {
        const groupedVideos: Record<string, VideoFile[]> = {};

        filteredVideos.forEach((video) => {
            const date = new Date(video.lastModified);
            const dateString = date.toISOString().split("T")[0]; // YYYY-MM-DD

            if (!groupedVideos[dateString]) {
                groupedVideos[dateString] = [];
            }

            groupedVideos[dateString].push(video);
        });

        // Get today and yesterday dates
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const todayString = today.toISOString().split("T")[0];
        const yesterdayString = yesterday.toISOString().split("T")[0];

        // Convert to array sorted by date (newest first)
        return Object.entries(groupedVideos)
            .map(([dateString, videos]) => {
                const date = new Date(dateString);
                let formattedDate;

                if (dateString === todayString) {
                    formattedDate = "Today";
                } else if (dateString === yesterdayString) {
                    formattedDate = "Yesterday";
                } else {
                    formattedDate = date.toLocaleDateString("en-US", {
                        weekday: "long",
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                    });
                }

                // Sort videos within each date group by last modified time (newest first)
                const sortedVideos = [...videos].sort(
                    (a, b) =>
                        new Date(b.lastModified).getTime() -
                        new Date(a.lastModified).getTime(),
                );

                return {
                    date: dateString,
                    formattedDate,
                    videos: sortedVideos,
                };
            })
            .sort(
                (a, b) =>
                    new Date(b.date).getTime() - new Date(a.date).getTime(),
            );
    }, [filteredVideos]);

    if (isLoading) {
        return (
            <div className="flex h-64 items-center justify-center">
                <p>Loading videos...</p>
            </div>
        );
    }

    if (filteredVideos.length === 0) {
        return (
            <div className="flex h-64 flex-col items-center justify-center">
                <p className="text-muted-foreground">
                    No video files found in the selected directory.
                </p>
                <Button
                    onClick={onSelectDirectory}
                    variant="outline"
                    className="mt-4"
                >
                    Select Another Directory
                </Button>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {videosByDate.map((dateGroup) => (
                <div key={dateGroup.date} className="mb-0 space-y-4">
                    <div className="bg-background sticky top-0 z-10 mb-0 flex items-center overflow-hidden py-2">
                        <h3 className="pr-2 text-lg font-medium text-nowrap">
                            {dateGroup.formattedDate}
                        </h3>
                        <Separator className="from-border bg-gradient-to-r to-transparent" />
                    </div>
                    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {dateGroup.videos.map((video) => (
                            <VideoContextMenu
                                key={video.path}
                                video={video}
                                videos={filteredVideos}
                                videoIds={
                                    selectedVideos.length > 0 &&
                                    selectedVideos.includes(video.path)
                                        ? selectedVideos
                                        : [video.path]
                                }
                                groups={groups}
                                videoGroupMap={videoGroupMap}
                                onAddToGroup={onAddToGroup}
                                onShowCreateGroup={onShowCreateGroup}
                                onRemoveFromGroup={onRemoveFromGroup}
                                sortedGames={sortedGames}
                            >
                                <VideoCard
                                    video={video}
                                    thumbnailUrl={thumbnails[video.path]}
                                    isSelected={selectedVideos.includes(
                                        video.path,
                                    )}
                                    videoGroupMap={videoGroupMap}
                                    groups={groups}
                                />
                            </VideoContextMenu>
                        ))}
                    </div>
                </div>
            ))}{" "}
        </div>
    );
}

export const VideoGrid = React.memo(VideoGridBase);
