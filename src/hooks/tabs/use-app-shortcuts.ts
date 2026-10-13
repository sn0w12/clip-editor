import { useHotkey } from "@tanstack/react-hotkeys";

import { useSettingHotkey } from "@/hooks/settings/use-setting-hotkey";
import {
    closeTabFully,
    reopenLastClosedTab,
} from "@/lib/routing/tab-lifecycle";
import {
    activateTab,
    appStore,
    createTabRecord,
    DEFAULT_TAB_NAME,
    openTab,
} from "@/stores/app-store";

import { useActiveTabRouter } from "./use-active-tab-router";

function cycleActiveTab(delta: number): void {
    const { tabs, activeTabId } = appStore.state;
    if (tabs.length <= 1) return;

    const index = tabs.findIndex((tab) => tab.tabId === activeTabId);
    const nextIndex = (index + delta + tabs.length) % tabs.length;
    activateTab(tabs[nextIndex].tabId);
}

function activateNthTab(position: number): void {
    const { tabs } = appStore.state;
    // Browsers treat Mod+9 as "jump to last tab"; other positions must exist.
    const target = position === 9 ? tabs[tabs.length - 1] : tabs[position - 1];
    if (target) activateTab(target.tabId);
}

/** Registers every tab shortcut from the settings system; re-registers
 * automatically when a binding changes. */
export function useAppShortcuts(): void {
    const router = useActiveTabRouter();

    useSettingHotkey("goToSettingsShortcut", () =>
        router?.navigate({ to: "/settings" })
    );
    useSettingHotkey("goToClipsShortcut", () => router?.navigate({ to: "/" }));

    useSettingHotkey("newTabShortcut", () => {
        openTab(createTabRecord({ title: DEFAULT_TAB_NAME }));
    });
    useSettingHotkey("closeTabShortcut", () => {
        const active = appStore.state.activeTabId;
        if (active) void closeTabFully(active);
    });
    useSettingHotkey("reopenClosedTabShortcut", () => {
        reopenLastClosedTab();
    });
    useSettingHotkey("nextTabShortcut", () => cycleActiveTab(1));
    useSettingHotkey("previousTabShortcut", () => cycleActiveTab(-1));

    useHotkey("Mod+1", () => activateNthTab(1));
    useHotkey("Mod+2", () => activateNthTab(2));
    useHotkey("Mod+3", () => activateNthTab(3));
    useHotkey("Mod+4", () => activateNthTab(4));
    useHotkey("Mod+5", () => activateNthTab(5));
    useHotkey("Mod+6", () => activateNthTab(6));
    useHotkey("Mod+7", () => activateNthTab(7));
    useHotkey("Mod+8", () => activateNthTab(8));
    useHotkey("Mod+9", () => activateNthTab(9));
}
