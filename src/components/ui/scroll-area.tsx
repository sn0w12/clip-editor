"use client";

import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type React from "react";

import { cn } from "@/lib/utils";

export function ScrollArea({
    className,
    children,
    viewportRef,
    scrollFade = false,
    scrollbarGutter = false,
    fill = false,
    clampContentMinWidth = true,
    overscrollContain = false,
    scrollBar = true,
    scrollX = true,
    ...props
}: ScrollAreaPrimitive.Root.Props & {
    viewportRef?: React.Ref<HTMLDivElement>;
    scrollFade?: boolean;
    scrollbarGutter?: boolean;
    fill?: boolean;
    clampContentMinWidth?: boolean;
    overscrollContain?: boolean;
    scrollBar?: boolean;
    /** When false, horizontal scrolling is disabled entirely (clipped). */
    scrollX?: boolean;
}): React.ReactElement {
    return (
        <ScrollAreaPrimitive.Root
            className={cn("h-full min-h-0 w-full", className)}
            {...props}
        >
            <ScrollAreaPrimitive.Viewport
                ref={viewportRef}
                className={cn(
                    "transition-shadows h-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                    !scrollX && "overflow-x-hidden",
                    overscrollContain &&
                        "data-has-overflow-x:overscroll-x-contain data-has-overflow-y:overscroll-y-contain",
                    scrollFade &&
                        "mask-t-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-start)))] mask-r-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-end)))] mask-b-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-y-end)))] mask-l-from-[calc(100%-min(var(--fade-size),var(--scroll-area-overflow-x-start)))] [--fade-size:1.5rem]",
                    scrollbarGutter &&
                        "data-has-overflow-x:pb-2.5 data-has-overflow-y:pe-2.5"
                )}
                style={scrollX ? undefined : { overflowX: "hidden" }}
                data-slot="scroll-area-viewport"
            >
                <ScrollAreaPrimitive.Content
                    className={cn(fill && "size-full")}
                    data-slot="scroll-area-content"
                    style={
                        clampContentMinWidth
                            ? { minWidth: scrollX ? 0 : "100%" }
                            : undefined
                    }
                >
                    {children}
                </ScrollAreaPrimitive.Content>
            </ScrollAreaPrimitive.Viewport>
            {scrollBar && <ScrollBar orientation="vertical" />}
            {scrollBar && scrollX && <ScrollBar orientation="horizontal" />}
            <ScrollAreaPrimitive.Corner data-slot="scroll-area-corner" />
        </ScrollAreaPrimitive.Root>
    );
}

export function ScrollBar({
    className,
    orientation = "vertical",
    ...props
}: ScrollAreaPrimitive.Scrollbar.Props): React.ReactElement {
    return (
        <ScrollAreaPrimitive.Scrollbar
            className={cn(
                "m-1 flex opacity-0 transition-opacity delay-300 data-hovering:opacity-100 data-hovering:delay-0 data-hovering:duration-100 data-scrolling:opacity-100 data-scrolling:delay-0 data-scrolling:duration-100 data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:flex-col data-[orientation=vertical]:w-1.5",
                className
            )}
            data-slot="scroll-area-scrollbar"
            orientation={orientation}
            {...props}
        >
            <ScrollAreaPrimitive.Thumb
                className="relative flex-1 rounded-full bg-foreground/20"
                data-slot="scroll-area-thumb"
            />
        </ScrollAreaPrimitive.Scrollbar>
    );
}

export { ScrollAreaPrimitive };
