import React from "react";
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
import { Check, Plus, Tag, Trash2 } from "lucide-react";
import { VideoFile, VideoGroup } from "@/types/video";
import { useVideoStore } from "@/contexts/video-store-context";

interface VideoContextMenuProps {
    children: React.ReactNode;
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
    videoIds,
    groups,
    videoGroupMap,
    onAddToGroup,
    onShowCreateGroup,
    onRemoveFromGroup,
}: VideoContextMenuProps) {
    const { handleDeleteVideos } = useVideoStore();

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

    return (
        <ContextMenu>
            <ContextMenuTrigger>{children}</ContextMenuTrigger>
            <ContextMenuContent className="w-56">
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
