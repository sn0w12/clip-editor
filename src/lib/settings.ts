import { useSelector } from "@tanstack/react-store";
import { useEffect, useMemo, useRef } from "react";

import type { SettingDefinition } from "@/lib/backend/protocol";
import type {
    SettingKey,
    SettingsValues,
} from "@/lib/settings/settings.generated";
import { isMac } from "@/lib/utils";
import {
    getSetting as getStoreSetting,
    setSetting as setStoreSetting,
    settingsStore,
} from "@/stores/settings-store";

export type SettingValue = string | boolean | number | string[];
export type SettingsMap = Record<string, SettingValue>;

/**
 * Compatibility layer over the schema-driven settings store for the ported
 * components. Legacy keys use the `shortcut_<name>` form; the schema stores
 * `<name>Shortcut`, so both resolve to the same key.
 */
function resolveKey(key: string): string {
    if (key.startsWith("shortcut_")) {
        return `${key.slice("shortcut_".length)}Shortcut`;
    }
    return key;
}

export function getSetting<T extends SettingValue = SettingValue>(
    key: string
): T | undefined {
    return getStoreSetting(resolveKey(key) as SettingKey) as T | undefined;
}

export function useSetting<T extends SettingValue = SettingValue>(
    key: string
): T | undefined {
    const resolved = resolveKey(key);
    return useSelector(
        settingsStore,
        (state) => state.values[resolved as SettingKey]
    ) as T | undefined;
}

export function useSettings(): SettingsMap {
    return useSelector(
        settingsStore,
        (state) => state.values as unknown as SettingsMap
    );
}

export function setSetting(key: string, value: SettingValue): Promise<void> {
    setStoreSetting(resolveKey(key) as SettingKey, value as never);
    return Promise.resolve();
}

export function loadSettings(): Promise<void> {
    // Bootstrap initializes the store before first render.
    return Promise.resolve();
}

export function useSettingsChange(callback: () => void): void {
    const ref = useRef(callback);
    useEffect(() => {
        ref.current = callback;
    }, [callback]);
    useEffect(() => {
        const dispose = settingsStore.subscribe(() => ref.current());
        return () => dispose.unsubscribe();
    }, []);
}

export function dispatchSettingsChange(): void {
    // The settings store is reactive; nothing to broadcast.
}

export function resetAllSettingsToDefault(): Promise<void> {
    const schema = settingsStore.state.schema;
    for (const tab of schema.tabs) {
        for (const section of tab.sections) {
            for (const definition of section.settings as SettingDefinition[]) {
                setStoreSetting(
                    definition.key as SettingKey,
                    definition.defaultValue as never
                );
            }
        }
    }
    return Promise.resolve();
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
    const parts = text.split("+").map((part) => part.trim());
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
        else if (upper === "META" || upper === "CMD" || upper === "WIN")
            meta = true;
        // `Mod` is the app's platform modifier: Command on macOS, Control
        // elsewhere. Without this it collapses to a bare key, so `Mod+A`
        // would fire on a plain `a`.
        else if (upper === "MOD") {
            if (isMac()) meta = true;
            else ctrl = true;
        } else key = upper;
    }
    return { ctrl, shift, alt, meta, key };
}

export function shortcutMatches(
    shortcut: Shortcut | null,
    event: KeyboardEvent
): boolean {
    if (!shortcut || !shortcut.key) return false;
    const modifiersMatch =
        event.ctrlKey === shortcut.ctrl &&
        event.shiftKey === shortcut.shift &&
        event.altKey === shortcut.alt &&
        event.metaKey === shortcut.meta;
    if (shortcut.key === "SPACE") {
        return (event.key === " " || event.key === "Space") && modifiersMatch;
    }
    return event.key.toUpperCase() === shortcut.key && modifiersMatch;
}

/** Bind a keyboard shortcut to a handler; the chord comes from the settings. */
export function useShortcutSetting(
    shortcutKey: string,
    handler: () => void
): void {
    const shortcutText = useSetting<string>(`shortcut_${shortcutKey}`);
    const handlerRef = useRef(handler);
    useEffect(() => {
        handlerRef.current = handler;
    }, [handler]);
    const shortcut = useMemo(
        () => (shortcutText ? parseShortcut(shortcutText) : null),
        [shortcutText]
    );
    useEffect(() => {
        if (!shortcut) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.repeat) return;
            if (shortcutMatches(shortcut, event)) {
                event.preventDefault();
                handlerRef.current();
            }
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [shortcut]);
}

export type { SettingKey, SettingsValues };
