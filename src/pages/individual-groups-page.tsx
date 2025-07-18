import React, { useEffect, useMemo } from "react";
import { useVideoStore } from "@/contexts/video-store-context";
import { useParams, useNavigate } from "@tanstack/react-router";
import { VideoCard } from "@/components/home/video-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ChevronLeft, Clock, Calendar, LayoutGrid } from "lucide-react";
import { Label } from "@/components/ui/label";
import { useBadge } from "@/contexts/badge-context";
import { formatTime } from "@/utils/format";

export default function GroupDetailPage() {
    const { groupId } = useParams({ from: "/groups/$groupId" });
    const navigate = useNavigate();
    const {
        videos,
        thumbnails,
        videoMetadata,
        groups,
        videoGroupMap,
        videoGroupAssignments,
        isLoading,
    } = useVideoStore();
    const { setBadgeContent, setBadgeVisible } = useBadge();

    // Find the current group
    const currentGroup = useMemo(() => {
        return groups.find((group) => group.id === groupId);
    }, [groupId, groups]);

    // Get videos for this group
    const groupVideos = useMemo(() => {
        // Get all video paths for this group
        const videoPaths = videoGroupAssignments
            .filter((assignment) => assignment.groupId === groupId)
            .map((assignment) => assignment.videoPath);

        // Return the video objects for these paths
        return videos
            .filter((video) => videoPaths.includes(video.path))
            .sort((a, b) => {
                if (!a.lastModified) return 1;
                if (!b.lastModified) return -1;

                return (
                    new Date(b.lastModified).getTime() -
                    new Date(a.lastModified).getTime()
                );
            });
    }, [videos, videoGroupAssignments, groupId]);

    // Calculate total duration using videoMetadata
    const totalDuration = useMemo(() => {
        return groupVideos.reduce((total, video) => {
            const metadata = videoMetadata[video.path];
            return total + (metadata?.duration || 0);
        }, 0);
    }, [groupVideos, videoMetadata]);

    // Get earliest and latest dates
    const dateRange = useMemo(() => {
        if (!groupVideos.length) return null;

        const dates = groupVideos
            .map((v) => (v.lastModified ? new Date(v.lastModified) : null))
            .filter(Boolean) as Date[];

        if (!dates.length) return null;

        return {
            earliest: new Date(Math.min(...dates.map((d) => d.getTime()))),
            latest: new Date(Math.max(...dates.map((d) => d.getTime()))),
        };
    }, [groupVideos]);

    const handleBackClick = () => {
        navigate({ to: "/groups" });
    };

    useEffect(() => {
        setBadgeContent(
            <div className="flex items-center gap-1">
                <span
                    className="h-4 w-4 rounded-full"
                    style={{ backgroundColor: currentGroup?.color }}
                />
                <span className="text-sm">{currentGroup?.name}</span>
            </div>,
        );
        setBadgeVisible(true);
        return () => setBadgeVisible(false);
    }, [setBadgeContent]);

    if (isLoading) {
        return (
            <div className="flex flex-col p-4">
                <Skeleton className="mb-4 h-10 w-48" />
                <Skeleton className="mb-6 h-6 w-96" />
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <Skeleton
                            key={i}
                            className="h-[180px] w-full rounded"
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (!currentGroup) {
        return (
            <div className="flex h-full flex-col items-center justify-center p-4">
                <p className="text-muted-foreground mb-4">Group not found</p>
                <Button onClick={handleBackClick}>
                    <ChevronLeft className="mr-1 h-4 w-4" />
                    Back to Groups
                </Button>
            </div>
        );
    }

    return (
        <div className="flex flex-col p-4 px-6 pr-4">
            <div className="bg-background sticky top-0 z-10">
                <div className="flex items-center">
                    <span
                        className="mr-3 inline-block h-6 w-6 rounded-full"
                        style={{ backgroundColor: currentGroup.color }}
                    />
                    <h1 className="text-3xl font-bold">{currentGroup.name}</h1>
                </div>

                <div className="text-muted-foreground mt-2 flex flex-wrap gap-4">
                    <div className="flex items-center gap-1">
                        <LayoutGrid className="h-4 w-4" />
                        <Label>{groupVideos.length} clips</Label>
                    </div>

                    {totalDuration > 0 && (
                        <div className="flex items-center gap-1">
                            <Clock className="h-4 w-4" />
                            <Label>{formatTime(totalDuration)}</Label>
                        </div>
                    )}

                    {dateRange && (
                        <div className="flex items-center gap-1">
                            <Calendar className="h-4 w-4" />
                            <Label>
                                {dateRange.earliest.toLocaleDateString()} -{" "}
                                {dateRange.latest.toLocaleDateString()}
                            </Label>
                        </div>
                    )}
                </div>
            </div>

            {/* Video grid */}
            <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {groupVideos.map((video) => (
                    <VideoCard
                        key={video.path}
                        video={video}
                        thumbnailUrl={thumbnails[video.path]}
                        isSelected={false}
                        videoGroupMap={videoGroupMap}
                        groups={groups}
                    />
                ))}
            </div>

            {groupVideos.length === 0 && (
                <div className="mt-8 flex h-40 flex-col items-center justify-center rounded-lg border border-dashed">
                    <p className="text-muted-foreground">
                        No clips in this group
                    </p>
                </div>
            )}
        </div>
    );
}
