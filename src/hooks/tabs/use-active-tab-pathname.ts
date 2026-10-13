import { useSelector } from "@tanstack/react-store";

import { appStore, selectActiveTab } from "@/stores/app-store";

/** Pathname of the active tab's last resolved route, or null when unknown. */
export function useActiveTabPathname(): string | null {
    const href = useSelector(
        appStore,
        (state) => selectActiveTab(state)?.lastResolvedHref ?? null
    );
    if (href === null) return null;
    const query = href.indexOf("?");
    return query === -1 ? href : href.slice(0, query);
}
