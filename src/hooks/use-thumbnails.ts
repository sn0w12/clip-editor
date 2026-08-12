import { useEffect, useState } from "react";

import { getThumbnail } from "@/lib/tauri";

const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();

export function useThumbnail(path: string | undefined, enabled = true): string | null {
    // Read the module-scoped cache during render so a cache hit never needs a
    // synchronous setState in an effect. Only the async fetch (below) sets state.
    const cachedThumb = path ? (cache.get(path) ?? null) : null;
    const [fetchedThumb, setFetchedThumb] = useState<string | null>(null);

    useEffect(() => {
        if (!path || !enabled || cache.has(path)) return;
        let promise = inflight.get(path);
        if (!promise) {
            promise = getThumbnail(path)
                .then((t) => (t ? t : null))
                .catch(() => null);
            inflight.set(path, promise);
            promise.finally(() => inflight.delete(path));
        }
        let cancelled = false;
        promise.then((t) => {
            cache.set(path, t);
            if (!cancelled) setFetchedThumb(t);
        });
        return () => {
            cancelled = true;
        };
    }, [path, enabled]);

    return cachedThumb ?? (path ? fetchedThumb : null);
}
