import React, { useMemo, useState } from "react";
import { useVideoStore } from "@/contexts/video-store-context";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
    Tag,
    Plus,
    Video,
    ArrowUpDown,
    Clock,
    Calendar,
    Trash2,
    ChevronUp,
    ChevronDown,
} from "lucide-react";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { useConfirm } from "@/contexts/confirm-context";
import { CreateGroupDialog } from "@/components/home/create-group-dialog";
import { formatTime } from "@/utils/format";

export default function GroupsPage() {
    const {
        groups,
        videoGroupMap,
        isLoading,
        isCreateGroupDialogOpen,
        setIsCreateGroupDialogOpen,
        handleCreateGroup,
        videoMetadata,
        videos,
        handleDeleteGroup,
    } = useVideoStore();
    const navigate = useNavigate();
    const { confirm } = useConfirm();

    // Add sorting state
    const [sortColumn, setSortColumn] = useState<
        "name" | "videoCount" | "totalDuration"
    >("videoCount");
    const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

    // Calculate group details
    const groupData = useMemo(() => {
        return groups
            .map((group) => {
                // Count videos in this group
                const videoPaths = Object.entries(videoGroupMap)
                    .filter(([, groupIds]) => groupIds.includes(group.id))
                    .map(([path]) => path);

                const videoCount = videoPaths.length;

                // Calculate total duration from metadata
                const totalDuration = videoPaths.reduce((total, path) => {
                    const metadata = videoMetadata[path];
                    return total + (metadata?.duration || 0);
                }, 0);

                // Get earliest and latest dates
                let earliestDate: Date | null = null;
                let latestDate: Date | null = null;

                videoPaths.forEach((path) => {
                    const video = videos.find((v) => v.path === path);
                    if (video?.lastModified) {
                        const date = new Date(video.lastModified);
                        if (!earliestDate || date < earliestDate) {
                            earliestDate = date;
                        }
                        if (!latestDate || date > latestDate) {
                            latestDate = date;
                        }
                    }
                });

                return {
                    ...group,
                    videoCount,
                    totalDuration,
                    earliestDate,
                    latestDate,
                };
            })
            .sort((a, b) => b.videoCount - a.videoCount); // Default sort by video count
    }, [groups, videoGroupMap, videoMetadata, videos]);

    // Add sorting functionality
    const sortData = useMemo(() => {
        return [...groupData].sort((a, b) => {
            if (sortColumn === "name") {
                return sortDirection === "asc"
                    ? a.name.localeCompare(b.name)
                    : b.name.localeCompare(a.name);
            } else if (sortColumn === "videoCount") {
                return sortDirection === "asc"
                    ? a.videoCount - b.videoCount
                    : b.videoCount - a.videoCount;
            } else if (sortColumn === "totalDuration") {
                return sortDirection === "asc"
                    ? a.totalDuration - b.totalDuration
                    : b.totalDuration - a.totalDuration;
            }
            return 0;
        });
    }, [groupData, sortColumn, sortDirection]);

    // Handle sorting
    const handleSort = (column: "name" | "videoCount" | "totalDuration") => {
        if (sortColumn === column) {
            // Toggle direction if clicking the same column
            setSortDirection(sortDirection === "asc" ? "desc" : "asc");
        } else {
            // Set new column and default to descending
            setSortColumn(column);
            setSortDirection("desc");
        }
    };

    const deleteGroup = async (groupId: string, groupName: string) => {
        const confirmed = await confirm({
            title: "Delete Group",
            description: `Are you sure you want to delete the group "${groupName}"? This action cannot be undone.`,
            confirmText: "Delete",
            cancelText: "Cancel",
            variant: "destructive",
        });

        if (confirmed) {
            handleDeleteGroup(groupId);
        }
    };

    // Loading state
    if (isLoading) {
        return (
            <div className="p-4">
                <div className="space-y-2">
                    <Skeleton className="h-8 w-48" />
                    <Skeleton className="h-4 w-32" />
                </div>
                <div className="mt-6">
                    <div className="rounded-md border">
                        <div className="bg-muted/50 h-10 border-b px-4">
                            <Skeleton className="mt-2.5 h-5 w-full" />
                        </div>
                        {Array.from({ length: 5 }).map((_, i) => (
                            <div
                                key={i}
                                className="border-b px-4 py-3 last:border-b-0"
                            >
                                <Skeleton className="h-5 w-full" />
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        );
    }

    // Empty state
    if (groupData.length === 0) {
        return (
            <div className="flex h-64 flex-col items-center justify-center p-4">
                <Tag
                    size={48}
                    className="text-muted-foreground mb-4 opacity-40"
                />
                <p className="text-muted-foreground mb-4">
                    No groups created yet.
                </p>
                <Button onClick={() => setIsCreateGroupDialogOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Create Group
                </Button>
                <CreateGroupDialog
                    open={isCreateGroupDialogOpen}
                    onOpenChange={setIsCreateGroupDialogOpen}
                    onCreateGroup={handleCreateGroup}
                />
            </div>
        );
    }

    // Render sort indicator icon
    const renderSortIcon = (
        column: "name" | "videoCount" | "totalDuration",
    ) => {
        if (sortColumn !== column) {
            return (
                <ArrowUpDown className="text-muted-foreground ml-1 h-3 w-3" />
            );
        }
        return sortDirection === "asc" ? (
            <ChevronUp className="ml-1 h-3 w-3" />
        ) : (
            <ChevronDown className="ml-1 h-3 w-3" />
        );
    };

    return (
        <div className="flex flex-col p-4 px-6 pr-4">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold">Groups</h1>
                    <p className="text-muted-foreground mt-1">
                        {groupData.length}{" "}
                        {groupData.length === 1 ? "group" : "groups"} of clips
                    </p>
                </div>
                <Button onClick={() => setIsCreateGroupDialogOpen(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Create Group
                </Button>
            </div>

            <div className="mt-4 rounded-md border">
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-12"></TableHead>
                            <TableHead>
                                <div
                                    className="flex cursor-pointer items-center"
                                    onClick={() => handleSort("name")}
                                >
                                    Name
                                    {renderSortIcon("name")}
                                </div>
                            </TableHead>
                            <TableHead>
                                <div
                                    className="flex cursor-pointer items-center"
                                    onClick={() => handleSort("videoCount")}
                                >
                                    Clips
                                    {renderSortIcon("videoCount")}
                                </div>
                            </TableHead>
                            <TableHead>
                                <div
                                    className="flex cursor-pointer items-center"
                                    onClick={() => handleSort("totalDuration")}
                                >
                                    Duration
                                    {renderSortIcon("totalDuration")}
                                </div>
                            </TableHead>
                            <TableHead>Date Range</TableHead>
                            <TableHead className="text-accent-negative text-right">
                                Delete
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {sortData.map((group) => (
                            <TableRow
                                key={group.id}
                                className="cursor-pointer"
                                onClick={() =>
                                    navigate({
                                        to: "/groups/$groupId",
                                        params: { groupId: group.id },
                                    })
                                }
                            >
                                <TableCell className="text-center">
                                    <span
                                        className="inline-block h-4 w-4 rounded-full align-middle"
                                        style={{ backgroundColor: group.color }}
                                    />
                                </TableCell>
                                <TableCell className="font-medium">
                                    {group.name}
                                </TableCell>
                                <TableCell>
                                    <div className="flex items-center">
                                        <Video className="text-muted-foreground mr-1.5 h-3.5 w-3.5" />
                                        <span>
                                            {group.videoCount}{" "}
                                            {group.videoCount === 1
                                                ? "clip"
                                                : "clips"}
                                        </span>
                                    </div>
                                </TableCell>
                                <TableCell>
                                    <div className="flex items-center">
                                        <Clock className="text-muted-foreground mr-1.5 h-3.5 w-3.5" />
                                        <span>
                                            {formatTime(group.totalDuration)}
                                        </span>
                                    </div>
                                </TableCell>
                                <TableCell>
                                    {group.earliestDate && group.latestDate ? (
                                        <div className="flex items-center">
                                            <Calendar className="text-muted-foreground mr-1.5 h-3.5 w-3.5" />
                                            <span>
                                                {(
                                                    group.earliestDate as Date
                                                ).toLocaleDateString()}{" "}
                                                -{" "}
                                                {(
                                                    group.latestDate as Date
                                                ).toLocaleDateString()}
                                            </span>
                                        </div>
                                    ) : (
                                        <span className="text-muted-foreground">
                                            No date info
                                        </span>
                                    )}
                                </TableCell>
                                <TableCell className="text-right">
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="text-destructive hover:text-destructive"
                                        onClick={(e) => {
                                            e.stopPropagation(); // Prevent row click
                                            deleteGroup(group.id, group.name);
                                        }}
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
            <CreateGroupDialog
                open={isCreateGroupDialogOpen}
                onOpenChange={setIsCreateGroupDialogOpen}
                onCreateGroup={handleCreateGroup}
            />
        </div>
    );
}
