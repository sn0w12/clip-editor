import React, { useMemo } from "react";
import { useVideoStore } from "@/contexts/video-store-context";
import { useSteam } from "@/contexts/steam-context";
import { Card } from "@/components/ui/card";
import { imgSrc, normalizeGameName } from "@/utils/games";
import { useNavigate } from "@tanstack/react-router";
import { Gamepad2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";

interface GameCardProps {
    name: string;
    clipCount: number;
    image?: string;
}

function GameCard({ name, clipCount, image }: GameCardProps) {
    const navigate = useNavigate();

    const handleClick = () => {
        navigate({
            to: "/games/$gameName",
            params: { gameName: name },
        });
    };

    return (
        <div className="group relative perspective-[800px]">
            <Card
                className="aspect-[0.67/1] transform-gpu cursor-pointer overflow-hidden border-0 py-0 transition-all duration-300 group-hover:scale-105 group-hover:rotate-x-[5deg]"
                onClick={handleClick}
            >
                <div className="relative h-full w-full">
                    {image ? (
                        <img
                            src={image}
                            alt={name}
                            className="h-full w-full rounded"
                        />
                    ) : (
                        <div className="bg-muted flex h-full w-full items-center justify-center">
                            <Gamepad2 className="text-muted-foreground h-12 w-12 opacity-50" />
                        </div>
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
                <div className="absolute right-0 bottom-3 left-0 px-3 text-center opacity-0 transition-opacity group-hover:opacity-100">
                    <p className="truncate text-sm font-medium text-white">
                        {name}
                    </p>
                    <Badge variant="secondary" className="mt-1">
                        {clipCount} {clipCount === 1 ? "clip" : "clips"}
                    </Badge>
                </div>
            </Card>
        </div>
    );
}

export default function GamesPage() {
    const { videos } = useVideoStore();
    const { games, gameImages, loading } = useSteam();

    const gameData = useMemo(() => {
        const gameCounts: Record<string, number> = {};
        videos.forEach((video) => {
            if (video.game) {
                gameCounts[video.game] = (gameCounts[video.game] || 0) + 1;
            }
        });

        // Create array of game data with appIds and images
        return Object.entries(gameCounts)
            .map(([gameName, count]) => {
                const normalizedName = normalizeGameName(gameName);
                const appId =
                    !loading && normalizedName
                        ? games[normalizedName].appid
                        : undefined;
                const gameImage = appId && gameImages[appId];

                let headerImage: string | undefined = undefined;
                if (gameImage) {
                    // Prefer header image, then library_hero, then icon
                    headerImage = imgSrc(gameImage.library_600x900);
                }

                return {
                    name: gameName,
                    appId: appId || "",
                    count,
                    image: headerImage,
                };
            })
            .sort((a, b) => b.count - a.count); // Sort by clip count (highest first)
    }, [videos, games, gameImages, loading]);

    if (loading) {
        return (
            <div className="grid grid-cols-1 gap-6 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                    <Card key={i} className="overflow-hidden">
                        <Skeleton className="h-[180px] w-full" />
                        <div className="p-4">
                            <Skeleton className="mb-2 h-5 w-3/4" />
                            <Skeleton className="h-4 w-1/4" />
                        </div>
                    </Card>
                ))}
            </div>
        );
    }

    if (gameData.length === 0) {
        return (
            <div className="flex h-64 flex-col items-center justify-center p-4">
                <Gamepad2
                    size={48}
                    className="text-muted-foreground mb-4 opacity-40"
                />
                <p className="text-muted-foreground">
                    No games found in your clips.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col p-4 px-6">
            <div>
                <h1 className="text-3xl font-bold">Games</h1>
                <p className="text-muted-foreground mt-1">
                    {gameData.length} {gameData.length === 1 ? "game" : "games"}{" "}
                    with clips
                </p>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {gameData.map((game) => (
                    <GameCard
                        key={game.name}
                        name={game.name}
                        clipCount={game.count}
                        image={game.image}
                    />
                ))}
            </div>
        </div>
    );
}
