import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { bootMark } from "@/lib/bootstrap/boot-timing";

/**
 * Reveals the app window. Keeping it hidden until the first frame is ready is
 * the point: revealing it when the webview finishes loading paints the
 * pre-render document, and that document carries the light tokens because the
 * theme class only lands after settings load. Reveal failures (a window
 * destroyed during teardown, IPC gone) must not surface as unhandled
 * rejections, and environments without a Tauri window are a no-op.
 */
export function revealWindow(): void {
    if (!isTauri()) return;
    bootMark("window.reveal");
    getCurrentWindow()
        .show()
        .catch(() => undefined);
}
