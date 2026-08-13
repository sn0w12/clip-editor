import { useNavigate } from "@tanstack/react-router";
import { ExternalLink, Gamepad2, Image, Trash } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
    Dialog,
    DialogClose,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogPanel,
    DialogPopup,
    DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { imgSrc } from "@/lib/tauri";
import { useClipsStore } from "@/stores/clips-store";
import { useGamesStore, resolveGameName } from "@/stores/games-store";

interface GameCardProps {
    name: string;
    clipCount: number;
    appId: string;
    image?: string | null;
    onSetCustomImage: (appId: string, type: string, value: string) => Promise<void>;
    onRemoveCustomGame: (appId: string) => Promise<void>;
}

const IMAGE_TYPES = [
    { label: "Library Vertical (600x900)", value: "library_600x900" },
    { label: "Header (1920x620)", value: "header" },
    { label: "Icon (Square)", value: "icon" },
] as const;

function GameCard({
    name,
    clipCount,
    appId,
    image,
    onSetCustomImage,
    onRemoveCustomGame,
}: GameCardProps) {
    const navigate = useNavigate();
    const isCustomGame = appId.startsWith("custom-");
    const [showImageDialog, setShowImageDialog] = useState(false);
    const [imageUrl, setImageUrl] = useState("");
    const [imageType, setImageType] = useState<"library_600x900" | "header" | "logo" | "icon">(
        "library_600x900",
    );
    const hasNoClips = clipCount === 0;

    const handleClick = () => {
        navigate({ to: "/games/$gameName", params: { gameName: encodeURIComponent(name) } });
    };

    const handleSetImage = async () => {
        if (isCustomGame && imageUrl.trim()) {
            await toastManager
                .promise(onSetCustomImage(appId, imageType, imageUrl.trim()), {
                    loading: { title: "Updating image…" },
                    success: { title: "Image updated" },
                    error: (e) => ({ title: `Failed to update image: ${String(e)}` }),
                })
                .then(() => setShowImageDialog(false))
                .catch(() => {});
        }
    };

    return (
        <>
            <ContextMenu>
                <ContextMenuTrigger
                    render={
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
                                            <span className="text-xs font-medium">C</span>
                                        </div>
                                    )}
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
                    }
                >
                    <ContextMenuContent>
                        <ContextMenuItem onClick={handleClick}>
                            <ExternalLink className="mr-2 h-4 w-4" />
                            Open Game
                        </ContextMenuItem>
                        {isCustomGame && (
                            <>
                                <ContextMenuSeparator />
                                <ContextMenuItem onClick={() => setShowImageDialog(true)}>
                                    <Image className="mr-2 h-4 w-4" />
                                    Set Custom Image
                                </ContextMenuItem>
                                <ContextMenuItem
                                    onClick={() => void onRemoveCustomGame(appId)}
                                    className="text-destructive focus:text-destructive"
                                >
                                    <Trash className="mr-2 h-4 w-4" />
                                    Remove Game
                                </ContextMenuItem>
                            </>
                        )}
                    </ContextMenuContent>
                </ContextMenuTrigger>
            </ContextMenu>

            <Dialog open={showImageDialog} onOpenChange={setShowImageDialog}>
                <DialogPopup className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Set Custom Image for {name}</DialogTitle>
                        <DialogDescription>Enter a URL for the custom game image</DialogDescription>
                    </DialogHeader>
                    <DialogPanel className="grid gap-4">
                        <Field>
                            <FieldLabel>Image Type</FieldLabel>
                            <Select
                                value={imageType}
                                items={IMAGE_TYPES}
                                onValueChange={(value) => {
                                    if (value !== null)
                                        setImageType(
                                            value as (typeof IMAGE_TYPES)[number]["value"],
                                        );
                                }}
                            >
                                <SelectTrigger id="image-type" className="w-full">
                                    <SelectValue placeholder="Select image type" />
                                </SelectTrigger>
                                <SelectContent align="center">
                                    {IMAGE_TYPES.map((type) => (
                                        <SelectItem key={type.value} value={type.value}>
                                            {type.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field>
                            <FieldLabel>Image URL</FieldLabel>
                            <Input
                                id="image-url"
                                placeholder="C:\Users\User\Documents\image.jpeg"
                                value={imageUrl}
                                onChange={(e) => setImageUrl(e.target.value)}
                            />
                        </Field>
                    </DialogPanel>
                    <DialogFooter>
                        <DialogClose render={<Button variant="ghost">Cancel</Button>} />
                        <Button onClick={() => void handleSetImage()}>Save</Button>
                    </DialogFooter>
                </DialogPopup>
            </Dialog>
        </>
    );
}

export function GamesPage() {
    const { clips, loading: clipsLoading } = useClipsStore();
    const { games, aliases, loading, setCustomImage, removeCustomGame } = useGamesStore();

    const gameData = useMemo(() => {
        const gameCounts: Record<string, number> = {};
        for (const video of clips) {
            if (video.game) {
                const resolved = resolveGameName(games, aliases, video.game);
                gameCounts[resolved] = (gameCounts[resolved] || 0) + 1;
            }
        }
        for (const game of games) {
            if (game.source === "custom" && !gameCounts[game.displayName]) {
                gameCounts[game.displayName] = 0;
            }
        }
        return Object.entries(gameCounts)
            .map(([gameName, count]) => {
                const game = games.find(
                    (g) => g.displayName === gameName || g.normalizedName === normalize(gameName),
                );
                const appId = game?.appId ?? gameName;
                const gameImage = game?.artwork;
                const image = gameImage?.library_600x900
                    ? imgSrc(gameImage.library_600x900)
                    : undefined;
                return { name: gameName, appId, count, image };
            })
            .sort((a, b) => {
                if (a.count > 0 && b.count > 0) return b.count - a.count;
                if (a.count > 0) return -1;
                if (b.count > 0) return 1;
                return a.name.localeCompare(b.name);
            });
    }, [clips, games, aliases]);

    // Gate on both stores so the page never flashes "No games found" while the
    // clip library is still loading. Keep the header visible and only swap the
    // grid area so the page never jumps.
    if (loading || clipsLoading) {
        return (
            <div className="flex h-full flex-col gap-4 p-6">
                <div>
                    <h1 className="text-3xl font-bold">Games</h1>
                    <p className="text-muted-foreground mt-1 text-sm">Loading games…</p>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                    {Array.from({ length: 12 }).map((_, i) => (
                        <div key={i} className="aspect-[0.67/1]">
                            <Skeleton className="h-full w-full rounded-lg" />
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    if (gameData.length === 0) {
        return (
            <div className="flex h-64 flex-col items-center justify-center p-4">
                <Gamepad2 size={48} className="text-muted-foreground mb-4 opacity-40" />
                <p className="text-muted-foreground">No games found in your clips.</p>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col gap-2 p-6">
            <div>
                <h1 className="text-3xl font-bold">Games</h1>
                <p className="text-muted-foreground mt-1 text-sm">
                    {gameData.length} {gameData.length === 1 ? "game" : "games"} with clips
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
                        onSetCustomImage={setCustomImage}
                        onRemoveCustomGame={removeCustomGame}
                    />
                ))}
            </div>
        </div>
    );
}

function normalize(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}
