import React, { useMemo } from "react";
import { usePageSelection } from "@/hooks/use-page-selection";

interface SelectionContainerProps<T> {
    items: T[];
    children: React.ComponentType<{
        selectedItems: T[];
        isSelecting: () => boolean;
        isItemSelected: (item: T) => boolean;
        clearSelection: () => void;
        selectAll: () => void;
        selectItem: (item: T) => void;
        deSelectItem: (item: T) => void;
        toggleItem: (item: T) => void;
    }>;
    itemSelector?: string;
    getItemId?: (item: T, index: number) => string;
    onSelectionChange?: (selectedItems: T[]) => void;
    enableShortcuts?: boolean;
}

export function SelectionContainer<T>({
    items,
    children: ChildComponent,
    itemSelector,
    getItemId,
    onSelectionChange,
    enableShortcuts,
}: SelectionContainerProps<T>) {
    const {
        selectedItems,
        isItemSelected,
        clearSelection,
        selectAll,
        selectItem,
        deSelectItem,
        toggleItem,
        isSelecting,
    } = usePageSelection({
        items,
        itemSelector,
        getItemId,
        onSelectionChange,
        enableShortcuts,
    });

    const selectionProps = useMemo(
        () => ({
            selectedItems,
            isSelecting,
            isItemSelected,
            clearSelection,
            selectAll,
            selectItem,
            deSelectItem,
            toggleItem,
        }),
        [
            selectedItems,
            isSelecting,
            isItemSelected,
            clearSelection,
            selectAll,
            selectItem,
            deSelectItem,
            toggleItem,
        ],
    );

    return React.createElement(ChildComponent, selectionProps);
}
