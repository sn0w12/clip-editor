import {
    ExternalLink,
    FolderPlus,
    FolderX,
    Gamepad2 as Gamepad2Icon,
    Link2 as Link2Icon,
    Pencil,
    Trash,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
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
import type { useGamesStore } from "@/stores/games-store";
import type { GameImage, SteamGame, VideoFile, VideoGroup } from "@/types";

import { GameIcon } from "../game-icon";

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
    onCreateGroup,
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
    onCreateGroup: (name: string) => Promise<VideoGroup>;
    children: React.ReactNode;
}) {
    const [pickerMode, setPickerMode] = useState<"set" | "alias" | null>(null);
    const [isNewGroupOpen, setIsNewGroupOpen] = useState(false);
    const unassigned = groups.filter((g) => !groupIds.includes(g.id));
    const assigned = groups.filter((g) => groupIds.includes(g.id));

    const handlePick = async (appId: string, displayName: string) => {
        if (pickerMode === "set") {
            onRename({ ...video, game: displayName });
            toastManager.add({
                title: `Set game to ${displayName}`,
                type: "success",
            });
        } else if (pickerMode === "alias") {
            await toastManager
                .promise(games.setAlias(video.rawGame ?? video.game, appId), {
                    loading: { title: "Setting alias…" },
                    success: {
                        title: `Aliased "${video.rawGame ?? video.game}" to ${displayName}`,
                    },
                    error: (e) => ({
                        title: `Failed to set alias: ${String(e)}`,
                    }),
                })
                .catch(() => {});
        }
        setPickerMode(null);
    };

    const handleCreateGroup = async (name: string) => {
        try {
            const group = await toastManager.promise(
                onCreateGroup(name.trim()),
                {
                    loading: { title: "Creating group…" },
                    success: (g) => ({ title: `Created ${g.name}` }),
                    error: (e) => ({
                        title: `Failed to create group: ${String(e)}`,
                    }),
                }
            );
            onAddToGroup(video, group.id);
            setIsNewGroupOpen(false);
        } catch {
            // The error toast is handled by toastManager.promise.
        }
    };

    return (
        <ContextMenu>
            <ContextMenuTrigger>{children}</ContextMenuTrigger>
            <ContextMenuContent>
                <ContextMenuItem onClick={() => onOpen(video)}>
                    <ExternalLink className="size-4" />
                    Open
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onRename(video)}>
                    <Pencil className="size-4" />
                    Rename game
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => setPickerMode("set")}>
                    <Gamepad2Icon className="size-4" />
                    Set game to
                </ContextMenuItem>
                <ContextMenuItem onClick={() => setPickerMode("alias")}>
                    <Link2Icon className="size-4" />
                    Alias to game
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuSub>
                    <ContextMenuSubTrigger>
                        <FolderPlus className="mr-2 size-4" />
                        Add to group
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-48">
                        <ContextMenuItem
                            onClick={() => setIsNewGroupOpen(true)}
                        >
                            <FolderPlus className="size-4" />
                            New Group
                        </ContextMenuItem>
                        {unassigned.length > 0 && <ContextMenuSeparator />}
                        {unassigned.map((group) => (
                            <ContextMenuItem
                                key={group.id}
                                onClick={() => onAddToGroup(video, group.id)}
                            >
                                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                                    <span
                                        className="size-3 rounded-full"
                                        style={{
                                            backgroundColor:
                                                group.color ??
                                                "var(--muted-foreground)",
                                        }}
                                    />
                                </span>
                                {group.name}
                            </ContextMenuItem>
                        ))}
                    </ContextMenuSubContent>
                </ContextMenuSub>
                {assigned.length > 0 && (
                    <ContextMenuSub>
                        <ContextMenuSubTrigger>
                            <FolderX className="mr-2 size-4" />
                            Remove from group
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-48">
                            {assigned.map((group) => (
                                <ContextMenuItem
                                    key={group.id}
                                    variant="destructive"
                                    onClick={() =>
                                        onRemoveFromGroup(video, group.id)
                                    }
                                >
                                    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                                        <span
                                            className="size-3 rounded-full"
                                            style={{
                                                backgroundColor:
                                                    group.color ??
                                                    "var(--muted-foreground)",
                                            }}
                                        />
                                    </span>
                                    {group.name}
                                </ContextMenuItem>
                            ))}
                        </ContextMenuSubContent>
                    </ContextMenuSub>
                )}
                <ContextMenuSeparator />
                <ContextMenuItem
                    variant="destructive"
                    onClick={() => onDelete([video.path])}
                >
                    <Trash className="size-4 text-destructive" />
                    Delete
                </ContextMenuItem>
            </ContextMenuContent>

            <GamePickerDialog
                open={pickerMode !== null}
                onOpenChange={(open) => !open && setPickerMode(null)}
                title={pickerMode === "set" ? "Set game" : "Alias to game"}
                onPick={(appId, displayName) =>
                    void handlePick(appId, displayName)
                }
                games={games.games}
                addCustomGame={games.addCustomGame}
            />
            <NewGroupDialog
                open={isNewGroupOpen}
                onOpenChange={setIsNewGroupOpen}
                onCreate={handleCreateGroup}
            />
        </ContextMenu>
    );
}

function NewGroupDialog({
    open,
    onOpenChange,
    onCreate,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreate: (name: string) => Promise<void>;
}) {
    const [name, setName] = useState("");

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) setName("");
                onOpenChange(next);
            }}
        >
            <DialogPopup className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>New Group</DialogTitle>
                    <DialogDescription>
                        Create a group and add this clip to it.
                    </DialogDescription>
                </DialogHeader>
                <Form
                    className="contents"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (!name.trim()) return;
                        void onCreate(name.trim())
                            .then(() => setName(""))
                            .catch(() => {});
                    }}
                >
                    <DialogPanel className="grid gap-4">
                        <Field>
                            <FieldLabel>Name</FieldLabel>
                            <Input
                                id="new-group-name"
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                placeholder="Favorites"
                                autoFocus
                            />
                        </Field>
                    </DialogPanel>
                    <DialogFooter>
                        <DialogClose
                            render={<Button variant="ghost">Cancel</Button>}
                        />
                        <Button type="submit">Create</Button>
                    </DialogFooter>
                </Form>
            </DialogPopup>
        </Dialog>
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
        const list = [...games].sort((a, b) =>
            a.displayName.localeCompare(b.displayName)
        );
        return q
            ? list.filter((g) => g.displayName.toLowerCase().includes(q))
            : list;
    }, [games, search]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogPopup className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    <DialogDescription>
                        Pick a game from your Steam library, or add a custom
                        game.
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
                                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                                    onClick={() =>
                                        onPick(game.appId, game.displayName)
                                    }
                                >
                                    <GameIcon
                                        game={game.displayName}
                                        gameImage={game.artwork}
                                        className="size-5"
                                    />
                                    <span className="truncate">
                                        {game.displayName}
                                    </span>
                                </button>
                            ))}
                            {filtered.length === 0 && (
                                <p className="px-2 py-1 text-sm text-muted-foreground">
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

export function matchGameImage(
    games: {
        appId: string;
        displayName: string;
        normalizedName: string;
        artwork?: GameImage | null;
    }[],
    aliases: { alias: string; appId: string }[],
    gameName: string
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
