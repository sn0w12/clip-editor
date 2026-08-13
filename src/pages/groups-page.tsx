import { useNavigate } from "@tanstack/react-router";
import { ArrowDownIcon, ArrowUpIcon, FolderPlusIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { EmptyState } from "@/components/empty-state";
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
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useConfirm } from "@/contexts/confirm-context";
import { formatDuration, cn } from "@/lib/utils";
import { useClipsStore } from "@/stores/clips-store";
import type { VideoGroup } from "@/types";

type SortKey = "name" | "videoCount" | "totalDuration";

interface GroupStats {
    group: VideoGroup;
    videoCount: number;
    totalDuration: number;
    firstDate?: string;
    lastDate?: string;
}

function SortHeader({
    label,
    sort,
    sortKey,
    sortDirection,
    onSort,
}: {
    label: string;
    sort: SortKey;
    sortKey: SortKey;
    sortDirection: "asc" | "desc";
    onSort: (key: SortKey) => void;
}): React.ReactElement {
    return (
        <th className="px-3 py-2 text-left font-medium">
            <Button
                variant="ghost"
                size="xs"
                onClick={() => onSort(sort)}
                className={cn(sortKey === sort && "text-primary")}
            >
                {label}
                {sortKey === sort &&
                    (sortDirection === "asc" ? <ArrowUpIcon /> : <ArrowDownIcon />)}
            </Button>
        </th>
    );
}

