import { createStore } from "@tanstack/store";

import type { ThemeMode } from "@/lib/settings/settings.generated";
import { getSetting, settingsStore } from "@/stores/settings-store";

export type { ThemeMode };
export type ResolvedTheme = "light" | "dark";

interface ThemeState {
    /** The theme actually applied to <html>. */
    resolved: ResolvedTheme;
}

export const themeStore = createStore<ThemeState>({ resolved: "light" });

function systemPrefersDark(): boolean {
    return (
        typeof window !== "undefined" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches
    );
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
    if (mode === "system") return systemPrefersDark() ? "dark" : "light";
    return mode;
}

function applyToDocument(resolved: ResolvedTheme): void {
    document.documentElement.classList.toggle("dark", resolved === "dark");
}

function currentMode(): ThemeMode {
    // Settings are guaranteed initialized before the first render; this
    // throws loudly if the bootstrap order is ever broken.
    return getSetting("theme");
}

function sync(): void {
    const resolved = resolveTheme(currentMode());
    applyToDocument(resolved);
    if (themeStore.state.resolved !== resolved) {
        themeStore.setState(() => ({ resolved }));
    }
}

/**
 * Wires OS-level theme detection and reacts to the `theme` setting.
 * Call once at startup AFTER settings are initialized but BEFORE the
 * first React render to avoid a wrong-theme flash.
 */
export function startThemeEngine(): void {
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    media.addEventListener("change", () => {
        if (currentMode() === "system") sync();
    });
    settingsStore.subscribe(sync);

    sync();
}
