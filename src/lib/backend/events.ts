import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import type {
    ExportComplete,
    ExportProgress,
    LibraryChanged,
    RecordingError,
    RecordingHealth,
    RecordingState,
    SteamArtworkUpdated,
} from "./domain";

export function onLibraryChanged(
    cb: (payload: LibraryChanged) => void
): Promise<UnlistenFn> {
    return listen<LibraryChanged>("library-changed", (e) => cb(e.payload));
}

export function onExportProgress(
    cb: (payload: ExportProgress) => void
): Promise<UnlistenFn> {
    return listen<ExportProgress>("export-progress", (e) => cb(e.payload));
}

export function onExportComplete(
    cb: (payload: ExportComplete) => void
): Promise<UnlistenFn> {
    return listen<ExportComplete>("export-complete", (e) => cb(e.payload));
}

export function onExportError(
    cb: (payload: { message: string }) => void
): Promise<UnlistenFn> {
    return listen<{ message: string }>("export-error", (e) => cb(e.payload));
}

export function onRecordingState(
    cb: (payload: RecordingState) => void
): Promise<UnlistenFn> {
    return listen<RecordingState>("recording-state", (e) => cb(e.payload));
}

export function onRecordingProgress(
    cb: (payload: { availableSeconds: number; targetSeconds: number }) => void
): Promise<UnlistenFn> {
    return listen<{ availableSeconds: number; targetSeconds: number }>(
        "recording-progress",
        (e) => cb(e.payload)
    );
}

export function onRecordingHealth(
    cb: (payload: RecordingHealth) => void
): Promise<UnlistenFn> {
    return listen<RecordingHealth>("recording-health", (e) => cb(e.payload));
}

export function onRecordingSaving(cb: () => void): Promise<UnlistenFn> {
    return listen("recording-saving", () => cb());
}

export function onRecordingSaved(
    cb: (payload: { path: string }) => void
): Promise<UnlistenFn> {
    return listen<{ path: string }>("recording-saved", (e) => cb(e.payload));
}

export function onRecordingError(
    cb: (payload: RecordingError) => void
): Promise<UnlistenFn> {
    return listen<RecordingError>("recording-error", (e) => cb(e.payload));
}

export function onSteamArtworkUpdated(
    cb: (payload: SteamArtworkUpdated) => void
): Promise<UnlistenFn> {
    return listen<SteamArtworkUpdated>("steam-artwork-updated", (e) =>
        cb(e.payload)
    );
}

export function onAppActivate(cb: () => void): Promise<UnlistenFn> {
    return listen("app-activate", () => cb());
}

export function onSteamScanDone(cb: () => void): Promise<UnlistenFn> {
    return listen("steam-scan-done", () => cb());
}

export type { UnlistenFn };
