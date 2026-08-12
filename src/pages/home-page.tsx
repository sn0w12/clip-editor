import { useNavigate } from "@tanstack/react-router";
import {
    ExternalLink,
    Gamepad2 as Gamepad2Icon,
    Link2 as Link2Icon,
    Pencil,
    Trash,
    FolderPlus,
    FolderX,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import { GameIcon } from "@/components/game-icon";
import { FilterHeader } from "@/components/home/filter-header";
import { SelectionOverlay, useDragSelection } from "@/components/home/selection";
import { VideoGrid } from "@/components/home/video-grid";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toastManager } from "@/components/ui/toast";
import { useConfirm } from "@/contexts/confirm-context";
import { rememberReturnToClip, takeReturnToClip } from "@/lib/return-to-clip";
import { dateKey } from "@/lib/utils";
import { useClipsStore } from "@/stores/clips-store";
import { useGamesStore, resolveGameName } from "@/stores/games-store";
import type { GameImage, SteamGame, VideoFile } from "@/types";

export type ViewMode = "list" | "grid";

export function HomePage() {
    const {
        clips,
        groups,
        loading,
        error: storeError,
        roots,
        reload,
        selectDirectory,
        deleteClips,
        createGroup,
        renameClip,
        assignToGroup,
        removeFromGroup,
    } = useClipsStore();
    const games = useGamesStore();
    const confirm = useConfirm();
    const navigate = useNavigate();
    const containerRef = useRef<HTMLDivElement>(null);

    const [viewMode, setViewMode] = useState<ViewMode>(
        () => (localStorage.getItem("view-mode") as ViewMode) || "grid",
    );
    const [dateRange, setDateRange] = useState<{ start?: Date; end?: Date }>({});
    const [selectedGames, setSelectedGames] = useState<string[]>([]);
    const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
    const [isCreateGroupOpen, setIsCreateGroupOpen] = useState(false);
    const [newGroupName, setNewGroupName] = useState("");
    const [renaming, setRenaming] = useState<VideoFile | null>(null);
    const [renameValue, setRenameValue] = useState("");

    const gameNames = useMemo(() => {
        const names = new Set<string>();
        for (const clip of clips) if (clip.game && clip.game !== "Unknown") names.add(clip.game);
        return [...names].sort((a, b) => a.localeCompare(b));
    }, [clips]);

    const filtered = useMemo(() => {
        let result = [...clips];
        if (dateRange.start) {
            const start = dateKey(dateRange.start.toISOString());
            result = result.filter((c) => dateKey(c.lastModified) >= start);
        }
        if (dateRange.end) {
            const end = dateKey(dateRange.end.toISOString());
            result = result.filter((c) => dateKey(c.lastModified) <= end);
        }
        if (selectedGames.length > 0) result = result.filter((c) => selectedGames.includes(c.game));
        if (selectedGroupIds.length > 0)
            result = result.filter((c) => c.groupIds.some((id) => selectedGroupIds.includes(id)));
        return result;
    }, [clips, dateRange, selectedGames, selectedGroupIds]);

    const resolvedGameNames = useMemo(() => {
        const map: Record<string, string> = {};
        for (const name of gameNames) {
            map[name] = resolveGameName(games.games, games.aliases, name);
        }
        return map;
    }, [gameNames, games.games, games.aliases]);

    const resolvedGameImages = useMemo(() => {
        const map: Record<string, GameImage | null> = {};
        for (const name of gameNames) {
            const resolved = resolvedGameNames[name] ?? name;
            map[resolved] = matchGameImage(games.games, games.aliases, resolved);
        }
        return map;
    }, [gameNames, resolvedGameNames, games.games, games.aliases]);

    const displayClips = useMemo(
        () =>
            filtered.map((c) => ({
                ...c,
                game: resolvedGameNames[c.game] ?? c.game,
                rawGame: c.game,
            })),
        [filtered, resolvedGameNames],
    );

    // Based on the full library (not the filtered view) so the calendar keeps
    // its clip dots regardless of the active date/game/group filter.
    const clipCountByDate = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const clip of clips) {
            const key = dateKey(clip.lastModified);
            counts[key] = (counts[key] ?? 0) + 1;
        }
        return counts;
    }, [clips]);

    const videoGroupMap = useMemo(() => {
        const map: Record<string, string[]> = {};
        for (const clip of displayClips) map[clip.path] = clip.groupIds;
        return map;
    }, [displayClips]);

    const totalSize = useMemo(() => filtered.reduce((sum, c) => sum + c.size, 0), [filtered]);

    const selection = useDragSelection(filtered, (v) => v.path, containerRef);

    const clearFilters = () => {
        setDateRange({});
        setSelectedGames([]);
        setSelectedGroupIds([]);
    };

    const setViewModePersisted = (mode: ViewMode) => {
        setViewMode(mode);
        localStorage.setItem("view-mode", mode);
    };

    const handleDelete = useCallback(
        async (paths: string[]) => {
            // Right-clicking Delete on a selected clip deletes the whole
            // selection; otherwise just the targeted clip(s).
            let targets = paths;
            if (
                paths.length === 1 &&
                selection.selected.size > 1 &&
                selection.selected.has(paths[0])
            ) {
                targets = [...selection.selected];
            }
            const ok = await confirm({
                title: `Delete ${targets.length} clip${targets.length > 1 ? "s" : ""}?`,
                description: "The files will be permanently deleted from disk.",
                confirmText: "Delete",
                variant: "destructive",
            });
            if (!ok) return;
            const result = await deleteClips(targets);
            if (result.failed.length > 0) {
                toastManager.add({
                    title: `Failed to delete ${result.failed.length} file(s)`,
                    type: "error",
                });
            } else {
                toastManager.add({
                    title: `Deleted ${targets.length} clip(s)`,
                    type: "success",
                });
            }
        },
        [selection.selected, confirm, deleteClips],
    );

    // Delete/Backspace removes the current selection (with confirmation).
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement | null)?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA") return;
            if (e.key !== "Delete" && e.key !== "Backspace") return;
            if (selection.selected.size === 0) return;
            e.preventDefault();
            void handleDelete([...selection.selected]);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [selection.selected, handleDelete]);

    const openEditor = (video: VideoFile) => {
        rememberReturnToClip(video.path);
        void navigate({
            to: "/clips/edit",
            search: { videoPath: video.path, videoName: video.name },
        });
    };

    // After returning from the editor, scroll the edited clip back into view.
    // The target is consumed inside the rAF callback so StrictMode's double
    // effect invocation can't eat it before the scroll runs.
    useEffect(() => {
        if (loading || clips.length === 0) return;
        const timerRef = { current: 0 };
        const frame = requestAnimationFrame(() => {
            const target = takeReturnToClip();
            if (!target) return;
            let attempts = 0;
            const tryScroll = () => {
                attempts += 1;
                const el = document.querySelector(`[data-video-path="${CSS.escape(target)}"]`);
                if (el) {
                    el.scrollIntoView({ block: "start" });
                    return;
                }
                if (attempts < 20) timerRef.current = window.setTimeout(tryScroll, 50);
            };
            tryScroll();
        });
        return () => {
            cancelAnimationFrame(frame);
            window.clearTimeout(timerRef.current);
        };
    }, [loading, clips.length]);

    if (!loading && clips.length === 0 && storeError === null) {
        return (
            <div className="flex h-full items-center justify-center p-6">
                <EmptyState
                    title="Welcome to Clip Editor"
                    description="Pick the folder where your game recordings live. The library watches it for new clips."
                >
                    <Button onClick={() => void selectDirectory()}>Choose folder</Button>
                </EmptyState>
            </div>
        );
    }

    return (
        <div ref={containerRef} className="relative flex h-full flex-col gap-2 p-6">
            <SelectionOverlay box={selection.box} />

            {storeError && (
                <Alert variant="warning">
                    {storeError}
                    <Button size="sm" variant="outline" onClick={() => void reload()}>
                        Retry
                    </Button>
                </Alert>
            )}

            <FilterHeader
                directoryPath={roots[0] ?? "No directory"}
                filteredCount={filtered.length}
                totalCount={clips.length}
                totalSize={totalSize}
                groups={groups}
                selectedGroupIds={selectedGroupIds}
                selectedGames={selectedGames}
                games={gameNames}
                steamGames={games.games}
                clipCountByDate={clipCountByDate}
                viewMode={viewMode}
                startDate={dateRange.start}
                endDate={dateRange.end}
                onSelectGroup={setSelectedGroupIds}
                onGameSelect={setSelectedGames}
                onDateRangeChange={(from, to) => setDateRange({ start: from, end: to })}
                onClearFilters={clearFilters}
                onChangeDirectory={() => selectDirectory()}
                onSetViewMode={setViewModePersisted}
            />

            <VideoGrid
                isLoading={loading}
                filteredVideos={displayClips}
                selectedVideos={[...selection.selected]}
                groups={groups}
                videoGroupMap={videoGroupMap}
                gameImages={resolvedGameImages}
                games={games}
                viewMode={viewMode}
                onSelectDirectory={() => selectDirectory()}
                onOpen={openEditor}
                onDelete={(paths) => void handleDelete(paths)}
                onRename={(video) => {
                    setRenaming(video);
                    setRenameValue(video.game);
                }}
                onAddToGroup={(video, groupId) => void assignToGroup([video.path], groupId)}
                onRemoveFromGroup={(video, groupId) => void removeFromGroup([video.path], groupId)}
            />

            <Dialog open={isCreateGroupOpen} onOpenChange={setIsCreateGroupOpen}>
                <DialogPopup className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Create group</DialogTitle>
                        <DialogDescription>
                            Group clips together for quick filtering.
                        </DialogDescription>
                    </DialogHeader>
                    <Form
                        className="contents"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (!newGroupName.trim()) return;
                            void toastManager
                                .promise(createGroup(newGroupName.trim()), {
                                    loading: { title: "Creating group…" },
                                    success: (group) => ({ title: `Created ${group.name}` }),
                                    error: (e) => ({
                                        title: `Failed to create group: ${String(e)}`,
                                    }),
                                })
                                .then(() => {
                                    setNewGroupName("");
                                    setIsCreateGroupOpen(false);
                                })
                                .catch(() => {});
                        }}
                    >
                        <DialogPanel className="grid gap-4">
                            <Field>
                                <FieldLabel>Name</FieldLabel>
                                <Input
                                    id="group-name"
                                    value={newGroupName}
                                    onChange={(e) => setNewGroupName(e.target.value)}
                                    placeholder="Favorites"
                                    autoFocus
                                />
                            </Field>
                        </DialogPanel>
                        <DialogFooter>
                            <DialogClose render={<Button variant="ghost">Cancel</Button>} />
                            <Button type="submit">Create</Button>
                        </DialogFooter>
                    </Form>
                </DialogPopup>
            </Dialog>

            <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
                <DialogPopup className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Rename game</DialogTitle>
                        <DialogDescription>{renaming?.name}</DialogDescription>
                    </DialogHeader>
                    <Form
                        className="contents"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (!renaming || !renameValue.trim()) return;
                            void toastManager
                                .promise(renameClip(renaming.path, renameValue.trim()), {
                                    loading: { title: "Renaming clip…" },
                                    success: { title: "Renamed" },
                                    error: (e) => ({
                                        title: `Failed to rename: ${String(e)}`,
                                    }),
                                })
                                .catch(() => {})
                                .finally(() => setRenaming(null));
                        }}
                    >
                        <DialogPanel className="grid gap-4">
                            <Field>
                                <FieldLabel>Game name</FieldLabel>
                                <Input
                                    id="rename-game"
                                    value={renameValue}
                                    onChange={(e) => setRenameValue(e.target.value)}
                                    autoFocus
                                />
                            </Field>
                        </DialogPanel>
                        <DialogFooter>
                            <DialogClose render={<Button variant="ghost">Cancel</Button>} />
                            <Button type="submit">Rename file</Button>
                        </DialogFooter>
                    </Form>
                </DialogPopup>
            </Dialog>
        </div>
    );
}

