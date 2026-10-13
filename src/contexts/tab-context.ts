import { createContext, useContext } from "react";

// Provided by each tab router's root route so pages resolve their own tab
// instead of global active-tab state.
export const TabContext = createContext<string | null>(null);

export function useTabId(): string {
    const tabId = useContext(TabContext);
    if (!tabId) {
        throw new Error("useTabId used outside a tab router");
    }
    return tabId;
}
