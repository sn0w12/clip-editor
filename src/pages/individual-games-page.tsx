import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon, Gamepad2Icon, RefreshCwIcon } from "lucide-react";
import { useMemo } from "react";

import { EmptyState } from "@/components/empty-state";
import { VideoCard } from "@/components/home/video-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { useConfirm } from "@/contexts/confirm-context";
import { useSelection } from "@/hooks/use-selection";
import { imgSrc } from "@/lib/tauri";
import { formatDuration } from "@/lib/utils";
import { VideoContextMenu } from "@/pages/home-page";
import { useClipsStore } from "@/stores/clips-store";
import { useGamesStore, gameImageFor, resolveGameName } from "@/stores/games-store";
import type { VideoFile } from "@/types";

export function GameDetailPage(): React.ReactElement {
    const { gameName } = useParams({ from: "/games/$gameName" });
    const decodedName = decodeURIComponent(gameName);
    const games = useGamesStore();
    const clips = useClipsStore();
    const confirm = useConfirm();
    const navigate = useNavigate();

    const game = useMemo(
        () => games.games.find((g) => g.displayName === decodedName),
        [games.games, decodedName],
    );

    const gameClips = useMemo(() => {
        return clips.clips.filter((clip) => {
            const resolved = resolveGameName(games.games, games.aliases, clip.game);
            if (resolved === decodedName) return true;
            const image = gameImageFor(games.games, games.aliases, clip.game);
            return (
                image !== null &&
                game !== undefined &&
                matchesGame(clip.game, game.displayName, game.normalizedName)
            );
        });
    }, [clips.clips, games.games, games.aliases, decodedName, game]);

    // Cards show the resolved display name (raw name kept for the context menu's
    // "Alias to game" action), matching the home page.
    const displayClips = useMemo(
        () =>
            gameClips.map((clip) => ({
                ...clip,
                game: resolveGameName(games.games, games.aliases, clip.game),
                rawGame: clip.game,
            })),
        [gameClips, games.games, games.aliases],
    );

    const stats = useMemo(() => {
        const totalDuration = gameClips.reduce((sum, c) => sum + (c.metadata?.duration ?? 0), 0);
        const dates = gameClips.map((c) => c.lastModified).sort();
        return {
            count: gameClips.length,
            totalDuration,
            first: dates[0],
            last: dates[dates.length - 1],
        };
    }, [gameClips]);

    const selection = useSelection(gameClips, (v) => v.path);

    const hero =
        game?.artwork?.library_hero ??
        game?.artwork?.header ??
        game?.artwork?.library_600x900 ??
        null;

    const openEditor = (video: VideoFile) => {
        void navigate({
            to: "/clips/edit",
            search: { videoPath: video.path, videoName: video.name },
        });
    };

    const handleDelete = async (paths: string[]) => {
        const ok = await confirm({
            title: `Delete ${paths.length} clip(s)?`,
            description: "The files will be permanently deleted from disk.",
            confirmText: "Delete",
            variant: "destructive",
        });
        if (!ok) return;
        const result = await clips.deleteClips(paths);
        toastManager.add({
            title:
                result.failed.length > 0
                    ? `Failed to delete ${result.failed.length} file(s)`
                    : `Deleted ${paths.length} clip(s)`,
            type: result.failed.length > 0 ? "error" : "success",
        });
    };

    return (
        <div className="flex h-full flex-col">
            {/* Hero */}
            <div className="relative h-72 shrink-0 overflow-hidden border-b">
                {hero ? (
                    <img src={imgSrc(hero)} alt="" className="inset-0 h-full w-full object-cover" />
                ) : (
                    <div className="bg-muted absolute inset-0 flex items-center justify-center">
                        <Gamepad2Icon className="text-muted-foreground size-16" />
                    </div>
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
                <div className="absolute top-4 left-4">
                    <Button
                        variant="ghost"
                        className="bg-black/30 text-white hover:bg-black/50"
                        render={<Link to="/games" />}
                    >
                        <ArrowLeftIcon /> Games
                    </Button>
                </div>
                <div className="absolute right-4 bottom-4 left-4 flex items-end justify-between">
                    <div>
                        <h1 className="text-2xl font-semibold text-white drop-shadow">
                            {decodedName}
                        </h1>
                        <div className="mt-1 flex gap-2 text-sm text-white/80">
                            <Badge variant="secondary">{stats.count} clip(s)</Badge>
                            <Badge variant="secondary">
                                {formatDuration(stats.totalDuration)} total
                            </Badge>
                            {stats.first && (
                                <Badge variant="secondary">since {formatDate(stats.first)}</Badge>
                            )}
                        </div>
                    </div>
                    {game && (
                        <Button
                            variant="outline"
                            size="sm"
                            className="bg-black/30 text-white hover:bg-black/50"
                            onClick={() => void games.refreshArtwork(game.appId)}
                        >
                            <RefreshCwIcon /> Refresh artwork
                        </Button>
                    )}
                </div>
            </div>

            {/* Clips */}
            <div className="flex-1 p-6">
                {gameClips.length === 0 ? (
                    <EmptyState
                        title="No clips for this game"
                        description="Clips are matched by the game name embedded in their filename."
                    />
                ) : (
                    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {displayClips.map((clip) => (
                            <VideoContextMenu
                                key={clip.path}
                                video={clip}
                                groupIds={clip.groupIds}
                                groups={clips.groups}
                                games={games}
                                onOpen={openEditor}
                                onDelete={(paths) => void handleDelete(paths)}
                                onRename={() => undefined}
                                onAddToGroup={(video, groupId) =>
                                    void clips.assignToGroup([video.path], groupId)
                                }
                                onRemoveFromGroup={(video, groupId) =>
                                    void clips.removeFromGroup([video.path], groupId)
                                }
                                onCreateGroup={(name) => clips.createGroup(name)}
                            >
                                <VideoCard
                                    video={clip}
                                    isSelected={selection.selected.has(clip.path)}
                                    groups={clips.groups}
                                    groupIds={clip.groupIds}
                                    gameImage={gameImageFor(
                                        games.games,
                                        games.aliases,
                                        clip.rawGame ?? clip.game,
                                    )}
                                />
                            </VideoContextMenu>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

function matchesGame(clipGame: string, displayName: string, normalizedName: string): boolean {
    const normalized = clipGame.toLowerCase().replace(/[^a-z0-9]/g, "");
    return clipGame === displayName || normalized === normalizedName;
}

function formatDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(date);
}
