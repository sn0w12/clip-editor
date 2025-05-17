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
import { Check, Plus, Tag } from "lucide-react";
import { VideoGroup } from "@/types/video";

interface VideoContextMenuProps {
    children: React.ReactNode;
    videoIds: string[];
    groups: VideoGroup[];
    videoGroupMap: Record<string, string[]>;
    onAddToGroup: (videoIds: string[], groupId: string) => void;
    onShowCreateGroup: () => void; // Changed to trigger external dialog
    onRemoveFromGroup: (videoIds: string[], groupId: string) => void;
}

export function VideoContextMenu({
    children,
    videoIds,
    groups,
    videoGroupMap,
    onAddToGroup,
    onShowCreateGroup,
    onRemoveFromGroup,
}: VideoContextMenuProps) {
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
            </ContextMenuContent>
        </ContextMenu>
    );
}