export function VideoContextMenu({
    video,
    groupIds,
    groups,
    games,
    onOpen,
    onDelete,
    onRename,
    onAddToGroup,
    onRemoveFromGroup,
    children,
}: {
    video: VideoFile & { rawGame?: string };
    groupIds: string[];
    groups: { id: string; name: string; color?: string | null }[];
    games: ReturnType<typeof useGamesStore>;
    onOpen: (video: VideoFile) => void;
    onDelete: (paths: string[]) => void;
    onRename: (video: VideoFile) => void;
    onAddToGroup: (video: VideoFile, groupId: string) => void;
    onRemoveFromGroup: (video: VideoFile, groupId: string) => void;
    children: React.ReactNode;
}) {
    const [pickerMode, setPickerMode] = useState<"set" | "alias" | null>(null);
    const unassigned = groups.filter((g) => !groupIds.includes(g.id));
    const assigned = groups.filter((g) => groupIds.includes(g.id));

    const handlePick = async (appId: string, displayName: string) => {
        if (pickerMode === "set") {
            onRename({ ...video, game: displayName });
            toastManager.add({ title: `Set game to ${displayName}`, type: "success" });
        } else if (pickerMode === "alias") {
            await toastManager
                .promise(games.setAlias(video.rawGame ?? video.game, appId), {
                    loading: { title: "Setting alias…" },
                    success: {
                        title: `Aliased "${video.rawGame ?? video.game}" to ${displayName}`,
                    },
                    error: (e) => ({ title: `Failed to set alias: ${String(e)}` }),
                })
                .catch(() => {});
        }
        setPickerMode(null);
    };

    return (
        <ContextMenu>
            <ContextMenuTrigger>{children}</ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem onClick={() => onOpen(video)}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onRename(video)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Rename game
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => setPickerMode("set")}>
                    <Gamepad2Icon className="mr-2 h-4 w-4" />
                    Set game to
                </ContextMenuItem>
                <ContextMenuItem onClick={() => setPickerMode("alias")}>
                    <Link2Icon className="mr-2 h-4 w-4" />
                    Alias to game
                </ContextMenuItem>
                <ContextMenuSeparator />
                {unassigned.map((group) => (
                    <ContextMenuItem key={group.id} onClick={() => onAddToGroup(video, group.id)}>
                        <FolderPlus className="mr-2 h-4 w-4" />
                        Add to {group.name}
                    </ContextMenuItem>
                ))}
                {assigned.map((group) => (
                    <>
                        <ContextMenuItem
                            key={group.id}
                            onClick={() => onRemoveFromGroup(video, group.id)}
                        >
                            <FolderX className="mr-2 h-4 w-4" />
                            Remove from {group.name}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                    </>
                ))}
                <ContextMenuItem
                    variant="destructive-no-confirm"
                    onClick={() => onDelete([video.path])}
                >
                    <Trash className="text-destructive mr-2 h-4 w-4" />
                    Delete
                </ContextMenuItem>
            </ContextMenuContent>

            <GamePickerDialog
                open={pickerMode !== null}
                onOpenChange={(open) => !open && setPickerMode(null)}
                title={pickerMode === "set" ? "Set game" : "Alias to game"}
                onPick={(appId, displayName) => void handlePick(appId, displayName)}
                games={games.games}
                addCustomGame={games.addCustomGame}
            />
        </ContextMenu>
    );
}

