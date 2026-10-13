import { useEffect } from "react";

import {
    insetBackdropClipPath,
    parsePx,
    type Rect,
    type TabBump,
} from "@/lib/backdrop/inset-backdrop-clip";
import { appStore } from "@/stores/app-store";

// Dialog backdrops blur only the body surface: the inset content area plus
// the active tab and its fillet wings, which read as one connected chrome
// piece. Titlebar and sidebar chrome around them stay unblurred.
const INSET_SELECTOR = '[data-slot="sidebar-inset"]';
const STRIP_SELECTOR = '[data-slot="tabs-strip"]';
// The history cluster changes width without a window resize when the update
// install button appears or disappears, shifting the tab bump; watching it
// keeps the clip path honest at that moment.
const TITLEBAR_HISTORY_SELECTOR = '[data-slot="titlebar-history"]';
const CORNER_SELECTOR = "[data-corner]";

const VAR_NAME = "--inset-backdrop-clip";
const COLLAPSED_VALUE = "inset(0px 100vw 100vh 0px)";
const PX_EPSILON = 1.5;

function readRect(element: Element): Rect {
    const box = element.getBoundingClientRect();
    return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
    };
}

function within(a: number, b: number): boolean {
    return Math.abs(a - b) <= PX_EPSILON;
}

function rectIsWing(wing: Rect): boolean {
    return wing.right > wing.left && wing.bottom > wing.top;
}

// Wing boxes sit 1px further out than the tab body (the `-1px` in the
// className), so shrink each by 1px toward the tab before tracing the slot.
function shrinkWingTowardTab(
    wing: Rect,
    side: "left" | "right",
    tabLeft: number,
    tabRight: number
): Rect {
    return side === "left"
        ? { ...wing, right: Math.min(wing.right, tabLeft) }
        : { ...wing, left: Math.max(wing.left, tabRight) };
}

function resolveTabBump(inset: Rect): TabBump | null {
    const activeTab = document.querySelector(
        '[data-slot="tabs-tab"][data-active]'
    );
    if (!activeTab) return null;
    const tab = readRect(activeTab);
    if (tab.bottom < inset.top - PX_EPSILON) return null;

    const leftWingBox = document.querySelector(
        `${CORNER_SELECTOR}[data-corner="bottom-left"]`
    );
    const rightWingBox = document.querySelector(
        `${CORNER_SELECTOR}[data-corner="bottom-right"]`
    );
    if (!leftWingBox || !rightWingBox) return null;

    const leftWing = shrinkWingTowardTab(
        readRect(leftWingBox),
        "left",
        tab.left,
        tab.right
    );
    const rightWing = shrinkWingTowardTab(
        readRect(rightWingBox),
        "right",
        tab.left,
        tab.right
    );
    if (!rectIsWing(leftWing) || !rectIsWing(rightWing)) return null;

    const styles = getComputedStyle(activeTab);
    const radius = parsePx(styles.borderTopLeftRadius);
    // The tab bottom must sit flush on the inset top edge; the wings must
    // flank the tab without overlapping it. Anything else falls back to the
    // plain inset outline rather than tracing a wrong shape.
    const flush =
        within(tab.bottom, inset.top) &&
        within(leftWing.bottom, inset.top) &&
        within(rightWing.bottom, inset.top) &&
        leftWing.right <= tab.left + PX_EPSILON &&
        rightWing.left >= tab.right - PX_EPSILON;
    if (!flush) return null;

    return {
        left: tab.left,
        right: tab.right,
        top: tab.top,
        radius,
        leftWing,
        rightWing,
    };
}

export function useInsetBackdropClip(): void {
    useEffect(() => {
        const inset = document.querySelector(INSET_SELECTOR);
        if (!inset) return;

        let frame = 0;
        // Store subscriptions fire before React commits the DOM change, so
        // measure on the frames after the new active tab has rendered.
        const scheduleUpdate = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                frame = requestAnimationFrame(update);
            });
        };

        const update = () => {
            const rect = readRect(inset);
            if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) {
                document.documentElement.style.setProperty(
                    VAR_NAME,
                    COLLAPSED_VALUE
                );
                return;
            }
            const insetRadius = parsePx(
                getComputedStyle(inset).borderTopLeftRadius
            );
            const bump = resolveTabBump(rect);
            const path = insetBackdropClipPath(rect, insetRadius, bump);
            document.documentElement.style.setProperty(
                VAR_NAME,
                `path('${path}')`
            );
        };

        update();
        const observer = new ResizeObserver(scheduleUpdate);
        observer.observe(inset);
        const strip = document.querySelector(STRIP_SELECTOR);
        if (strip) observer.observe(strip);
        const history = document.querySelector(TITLEBAR_HISTORY_SELECTOR);
        if (history) observer.observe(history);
        window.addEventListener("resize", scheduleUpdate);
        let prevActiveTabId = appStore.state.activeTabId;
        const unsubscribe = appStore.subscribe((state) => {
            if (state.activeTabId !== prevActiveTabId) {
                prevActiveTabId = state.activeTabId;
                scheduleUpdate();
            }
        });
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            window.removeEventListener("resize", scheduleUpdate);
            unsubscribe.unsubscribe();
            document.documentElement.style.removeProperty(VAR_NAME);
        };
    }, []);
}
