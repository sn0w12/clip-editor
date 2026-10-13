import {
    createMemoryHistory,
    createRouter as createTanStackRouter,
} from "@tanstack/react-router";

import { createTabRouteTree } from "@/routes/route-tree";
import { setLastResolvedHref } from "@/stores/app-store";
import { attachRouter, getRuntime } from "@/stores/tab-runtime";

import type { AppServices } from "../bootstrap/app-runtime";

/**
 * Creates the per-tab router. Every tab gets its own memory history and its
 * OWN route-tree instances. Routers mutate route nodes internally, so trees
 * are never shared between live routers.
 */
export function createTabRouter(
    tabId: string,
    initialHref: string,
    _services: AppServices
) {
    const history = createMemoryHistory({
        initialEntries: [initialHref || "/"],
    });

    const router = createTanStackRouter({
        routeTree: createTabRouteTree({ tabId }),
        history,
        defaultPreload: "intent",
        defaultPreloadStaleTime: 0,
    });

    const unsubscribe = router.subscribe("onResolved", (event) => {
        setLastResolvedHref(tabId, event.toLocation.href);
    });
    getRuntime(tabId)?.disposers.push(unsubscribe);

    attachRouter(tabId, router);
    return router;
}

export type TabRouter = ReturnType<typeof createTabRouter>;

export async function disposeTabRouter(tabId: string): Promise<void> {
    // Router instances are garbage collected with the runtime; memory histories
    // hold no global resources. Subscriptions are removed by runtime disposal.
    void tabId;
}
