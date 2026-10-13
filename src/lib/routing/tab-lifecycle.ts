import { activateTab, appStore, closeTab, openTab } from "@/stores/app-store";
import type { TabRecord } from "@/stores/app-store";
import { disposeRuntime, getRuntime } from "@/stores/tab-runtime";

/** Most recently closed tabs first; in-memory only, reset on app restart. */
const closedTabStack: TabRecord[] = [];

/**
 * Full tab close: pushes the tab onto the reopen stack, drops the record,
 * then disposes the runtime. Long work owned by the tab is cancelled by its
 * own owner, not here, so this stays synchronous enough to reason about.
 */
export async function closeTabFully(tabId: string): Promise<void> {
    const closing = getRuntime(tabId)?.tab;
    if (closing) closedTabStack.push(closing);
    closeTab(tabId);
    await disposeRuntime(tabId);
}

async function closeTabsFully(tabIds: string[]): Promise<void> {
    for (const tabId of tabIds) {
        await closeTabFully(tabId);
    }
}

export async function closeOtherTabsFully(keepTabId: string): Promise<void> {
    const otherIds = appStore.state.tabs
        .filter((tab) => tab.tabId !== keepTabId)
        .map((tab) => tab.tabId);

    await closeTabsFully(otherIds);

    if (appStore.state.tabs.some((tab) => tab.tabId === keepTabId)) {
        activateTab(keepTabId);
    }
}

export async function closeTabsToRightFully(tabId: string): Promise<void> {
    const index = appStore.state.tabs.findIndex((tab) => tab.tabId === tabId);
    if (index === -1) return;

    const rightIds = appStore.state.tabs
        .slice(index + 1)
        .map((tab) => tab.tabId);

    await closeTabsFully(rightIds);
}

/** Reopens the most recently closed tab, or returns null when empty. */
export function reopenLastClosedTab(): TabRecord | null {
    // Never resurrect a duplicate id if something re-opened it meanwhile.
    while (closedTabStack.length > 0) {
        const record = closedTabStack.pop();
        if (!record) break;
        if (appStore.state.tabs.some((tab) => tab.tabId === record.tabId)) {
            continue;
        }
        openTab(record);
        return record;
    }
    return null;
}

/** Test helper. */
export function clearClosedTabStackForTests(): void {
    closedTabStack.length = 0;
}
