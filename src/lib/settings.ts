// Settings store: SQLite-backed via commands, mirrored in a module store with
// subscription hooks (legacy `useSetting`/`useShortcutSetting` contract).

import { useEffect, useSyncExternalStore } from "react";

import * as tauri from "@/lib/tauri";

export type SettingValue = string | boolean | number | string[];
export type SettingsMap = Record<string, SettingValue>;

let settings: SettingsMap = {};
const listeners = new Set<() => void>();

function notify() {
    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getSnapshot(): SettingsMap {
    return settings;
}

/** Load all settings from SQLite (call once at startup). */
export async function loadSettings(): Promise<void> {
    const loaded = await tauri.getSettings();
    settings = loaded as SettingsMap;
    notify();
}

export function getSetting<T extends SettingValue = SettingValue>(key: string): T | undefined {
    return settings[key] as T | undefined;
}

/** Reactive setting value; re-renders on any settings change. */
export function useSetting<T extends SettingValue = SettingValue>(key: string): T | undefined {
    const snapshot = useSyncExternalStore(subscribe, getSnapshot);
    return snapshot[key] as T | undefined;
}

/** The full settings map, reactive to any change. */
export function useSettings(): SettingsMap {
    return useSyncExternalStore(subscribe, getSnapshot);
}

/** Persist a setting through SQLite and update the local mirror. */
export async function setSetting(key: string, value: SettingValue): Promise<void> {
    await tauri.setSetting(key, value);
    settings = { ...settings, [key]: value };
    notify();
}

/** Subscribe to settings changes (legacy `useSettingsChange`). */
export function useSettingsChange(callback: () => void): void {
    useEffect(() => {
        const listener = () => callback();
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }, [callback]);
}

/** Notify listeners after external changes (legacy `dispatchSettingsChange`). */
export function dispatchSettingsChange(): void {
    notify();
}

export async function resetAllSettingsToDefault(): Promise<void> {
    await tauri.resetSettings();
    await loadSettings();
}

export interface Shortcut {
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
    key: string;
}

export function parseShortcut(text: string | undefined): Shortcut | null {
    if (!text) return null;
    const parts = text.split("+").map((p) => p.trim());
    let ctrl = false;
    let shift = false;
    let alt = false;
    let meta = false;
    let key = "";
    for (const part of parts) {
        const upper = part.toUpperCase();
        if (upper === "CTRL" || upper === "CONTROL") ctrl = true;
        else if (upper === "SHIFT") shift = true;
        else if (upper === "ALT") alt = true;
        else if (upper === "META" || upper === "CMD" || upper === "WIN") meta = true;
        else key = upper;
    }
    return { ctrl, shift, alt, meta, key };
}

export function shortcutMatches(shortcut: Shortcut | null, event: KeyboardEvent): boolean {
    if (!shortcut || !shortcut.key) return false;
    const modifiersMatch =
        event.ctrlKey === shortcut.ctrl &&
        event.shiftKey === shortcut.shift &&
        event.altKey === shortcut.alt &&
        event.metaKey === shortcut.meta;
    if (shortcut.key === "SPACE") {
        // The spacebar's event.key is " " (or "Space" on some platforms), which
        // toUpperCase() does not turn into "SPACE".
        return (event.key === " " || event.key === "Space") && modifiersMatch;
    }
    return event.key.toUpperCase() === shortcut.key && modifiersMatch;
}

/**
 * Bind a keyboard shortcut to a handler. The shortcut string comes from the
 * settings store (legacy `useShortcutSetting`).
 */
export function useShortcutSetting(shortcutKey: string, handler: () => void): void {
    const shortcutText = useSetting<string>(`shortcut_${shortcutKey}`);
    const shortcut = shortcutText ? parseShortcut(shortcutText) : null;
    useEffect(() => {
        if (!shortcut) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.repeat) return;
            if (shortcutMatches(shortcut, event)) {
                event.preventDefault();
                handler();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [shortcut, handler]);
}
