import { Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConfirm } from "@/contexts/confirm-context";
import { imgSrc, deleteClips, removeExport } from "@/lib/tauri";
import { formatBytes, formatRelativeDate, cn } from "@/lib/utils";
import type { ExportedClip } from "@/types";

import { formatTime } from "./clip-video-player";

interface PreviousExportsProps {
    exports: ExportedClip[];
    setExports: React.Dispatch<React.SetStateAction<ExportedClip[]>>;
    isLoading: boolean;
    onSelectClip: (clipPath: string | null, clipDuration: number | null) => void;
    selectedClipPath: string | null;
}

export function PreviousExports({
    exports,
    setExports,
    isLoading,
    onSelectClip,
    selectedClipPath,
}: PreviousExportsProps) {
    const [isDeletingPath, setIsDeletingPath] = useState<string | null>(null);
    const confirm = useConfirm();

    const handleDeleteExport = async (clipPath: string) => {
        try {
            const shouldDelete = await confirm({
                title: "Delete Clip",
                description: "Are you sure you want to delete this clip?",
                confirmText: "Delete",
                cancelText: "Cancel",
                variant: "destructive",
            });
            if (!shouldDelete) return;
            setIsDeletingPath(clipPath);

            const result = await deleteClips([clipPath]);
            if (result.failed.length > 0) {
                toastManager.add({
                    title: `Failed to delete clip: ${result.failed[0] ?? result.error ?? "Unknown error"}`,
                    type: "error",
                });
                return;
            }
            await removeExport(clipPath);
            setExports(exports.filter((clip) => clip.path !== clipPath));
            if (selectedClipPath === clipPath) {
                onSelectClip(null, null);
            }
            toastManager.add({ title: "Clip deleted successfully", type: "success" });
        } catch (error) {
            console.error("Error deleting export:", error);
            toastManager.add({ title: "Failed to delete clip", type: "error" });
        } finally {
            setIsDeletingPath(null);
        }
    };

    const handleSelectClip = (clipPath: string, clipDuration: number) => {
        if (selectedClipPath === clipPath) {
            onSelectClip(null, null);
            return;
        }
        onSelectClip(clipPath, clipDuration);
    };

    return (
        <div className="min-h-0 flex-grow px-4 pb-0">
            <ScrollArea className="h-full w-full">
                {isLoading ? (
                    <div className="flex h-16 items-center justify-center">
                        <Spinner className="h-5 w-5" />
                    </div>
                ) : exports.length === 0 ? (
                    <div className="flex h-16 items-center justify-center">
                        <p className="text-muted-foreground text-sm">
                            No exports found for this video
                        </p>
                    </div>
                ) : (
                    <div className="grid gap-2">
                        {exports.map((clip, index) => (
                            <div
                                key={index}
                                className={cn(
                                    "bg-card hover:bg-accent/50 relative flex cursor-pointer justify-between rounded-md border p-2 transition-all",
                                    selectedClipPath === clip.path && "border-accent-positive",
                                )}
                                onClick={() => handleSelectClip(clip.path, clip.duration)}
                            >
                                <div className="grid grid-cols-[auto_1fr_auto] gap-2">
                                    <div className="bg-muted relative h-14 w-24 overflow-hidden rounded">
                                        <img
                                            src={
                                                clip.thumbnail
                                                    ? imgSrc(clip.thumbnail)
                                                    : imgSrc(clip.path)
                                            }
                                            alt="Clip thumbnail"
                                            className="absolute inset-0 h-full w-full object-cover"
                                            onError={(e) => {
                                                e.currentTarget.style.display = "none";
                                            }}
                                        />
                                    </div>
                                    <div className="flex flex-col justify-center overflow-hidden">
                                        <p className="truncate text-sm font-medium">{clip.name}</p>
                                        <div className="text-muted-foreground flex gap-3 text-xs">
                                            <span>{formatTime(clip.duration)}</span>
                                            <span>{formatBytes(clip.size)}</span>
                                            <span>
                                                {formatRelativeDate(
                                                    new Date(clip.timestamp).toISOString(),
                                                )}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex h-6">
                                    {selectedClipPath === clip.path && (
                                        <Tooltip>
                                            <TooltipTrigger
                                                render={
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        className="h-6 w-6 p-0"
                                                        onClick={() =>
                                                            handleSelectClip(
                                                                clip.path,
                                                                clip.duration,
                                                            )
                                                        }
                                                    />
                                                }
                                            >
                                                <Undo2 className="h-4 w-4" />
                                                <span className="sr-only">
                                                    Return to default video
                                                </span>
                                            </TooltipTrigger>
                                            <TooltipContent>Return to default video</TooltipContent>
                                        </Tooltip>
                                    )}
                                    <Tooltip>
                                        <TooltipTrigger
                                            render={
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-6 w-6 p-0"
                                                    onClick={(
                                                        e: React.MouseEvent<HTMLButtonElement>,
                                                    ) => {
                                                        e.stopPropagation();
                                                        void handleDeleteExport(clip.path);
                                                    }}
                                                    disabled={isDeletingPath === clip.path}
                                                />
                                            }
                                        >
                                            <Trash2 className="text-destructive h-4 w-4" />
                                            <span className="sr-only">Delete clip</span>
                                        </TooltipTrigger>
                                        <TooltipContent>Delete clip</TooltipContent>
                                    </Tooltip>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </ScrollArea>
        </div>
    );
}
