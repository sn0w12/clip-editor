import React, { useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatTime } from "@/utils/format";
import { imgSrc } from "@/utils/games";
import { ExportedClip } from "@/types/video-editor";
import { CardContent } from "../ui/card";
import { Button } from "@/components/ui/button";
import { Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { useConfirm } from "@/contexts/confirm-context";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

interface PreviousExportsProps {
    exports: ExportedClip[];
    setExports: React.Dispatch<React.SetStateAction<ExportedClip[]>>;
    isLoading: boolean;
    onSelectClip: (
        clipPath: string | null,
        clipDuration: number | null,
    ) => void;
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
    const { confirm } = useConfirm();

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1048576).toFixed(1)} MB`;
    };

    const handleDeleteExport = async (clipPath: string) => {
        try {
            const shouldDelete = await confirm({
                title: "Delete Clip",
                description: "Are you sure you want to delete this clip?",
                confirmText: "Delete",
                cancelText: "Cancel",
            });
            if (!shouldDelete) return;
            setIsDeletingPath(clipPath);

            const result = await window.videos.deleteVideoFiles([clipPath]);
            if (result.success) {
                setExports(exports.filter((clip) => clip.path !== clipPath));
                if (selectedClipPath === clipPath) {
                    onSelectClip(null, null);
                }
                toast.success("Clip deleted successfully");
            } else {
                toast.error(`Failed to delete clip: ${result.error}`);
            }
        } catch (error) {
            console.error("Error deleting export:", error);
            toast.error("Failed to delete clip");
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
        <CardContent className="flex-grow overflow-auto px-4 pb-0">
            {isLoading ? null : exports.length === 0 ? (
                <div className="flex h-16 items-center justify-center">
                    <p className="text-muted-foreground text-sm">
                        No exports found for this video
                    </p>
                </div>
            ) : (
                <ScrollArea className="max-h-48 overflow-auto">
                    <div className="grid gap-2">
                        {exports.map((clip, index) => (
                            <div
                                key={index}
                                className={`bg-card hover:bg-accent/50 relative flex cursor-pointer justify-between rounded-md border p-2 transition-all ${selectedClipPath === clip.path ? "border-accent-positive" : ""}`}
                                onClick={() =>
                                    handleSelectClip(clip.path, clip.duration)
                                }
                            >
                                <div className="grid grid-cols-[auto_1fr_auto] gap-2">
                                    {clip.thumbnail ? (
                                        <div className="bg-muted h-14 w-24 overflow-hidden rounded">
                                            <img
                                                src={imgSrc(clip.thumbnail)}
                                                alt="Clip thumbnail"
                                                className="h-full w-full object-cover"
                                            />
                                        </div>
                                    ) : (
                                        <div className="bg-muted flex h-14 w-24 items-center justify-center rounded">
                                            <p className="text-muted-foreground text-xs">
                                                No thumbnail
                                            </p>
                                        </div>
                                    )}
                                    <div className="flex flex-col justify-center overflow-hidden">
                                        <p className="truncate text-sm font-medium">
                                            {clip.name}
                                        </p>
                                        <div className="text-muted-foreground flex gap-3 text-xs">
                                            <span>
                                                {formatTime(clip.duration)}
                                            </span>
                                            <span>
                                                {formatFileSize(clip.size)}
                                            </span>
                                            <span>
                                                {new Date(
                                                    clip.timestamp,
                                                ).toLocaleDateString()}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex h-6">
                                    {selectedClipPath === clip.path && (
                                        <Tooltip>
                                            <TooltipTrigger>
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
                                                >
                                                    <Undo2 className="h-4 w-4" />
                                                    <span className="sr-only">
                                                        Return to default video
                                                    </span>
                                                </Button>
                                            </TooltipTrigger>
                                            <TooltipContent>
                                                Return to default video
                                            </TooltipContent>
                                        </Tooltip>
                                    )}
                                    <Tooltip>
                                        <TooltipTrigger>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-6 w-6 p-0"
                                                onClick={(
                                                    e: React.MouseEvent,
                                                ) => {
                                                    e.stopPropagation();
                                                    handleDeleteExport(
                                                        clip.path,
                                                    );
                                                }}
                                                disabled={
                                                    isDeletingPath === clip.path
                                                }
                                            >
                                                <Trash2 className="text-destructive h-4 w-4" />
                                                <span className="sr-only">
                                                    Delete clip
                                                </span>
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            Delete clip
                                        </TooltipContent>
                                    </Tooltip>
                                </div>
                            </div>
                        ))}
                    </div>
                </ScrollArea>
            )}
        </CardContent>
    );
}
