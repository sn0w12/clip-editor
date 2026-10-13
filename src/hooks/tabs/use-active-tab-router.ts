"use no memo";

import { useSelector } from "@tanstack/react-store";
import { useEffect, useReducer } from "react";

import type { TabRouter } from "@/lib/routing/tab-router-factory";
import { selectActiveTab, appStore } from "@/stores/app-store";
import { getRuntime, runtimeVersionStore } from "@/stores/tab-runtime";

/** Read-only view of the active tab's router; runtime creation belongs to
 * ActiveTabHost (a store update during render here would break React). */
export function useActiveTabRouter(): TabRouter | null {
    useSelector(runtimeVersionStore(), (version) => version);
    const activeTab = useSelector(appStore, selectActiveTab);

    if (!activeTab) return null;
    return getRuntime(activeTab.tabId)?.router ?? null;
}

interface HistorySnapshot {
    index: number;
    length: number;
}

function readHistorySnapshot(router: TabRouter): HistorySnapshot {
    return {
        index: router.history.location.state.__TSR_index,
        length: router.history.length,
    };
}

/** Reactive view over the active tab's memory history: memory histories
 * truncate forward entries on push, so forward availability is exactly
 * "entries ahead of us". Snapshot values are read live during render and a
 * history subscription only forces the rerender. */
export function useActiveTabHistory(): {
    canGoBack: boolean;
    canGoForward: boolean;
    back: () => void;
    forward: () => void;
} {
    const router = useActiveTabRouter();
    const [, requestRerender] = useReducer((count: number) => count + 1, 0);

    useEffect(() => {
        if (!router) return undefined;
        return router.history.subscribe(requestRerender);
    }, [router]);

    const snapshot = router
        ? readHistorySnapshot(router)
        : { index: 0, length: 1 };

    return {
        canGoBack: snapshot.index > 0,
        canGoForward: snapshot.index < snapshot.length - 1,
        back: () => router?.history.back(),
        forward: () => router?.history.forward(),
    };
}
