import React, { useMemo } from "react";
import { useDragSelection } from "@/hooks/use-drag-selection";
import { useSelection } from "@/contexts/selection-context";
import { APP_CONFIG } from "@/config";

interface SelectionOverlayProps {
    containerRef: React.RefObject<HTMLElement | null>;
    customStyle?: Partial<SelectionOverlayStyle>;
}

interface SelectionOverlayStyle {
    border: {
        width: string;
        style: "solid" | "dashed" | "dotted";
        color: string;
    };
    background: {
        color: string;
    };
    borderRadius: string;
    zIndex: number;
}

export function SelectionOverlay({
    containerRef,
    customStyle,
}: SelectionOverlayProps) {
    const { getState } = useSelection();

    const { selectionBox } = useDragSelection({
        containerRef,
        onSelectionChange: (box) => {
            const state = getState();
            if (state.onSelectionChange) {
                state.onSelectionChange(box);
            }
        },
        onSelectionStart: () => {
            const state = getState();
            if (state.onSelectionStart) {
                state.onSelectionStart();
            }
        },
        onSelectionEnd: () => {
            const state = getState();
            if (state.onSelectionEnd) {
                state.onSelectionEnd();
            }
        },
        shouldStartSelecting: (target) => {
            const state = getState();
            if (!state.enabled) return false;
            const shouldStartSelecting = state.shouldStartSelecting
                ? state.shouldStartSelecting(target)
                : false;

            if (shouldStartSelecting) {
                if (window.getSelection) {
                    window.getSelection()?.removeAllRanges();
                }
            }
            return shouldStartSelecting;
        },
    });

    const overlayStyle = useMemo(() => {
        if (!selectionBox) return null;

        const container = containerRef.current;
        if (!container) return null;

        const containerRect = container.getBoundingClientRect();
        const viewportBox = {
            left: containerRect.left + selectionBox.left - container.scrollLeft,
            top: containerRect.top + selectionBox.top - container.scrollTop,
            width: selectionBox.width,
            height: selectionBox.height,
        };

        const defaultStyle = APP_CONFIG.selectionOverlay;
        const mergedStyle = {
            ...defaultStyle,
            ...customStyle,
        };

        return {
            position: "fixed" as const,
            left: viewportBox.left,
            top: viewportBox.top,
            width: viewportBox.width,
            height: viewportBox.height,
            border: `${mergedStyle.border.width} ${mergedStyle.border.style} ${mergedStyle.border.color}`,
            backgroundColor: mergedStyle.background.color,
            borderRadius: mergedStyle.borderRadius,
            pointerEvents: "none" as const,
            zIndex: mergedStyle.zIndex,
        };
    }, [selectionBox, containerRef, customStyle]);

    if (!selectionBox || !overlayStyle) return null;

    return <div style={overlayStyle} />;
}
