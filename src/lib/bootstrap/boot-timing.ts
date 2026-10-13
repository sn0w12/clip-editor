import { info } from "@tauri-apps/plugin-log";

const BOOT_START = performance.now();

/** Emits a boot-phase timing line into the app log, relative to module eval. */
export function bootMark(label: string): void {
    // The log transport is absent outside the Tauri webview (tests); boot
    // timing must never turn into an unhandled rejection there.
    info(
        `[boot] ${label} +${Math.round(performance.now() - BOOT_START)}ms`
    ).catch(() => undefined);
}
