import { useCallback, useEffect, useState } from "react";

import * as tauri from "@/lib/tauri";
import type { OpResult, ScanResult, VideoFile, VideoGroup } from "@/types";

export interface ClipsStoreState {
    clips: VideoFile[];
    groups: VideoGroup[];
    loading: boolean;
    error: string | null;
    roots: string[];
}

/** The most recent library snapshot; the editor's prev/next buttons use it. */
export let lastLibrary: VideoFile[] = [];

function setLastLibrary(clips: VideoFile[]) {
    lastLibrary = clips;
}

/** Module-level cache so re-mounting a page doesn't refetch from scratch (and
 * flash a loader); the store hydrates from this and refreshes in the
 * background. */
let cachedSnapshot: {
    clips: VideoFile[];
    groups: VideoGroup[];
    roots: string[];
} | null = null;
/** Last serialized snapshot; an unchanged reload skips state updates so a
 * navigation back to a page doesn't re-render every card needlessly. */
let lastSnapshotJson: string | null = null;

/**
 * Load the library (clips + groups) and keep it fresh via `library-changed`
 * watcher events. Returns actions for every mutation; mutations reload the
 * affected state so callers never hand-maintain caches.
 */
export function useClipsStore(): ClipsStoreState & {
    reload: () => Promise<void>;
    selectDirectory: () => Promise<string | null>;
    scan: () => Promise<ScanResult>;
    deleteClips: (paths: string[]) => Promise<OpResult>;
    renameClip: (path: string, newGameName: string) => Promise<void>;
    createGroup: (name: string, color?: string) => Promise<VideoGroup>;
    deleteGroup: (id: string) => Promise<void>;
    assignToGroup: (paths: string[], groupId: string) => Promise<void>;
    removeFromGroup: (paths: string[], groupId: string) => Promise<void>;
} {
    const [clips, setClips] = useState<VideoFile[]>(cachedSnapshot?.clips ?? []);
    const [groups, setGroups] = useState<VideoGroup[]>(cachedSnapshot?.groups ?? []);
    const [loading, setLoading] = useState<boolean>(!cachedSnapshot);
    const [error, setError] = useState<string | null>(null);
    const [roots, setRoots] = useState<string[]>(cachedSnapshot?.roots ?? []);

    const reload = useCallback(async () => {
        try {
            const [clips, groups, roots] = await Promise.all([
                tauri.getClips(),
                tauri.listGroups(),
                tauri.getLibraryRoots(),
            ]);
            cachedSnapshot = { clips, groups, roots };
            const nextJson = JSON.stringify(cachedSnapshot);
            if (nextJson === lastSnapshotJson) return;
            lastSnapshotJson = nextJson;
            setClips(clips);
            setLastLibrary(clips);
            setGroups(groups);
            setRoots(roots);
            setError(null);
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const load = async () => {
            try {
                const [clips, groups, roots] = await Promise.all([
                    tauri.getClips(),
                    tauri.listGroups(),
                    tauri.getLibraryRoots(),
                ]);
                cachedSnapshot = { clips, groups, roots };
                const nextJson = JSON.stringify(cachedSnapshot);
                if (nextJson === lastSnapshotJson) return;
                lastSnapshotJson = nextJson;
                setClips(clips);
                setLastLibrary(clips);
                setGroups(groups);
                setRoots(roots);
                setError(null);
            } catch (e) {
                setError(String(e));
            } finally {
                setLoading(false);
            }
        };
        void load();
    }, []);

    useEffect(() => {
        const unlisten = tauri.onLibraryChanged((payload) => {
            if (payload.kind === "watcher-error") {
                // Reconnect state: keep the current clips visible, flag the error.
                setError(payload.message ?? "Library watcher disconnected");
                return;
            }
            void reload();
        });
        return () => {
            void unlisten.then((fn) => fn());
        };
    }, [reload]);

    const selectDirectory = useCallback(async () => {
        const dir = await tauri.selectDirectory();
        if (dir) {
            // Legacy behavior: choosing a directory replaces the current one.
            for (const root of roots) {
                await tauri.removeLibraryRoot(root);
            }
            await tauri.addLibraryRoot(dir);
            await reload();
        }
        return dir;
    }, [reload, roots]);

    const scan = useCallback(async () => {
        const result = await tauri.scanLibrary();
        const resultRoots = result.roots;
        setRoots(resultRoots);
        await reload();
        return result;
    }, [reload]);

    const deleteClips = useCallback(
        async (paths: string[]) => {
            const result = await tauri.deleteClips(paths);
            await reload();
            return result;
        },
        [reload],
    );

    const renameClip = useCallback(
        async (path: string, newGameName: string) => {
            await tauri.renameClip(path, newGameName);
            await reload();
        },
        [reload],
    );

    const createGroup = useCallback(async (name: string, color?: string) => {
        const group = await tauri.createGroup(name, color);
        setGroups((g) => [...g, group]);
        return group;
    }, []);

    const deleteGroup = useCallback(async (id: string) => {
        await tauri.deleteGroup(id);
        setGroups((g) => g.filter((group) => group.id !== id));
    }, []);

    const assignToGroup = useCallback(
        async (paths: string[], groupId: string) => {
            await tauri.assignClipsToGroup(paths, groupId);
            await reload();
        },
        [reload],
    );

    const removeFromGroup = useCallback(
        async (paths: string[], groupId: string) => {
            await tauri.removeClipsFromGroup(paths, groupId);
            await reload();
        },
        [reload],
    );

    return {
        clips,
        groups,
        loading,
        error,
        roots,
        reload,
        selectDirectory,
        scan,
        deleteClips,
        renameClip,
        createGroup,
        deleteGroup,
        assignToGroup,
        removeFromGroup,
    };
}

/** Group id -> clip paths (derived from clips). */
export function useClipGroupMap(clips: VideoFile[]): Map<string, string[]> {
    const map = new Map<string, string[]>();
    for (const clip of clips) {
        for (const groupId of clip.groupIds) {
            const entry = map.get(groupId) ?? [];
            entry.push(clip.path);
            map.set(groupId, entry);
        }
    }
    return map;
}
