import React, { useState, useCallback, memo } from "react";
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
    Check,
    ExternalLink,
    Folder,
    Plus,
    Tag,
    Trash2,
    Gamepad2,
} from "lucide-react";
import { VideoFile, VideoGroup } from "@/types/video";
import { useVideoStore } from "@/contexts/video-store-context";
import { useNavigate } from "@tanstack/react-router";
import { useSteam } from "@/contexts/steam-context";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface VideoContextMenuProps {
    children: React.ReactNode;
    video: VideoFile;
    videos: VideoFile[];
    videoIds: string[];
    groups: VideoGroup[];
    videoGroupMap: Record<string, string[]>;
    onAddToGroup: (videoIds: string[], groupId: string) => void;
    onShowCreateGroup: () => void;
    onRemoveFromGroup: (videoIds: string[], groupId: string) => void;
    sortedGames: Array<{ id: string; slug: string; name: string }>;
}

function VideoContextMenuBase({
    children,
    videos,
    video,
    videoIds,
    groups,
    videoGroupMap,
    onAddToGroup,
    onShowCreateGroup,
    onRemoveFromGroup,
    sortedGames,
}: VideoContextMenuProps) {
    const navigate = useNavigate();
    const { handleDeleteVideos, handleUpdateVideoGames } = useVideoStore();
    const { addCustomGame } = useSteam();
    const [isCustomGameDialogOpen, setIsCustomGameDialogOpen] = useState(false);
    const [customGameName, setCustomGameName] = useState("");
    const [gameSearchTerm, setGameSearchTerm] = useState("");
    const searchInputRef = React.useRef<HTMLInputElement>(null);

    function deleteVideosDescription(videoPaths: string[]) {
        const videoNames = videoPaths.map((path) => {
            const video = videos.find((v) => v.path === path);
            return video ? video.name : path;
        });

        return `Are you sure you want to delete ${
            videoPaths.length > 1
                ? `these ${videoPaths.length} videos`
                : `"${videoNames[0]}"`
        }? This will permanently remove ${
            videoPaths.length > 1 ? "them" : "it"
        } from your drive.`;
    }

    const showInFolder = useCallback(async (path: string) => {
        try {
            await window.videos.showInFolder(path);
        } catch (error) {
            console.error("Failed to show file in folder:", error);
        }
    }, []);

    const handleCustomGameSubmit = useCallback(() => {
        if (customGameName.trim()) {
            addCustomGame(customGameName.trim());
            handleUpdateVideoGames(videoIds, customGameName.trim());

            setCustomGameName("");
            setIsCustomGameDialogOpen(false);
        }
    }, [addCustomGame, customGameName, handleUpdateVideoGames, videoIds]);

    // Only allow showing in folder when a single video is selected
    const canShowInFolder = videoIds.length === 1;

    // Get current game for the selected videos
    const currentGame =
        videoIds.length === 1
            ? videos.find((v) => v.path === videoIds[0])?.game || "Unknown"
            : "";

    // Filter games based on search term
    const filteredGames = sortedGames.filter((game) =>
        game.name.toLowerCase().includes(gameSearchTerm.toLowerCase()),
    );

    // Reset search when context menu closes
    const handleContextMenuOpenChange = (open: boolean) => {
        if (!open) {
            setGameSearchTerm("");
        }
    };

    return (
        <>
            <ContextMenu onOpenChange={handleContextMenuOpenChange}>
                <ContextMenuTrigger>{children}</ContextMenuTrigger>
                <ContextMenuContent className="w-56">
                    <ContextMenuItem
                        className="flex items-center gap-2"
                        onClick={() => {
                            navigate({
                                to: "/clips/edit",
                                search: {
                                    videoPath: video.path,
                                    videoName: video.name,
                                },
                            });
                        }}
                    >
                        <ExternalLink size={16} />
                        Open
                    </ContextMenuItem>

                    <ContextMenuSub>
                        <ContextMenuSubTrigger className="flex items-center gap-2">
                            <Gamepad2 size={16} />
                            Set Game
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="max-h-80 w-56 overflow-y-auto">
                            <Input
                                ref={searchInputRef}
                                placeholder="Search game..."
                                value={gameSearchTerm}
                                onChange={(e) => {
                                    e.stopPropagation();
                                    setGameSearchTerm(e.target.value);
                                }}
                                onKeyDown={(e) => {
                                    e.stopPropagation();
                                }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                }}
                                className="h-8"
                            />

                            <ContextMenuItem
                                className="flex items-center gap-2"
                                onClick={() => setIsCustomGameDialogOpen(true)}
                            >
                                <Plus size={16} />
                                Custom Game...
                            </ContextMenuItem>

                            {filteredGames.length > 0 && (
                                <ContextMenuSeparator />
                            )}

                            {filteredGames.map((game) => (
                                <ContextMenuItem
                                    key={game.slug}
                                    className="flex items-center justify-between"
                                    onClick={() =>
                                        handleUpdateVideoGames(
                                            videoIds,
                                            game.name,
                                        )
                                    }
                                >
                                    <span className="truncate">
                                        {game.name}
                                    </span>
                                    {game.name === currentGame && (
                                        <Check size={16} />
                                    )}
                                </ContextMenuItem>
                            ))}

                            {filteredGames.length === 0 && gameSearchTerm && (
                                <div className="text-muted-foreground px-2 py-1.5 text-center text-sm">
                                    No games found
                                </div>
                            )}
                        </ContextMenuSubContent>
                    </ContextMenuSub>

                    <ContextMenuSub>
                        <ContextMenuSubTrigger className="flex items-center gap-2">
                            <Tag size={16} />
                            Groups
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent className="w-48">
                            <ContextMenuItem
                                className="flex items-center gap-2"
                                onClick={onShowCreateGroup}
                            >
                                <Plus size={16} />
                                New Group...
                            </ContextMenuItem>

                            {groups.length > 0 && <ContextMenuSeparator />}

                            {groups.map((group) => {
                                const allInGroup = videoIds.every((videoId) =>
                                    (videoGroupMap[videoId] || []).includes(
                                        group.id,
                                    ),
                                );

                                return (
                                    <ContextMenuItem
                                        key={group.id}
                                        className="flex items-center justify-between"
                                        onClick={() => {
                                            if (allInGroup) {
                                                onRemoveFromGroup(
                                                    videoIds,
                                                    group.id,
                                                );
                                            } else {
                                                onAddToGroup(
                                                    videoIds,
                                                    group.id,
                                                );
                                            }
                                        }}
                                    >
                                        <span className="flex items-center gap-2">
                                            {group.color && (
                                                <span
                                                    className="h-3 w-3 rounded-full"
                                                    style={{
                                                        backgroundColor:
                                                            group.color,
                                                    }}
                                                />
                                            )}
                                            {group.name}
                                        </span>
                                        {allInGroup && <Check size={16} />}
                                    </ContextMenuItem>
                                );
                            })}
                        </ContextMenuSubContent>
                        {canShowInFolder && (
                            <ContextMenuItem
                                className="flex items-center gap-2"
                                onClick={() => showInFolder(videoIds[0])}
                            >
                                <Folder size={16} />
                                Show in Folder
                            </ContextMenuItem>
                        )}
                    </ContextMenuSub>

                    <ContextMenuSeparator />

                    <ContextMenuItem
                        className="flex items-center gap-2"
                        variant="destructive"
                        confirmDescription={deleteVideosDescription(videoIds)}
                        onClick={() => handleDeleteVideos(videoIds)}
                    >
                        <Trash2 size={16} />
                        Delete{" "}
                        {videoIds.length > 1 ? `(${videoIds.length})` : ""}
                    </ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>

            <Dialog
                open={isCustomGameDialogOpen}
                onOpenChange={setIsCustomGameDialogOpen}
            >
                <DialogContent className="sm:max-w-[425px]">
                    <DialogHeader>
                        <DialogTitle>Add Custom Game</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <Input
                            placeholder="Enter game name"
                            value={customGameName}
                            onChange={(e) => setCustomGameName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    handleCustomGameSubmit();
                                }
                            }}
                        />
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setIsCustomGameDialogOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button onClick={handleCustomGameSubmit}>Apply</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}

export const VideoContextMenu = memo(VideoContextMenuBase);
