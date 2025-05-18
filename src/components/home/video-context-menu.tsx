import React, { useMemo } from "react";
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
}

export function VideoContextMenu({
    children,
    videos,
    video,
    videoIds,
    groups,
    videoGroupMap,
    onAddToGroup,
    onShowCreateGroup,
    onRemoveFromGroup,
}: VideoContextMenuProps) {
    const navigate = useNavigate();
    const { handleDeleteVideos, handleUpdateVideoGames } = useVideoStore();
    const { games } = useSteam();

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

    const showInFolder = async (path: string) => {
        try {
            await window.videos.showInFolder(path);
        } catch (error) {
            console.error("Failed to show file in folder:", error);
        }
    };

    // Only allow showing in folder when a single video is selected
    const canShowInFolder = videoIds.length === 1;

    // Get current game for the selected videos
    const currentGame =
        videoIds.length === 1
            ? videos.find((v) => v.path === videoIds[0])?.game || "Unknown"
            : "";

    // Create sorted list of game names from the keys
    const sortedGames = useMemo(() => {
        return Object.entries(games)
            .map(([slug, { appid, displayName }]) => ({
                id: appid,
                slug,
                name: displayName,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [games]);

    return (
        <ContextMenu>
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
                        {sortedGames.map((game) => (
                            <ContextMenuItem
                                key={game.slug}
                                className="flex items-center justify-between"
                                onClick={() =>
                                    handleUpdateVideoGames(videoIds, game.name)
                                }
                            >
                                <span className="truncate">{game.name}</span>
                                {game.name === currentGame && (
                                    <Check size={16} />
                                )}
                            </ContextMenuItem>
                        ))}
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
                                            onAddToGroup(videoIds, group.id);
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
                    Delete {videoIds.length > 1 ? `(${videoIds.length})` : ""}
                </ContextMenuItem>
            </ContextMenuContent>
        </ContextMenu>
    );
}
