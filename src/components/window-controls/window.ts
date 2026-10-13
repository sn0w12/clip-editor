import { PhysicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { detectPlatform } from "./platform";

export interface WindowControlsApi {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    unmaximize: () => Promise<void>;
    close: () => Promise<void>;
    fullscreen: () => Promise<void>;
    startDrag: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizedChange: (
        cb: (maximized: boolean) => void
    ) => Promise<() => void>;
}

const noop = async () => {};

function createNoopControls(): WindowControlsApi {
    return {
        minimize: noop,
        maximize: noop,
        unmaximize: noop,
        close: noop,
        fullscreen: noop,
        startDrag: noop,
        isMaximized: async () => false,
        onMaximizedChange: async () => () => {},
    };
}

// Tauri v2 has no isSimpleFullscreen() getter, track it locally.
let simpleFullscreenActive = false;

// Shared maximized state, single listener for all control instances.
const subscribers = new Set<(maximized: boolean) => void>();
let currentMaximized: boolean | undefined;
let listenerActive = false;
let unlistenFocus: (() => void) | undefined;
let unlistenResized: (() => void) | undefined;
let resizeDebounce: ReturnType<typeof setTimeout> | undefined;

function notifySubscribers(maximized: boolean) {
    if (maximized === currentMaximized) return;
    currentMaximized = maximized;
    for (const cb of subscribers) {
        cb(maximized);
    }
}

async function refreshMaximized() {
    try {
        notifySubscribers(await getCurrentWindow().isMaximized());
    } catch {
        // Window gone, keep last known state.
    }
}

async function ensureListener() {
    if (listenerActive) return;
    listenerActive = true;

    try {
        const win = getCurrentWindow();
        notifySubscribers(await win.isMaximized());

        // onFocusChanged instead of onResized avoids IPC storms during animations.
        unlistenFocus = await win.onFocusChanged(
            async ({ payload: focused }) => {
                if (focused) {
                    await refreshMaximized();
                }
            }
        );

        // Debounced so drag-resizes settle into one query; without this,
        // OS-level maximizes (Win+Up, taskbar, titlebar double-click)
        // never reach subscribers because focus never changes.
        unlistenResized = await win.onResized(() => {
            clearTimeout(resizeDebounce);
            resizeDebounce = setTimeout(() => void refreshMaximized(), 120);
        });
    } catch {
        listenerActive = false;
    }
}

function teardownListener() {
    if (unlistenFocus) {
        unlistenFocus();
        unlistenFocus = undefined;
    }
    if (unlistenResized) {
        unlistenResized();
        unlistenResized = undefined;
    }
    clearTimeout(resizeDebounce);
    listenerActive = false;
    currentMaximized = undefined;
}

function subscribe(cb: (maximized: boolean) => void): () => void {
    subscribers.add(cb);
    if (currentMaximized !== undefined) {
        cb(currentMaximized);
    }
    void ensureListener();

    return () => {
        subscribers.delete(cb);
        if (subscribers.size === 0) {
            teardownListener();
        }
    };
}

export function createWindowControls(): WindowControlsApi {
    try {
        const win = getCurrentWindow();

        return {
            minimize: () => win.minimize(),
            maximize: async () => {
                // The 1px resize below only makes sense on macOS, where it
                // re-registers WKWebView tracking areas after the zoom
                // animation. Elsewhere issue an explicit maximize: toggle
                // would undo itself on a double-click or an impatient
                // second click, which reads as "instantly un-maximizes".
                if (detectPlatform() !== "macos") {
                    await win.maximize();
                    await refreshMaximized();
                    return;
                }

                let unlisten: (() => void) | undefined;
                let debounce: ReturnType<typeof setTimeout> | undefined;
                let finished = false;

                const finish = async () => {
                    if (finished) return;
                    finished = true;
                    unlisten?.();
                    clearTimeout(debounce);
                    clearTimeout(safety);
                    try {
                        // After zoom animation WKWebView tracking areas cover old
                        // bounds, so a 1px resize re-registers them for the new
                        // bounds and restores hover/mouse events.
                        const size = await win.outerSize();
                        await win.setSize(
                            new PhysicalSize(size.width + 1, size.height)
                        );
                        await win.setSize(
                            new PhysicalSize(size.width, size.height)
                        );
                        const maximized = await win.isMaximized();
                        notifySubscribers(maximized);
                    } catch {
                        // Window closed mid-animation, nothing to update.
                    }
                };

                unlisten = await win.onResized(() => {
                    clearTimeout(debounce);
                    debounce = setTimeout(() => void finish(), 50);
                });

                const safety = setTimeout(() => void finish(), 600);

                await win.toggleMaximize();
            },
            close: () => win.close(),
            unmaximize: async () => {
                await win.unmaximize();
                await refreshMaximized();
            },
            fullscreen: async () => {
                if (detectPlatform() === "macos") {
                    // isFullscreen() is false in simple fullscreen, so it
                    // cannot be used as the toggle source here.
                    simpleFullscreenActive = !simpleFullscreenActive;
                    await win.setSimpleFullscreen(simpleFullscreenActive);
                } else {
                    const isFs = await win.isFullscreen();
                    await win.setFullscreen(!isFs);
                }
            },
            startDrag: () => win.startDragging(),
            isMaximized: () => win.isMaximized(),
            onMaximizedChange: async (cb) => subscribe(cb),
        };
    } catch {
        return createNoopControls();
    }
}
