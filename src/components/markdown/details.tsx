import { ChevronDown } from "lucide-react";

import {
    Collapsible,
    CollapsiblePanel,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Frame, FrameHeader, FramePanel } from "@/components/ui/frame";
import { cn } from "@/lib/utils";

/**
 * The disclosure a `<details>`/`<summary>` pair becomes. The body arrives as
 * already-parsed markdown children, so headings, lists, and code fences
 * inside a release-notes block keep working.
 *
 * Built from the same Frame header and panel as a timeline message, so a
 * release-notes block nested in a body reads as part of the thread rather
 * than as an unstyled box.
 */
export function MarkdownDetails({
    children,
    className,
    "data-summary": summary,
    "data-open": open,
}: {
    children?: React.ReactNode;
    className?: string;
    "data-summary"?: string;
    "data-open"?: string;
}) {
    return (
        <Collapsible
            className={cn("my-2", className)}
            defaultOpen={open === "" || open === "open"}
        >
            <Frame>
                <FrameHeader className="flex flex-row items-center px-2 py-1">
                    <CollapsibleTrigger
                        className={cn(
                            "flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-0.5 py-0.5 text-sm font-medium",
                            // The chevron points right while closed and down
                            // while open, driven off the trigger's own state
                            // attribute.
                            "[&[data-panel-open]>svg]:rotate-0"
                        )}
                    >
                        <ChevronDown className="size-4 shrink-0 -rotate-90 transition-transform" />
                        <span className="truncate">{summary ?? "Details"}</span>
                    </CollapsibleTrigger>
                </FrameHeader>
                <CollapsiblePanel>
                    <FramePanel className="px-2 py-1.5 text-sm empty:hidden">
                        {children}
                    </FramePanel>
                </CollapsiblePanel>
            </Frame>
        </Collapsible>
    );
}
