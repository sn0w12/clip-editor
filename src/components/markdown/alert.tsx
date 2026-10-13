import {
    CircleAlert,
    Info,
    Lightbulb,
    OctagonAlert,
    TriangleAlert,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Frame, FrameHeader, FramePanel } from "@/components/ui/frame";
import { cn } from "@/lib/utils";

interface AlertTone {
    label: string;
    icon: LucideIcon;
    text: string;
}

const TONES: Record<string, AlertTone> = {
    note: { label: "Note", icon: Info, text: "text-info" },
    tip: { label: "Tip", icon: Lightbulb, text: "text-success" },
    important: { label: "Important", icon: CircleAlert, text: "text-info" },
    warning: { label: "Warning", icon: TriangleAlert, text: "text-warning" },
    caution: { label: "Caution", icon: OctagonAlert, text: "text-destructive" },
};

/** A GitHub alert from a `> [!NOTE]` block, built from the same Frame parts as
 * every other framed surface. The extension emits the kind, never the markup. */
export function MarkdownAlert({
    "data-kind": kind,
    "data-title": title,
    children,
}: {
    "data-kind"?: string;
    "data-title"?: string;
    children?: React.ReactNode;
}) {
    const tone = TONES[kind ?? ""] ?? TONES.note;
    const Icon = tone.icon;
    return (
        <Frame role="note" className="my-2">
            <FrameHeader className="flex flex-row items-center gap-1.5 px-2 py-1.5">
                <Icon className={cn("size-3.5", tone.text)} />
                <span className={cn("text-xs font-medium", tone.text)}>
                    {title !== undefined && title.length > 0
                        ? title
                        : tone.label}
                </span>
            </FrameHeader>
            <FramePanel className="px-2 py-1.5 text-sm empty:hidden">
                {children}
            </FramePanel>
        </Frame>
    );
}
