import { InboxIcon } from "lucide-react";
import type * as React from "react";

import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyMedia,
    EmptyTitle,
} from "@/components/ui/empty";

export function EmptyState({
    title,
    description,
    children,
}: {
    title: React.ReactNode;
    description?: React.ReactNode;
    children?: React.ReactNode;
}): React.ReactElement {
    return (
        <Empty>
            <EmptyContent>
                <EmptyMedia>
                    <InboxIcon className="size-10 text-muted-foreground" />
                </EmptyMedia>
                <EmptyTitle className="ui-selectable font-display text-3xl font-normal">
                    {title}
                </EmptyTitle>
                {description ? (
                    <EmptyDescription className="ui-selectable">
                        {description}
                    </EmptyDescription>
                ) : null}
                {children}
            </EmptyContent>
        </Empty>
    );
}
