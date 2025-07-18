import { ShortcutOptions } from "@/hooks/use-shortcut";
import { useShortcutSetting } from "@/utils/settings";
import { Dispatch, SetStateAction } from "react";
import { SelectionBox } from "@/hooks/use-drag-selection";

export function isInteractive(target: HTMLElement): boolean {
    if (!target) return false;
    return !target.closest(
        'button, [role="button"], a, input, select, p, h1, h2, h3, h4, h5, h6, textarea, [contenteditable="true"]',
    );
}

export function useSelectionShortcuts<T>(
    items: T[],
    selectedItems: T[],
    setSelectedItems: Dispatch<SetStateAction<T[]>>,
    options: ShortcutOptions = { preventDefault: true },
) {
    // Select all items
    useShortcutSetting(
        "selectAll",
        () => {
            setSelectedItems([...items]);
        },
        options,
    );

    // Clear selection
    useShortcutSetting(
        "selectNone",
        () => {
            setSelectedItems([]);
        },
        options,
    );

    // Invert selection
    useShortcutSetting(
        "selectInvert",
        () => {
            const newSelectedItems = items.filter(
                (item) => !selectedItems.includes(item),
            );
            setSelectedItems(newSelectedItems);
        },
        options,
    );
}

export function boxesIntersect(
    box1: SelectionBox,
    box2: (DOMRect | null) | SelectionBox,
): boolean {
    if (!box2) return false;

    return !(
        box1.right < box2.left ||
        box1.left > box2.right ||
        box1.bottom < box2.top ||
        box1.top > box2.bottom
    );
}

export function getElementBox(
    element: Element,
    containerRef: React.RefObject<HTMLElement>,
): SelectionBox {
    const rect = element.getBoundingClientRect();
    const container = containerRef.current;

    let box: SelectionBox;

    if (!container) {
        box = {
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
        };
    } else {
        const containerRect = container.getBoundingClientRect();
        box = {
            left: rect.left - containerRect.left + container.scrollLeft,
            top: rect.top - containerRect.top + container.scrollTop,
            right: rect.right - containerRect.left + container.scrollLeft,
            bottom: rect.bottom - containerRect.top + container.scrollTop,
            width: rect.width,
            height: rect.height,
        };
    }

    return box;
}
