import { createContext, useContext } from "react";

// Provided by the titlebar's TitlebarTab so page-provided title components
// (rendered prop-less) can resolve their own tab record.
export const TabTitleContext = createContext<string | null>(null);

export function useTitlebarTabId(): string {
    const tabId = useContext(TabTitleContext);
    if (!tabId) {
        throw new Error("useTitlebarTabId used outside a titlebar tab");
    }
    return tabId;
}
