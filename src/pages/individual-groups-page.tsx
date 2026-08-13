import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useMemo } from "react";

import { EmptyState } from "@/components/empty-state";
import { VideoCard } from "@/components/home/video-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { useConfirm } from "@/contexts/confirm-context";
import { useSelection } from "@/hooks/use-selection";
import { formatDuration } from "@/lib/utils";
import { VideoContextMenu } from "@/pages/home-page";
import { useClipsStore } from "@/stores/clips-store";
import { useGamesStore, gameImageFor, resolveGameName } from "@/stores/games-store";
import type { VideoFile } from "@/types";

export function GroupDetailPage(): React.ReactElement {
    const { groupId } = useParams({ from: "/groups/$groupId" });
    const store = useClipsStore();
    const games = useGamesStore();
    const confirm = useConfirm();
    const navigate = useNavigate();

    const group = useMemo(
        () => store.groups.find((g) => g.id === groupId),
        [store.groups, groupId],
    );

    const groupClips = useMemo(
        () => store.clips.filter((c) => c.groupIds.includes(groupId)),
        [store.clips, groupId],
    );

    // Cards show the resolved display name (raw name kept for the context menu's
    // "Alias to game" action), matching the home page.
    const displayClips = useMemo(
        () =>
            groupClips.map((clip) => ({
                ...clip,
                game: resolveGameName(games.games, games.aliases, clip.game),
                rawGame: clip.game,
            })),
        [groupClips, games.games, games.aliases],
    );

    const stats = useMemo(() => {
        const totalDuration = groupClips.reduce((sum, c) => sum + (c.metadata?.duration ?? 0), 0);
        const dates = groupClips.map((c) => c.lastModified).sort();
        return {
            count: groupClips.length,
            totalDuration,
            first: dates[0],
            last: dates[dates.length - 1],
        };
    }, [groupClips]);

    const selection = useSelection(groupClips, (v) => v.path);

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
        const result = await store.deleteClips(paths);
        toastManager.add({
            title:
                result.failed.length > 0
                    ? `Failed to delete ${result.failed.length} file(s)`
                    : `Deleted ${paths.length} clip(s)`,
            type: result.failed.length > 0 ? "error" : "success",
        });
    };

    if (!group) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <EmptyState title="Group not found" description="This group may have been deleted.">
                    <Button render={<Link to="/groups" />}>
                        <ArrowLeftIcon /> All groups
                    </Button>
                </EmptyState>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col gap-4 p-6">
            <div>
                <Button variant="ghost" size="sm" render={<Link to="/groups" />}>
                    <ArrowLeftIcon /> Groups
                </Button>
                <h1 className="mt-2 flex items-center gap-2 text-xl font-semibold">
                    <span
                        className="size-3 rounded-full"
                        style={{ backgroundColor: group.color ?? "var(--accent-color)" }}
                    />
                    {group.name}
                </h1>
                <div className="mt-2 flex gap-2">
                    <Badge variant="secondary">{stats.count} clip(s)</Badge>
                    <Badge variant="secondary">{formatDuration(stats.totalDuration)} total</Badge>
                    {stats.first && (
                        <Badge variant="secondary">
                            {formatDate(stats.first)} – {formatDate(stats.last ?? stats.first)}
                        </Badge>
                    )}
                </div>
            </div>

            {groupClips.length === 0 ? (
                <EmptyState
                    title="No clips in this group"
                    description="Right-click a clip and choose Add to group."
                />
            ) : (
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                    {displayClips.map((clip) => (
                        <VideoContextMenu
                            key={clip.path}
                            video={clip}
                            groupIds={clip.groupIds}
                            groups={store.groups}
                            games={games}
                            onOpen={openEditor}
                            onDelete={(paths) => void handleDelete(paths)}
                            onRename={() => undefined}
                            onAddToGroup={(video, groupId) =>
                                void store.assignToGroup([video.path], groupId)
                            }
                            onRemoveFromGroup={(video, groupId) =>
                                void store.removeFromGroup([video.path], groupId)
                            }
                        >
                            <VideoCard
                                video={clip}
                                isSelected={selection.selected.has(clip.path)}
                                groups={store.groups}
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
    );
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
