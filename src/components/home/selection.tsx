import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import { useShortcutSetting } from "@/lib/settings";

interface Box {
    x: number;
    y: number;
    w: number;
    h: number;
}

const SELECTABLE_ELEMENTS = [
    "button",
    "a",
    "input",
    "textarea",
    "select",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "label",
    "p",
    "span",
    "[role='button']",
];

export function useDragSelection<T>(
    items: T[],
    getItemId: (item: T) => string,
    containerRef: RefObject<HTMLElement | null>,
    onSelectionChange?: (selected: Set<string>) => void,
) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [box, setBox] = useState<Box | null>(null);
    const [isSelecting, setIsSelecting] = useState(false);
    const startRef = useRef<{
        x: number;
        y: number;
        ctrl: boolean;
        shift: boolean;
    } | null>(null);
    const lastIndexRef = useRef(-1);
    const selectedRef = useRef(selected);
    const boxRef = useRef<Box | null>(null);
    // Pending drag state, flushed once per animation frame so a fast mouse can
    // never re-render the grid more than once per frame.
    const pendingBoxRef = useRef<Box | null>(null);
    const pendingSelectionRef = useRef<Set<string> | null>(null);
    const rafIdRef = useRef<number | null>(null);

    // Keep latest-value refs in sync outside of render (only read in handlers).
    useEffect(() => {
        selectedRef.current = selected;
    }, [selected]);
    useEffect(() => {
        boxRef.current = box;
    }, [box]);

    const setSelection = useCallback(
        (next: Set<string>) => {
            setSelected(next);
            onSelectionChange?.(next);
        },
        [onSelectionChange],
    );

    const handleMouseDown = useCallback((e: MouseEvent) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest(".selectable-item")) return;
        if (target.closest(SELECTABLE_ELEMENTS.join(", "))) return;
        // The listener is attached to the container, so `currentTarget` is it.
        const containerRect = (e.currentTarget as HTMLElement | null)?.getBoundingClientRect();
        // The start point is stored container-relative so the selection stays
        // anchored to the content even when the container scrolls mid-drag.
        const x = e.clientX - (containerRect?.left ?? 0);
        const y = e.clientY - (containerRect?.top ?? 0);
        startRef.current = {
            x,
            y,
            ctrl: e.ctrlKey || e.metaKey,
            shift: e.shiftKey,
        };
        setBox({ x, y, w: 0, h: 0 });
        setIsSelecting(true);
    }, []);

    useEffect(() => {
        document.body.style.userSelect = isSelecting ? "none" : "";
        return () => {
            document.body.style.userSelect = "";
        };
    }, [isSelecting]);

    useEffect(() => {
        if (!isSelecting) return;
        const container = containerRef.current;
        if (!container) return;

        // Cache each card's container-relative rect once at drag start. The
        // whole container moves with ancestor scrolls, so these stay valid for
        // the duration of the drag — no per-move DOM queries or layout reads.
        const containerRect = container.getBoundingClientRect();
        const elementRects = Array.from(
            container.querySelectorAll<HTMLElement>(".selectable-item"),
        ).map((el) => {
            const r = el.getBoundingClientRect();
            return {
                left: r.left - containerRect.left,
                top: r.top - containerRect.top,
                right: r.right - containerRect.left,
                bottom: r.bottom - containerRect.top,
            };
        });

        const flush = () => {
            rafIdRef.current = null;
            if (pendingBoxRef.current !== null) {
                setBox(pendingBoxRef.current);
                pendingBoxRef.current = null;
            }
            if (pendingSelectionRef.current !== null) {
                setSelection(pendingSelectionRef.current);
                pendingSelectionRef.current = null;
            }
        };

        const handleMove = (e: MouseEvent) => {
            const start = startRef.current;
            if (!start) return;
            // Fresh container rect so the selection tracks the cursor while the
            // container scrolls mid-drag.
            const rect = container.getBoundingClientRect();
            const curX = e.clientX - rect.left;
            const curY = e.clientY - rect.top;
            const box = {
                x: Math.min(start.x, curX),
                y: Math.min(start.y, curY),
                w: Math.abs(curX - start.x),
                h: Math.abs(curY - start.y),
            };
            boxRef.current = box;
            pendingBoxRef.current = box;

            if (box.w >= 4 && box.h >= 4) {
                const dragRect = {
                    left: box.x,
                    top: box.y,
                    right: box.x + box.w,
                    bottom: box.y + box.h,
                };
                const hit: string[] = [];
                let lastHit = -1;
                elementRects.forEach((r, index) => {
                    const intersects =
                        r.left < dragRect.right &&
                        r.right > dragRect.left &&
                        r.top < dragRect.bottom &&
                        r.bottom > dragRect.top;
                    if (intersects) {
                        const id = getItemId(items[index]);
                        if (id) {
                            hit.push(id);
                            lastHit = index;
                        }
                    }
                });

                const prev = start.shift ? selectedRef.current : new Set<string>();
                if (start.shift && lastHit >= 0 && lastIndexRef.current >= 0) {
                    const [from, to] = [
                        Math.min(lastIndexRef.current, lastHit),
                        Math.max(lastIndexRef.current, lastHit),
                    ];
                    for (let i = from; i <= to; i++) {
                        const id = getItemId(items[i]);
                        if (id) prev.add(id);
                    }
                }
                for (const id of hit) {
                    if (start.ctrl) prev.delete(id);
                    else prev.add(id);
                }
                lastIndexRef.current = lastHit;
                // Keep the ref current so the next move accumulates correctly;
                // the state update is deferred to the rAF flush.
                selectedRef.current = prev;
                pendingSelectionRef.current = prev;
            }

            if (rafIdRef.current === null) {
                rafIdRef.current = requestAnimationFrame(flush);
            }
        };

        const handleUp = () => {
            if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = null;
                flush();
            }
            const start = startRef.current;
            const box = boxRef.current;
            setIsSelecting(false);
            setBox(null);
            startRef.current = null;
            if (start && box && box.w < 4 && box.h < 4 && !start.ctrl && !start.shift) {
                setSelection(new Set());
            }
        };

        window.addEventListener("mousemove", handleMove);
        window.addEventListener("mouseup", handleUp);
        return () => {
            window.removeEventListener("mousemove", handleMove);
            window.removeEventListener("mouseup", handleUp);
            if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = null;
            }
        };
    }, [isSelecting, containerRef, items, getItemId, setSelection]);

    const selectAll = useCallback(() => {
        setSelection(new Set(items.map(getItemId)));
    }, [items, getItemId, setSelection]);

    const selectNone = useCallback(() => {
        setSelection(new Set());
    }, [setSelection]);

    const selectInvert = useCallback(() => {
        const all = new Set(items.map(getItemId));
        const next = new Set<string>();
        for (const id of all) if (!selectedRef.current.has(id)) next.add(id);
        setSelection(next);
    }, [items, getItemId, setSelection]);

    useShortcutSetting("selectAll", selectAll);
    useShortcutSetting("selectNone", selectNone);
    useShortcutSetting("selectInvert", selectInvert);

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            selectNone();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [selectNone]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;
        container.addEventListener("mousedown", handleMouseDown);
        return () => container.removeEventListener("mousedown", handleMouseDown);
    }, [containerRef, handleMouseDown, items]);

    return useMemo(
        () => ({
            selected,
            box,
            isSelecting,
            clear: () => setSelection(new Set()),
        }),
        [selected, box, isSelecting, setSelection],
    );
}

export function SelectionOverlay({ box }: { box: Box | null }) {
    if (!box) return null;
    return (
        <div
            className="pointer-events-none absolute z-50"
            style={{
                left: box.x,
                top: box.y,
                width: box.w,
                height: box.h,
                border: "2px dashed var(--primary)",
                background: "color-mix(in srgb, var(--primary) 10%, transparent)",
                borderRadius: "0.5rem",
            }}
        />
    );
}
