import type { ComponentType } from "react";

import type { TitleBadge } from "@/stores/app-store";

// Bind persisted badge keys to component references here; hydration resolves
// them before first paint after a restart. A key must keep pointing at the
// same badge across releases, since the session document stores the key and
// never the component reference.
const BADGES: Array<[string, ComponentType]> = [];

const byKey = new Map<string, ComponentType>(BADGES);

export function resolveTitleBadge(
    key: string | undefined
): TitleBadge | undefined {
    if (!key) return undefined;
    const component = byKey.get(key);
    return component ? { key, component } : undefined;
}
