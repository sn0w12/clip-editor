import { createStore } from "@tanstack/store";
import type { ComponentType } from "react";

/**
 * Titlebar badge bound to a tab: `key` is persisted across restarts,
 * `component` is its live React reference for this session.
 */
export interface TitleBadge {
    key: string;
    component: ComponentType;
}

export interface TabRecord {
    tabId: string;
    title: string;
    titleBadge?: TitleBadge;
    /** Last fully resolved href; seeds a recreated runtime after restart. */
    lastResolvedHref: string;
    createdAt: number;
}

export interface AppState {
    tabs: TabRecord[];
    activeTabId: string | null;
}

function initialState(): AppState {
    return {
        tabs: [],
        activeTabId: null,
    };
}

/**
 * Owns open tabs, their order and which one is active. This is the only
 * durable UI state, and it is what the session document persists.
 */
export const appStore = createStore<AppState>(initialState());

let nextTabSeq = 1;

export const DEFAULT_TAB_NAME = "Home";

export function createTabRecord(input: {
    title: string;
    initialHref?: string;
}): TabRecord {
    return {
        tabId: `tab-${Date.now().toString(36)}-${nextTabSeq++}`,
        title: input.title,
        lastResolvedHref: input.initialHref ?? "/",
        createdAt: Date.now(),
    };
}

export function openTab(record: TabRecord) {
    appStore.setState((state) => {
        if (state.tabs.some((tab) => tab.tabId === record.tabId)) return state;
        return {
            ...state,
            tabs: [...state.tabs, record],
            activeTabId: record.tabId,
        };
    });
}

export function activateTab(tabId: string | null) {
    appStore.setState((state) => ({ ...state, activeTabId: tabId }));
}

/** Moves a tab to a new position in the strip; the active tab stays active. */
export function moveTab(tabId: string, toIndex: number) {
    appStore.setState((state) => {
        const from = state.tabs.findIndex((tab) => tab.tabId === tabId);
        if (from === -1) return state;

        const clamped = Math.max(0, Math.min(toIndex, state.tabs.length - 1));
        if (clamped === from) return state;

        const tabs = [...state.tabs];
        const [moved] = tabs.splice(from, 1);
        tabs.splice(clamped, 0, moved);
        return { ...state, tabs };
    });
}

export function closeTab(tabId: string) {
    appStore.setState((state) => {
        if (state.tabs.length <= 1) return state;

        const index = state.tabs.findIndex((tab) => tab.tabId === tabId);
        if (index === -1) return state;
        const tabs = state.tabs.filter((tab) => tab.tabId !== tabId);

        let activeTabId = state.activeTabId;
        if (activeTabId === tabId) {
            const neighborIndex = Math.min(index, tabs.length - 1);
            activeTabId =
                neighborIndex >= 0 && neighborIndex < tabs.length
                    ? tabs[neighborIndex].tabId
                    : null;
        }

        return { ...state, tabs, activeTabId };
    });
}

/**
 * Sets a tab's page-provided title and optional badge; no-ops when nothing
 * changes so render-stable inputs cannot cause update loops.
 */
export function setTabTitle(
    tabId: string,
    title: string,
    titleBadge?: TitleBadge
) {
    appStore.setState((state) => {
        const existing = state.tabs.find((tab) => tab.tabId === tabId);
        if (!existing) return state;
        if (
            existing.title === title &&
            (existing.titleBadge?.key ?? undefined) ===
                (titleBadge?.key ?? undefined)
        ) {
            return state;
        }
        return {
            ...state,
            tabs: state.tabs.map((tab) =>
                tab.tabId === tabId ? { ...tab, title, titleBadge } : tab
            ),
        };
    });
}

export function setLastResolvedHref(tabId: string, href: string) {
    appStore.setState((state) => {
        const tabs = state.tabs.map((tab) =>
            tab.tabId === tabId ? { ...tab, lastResolvedHref: href } : tab
        );
        const changed = tabs.some(
            (tab, index) =>
                tab.lastResolvedHref !== state.tabs[index].lastResolvedHref
        );
        return changed ? { ...state, tabs } : state;
    });
}

export function replaceTabs(tabs: TabRecord[], activeTabId: string | null) {
    appStore.setState((state) => ({
        ...state,
        tabs,
        activeTabId,
    }));
}

export function duplicateTab(source: TabRecord): TabRecord {
    // Prefer the live record: render snapshots lag behind href updates.
    const live =
        appStore.state.tabs.find((tab) => tab.tabId === source.tabId) ?? source;
    const clone = createTabRecord({
        title: live.title,
        initialHref: live.lastResolvedHref,
    });
    openTab(clone);

    const sourceIndex = appStore.state.tabs.findIndex(
        (tab) => tab.tabId === source.tabId
    );
    if (sourceIndex !== -1) {
        moveTab(clone.tabId, sourceIndex + 1);
    }
    return clone;
}

export function selectActiveTab(state: AppState = appStore.state) {
    return state.tabs.find((tab) => tab.tabId === state.activeTabId) ?? null;
}

export function selectTabs(state: AppState = appStore.state) {
    return state.tabs;
}

export function selectActiveTabId(state: AppState = appStore.state) {
    return state.activeTabId;
}
