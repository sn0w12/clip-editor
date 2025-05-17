import { useShortcut } from "@/hooks/use-shortcut";
import { VideoFile } from "@/types/video";
import { useSetting } from "@/utils/settings";
import { Dispatch, SetStateAction } from "react";

export function isInteractive(target: HTMLElement): boolean {
    if (!target) return false;
    return !target.closest(
        'button, [role="button"], a, input, select, p, h1, h2, h3, h4, h5, h6, textarea, [contenteditable="true"]',
    );
}

type SelectionShortcutOptions = {
    preventDefault?: boolean;
};

export function useSelectionShortcuts<T>(
    items: T[],
    selectedItems: T[],
    setSelectedItems: Dispatch<SetStateAction<T[]>>,
    options: SelectionShortcutOptions = { preventDefault: true },
) {
    // Select all items
    useShortcut(
        useSetting("selectAll"),
        () => {
            setSelectedItems([...items]);
        },
        options,
    );

    // Clear selection
    useShortcut(
        useSetting("selectNone"),
        () => {
            setSelectedItems([]);
        },
        options,
    );

    // Invert selection
    useShortcut(
        useSetting("selectInvert"),
        () => {
            const newSelectedItems = items.filter(
                (item) => !selectedItems.includes(item),
            );
            setSelectedItems(newSelectedItems);
        },
        options,
    );
}

/**
 * Updates the positions of selectable items in the DOM
 * and returns a mapping of video paths to their positions
 */
export function getItemPositions(filteredVideos: VideoFile[]): DOMRect[] {
    // Create a map of video paths to their indices for accurate tracking
    const pathToIndexMap = new Map(
        filteredVideos.map((video, index) => [video.path, index]),
    );

    // Get all items with the selectable-item class
    const items = document.querySelectorAll(".selectable-item");

    // Create an array of the same length as filteredVideos
    const positions: DOMRect[] = new Array(filteredVideos.length);

    // For each DOM element, get its rect and store it at the correct index
    Array.from(items).forEach((item) => {
        const rect = item.getBoundingClientRect();
        const path = item.getAttribute("data-video-path");
        if (path && pathToIndexMap.has(path)) {
            positions[pathToIndexMap.get(path)!] = rect;
        }
    });

    return positions;
}
