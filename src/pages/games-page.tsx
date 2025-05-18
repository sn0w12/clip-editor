import React, { useMemo, useState } from "react";
import { useVideoStore } from "@/contexts/video-store-context";
import { useSteam } from "@/contexts/steam-context";
import { Card } from "@/components/ui/card";
import { getGameId, imgSrc } from "@/utils/games";
import { useNavigate } from "@tanstack/react-router";
import { Gamepad2, Image, ExternalLink, Trash } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface GameCardProps {
    name: string;
    clipCount: number;
    appId: string;
    image?: string;
}

function GameCard({ name, clipCount, appId, image }: GameCardProps) {
    const navigate = useNavigate();
    const { setCustomGameImage, removeCustomGame } = useSteam();
    const isCustomGame = appId.startsWith("custom-");
    const [showImageDialog, setShowImageDialog] = useState(false);
    const [imageUrl, setImageUrl] = useState("");
    const [imageType, setImageType] = useState<
        "library_600x900" | "header" | "logo" | "icon"
    >("library_600x900");
    const hasNoClips = clipCount === 0;

    const handleClick = () => {
        navigate({
            to: "/games/$gameName",
            params: { gameName: name },
        });
    };

    const handleSetImage = () => {
        if (isCustomGame) {
            setCustomGameImage(appId, imageUrl, imageType);
            setShowImageDialog(false);
        }
    };

    return (
        <>
            <ContextMenu>
                <ContextMenuTrigger>
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
                                {isCustomGame && (
                                    <div
                                        className={`${hasNoClips ? "bg-destructive/60" : "bg-primary/60"} text-primary-foreground absolute top-2 right-2 flex h-6 w-6 items-center justify-center rounded-full backdrop-blur-sm`}
                                    >
                                        <span className="text-xs font-medium">
                                            C
                                        </span>
                                    </div>
                                )}
                            </div>
                            <div className="absolute right-0 bottom-3 left-0 px-3 text-center opacity-0 transition-opacity group-hover:opacity-100">
                                <p className="truncate text-sm font-medium text-white">
                                    {name}
                                </p>
                                <Badge variant="secondary" className="mt-1">
                                    {clipCount}{" "}
                                    {clipCount === 1 ? "clip" : "clips"}
                                </Badge>
                            </div>
                        </Card>
                    </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuItem onClick={handleClick}>
                        <ExternalLink className="mr-2 h-4 w-4" />
                        Open Game
                    </ContextMenuItem>

                    {isCustomGame && (
                        <>
                            <ContextMenuSeparator />
                            <ContextMenuItem
                                onClick={() => setShowImageDialog(true)}
                            >
                                <Image className="mr-2 h-4 w-4" />
                                Set Custom Image
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() => removeCustomGame(appId)}
                                variant="destructive"
                                className="text-destructive focus:text-destructive"
                            >
                                <Trash className="mr-2 h-4 w-4" />
                                Remove Game
                            </ContextMenuItem>
                        </>
                    )}
                </ContextMenuContent>
            </ContextMenu>

            <Dialog open={showImageDialog} onOpenChange={setShowImageDialog}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Set Custom Image for {name}</DialogTitle>
                        <DialogDescription>
                            Enter a URL for the custom game image
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div className="space-y-2">
                            <Label htmlFor="image-type">Image Type</Label>
                            <Select
                                value={imageType}
                                onValueChange={(value) =>
                                    setImageType(
                                        value as
                                            | "library_600x900"
                                            | "header"
                                            | "logo"
                                            | "icon",
                                    )
                                }
                            >
                                <SelectTrigger className="w-full">
                                    <SelectValue placeholder="Select image type" />
                                </SelectTrigger>
                                <SelectContent align="center">
                                    <SelectItem value="library_600x900">
                                        Library Vertical (600x900)
                                    </SelectItem>
                                    <SelectItem value="header">
                                        Header (1920x620)
                                    </SelectItem>
                                    {/* <SelectItem value="logo">Logo</SelectItem> */}
                                    <SelectItem value="icon">
                                        Icon (Square)
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="image-url">Image URL</Label>
                            <Input
                                id="image-url"
                                placeholder="C:\Users\User\Documents\image.jpeg"
                                value={imageUrl}
                                onChange={(e) => setImageUrl(e.target.value)}
                            />
                        </div>
                        <div className="flex justify-end space-x-2">
                            <Button
                                variant="outline"
                                onClick={() => setShowImageDialog(false)}
                            >
                                Cancel
                            </Button>
                            <Button onClick={handleSetImage}>Save</Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </>
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

        const customGameIds = Object.keys(games).filter((gameId) =>
            gameId.startsWith("custom-"),
        );
        customGameIds.forEach((gameId) => {
            const customGame = games[gameId];
            if (!gameCounts[customGame.displayName]) {
                gameCounts[customGame.displayName] = 0;
            }
        });

        // Create array of game data with appIds and images
        return Object.entries(gameCounts)
            .map(([gameName, count]) => {
                const appId = getGameId(gameName, games, loading) ?? gameName;
                const gameImage = appId && gameImages[appId];

                let headerImage: string | undefined = undefined;
                if (gameImage) {
                    headerImage = imgSrc(gameImage.library_600x900);
                }

                return {
                    name: gameName,
                    appId: appId || "",
                    count,
                    image: headerImage,
                };
            })
            .sort((a, b) => {
                // Keep games with clips at the top (sorted by count)
                if (a.count > 0 && b.count > 0) return b.count - a.count;
                if (a.count > 0) return -1;
                if (b.count > 0) return 1;
                // For games with 0 clips, sort alphabetically
                return a.name.localeCompare(b.name);
            });
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
                        appId={game.appId}
                        image={game.image}
                    />
                ))}
            </div>
        </div>
    );
}
