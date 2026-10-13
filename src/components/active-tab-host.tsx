"use no memo";

import { RouterProvider } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { Activity, useEffect, useLayoutEffect } from "react";

import { useAppServices } from "@/contexts/services-context";
import { bootMark } from "@/lib/bootstrap/boot-timing";
import { createTabRouter } from "@/lib/routing/tab-router-factory";
import {
    appStore,
    createTabRecord,
    DEFAULT_TAB_NAME,
    openTab,
    selectActiveTab,
    selectTabs,
} from "@/stores/app-store";
import type { TabRecord } from "@/stores/app-store";
import {
    getOrCreateRuntime,
    getRuntime,
    runtimeVersionStore,
} from "@/stores/tab-runtime";

/**
 * Renders every open tab inside an <Activity> boundary: hidden tabs stay
 * mounted so their React state and DOM survive switches, and routers live
 * in the runtime registry so each tab's memory history persists. Always
 * keeps at least one tab.
 */
let reportedFirstMount = false;
let reportedFirstPaint = false;

export function ActiveTabHost() {
    const services = useAppServices();

    useSelector(runtimeVersionStore(), (version) => version);
    const tabs = useSelector(appStore, selectTabs);
    const activeTab = useSelector(appStore, selectActiveTab);

    useEffect(() => {
        if (tabs.length === 0) {
            openTab(createTabRecord({ title: DEFAULT_TAB_NAME }));
        }
    }, [tabs.length]);

    // Runtime creation is a side effect: it bumps the registry version
    // store, which must not happen during render.
    useLayoutEffect(() => {
        if (!reportedFirstMount) {
            reportedFirstMount = true;
            bootMark("first.mount");
            // Double rAF lands after the browser painted the committed tree.
            requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                    if (!reportedFirstPaint) {
                        reportedFirstPaint = true;
                        bootMark("first.paint");
                    }
                })
            );
        }
        for (const tab of tabs) {
            const runtime = getOrCreateRuntime(tab);
            runtime.router ??= createTabRouter(
                tab.tabId,
                tab.lastResolvedHref,
                services
            );
        }
    }, [tabs, services]);

    if (!activeTab) return null;

    return (
        <>
            {tabs.map((tab) => (
                <KeptAliveTab
                    key={tab.tabId}
                    tab={tab}
                    isActive={tab.tabId === activeTab.tabId}
                />
            ))}
        </>
    );
}

function KeptAliveTab({
    tab,
    isActive,
}: {
    tab: TabRecord;
    isActive: boolean;
}) {
    // The router may not exist yet right after a tab opens; the layout
    // effect above creates it and re-renders us. Skip until then.
    const router = getRuntime(tab.tabId)?.router;
    if (!router) return null;

    return (
        <Activity mode={isActive ? "visible" : "hidden"}>
            <RouterProvider router={router} />
        </Activity>
    );
}
