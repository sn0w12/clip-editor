import React, { useEffect, useMemo } from "react";
import { useVideoStore } from "@/contexts/video-store-context";
import { useSteam } from "@/contexts/steam-context";
import { useParams, useNavigate } from "@tanstack/react-router";
import { getGameId, imgSrc } from "@/utils/games";
import { VideoCard } from "@/components/home/video-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { ChevronLeft, Clock, Calendar, LayoutGrid } from "lucide-react";
import { Label } from "@/components/ui/label";
import { useBadge } from "@/contexts/badge-context";
import { formatTime } from "@/utils/format";

export default function GameDetailPage() {
    const { gameName } = useParams({ from: "/games/$gameName" });
    const navigate = useNavigate();
    const { videos, thumbnails, videoMetadata, groups, videoGroupMap } =
        useVideoStore();
    const { games, gameImages, loading } = useSteam();
    const { setBadgeContent, setBadgeVisible } = useBadge();

    const decodedGameName = decodeURIComponent(gameName);

    // Get game data
    const gameData = useMemo(() => {
        if (loading) return null;

        const appId = getGameId(decodedGameName, games, loading);
        const gameImage = appId && gameImages[appId];

        return {
            name: decodedGameName,
            appId: appId || "",
            images: gameImage || {},
        };
    }, [decodedGameName, games, gameImages, loading]);

    const gameVideos = useMemo(() => {
        return videos
            .filter((video) => video.game === decodedGameName)
            .sort((a, b) => {
                if (!a.lastModified) return 1;
                if (!b.lastModified) return -1;

                return (
                    new Date(b.lastModified).getTime() -
                    new Date(a.lastModified).getTime()
                );
            });
    }, [videos, decodedGameName]);

    // Calculate total duration using videoMetadata
    const totalDuration = useMemo(() => {
        return gameVideos.reduce((total, video) => {
            // Get duration from metadata if available
            const metadata = videoMetadata[video.path];
            return total + (metadata?.duration || 0);
        }, 0);
    }, [gameVideos, videoMetadata]);

    // Get earliest and latest dates
    const dateRange = useMemo(() => {
        if (!gameVideos.length) return null;

        const dates = gameVideos
            .map((v) => (v.lastModified ? new Date(v.lastModified) : null))
            .filter(Boolean) as Date[];

        if (!dates.length) return null;

        return {
            earliest: new Date(Math.min(...dates.map((d) => d.getTime()))),
            latest: new Date(Math.max(...dates.map((d) => d.getTime()))),
        };
    }, [gameVideos]);

    const iconImage = gameData?.images
        ? imgSrc(gameData.images.icon)
        : undefined;

    useEffect(() => {
        setBadgeContent(
            <div className="flex items-center gap-1">
                {iconImage && (
                    <img
                        src={iconImage}
                        alt={gameData?.name}
                        className="h-4 w-4 rounded"
                    />
                )}
                <span className="text-sm">{gameData?.name}</span>
            </div>,
        );
        setBadgeVisible(true);
        return () => setBadgeVisible(false);
    }, [setBadgeContent, iconImage]);

    const handleBackClick = () => {
        navigate({ to: "/games" });
    };

    if (loading) {
        return (
            <div className="flex flex-col p-4">
                <Skeleton className="mb-6 h-[200px] w-full rounded-lg" />
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

    // Hero image from Steam data
    const heroImage = gameData?.images
        ? imgSrc(
              gameData.images.library_hero ||
                  gameData.images.header ||
                  gameData.images.library_600x900,
          )
        : undefined;

    return (
        <div className="flex flex-col">
            {/* Hero banner */}
            <div className="relative h-[350px] w-full">
                {heroImage ? (
                    <img
                        src={heroImage}
                        alt={decodedGameName}
                        className="h-full w-full object-cover"
                    />
                ) : (
                    <div className="bg-muted h-full w-full" />
                )}
                <div className="from-background via-background/30 pointer-events-none absolute inset-0 h-[352px] w-full bg-gradient-to-t to-transparent" />

                <Button
                    variant="ghost"
                    size="sm"
                    className="bg-background/30 hover:bg-background/50 absolute top-4 left-4 backdrop-blur-sm"
                    onClick={handleBackClick}
                >
                    <ChevronLeft className="mr-1 h-4 w-4" />
                    Back to Games
                </Button>
            </div>

            {/* Content */}
            <div className="p-4 px-6 pr-4">
                <div className="bg-background sticky top-0 z-10 py-2">
                    <h1 className="text-3xl font-bold">{decodedGameName}</h1>

                    <div className="text-muted-foreground mt-2 flex flex-wrap gap-4">
                        <div className="flex items-center gap-1">
                            <LayoutGrid className="h-4 w-4" />
                            <Label>{gameVideos.length} clips</Label>
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
                <div className="mt-2 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {gameVideos.map((video) => (
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

                {gameVideos.length === 0 && (
                    <div className="mt-8 flex h-40 flex-col items-center justify-center rounded-lg border border-dashed">
                        <p className="text-muted-foreground">
                            No clips found for this game
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}
