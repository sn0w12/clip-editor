import React from "react";
import { VideoGroup } from "@/types/video";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Tag } from "lucide-react";

interface GroupFilterProps {
    groups: VideoGroup[];
    selectedGroupId: string | null;
    onSelectGroup: (groupId: string | null) => void;
}

export function GroupFilter({
    groups,
    selectedGroupId,
    onSelectGroup,
}: GroupFilterProps) {
    if (groups.length === 0) return null;

    return (
        <Select
            value={selectedGroupId || "all"}
            onValueChange={(value) =>
                onSelectGroup(value === "all" ? null : value)
            }
        >
            <SelectTrigger className="!h-10 w-[180px] gap-2">
                <Tag size={16} />
                <SelectValue placeholder="Filter by Group" />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="all">All Videos</SelectItem>
                {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                        <div className="flex items-center gap-2">
                            {group.color && (
                                <span
                                    className="h-3 w-3 rounded-full"
                                    style={{ backgroundColor: group.color }}
                                />
                            )}
                            {group.name}
                        </div>
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}
