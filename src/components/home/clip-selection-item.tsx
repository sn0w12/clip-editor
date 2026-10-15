import type * as React from "react";

import { MarqueeItem } from "@/components/ui/marquee";

export function ClipSelectionItem({
    value,
    children,
}: {
    value: string;
    children: React.ReactNode;
}): React.ReactElement {
    return (
        <MarqueeItem onClick={(event) => event.preventDefault()} value={value}>
            {children}
        </MarqueeItem>
    );
}