function GamePickerDialog({
    open,
    onOpenChange,
    title,
    onPick,
    games,
    addCustomGame,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    onPick: (appId: string, displayName: string) => void;
    games: SteamGame[];
    addCustomGame: (name: string) => Promise<SteamGame>;
}) {
    const [search, setSearch] = useState("");
    const [customName, setCustomName] = useState("");
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        const list = [...games].sort((a, b) => a.displayName.localeCompare(b.displayName));
        return q ? list.filter((g) => g.displayName.toLowerCase().includes(q)) : list;
    }, [games, search]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogPopup className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        Pick a game from your Steam library, or add a custom game.
                    </DialogDescription>
                </DialogHeader>
                <DialogPanel className="grid gap-4">
                    <Field>
                        <FieldLabel>Search</FieldLabel>
                        <Input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Search games..."
                            autoFocus
                        />
                    </Field>
                    <ScrollArea className="max-h-64">
                        <div className="space-y-0.5">
                            {filtered.map((game) => (
                                <button
                                    key={game.appId}
                                    type="button"
                                    className="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm"
                                    onClick={() => onPick(game.appId, game.displayName)}
                                >
                                    <GameIcon
                                        game={game.displayName}
                                        gameImage={game.artwork}
                                        className="size-5"
                                    />
                                    <span className="truncate">{game.displayName}</span>
                                </button>
                            ))}
                            {filtered.length === 0 && (
                                <p className="text-muted-foreground px-2 py-1 text-sm">
                                    No games found.
                                </p>
                            )}
                        </div>
                    </ScrollArea>
                    <div className="flex items-center gap-2">
                        <Input
                            value={customName}
                            onChange={(e) => setCustomName(e.target.value)}
                            placeholder="Custom game name"
                            className="text-sm"
                        />
                        <Button
                            size="sm"
                            disabled={!customName.trim()}
                            onClick={async () => {
                                const name = customName.trim();
                                const game = await addCustomGame(name);
                                onPick(game.appId, game.displayName);
                                setCustomName("");
                            }}
                        >
                            Add
                        </Button>
                    </div>
                </DialogPanel>
            </DialogPopup>
        </Dialog>
    );
}

function matchGameImage(
    games: {
        appId: string;
        displayName: string;
        normalizedName: string;
        artwork?: GameImage | null;
    }[],
    aliases: { alias: string; appId: string }[],
    gameName: string,
): GameImage | null {
    if (!gameName || gameName === "Unknown") return null;
    const alias = aliases.find((a) => a.alias === gameName);
    if (alias) {
        const viaAlias = games.find((g) => g.appId === alias.appId);
        if (viaAlias?.artwork) return viaAlias.artwork;
    }
    const normalized = gameName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const byName = games.find((g) => g.normalizedName === normalized);
    if (byName?.artwork) return byName.artwork;
    const exact = games.find((g) => g.displayName === gameName);
    return exact?.artwork ?? null;
}
