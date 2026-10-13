import { resolveTitleBadge } from "@/components/titlebar/title-badge-registry";
import type { SessionDocument } from "@/lib/backend/protocol";
import type { BackendClient } from "@/lib/backend/transport/client";
import { getAppRuntime } from "@/lib/bootstrap/app-runtime";
import { bootMark } from "@/lib/bootstrap/boot-timing";
import { appStore, replaceTabs } from "@/stores/app-store";
import type { TabRecord } from "@/stores/app-store";
import { getSetting } from "@/stores/settings-store";

const PERSIST_DEBOUNCE_MS = 250;

export type RestoreResult =
    | { kind: "restored"; tabs: number }
    | { kind: "empty" }
    | { kind: "loadFailed"; message: string };

export async function restoreSession(
    backend?: BackendClient
): Promise<RestoreResult> {
    const client = backend ?? getAppRuntime().backend;
    const loaded = await client.session.load();
    bootMark("session.load");
    if (!loaded.ok) {
        return { kind: "loadFailed", message: loaded.error.message };
    }

    const session = loaded.value;
    if (!Array.isArray(session.tabs) || session.tabs.length === 0) {
        return { kind: "empty" };
    }

    const tabs: TabRecord[] = session.tabs.map((tab) => ({
        tabId: tab.tabId,
        title: tab.title,
        lastResolvedHref: tab.lastResolvedHref ?? "/",
        // Badges are self-resolving; restoring them is safe.
        titleBadge: resolveTitleBadge(tab.titleBadge),
        createdAt: Date.now(),
    }));

    const activeTabId =
        session.activeTabId != null &&
        tabs.some((tab) => tab.tabId === session.activeTabId)
            ? session.activeTabId
            : (tabs[tabs.length - 1]?.tabId ?? null);

    replaceTabs(tabs, activeTabId);
    return { kind: "restored", tabs: tabs.length };
}

export function currentSessionDocument(): SessionDocument {
    const { tabs, activeTabId } = appStore.state;
    return {
        version: 1,
        tabs: tabs.map((tab) => ({
            tabId: tab.tabId,
            title: tab.title,
            lastResolvedHref: tab.lastResolvedHref,
            titleBadge: tab.titleBadge?.key,
        })),
        activeTabId,
    };
}

export function initSessionPersistence(
    save: (doc: SessionDocument) => Promise<void>
): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            void save(currentSessionDocument()).catch((error: unknown) => {
                console.error("session save failed:", error);
            });
        }, PERSIST_DEBOUNCE_MS);
    };
    const subscription = appStore.subscribe(schedule);

    return () => {
        clearTimeout(timer);
        subscription.unsubscribe();
        void save(currentSessionDocument()).catch((error: unknown) => {
            console.error("final session save failed:", error);
        });
    };
}

export function shouldRestoreTabs(): boolean {
    return getSetting("reopenTabsOnLaunch");
}
