import { createContext, useContext, useMemo, useState } from "react";
import type * as React from "react";

interface BadgeContextValue {
    badgeContent: React.ReactNode;
    badgeVisible: boolean;
    setBadgeContent: (content: React.ReactNode) => void;
    setBadgeVisible: (visible: boolean) => void;
}

const BadgeContext = createContext<BadgeContextValue | null>(null);

export function BadgeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
    const [badgeContent, setBadgeContent] = useState<React.ReactNode>(null);
    const [badgeVisible, setBadgeVisible] = useState(false);

    const value = useMemo(
        () => ({ badgeContent, badgeVisible, setBadgeContent, setBadgeVisible }),
        [badgeContent, badgeVisible],
    );

    return <BadgeContext.Provider value={value}>{children}</BadgeContext.Provider>;
}

export function useBadge(): BadgeContextValue {
    const context = useContext(BadgeContext);
    if (!context) {
        throw new Error("useBadge must be used within a BadgeProvider");
    }
    return context;
}
