import { useCallback, useEffect, useRef, useState } from "react";
import { useSelection } from "@/contexts/selection-context";
import { useMainElement } from "@/layouts/base-layout";
import {
    boxesIntersect,
    getElementBox,
    isInteractive,
    useSelectionShortcuts,
} from "@/utils/selection";
import { SelectionBox } from "./use-drag-selection";
import { useSidebar } from "@/components/ui/sidebar";
import debounce from "lodash/debounce";
import { normalizeKeyInput, useSetting } from "@/utils/settings";

interface UsePageSelectionOptions<T> {
    items: T[];
    itemSelector?: string;
    getItemId?: (item: T, index: number) => string;
    onSelectionChange?: (selectedItems: T[]) => void;
    enableShortcuts?: boolean;
    cacheDeps?: unknown[];
}

export function usePageSelection<T>({
    items,
    itemSelector = ".selectable-item",
    getItemId = (item, index) => String(index),
    onSelectionChange,
    enableShortcuts = true,
    cacheDeps = [],
}: UsePageSelectionOptions<T>) {
    const {
        enableSelection,
        setOnSelectionChange,
        setShouldStartSelecting,
        setOnSelectionStart,
        setOnSelectionEnd,
        getState,
        isSelecting,
    } = useSelection();
    const { onAnimationComplete: onSidebarAnimationComplete } = useSidebar();

    const mainElementRef = useMainElement();
    const [selectedItems, setSelectedItems] = useState<T[]>([]);
    const [continueSelection, setContinueSelection] = useState(false);
    const [selectBetween, setSelectBetween] = useState(false);
    const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(
        null,
    );
    const boxesCacheRef = useRef<SelectionBox[]>([]);
    const lastSelectionRef = useRef<T[]>([]);
    const continueSelectionKey = useSetting("continueSelection");
    const selectBetweenKey = useSetting("selectBetween");

    // Enable keyboard shortcuts if requested
    useSelectionShortcuts(
        enableShortcuts ? items : [],
        selectedItems,
        setSelectedItems,
    );

    // Update boxes cache when items change
    const updateBoxesCache = useCallback(() => {
        const gridItems = document.querySelectorAll(itemSelector);
        boxesCacheRef.current = Array.from(gridItems).map((item) =>
            getElementBox(item, mainElementRef as React.RefObject<HTMLElement>),
        );
    }, [mainElementRef, items.length, itemSelector, ...cacheDeps]);

    useEffect(() => {
        updateBoxesCache();
    }, [mainElementRef, items.length, itemSelector, ...cacheDeps]);

    const debouncedUpdateBoxesCache = useRef(
        debounce(() => {
            updateBoxesCache();
        }, 10),
    ).current;

    useEffect(() => {
        updateBoxesCache();
        window.addEventListener("resize", updateBoxesCache);
        if (mainElementRef?.current) {
            mainElementRef.current.addEventListener("scroll", updateBoxesCache);
        }
        return () => {
            window.removeEventListener("resize", updateBoxesCache);
            if (mainElementRef?.current) {
                mainElementRef.current.removeEventListener(
                    "scroll",
                    updateBoxesCache,
                );
            }
        };
    }, [updateBoxesCache, mainElementRef]);

    useEffect(() => {
        const unsubscribe = onSidebarAnimationComplete(() => {
            debouncedUpdateBoxesCache();
        });
        return () => {
            unsubscribe?.();
            debouncedUpdateBoxesCache.cancel();
        };
    }, [onSidebarAnimationComplete, debouncedUpdateBoxesCache]);

    // Handle selection changes
    const handleSelectionChange = useCallback(
        (box: SelectionBox | null) => {
            if (!box) return;

            let itemsToSelect: T[] = [];
            boxesCacheRef.current.forEach((elementBox, index) => {
                if (boxesIntersect(box, elementBox) && items[index]) {
                    itemsToSelect.push(items[index]);
                }
            });

            // Merge with previous selection
            if (continueSelection) {
                const prev = lastSelectionRef.current;
                itemsToSelect = Array.from(
                    new Set([...prev, ...itemsToSelect]),
                );
            }

            const lastSelection = lastSelectionRef.current;
            const sortedNewSelection = itemsToSelect
                .map((item) => getItemId(item, items.indexOf(item)))
                .sort();
            const sortedLastSelection = lastSelection
                .map((item) => getItemId(item, items.indexOf(item)))
                .sort();

            if (
                sortedNewSelection.length !== sortedLastSelection.length ||
                !sortedNewSelection.every(
                    (item, index) => item === sortedLastSelection[index],
                )
            ) {
                lastSelectionRef.current = itemsToSelect;
                setSelectedItems(itemsToSelect);
                onSelectionChange?.(itemsToSelect);
            }
        },
        [items, getItemId, onSelectionChange, continueSelection],
    );

    const handleSelectionStart = useCallback(() => {
        if (!continueSelection) {
            lastSelectionRef.current = [];
        }
    }, [continueSelection]);

    const handleSelectionEnd = useCallback(() => {
        lastSelectionRef.current = selectedItems;
    }, [selectedItems]);

    const handleShouldStartSelecting = useCallback(
        (target: EventTarget, e?: MouseEvent) => {
            if (!(target instanceof HTMLElement)) return false;

            const container = mainElementRef?.current;
            if (!container) return false;
            if (!container.contains(target)) return false;

            let clientX: number | undefined, clientY: number | undefined;
            if (
                e &&
                typeof e.clientX === "number" &&
                typeof e.clientY === "number"
            ) {
                clientX = e.clientX;
                clientY = e.clientY;
            } else if (target instanceof HTMLElement) {
                const rect = target.getBoundingClientRect();
                clientX = rect.left + rect.width / 2;
                clientY = rect.top + rect.height / 2;
            }

            if (clientX === undefined || clientY === undefined) return false;

            return isInteractive(target);
        },
        [mainElementRef],
    );

    const handleBackgroundClick = useCallback(
        (e: MouseEvent) => {
            if (e.button !== 0) return; // Only handle left clicks
            const focusGuard = document.querySelector(
                "[data-radix-focus-guard]",
            );
            if (focusGuard) {
                return;
            }

            const state = getState();
            if (
                !state.isSelecting &&
                !continueSelection &&
                selectedItems.length > 0
            ) {
                setSelectedItems([]);
                onSelectionChange?.([]);
            }
        },
        [getState, onSelectionChange, continueSelection, selectedItems],
    );

    const handleKeyDown = useCallback(
        (e: KeyboardEvent) => {
            const key = normalizeKeyInput(e.key);
            if (key === continueSelectionKey) {
                setContinueSelection(true);
            }
            if (key === selectBetweenKey) {
                setSelectBetween(true);
            }
        },
        [continueSelectionKey, selectBetweenKey],
    );

    const handleKeyUp = useCallback(
        (e: KeyboardEvent) => {
            const key = normalizeKeyInput(e.key);
            if (key === continueSelectionKey) {
                setContinueSelection(false);
            }
            if (key === selectBetweenKey) {
                setSelectBetween(false);
            }
        },
        [continueSelectionKey, selectBetweenKey],
    );

    const selectRange = useCallback(
        (start: number, end: number) => {
            const [from, to] = [Math.min(start, end), Math.max(start, end)];
            const range = items.slice(from, to + 1);
            setSelectedItems(range);
            onSelectionChange?.(range);
        },
        [items, onSelectionChange],
    );

    const toggleItem = useCallback(
        (item: T) => {
            const index = items.indexOf(item);
            if (index === -1) return;

            if (selectBetween && lastSelectedIndex !== null) {
                selectRange(lastSelectedIndex, index);
            } else {
                setSelectedItems((prev) => {
                    const isSelected = prev.includes(item);
                    const newSelection = isSelected
                        ? prev.filter((i) => i !== item)
                        : [...prev, item];
                    onSelectionChange?.(newSelection);
                    return newSelection;
                });
                setLastSelectedIndex(index);
            }
        },
        [
            items,
            selectBetween,
            lastSelectedIndex,
            selectRange,
            onSelectionChange,
        ],
    );

    const selectItem = useCallback(
        (item: T) => {
            const index = items.indexOf(item);
            if (index === -1) return;

            if (selectBetween && lastSelectedIndex !== null) {
                selectRange(lastSelectedIndex, index);
            } else {
                setSelectedItems((prev) => {
                    if (prev.includes(item)) return prev;
                    const newSelection = [...prev, item];
                    onSelectionChange?.(newSelection);
                    return newSelection;
                });
                setLastSelectedIndex(index);
            }
        },
        [
            items,
            selectBetween,
            lastSelectedIndex,
            selectRange,
            onSelectionChange,
        ],
    );

    const deSelectItem = useCallback(
        (item: T) => {
            const index = items.indexOf(item);
            if (index === -1) return;

            if (selectBetween && lastSelectedIndex !== null) {
                const [from, to] = [
                    Math.min(lastSelectedIndex, index),
                    Math.max(lastSelectedIndex, index),
                ];
                setSelectedItems((prev) => {
                    const newSelection = prev.filter(
                        (_, i) => i < from || i > to,
                    );
                    onSelectionChange?.(newSelection);
                    return newSelection;
                });
            } else {
                setSelectedItems((prev) => {
                    if (!prev.includes(item)) return prev;
                    const newSelection = prev.filter((i) => i !== item);
                    onSelectionChange?.(newSelection);
                    return newSelection;
                });
                setLastSelectedIndex(index);
            }
        },
        [items, selectBetween, lastSelectedIndex, onSelectionChange],
    );

    // Setup selection
    useEffect(() => {
        enableSelection(true);
        setShouldStartSelecting(handleShouldStartSelecting);
        setOnSelectionChange(handleSelectionChange);
        setOnSelectionStart(handleSelectionStart);
        setOnSelectionEnd(handleSelectionEnd);

        window.addEventListener("mousedown", handleBackgroundClick);
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);

        return () => {
            enableSelection(false);
            setOnSelectionChange(undefined);
            setShouldStartSelecting(undefined);
            setOnSelectionStart(undefined);
            setOnSelectionEnd(undefined);
            window.removeEventListener("mousedown", handleBackgroundClick);
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
        };
    }, [
        enableSelection,
        setShouldStartSelecting,
        setOnSelectionChange,
        setOnSelectionStart,
        setOnSelectionEnd,
        handleSelectionChange,
        handleShouldStartSelecting,
        handleSelectionStart,
        handleSelectionEnd,
        handleBackgroundClick,
    ]);

    return {
        selectedItems,
        setSelectedItems,
        isItemSelected: useCallback(
            (item: T) => selectedItems.includes(item),
            [selectedItems],
        ),
        clearSelection: useCallback(() => {
            setSelectedItems([]);
            onSelectionChange?.([]);
        }, [onSelectionChange]),
        selectAll: useCallback(() => {
            setSelectedItems([...items]);
            onSelectionChange?.([...items]);
        }, [items, onSelectionChange]),
        selectItem,
        deSelectItem,
        toggleItem,
        selectRange,
        getState,
        isSelecting,
    };
}
