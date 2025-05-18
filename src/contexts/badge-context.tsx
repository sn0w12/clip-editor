import React, { createContext, useContext, ReactNode, useState } from "react";

type BadgeContextType = {
    badgeContent: ReactNode | null;
    badgeVisible: boolean;
    setBadgeContent: (content: ReactNode | null) => void;
    setBadgeVisible: (visible: boolean) => void;
};

const BadgeContext = createContext<BadgeContextType | undefined>(undefined);

export function BadgeProvider({ children }: { children: ReactNode }) {
    const [badgeContent, setBadgeContent] = useState<ReactNode | null>(null);
    const [badgeVisible, setBadgeVisible] = useState<boolean>(false);

    return (
        <BadgeContext.Provider
            value={{
                badgeContent,
                setBadgeContent,
                badgeVisible,
                setBadgeVisible,
            }}
        >
            {children}
        </BadgeContext.Provider>
    );
}

export function useBadge() {
    const context = useContext(BadgeContext);
    if (context === undefined) {
        throw new Error("useBadge must be used within a BadgeProvider");
    }
    return context;
}
