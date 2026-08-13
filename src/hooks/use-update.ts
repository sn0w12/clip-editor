import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useState } from "react";

/** Check once on mount for an available update; exposes install-and-restart. */
export function useUpdateAvailable(): {
    available: boolean;
    checking: boolean;
    installAndRestart: () => Promise<void>;
} {
    const [update, setUpdate] = useState<Update | null>(null);
    const [checking, setChecking] = useState(true);

    useEffect(() => {
        let cancelled = false;
        void check()
            .then((result) => {
                if (!cancelled) setUpdate(result ?? null);
            })
            .catch(() => {
                // Updater unavailable (dev build, no endpoint, etc.).
            })
            .finally(() => {
                if (!cancelled) setChecking(false);
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const installAndRestart = useCallback(async () => {
        if (!update) return;
        await update.downloadAndInstall();
        await relaunch();
    }, [update]);

    return { available: update !== null, checking, installAndRestart };
}
