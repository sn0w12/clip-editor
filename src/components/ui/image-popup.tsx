import React, { useState, useEffect } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogClose,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import * as VisuallyHidden from "@radix-ui/react-visually-hidden";
import { toast } from "sonner";
import { tagHandler } from "@/helpers/tags";

interface ImagePopupProps {
    imageUrl: string;
    imageName: string;
    tags?: string[];
    score?: string | null;
    isOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    trigger?: (props: { onClick: () => void }) => React.ReactNode;
}

export function ImagePopup({
    imageUrl,
    imageName,
    tags = [],
    score,
    isOpen: propIsOpen,
    onOpenChange: propOnOpenChange,
    trigger,
}: ImagePopupProps) {
    const [internalIsOpen, setInternalIsOpen] = useState(false);
    const [categorizedTags, setCategorizedTags] = useState<
        Record<string, string[]>
    >({});

    // Use either props or internal state
    const isControlled =
        propIsOpen !== undefined && propOnOpenChange !== undefined;
    const isOpen = isControlled ? propIsOpen : internalIsOpen;

    const onOpenChange = (open: boolean) => {
        if (isControlled) {
            propOnOpenChange!(open);
        } else {
            setInternalIsOpen(open);
        }
    };

    const preventDrag = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
    };

    useEffect(() => {
        if (tags.length > 0) {
            const tagTypes = tagHandler.splitTagsByCategory(tags);
            setCategorizedTags(tagTypes);
        }
    }, [tags]);

    const descriptionId = `image-popup-description-${imageName.replace(/\s+/g, "-")}`;

    return (
        <>
            {trigger && trigger({ onClick: () => onOpenChange(true) })}

            <Dialog open={isOpen} onOpenChange={onOpenChange}>
                <DialogContent className="max-h-[90vh] max-w-[90vw] overflow-hidden p-0">
                    <DialogDescription id={descriptionId} className="sr-only">
                        Full view of {imageName} image
                    </DialogDescription>

                    <ScrollArea className="max-h-[90vh] w-full">
                        <DialogHeader className="absolute top-0 right-0 z-10 p-2">
                            <VisuallyHidden.Root>
                                <DialogTitle>Image: {imageName}</DialogTitle>
                            </VisuallyHidden.Root>
                            <DialogClose asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="bg-background/80 h-8 w-8 rounded-full"
                                >
                                    <X className="h-4 w-4" />
                                </Button>
                            </DialogClose>
                        </DialogHeader>
                        <div className="flex h-full flex-col">
                            <div className="relative flex-1 overflow-auto">
                                <img
                                    src={imageUrl + "?full=true"}
                                    alt={imageName}
                                    className="h-auto w-full object-contain"
                                    onDragStart={preventDrag}
                                />
                            </div>
                            {(tags.length > 0 || score) && (
                                <div className="bg-background border-t p-4">
                                    <div className="mb-2 flex flex-row items-center justify-between">
                                        <h3 className="font-medium">
                                            {imageName}
                                        </h3>
                                    </div>
                                    {score && (
                                        <div className="mb-2 flex flex-row items-center gap-2">
                                            <div>
                                                <span className="text-muted-foreground">
                                                    Score:
                                                </span>
                                                {score}
                                            </div>
                                        </div>
                                    )}
                                    {tags.length > 0 && (
                                        <>
                                            {Object.entries(categorizedTags)
                                                .length > 0 ? (
                                                <div className="space-y-3">
                                                    {Object.entries(
                                                        categorizedTags,
                                                    ).map(
                                                        ([
                                                            category,
                                                            categoryTags,
                                                        ]) =>
                                                            categoryTags.length >
                                                                0 && (
                                                                <div
                                                                    key={
                                                                        category
                                                                    }
                                                                >
                                                                    <div className="mb-1 flex items-center justify-between">
                                                                        <h4 className="text-muted-foreground text-sm font-medium capitalize">
                                                                            {
                                                                                category
                                                                            }
                                                                        </h4>
                                                                        <Button
                                                                            variant="ghost"
                                                                            size="sm"
                                                                            onClick={() => {
                                                                                navigator.clipboard.writeText(
                                                                                    categoryTags.join(
                                                                                        ", ",
                                                                                    ),
                                                                                );
                                                                                toast(
                                                                                    `${category} tags copied to clipboard`,
                                                                                );
                                                                            }}
                                                                            className="h-6 px-2"
                                                                        >
                                                                            <span className="text-muted-foreground text-xs">
                                                                                Copy
                                                                            </span>
                                                                        </Button>
                                                                    </div>
                                                                    <div className="flex flex-wrap gap-1">
                                                                        {categoryTags.map(
                                                                            (
                                                                                tag,
                                                                            ) => (
                                                                                <span
                                                                                    key={
                                                                                        tag
                                                                                    }
                                                                                    className="bg-secondary text-secondary-foreground rounded px-2 py-1 text-xs"
                                                                                >
                                                                                    {
                                                                                        tag
                                                                                    }
                                                                                </span>
                                                                            ),
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            ),
                                                    )}
                                                </div>
                                            ) : (
                                                <div>
                                                    <div className="mb-1 flex items-center justify-between">
                                                        <h4 className="text-muted-foreground text-sm font-medium">
                                                            All Tags
                                                        </h4>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() => {
                                                                navigator.clipboard.writeText(
                                                                    tags.join(
                                                                        ", ",
                                                                    ),
                                                                );
                                                                toast(
                                                                    "Tags copied to clipboard",
                                                                );
                                                            }}
                                                            className="h-6 px-2"
                                                        >
                                                            <span className="text-muted-foreground text-xs">
                                                                Copy
                                                            </span>
                                                        </Button>
                                                    </div>
                                                    <div className="flex flex-wrap gap-1">
                                                        {tags.map((tag) => (
                                                            <span
                                                                key={tag}
                                                                className="bg-secondary text-secondary-foreground rounded px-2 py-1 text-xs"
                                                            >
                                                                {tag}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                </DialogContent>
            </Dialog>
        </>
    );
}
