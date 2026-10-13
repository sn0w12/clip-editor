import { createStore } from "@tanstack/store";

import type {
    SettingsSchema,
    SettingsSnapshot,
    ValuesSnapshot,
} from "@/lib/backend/protocol";
import type {
    SettingKey,
    SettingsValues,
    ShortcutSettingKey,
} from "@/lib/settings/settings.generated";

/**
 * Persists one setting change. Implementations must eventually return the
 * backend's canonical values snapshot (or reject).
 */
export type SettingsSaver = (
    key: SettingKey,
    value: SettingsValues[SettingKey]
) => Promise<ValuesSnapshot>;

export interface SettingsState {
    ready: boolean;
    schema: SettingsSchema;
    values: SettingsValues;
    savedKeys: ReadonlySet<string>;
    /** Keys queued or in-flight to the backend. */
    pendingKeys: ReadonlySet<string>;
    lastError: string | null;
}

function initialState(): SettingsState {
    return {
        ready: false,
        schema: { tabs: [] },
        // Replaced wholesale by initializeSettings before the app renders.
        values: {} as SettingsValues,
        savedKeys: new Set<string>(),
        pendingKeys: new Set<string>(),
        lastError: null,
    };
}

export const settingsStore = createStore<SettingsState>(initialState());

let saver: SettingsSaver | null = null;
/** Bumped on (re)initialization so stale saves cannot clobber new state. */
let generation = 0;
const queued = new Map<SettingKey, SettingsValues[SettingKey]>();
let draining = false;
let drainChain: Promise<void> = Promise.resolve();

/** Wires the transport used to persist changes; pass null to detach. */
export function configureSettingsSaver(next: SettingsSaver | null): void {
    saver = next;
}

/** Seeds the store from a backend snapshot before first render. */
export function initializeSettings(snapshot: SettingsSnapshot): void {
    generation += 1;
    queued.clear();
    settingsStore.setState(() => ({
        ready: true,
        schema: snapshot.schema,
        // Wire shape and generated interface are kept in lockstep by the
        // Rust exporter tests, so this boundary cast is exact.
        values: snapshot.values as unknown as SettingsValues,
        savedKeys: new Set(snapshot.savedKeys),
        pendingKeys: new Set<string>(),
        lastError: null,
    }));
}

/**
 * Non-reactive typed read for non-React code. Throws when settings have
 * not been initialized yet. Bootstrap guarantees they are.
 */
export function getSetting<TKey extends SettingKey>(
    key: TKey
): SettingsValues[TKey] {
    const state = settingsStore.state;
    if (!state.ready) {
        throw new Error(
            `setting \`${key}\` read before settings were initialized`
        );
    }
    return state.values[key];
}

/**
 * Synchronous typed write: the store updates immediately so every reader
 * sees the change in the same tick, while persistence is coalesced and
 * serialized through the saver.
 */
export function setSetting<TKey extends SettingKey>(
    key: TKey,
    value: SettingsValues[TKey]
): void {
    const state = settingsStore.state;
    if (!state.ready) {
        throw new Error(
            `setting \`${key}\` written before settings were initialized`
        );
    }

    settingsStore.setState((prev) => ({
        ...prev,
        values: { ...prev.values, [key]: value },
    }));

    if (!saver) return;
    queued.set(key, value);
    markPending(key, true);
    if (!draining) {
        draining = true;
        drainChain = drainChain.then(() => drain());
    }
}

async function drain(): Promise<void> {
    const startGeneration = generation;

    try {
        while (queued.size > 0) {
            const currentSaver = saver;
            if (!currentSaver) break;

            // Latest-wins per key: rapid edits collapse into one save.
            const entries = [...queued];
            queued.clear();

            for (const [key, value] of entries) {
                if (!saver) break;
                try {
                    const snapshot = await currentSaver(key, value);
                    if (
                        generation !== startGeneration ||
                        queued.size > 0 ||
                        saver !== currentSaver
                    ) {
                        // A newer local change or re-init owns the truth;
                        // its response will apply the final state instead.
                        continue;
                    }
                    applyCanonical(snapshot);
                    clearError();
                } catch (error) {
                    // Keep the local value (it stays authoritative until a
                    // later change retries persistence).
                    setError(
                        error instanceof Error ? error.message : String(error)
                    );
                } finally {
                    markPending(key, false);
                }
            }
        }
    } finally {
        draining = false;
    }
}

/** Awaits in-flight/queued persistence; used by tests and shutdown paths. */
export function flushSettingsSaves(): Promise<void> {
    return drainChain;
}

/** Test helper: resets the store and all save machinery. */
export function resetSettingsForTests(): void {
    generation += 1;
    queued.clear();
    draining = false;
    drainChain = Promise.resolve();
    configureSettingsSaver(null);
    settingsStore.setState(() => initialState());
}

/**
 * Test helper: marks settings initialized with an empty schema and the
 * given values, mirroring what bootstrap guarantees in the real app.
 */
export function seedSettingsForTests(values: Partial<SettingsValues>): void {
    generation += 1;
    queued.clear();
    settingsStore.setState(() => ({
        ready: true,
        schema: { tabs: [] },
        values: { ...({} as SettingsValues), ...values },
        savedKeys: new Set<string>(),
        pendingKeys: new Set<string>(),
        lastError: null,
    }));
}

function applyCanonical(snapshot: ValuesSnapshot): void {
    settingsStore.setState((prev) => ({
        ...prev,
        // Same exporter-guaranteed boundary as initializeSettings.
        values: snapshot.values as unknown as SettingsValues,
        savedKeys: new Set(snapshot.savedKeys),
    }));
}

function markPending(key: SettingKey, pending: boolean): void {
    settingsStore.setState((prev) => {
        const next = new Set(prev.pendingKeys);
        let changed = false;
        if (pending && !next.has(key)) {
            next.add(key);
            changed = true;
        } else if (!pending && next.has(key)) {
            next.delete(key);
            changed = true;
        }
        return changed ? { ...prev, pendingKeys: next } : prev;
    });
}

function setError(message: string): void {
    settingsStore.setState((prev) =>
        prev.lastError === message ? prev : { ...prev, lastError: message }
    );
}

function clearError(): void {
    settingsStore.setState((prev) =>
        prev.lastError === null ? prev : { ...prev, lastError: null }
    );
}

export type { SettingKey, ShortcutSettingKey };