export function GroupsPage(): React.ReactElement {
    const store = useClipsStore();
    const confirm = useConfirm();
    const navigate = useNavigate();

    const [sortKey, setSortKey] = useState<SortKey>("name");
    const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
    const [isCreateOpen, setIsCreateOpen] = useState(false);
    const [name, setName] = useState("");

    const stats: GroupStats[] = useMemo(() => {
        const byGroup = new Map<string, { count: number; duration: number; dates: string[] }>();
        for (const clip of store.clips) {
            for (const groupId of clip.groupIds) {
                const entry = byGroup.get(groupId) ?? { count: 0, duration: 0, dates: [] };
                entry.count += 1;
                entry.duration += clip.metadata?.duration ?? 0;
                entry.dates.push(clip.lastModified);
                byGroup.set(groupId, entry);
            }
        }
        return store.groups.map((group) => {
            const entry = byGroup.get(group.id) ?? { count: 0, duration: 0, dates: [] };
            const sorted = [...entry.dates].sort();
            return {
                group,
                videoCount: entry.count,
                totalDuration: entry.duration,
                firstDate: sorted[0],
                lastDate: sorted[sorted.length - 1],
            };
        });
    }, [store.clips, store.groups]);

    const sorted = useMemo(() => {
        const list = [...stats];
        const direction = sortDirection === "asc" ? 1 : -1;
        list.sort((a, b) => {
            switch (sortKey) {
                case "videoCount":
                    return (a.videoCount - b.videoCount) * direction;
                case "totalDuration":
                    return (a.totalDuration - b.totalDuration) * direction;
                default:
                    return a.group.name.localeCompare(b.group.name) * direction;
            }
        });
        return list;
    }, [stats, sortKey, sortDirection]);

    const toggleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
        } else {
            setSortKey(key);
            setSortDirection("asc");
        }
    };

    const handleDelete = async (group: VideoGroup) => {
        const ok = await confirm({
            title: `Delete ${group.name}?`,
            description: "Clips stay on disk; only the group is removed.",
            confirmText: "Delete",
            variant: "destructive",
        });
        if (ok) {
            await toastManager
                .promise(store.deleteGroup(group.id), {
                    loading: { title: "Deleting group…" },
                    success: { title: "Group deleted" },
                    error: (e) => ({ title: `Failed to delete group: ${String(e)}` }),
                })
                .catch(() => {});
        }
    };

    return (
        <div className="flex h-full flex-col gap-2 p-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold">Groups</h1>
                    <p className="text-muted-foreground text-sm">{store.groups.length} group(s)</p>
                </div>
                <Button size="sm" onClick={() => setIsCreateOpen(true)}>
                    <FolderPlusIcon /> New group
                </Button>
            </div>

            {store.loading ? (
                <div className="space-y-2">
                    {Array.from({ length: 5 }, (_, i) => (
                        <Skeleton key={i} className="h-10 w-full" />
                    ))}
                </div>
            ) : sorted.length === 0 ? (
                <EmptyState
                    title="No groups yet"
                    description="Create a group and assign clips to it from the clip context menu."
                >
                    <Button onClick={() => setIsCreateOpen(true)}>
                        <FolderPlusIcon /> New group
                    </Button>
                </EmptyState>
            ) : (
                <div className="min-h-0 flex-1 rounded-lg border">
                    <table className="w-full text-sm">
                        <thead className="bg-muted/40">
                            <tr>
                                <SortHeader
                                    label="Name"
                                    sort="name"
                                    sortKey={sortKey}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                />
                                <SortHeader
                                    label="Clips"
                                    sort="videoCount"
                                    sortKey={sortKey}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                />
                                <SortHeader
                                    label="Duration"
                                    sort="totalDuration"
                                    sortKey={sortKey}
                                    sortDirection={sortDirection}
                                    onSort={toggleSort}
                                />
                                <th className="px-3 py-2 text-left font-medium">Date range</th>
                                <th className="w-16" />
                            </tr>
                        </thead>
                        <tbody>
                            {sorted.map(
                                ({ group, videoCount, totalDuration, firstDate, lastDate }) => (
                                    <tr
                                        key={group.id}
                                        className="hover:bg-accent/30 cursor-pointer border-t transition-colors"
                                        onClick={() =>
                                            void navigate({
                                                to: "/groups/$groupId",
                                                params: { groupId: group.id },
                                            })
                                        }
                                    >
                                        <td className="px-3 py-2">
                                            <span className="flex items-center gap-2 font-medium">
                                                <span
                                                    className="size-2.5 shrink-0 rounded-full"
                                                    style={{
                                                        backgroundColor:
                                                            group.color ?? "var(--accent-color)",
                                                    }}
                                                />
                                                {group.name}
                                            </span>
                                        </td>
                                        <td className="text-muted-foreground px-3 py-2">
                                            {videoCount}
                                        </td>
                                        <td className="text-muted-foreground px-3 py-2">
                                            {formatDuration(totalDuration)}
                                        </td>
                                        <td className="text-muted-foreground px-3 py-2">
                                            {firstDate
                                                ? `${formatDate(firstDate)} – ${formatDate(lastDate ?? firstDate)}`
                                                : "—"}
                                        </td>
                                        <td className="px-3 py-2 text-right">
                                            <Button
                                                size="icon-sm"
                                                variant="ghost"
                                                aria-label={`Delete ${group.name}`}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    void handleDelete(group);
                                                }}
                                            >
                                                <Trash2Icon />
                                            </Button>
                                        </td>
                                    </tr>
                                ),
                            )}
                        </tbody>
                    </table>
                </div>
            )}

            <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
                <DialogPopup className="sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle>New group</DialogTitle>
                        <DialogDescription>
                            Group clips together for quick filtering.
                        </DialogDescription>
                    </DialogHeader>
                    <Form
                        className="contents"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (!name.trim()) return;
                            void toastManager
                                .promise(store.createGroup(name.trim()), {
                                    loading: { title: "Creating group…" },
                                    success: (group) => ({ title: `Created ${group.name}` }),
                                    error: (e) => ({
                                        title: `Failed to create group: ${String(e)}`,
                                    }),
                                })
                                .then(() => {
                                    setName("");
                                    setIsCreateOpen(false);
                                })
                                .catch(() => {});
                        }}
                    >
                        <DialogPanel className="grid gap-4">
                            <Field>
                                <FieldLabel>Name</FieldLabel>
                                <Input
                                    id="group-name"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    autoFocus
                                    placeholder="Favorites"
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
        </div>
    );
}

function formatDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}
