import { useSidebar } from "@/components/ui/sidebar";
import React, { useCallback, useRef, useState } from "react";

export interface SelectionBox {
    top: number;
    left: number;
    width: number;
    height: number;
    right: number;
    bottom: number;
}

interface UseDragSelectionOptions {
    onSelectionChange?: (box: SelectionBox | null) => void;
    onSelectionStart?: () => void;
    onSelectionEnd?: () => void;
    shouldStartSelecting?: (target: EventTarget) => boolean;
    containerRef: React.RefObject<HTMLElement | null>;
}

const DRAG_THRESHOLD = 2;

export function useDragSelection({
    onSelectionChange,
    onSelectionStart,
    onSelectionEnd,
    shouldStartSelecting,
    containerRef,
}: UseDragSelectionOptions) {
    const isSelectingRef = useRef(false);
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const startPos = useRef<{ x: number; y: number } | null>(null);
    const containerRectRef = useRef<DOMRect | null>(null);
    const lastSelectionHash = useRef<string>("");
    const lastMousePos = useRef<{ x: number; y: number } | null>(null);
    const animationFrameRef = useRef<number | null>(null);
    const isAnimatingRef = useRef(false);
    const {
        state: sidebarState,
        onAnimationComplete: onSidebarAnimationComplete,
    } = useSidebar();

    const getRelativePosition = useCallback(
        (clientX: number, clientY: number) => {
            const container = containerRef.current;
            if (!container || !containerRectRef.current) return { x: 0, y: 0 };

            return {
                x:
                    clientX -
                    containerRectRef.current.left +
                    container.scrollLeft,
                y: clientY - containerRectRef.current.top + container.scrollTop,
            };
        },
        [containerRef],
    );

    const updateSelectionBox = useCallback(
        (clientX: number, clientY: number) => {
            lastMousePos.current = { x: clientX, y: clientY }; // Track last mouse position

            if (!startPos.current) return;

            const currentPos = getRelativePosition(clientX, clientY);

            const left = Math.min(startPos.current.x, currentPos.x);
            const top = Math.min(startPos.current.y, currentPos.y);
            const right = Math.max(startPos.current.x, currentPos.x);
            const bottom = Math.max(startPos.current.y, currentPos.y);

            const box: SelectionBox = {
                left,
                top,
                width: right - left,
                height: bottom - top,
                right,
                bottom,
            };

            // Create a hash to avoid unnecessary updates
            const boxHash = `${box.left}-${box.top}-${box.width}-${box.height}`;
            if (boxHash !== lastSelectionHash.current) {
                lastSelectionHash.current = boxHash;
                setSelectionBox(box);
                onSelectionChange?.(box);
            }
        },
        [getRelativePosition, onSelectionChange],
    );

    const updateContainerRect = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;

        const oldRect = containerRectRef.current;
        const newRect = container.getBoundingClientRect();

        // If we're currently selecting and the container rect changed, adjust the start position
        if (isSelectingRef.current && oldRect && startPos.current) {
            const deltaX = newRect.left - oldRect.left;
            const deltaY = newRect.top - oldRect.top;

            // Adjust start position to compensate for container movement
            startPos.current = {
                x: startPos.current.x - deltaX,
                y: startPos.current.y - deltaY,
            };
        }

        containerRectRef.current = newRect;

        // Update selection box with current mouse position if we're selecting
        if (isSelectingRef.current && lastMousePos.current) {
            updateSelectionBox(lastMousePos.current.x, lastMousePos.current.y);
        }
    }, [containerRef, updateSelectionBox]);

    const handleMouseDown = useCallback(
        (e: MouseEvent) => {
            if (e.button !== 0) return;

            if (
                shouldStartSelecting &&
                !shouldStartSelecting(e.target as EventTarget)
            ) {
                return;
            }

            e.preventDefault();

            const container = containerRef.current;
            if (!container) return;

            // Cache container rect for performance
            containerRectRef.current = container.getBoundingClientRect();

            const pos = getRelativePosition(e.clientX, e.clientY);
            startPos.current = pos;

            // Clear any existing text selection
            if (window.getSelection) {
                window.getSelection()?.removeAllRanges();
            }
        },
        [shouldStartSelecting, containerRef, getRelativePosition],
    );

    const handleMouseMove = useCallback(
        (e: MouseEvent) => {
            if (!startPos.current) return;
            if (!isSelectingRef.current) {
                const currentPos = getRelativePosition(e.clientX, e.clientY);
                const dx = currentPos.x - startPos.current.x;
                const dy = currentPos.y - startPos.current.y;
                if (
                    Math.abs(dx) < DRAG_THRESHOLD &&
                    Math.abs(dy) < DRAG_THRESHOLD
                ) {
                    return;
                }
                isSelectingRef.current = true;
                onSelectionStart?.();
            }

            updateSelectionBox(e.clientX, e.clientY);
        },
        [getRelativePosition, updateSelectionBox, onSelectionStart],
    );

    const handleMouseUp = useCallback(
        (e: MouseEvent) => {
            if (e.button !== 0) return;

            setSelectionBox(null);
            onSelectionEnd?.();
            onSelectionChange?.(null);

            isSelectingRef.current = false;
            startPos.current = null;
            containerRectRef.current = null;
            lastSelectionHash.current = "";
        },
        [onSelectionEnd, onSelectionChange],
    );

    const handleScroll = useCallback(() => {
        if (!isSelectingRef.current) return;

        if (lastMousePos.current) {
            updateSelectionBox(lastMousePos.current.x, lastMousePos.current.y);
        }
    }, [updateSelectionBox]);

    React.useEffect(() => {
        const container = containerRef.current;
        document.addEventListener("mousedown", handleMouseDown);
        document.addEventListener("mousemove", handleMouseMove);
        document.addEventListener("mouseup", handleMouseUp);
        window.addEventListener("resize", updateContainerRect);

        if (container) {
            container.addEventListener("scroll", handleScroll);
        }

        return () => {
            document.removeEventListener("mousedown", handleMouseDown);
            document.removeEventListener("mousemove", handleMouseMove);
            document.removeEventListener("mouseup", handleMouseUp);
            window.removeEventListener("resize", updateContainerRect);
            if (container) {
                container.removeEventListener("scroll", handleScroll);
            }
        };
    }, [
        handleMouseDown,
        handleMouseMove,
        handleMouseUp,
        handleScroll,
        containerRef,
    ]);

    const startAnimationFrameLoop = useCallback(() => {
        if (isAnimatingRef.current) return;

        isAnimatingRef.current = true;

        const loop = () => {
            if (!isAnimatingRef.current) return;

            updateContainerRect();
            animationFrameRef.current = requestAnimationFrame(loop);
        };

        loop();
    }, [updateContainerRect]);

    const stopAnimationFrameLoop = useCallback(() => {
        isAnimatingRef.current = false;
        if (animationFrameRef.current) {
            cancelAnimationFrame(animationFrameRef.current);
            animationFrameRef.current = null;
        }
    }, []);

    React.useEffect(() => {
        startAnimationFrameLoop();
    }, [sidebarState, startAnimationFrameLoop]);

    onSidebarAnimationComplete(() => {
        stopAnimationFrameLoop();
        updateContainerRect();
    });

    return {
        isSelecting: isSelectingRef.current,
        selectionBox,
    };
}
