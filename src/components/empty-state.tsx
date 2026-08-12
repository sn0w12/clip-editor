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
                    <InboxIcon className="text-muted-foreground size-10" />
                </EmptyMedia>
                <EmptyTitle>{title}</EmptyTitle>
                {description ? <EmptyDescription>{description}</EmptyDescription> : null}
                {children}
            </EmptyContent>
        </Empty>
    );
}
