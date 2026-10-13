import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "@/components/empty-state";
import {
    FilterHeader,
    FilterHeaderControls,
} from "@/components/home/filter-header";
import {
    SelectionOverlay,
    useDragSelection,
} from "@/components/home/selection";
import type { ViewMode } from "@/components/home/types";
import { VideoGrid } from "@/components/home/video-grid";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
import { filterClips, useFiltersStore } from "@/stores/filters-store";
import {
    useGamesStore,
    resolveGameName,
    gameImageFor,
} from "@/stores/games-store";
import type { GameImage, VideoFile } from "@/types";

export function ClipsPage() {
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
    const { confirm } = useConfirm();
    const navigate = useNavigate();
    const containerRef = useRef<HTMLDivElement>(null);

    const [viewMode, setViewMode] = useState<ViewMode>(
        () => (localStorage.getItem("view-mode") as ViewMode) || "grid"
    );
    const [isCreateGroupOpen, setIsCreateGroupOpen] = useState(false);
    const [newGroupName, setNewGroupName] = useState("");
    const [renaming, setRenaming] = useState<VideoFile | null>(null);
    const [renameValue, setRenameValue] = useState("");

    const {
        dateRange,
        selectedGames,
        selectedGroupIds,
        setDateRange,
        setSelectedGames,
        setSelectedGroupIds,
        clearFilters,
    } = useFiltersStore();

    const gameNames = useMemo(() => {
        const names = new Set<string>();
        for (const clip of clips)
            if (clip.game && clip.game !== "Unknown") names.add(clip.game);
        return [...names].sort((a, b) => a.localeCompare(b));
    }, [clips]);

    const filtered = useMemo(
        () =>
            filterClips(clips, { dateRange, selectedGames, selectedGroupIds }),
        [clips, dateRange, selectedGames, selectedGroupIds]
    );

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
            map[resolved] = gameImageFor(games.games, games.aliases, resolved);
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
        [filtered, resolvedGameNames]
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

    const totalSize = useMemo(
        () => filtered.reduce((sum, c) => sum + c.size, 0),
        [filtered]
    );

    const selection = useDragSelection(filtered, (v) => v.path, containerRef);

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
            const { confirmed } = await confirm({
                title: `Delete ${targets.length} clip${targets.length > 1 ? "s" : ""}?`,
                description: "The files will be permanently deleted from disk.",
                confirmText: "Delete",
                variant: "destructive",
            });
            if (!confirmed) return;
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
        [selection.selected, confirm, deleteClips]
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
                const el = document.querySelector(
                    `[data-video-path="${CSS.escape(target)}"]`
                );
                if (el) {
                    el.scrollIntoView({ block: "start" });
                    return;
                }
                if (attempts < 20)
                    timerRef.current = window.setTimeout(tryScroll, 50);
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
                    <Button onClick={() => void selectDirectory()}>
                        Choose folder
                    </Button>
                </EmptyState>
            </div>
        );
    }

    return (
        <ScrollArea className="size-full" scrollX={false}>
            <div
                ref={containerRef}
                className="relative flex min-h-full flex-col gap-2 p-6"
            >
                <SelectionOverlay box={selection.box} />

                {storeError && (
                    <Alert variant="warning">
                        {storeError}
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void reload()}
                        >
                            Retry
                        </Button>
                    </Alert>
                )}

                <div className="grid grid-cols-[1fr_auto] items-start gap-x-4 gap-y-2">
                    <FilterHeader
                        directoryPath={roots[0] ?? "No directory"}
                        filteredCount={filtered.length}
                        totalCount={clips.length}
                        totalSize={totalSize}
                    />
                    <FilterHeaderControls
                        className="sticky top-1 z-20 bg-background"
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
                        onDateRangeChange={(from, to) =>
                            setDateRange({ start: from, end: to })
                        }
                        onClearFilters={clearFilters}
                        onChangeDirectory={() => selectDirectory()}
                        onSetViewMode={setViewModePersisted}
                    />
                    <div className="col-span-2">
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
                            onAddToGroup={(video, groupId) =>
                                void assignToGroup([video.path], groupId)
                            }
                            onRemoveFromGroup={(video, groupId) =>
                                void removeFromGroup([video.path], groupId)
                            }
                            onCreateGroup={(name) => createGroup(name)}
                        />
                    </div>
                </div>

                <Dialog
                    open={isCreateGroupOpen}
                    onOpenChange={setIsCreateGroupOpen}
                >
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
                                        success: (group) => ({
                                            title: `Created ${group.name}`,
                                        }),
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
                                        onChange={(e) =>
                                            setNewGroupName(e.target.value)
                                        }
                                        placeholder="Favorites"
                                        autoFocus
                                    />
                                </Field>
                            </DialogPanel>
                            <DialogFooter>
                                <DialogClose
                                    render={
                                        <Button variant="ghost">Cancel</Button>
                                    }
                                />
                                <Button type="submit">Create</Button>
                            </DialogFooter>
                        </Form>
                    </DialogPopup>
                </Dialog>

                <Dialog
                    open={renaming !== null}
                    onOpenChange={(open) => !open && setRenaming(null)}
                >
                    <DialogPopup className="sm:max-w-md">
                        <DialogHeader>
                            <DialogTitle>Rename game</DialogTitle>
                            <DialogDescription>
                                {renaming?.name}
                            </DialogDescription>
                        </DialogHeader>
                        <Form
                            className="contents"
                            onSubmit={(e) => {
                                e.preventDefault();
                                if (!renaming || !renameValue.trim()) return;
                                void toastManager
                                    .promise(
                                        renameClip(
                                            renaming.path,
                                            renameValue.trim()
                                        ),
                                        {
                                            loading: {
                                                title: "Renaming clip…",
                                            },
                                            success: { title: "Renamed" },
                                            error: (e) => ({
                                                title: `Failed to rename: ${String(e)}`,
                                            }),
                                        }
                                    )
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
                                        onChange={(e) =>
                                            setRenameValue(e.target.value)
                                        }
                                        autoFocus
                                    />
                                </Field>
                            </DialogPanel>
                            <DialogFooter>
                                <DialogClose
                                    render={
                                        <Button variant="ghost">Cancel</Button>
                                    }
                                />
                                <Button type="submit">Rename file</Button>
                            </DialogFooter>
                        </Form>
                    </DialogPopup>
                </Dialog>
            </div>
        </ScrollArea>
    );
}
