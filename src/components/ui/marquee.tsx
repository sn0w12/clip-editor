"use client";

import type * as React from "react";
import {
    createHandle,
    Marquee as MarqueePrimitive,
} from "react-marquee-select";
import type {
    SelectionItemProps,
    SelectionOverlayProps,
    SelectionRootProps,
    SelectionSurfaceProps,
} from "react-marquee-select";

import { cn } from "@/lib/utils";

export function Marquee({
    className,
    ...props
}: SelectionRootProps): React.ReactElement {
    return (
        <MarqueePrimitive.Root
            className={className}
            data-slot="marquee"
            {...props}
        />
    );
}

export function MarqueeSurface({
    className,
    ...props
}: SelectionSurfaceProps): React.ReactElement {
    return (
        <MarqueePrimitive.Surface
            className={className}
            data-slot="marquee-surface"
            {...props}
        />
    );
}

export function MarqueeItem({
    className,
    ...props
}: SelectionItemProps): React.ReactElement {
    return (
        <MarqueePrimitive.Item
            className={className}
            data-slot="marquee-item"
            {...props}
        />
    );
}

export function MarqueeOverlay({
    className,
    ...props
}: SelectionOverlayProps): React.ReactElement {
    return (
        <MarqueePrimitive.Overlay
            className={cn(
                "z-50 rounded-lg border border-primary/50 bg-primary/10",
                className
            )}
            data-slot="marquee-overlay"
            {...props}
        />
    );
}

export { createHandle, MarqueePrimitive };
export type {
    ModifierHandler,
    SelectionHandleRef,
    SelectionItemProps,
    SelectionOverlayProps,
    SelectionRootProps,
    SelectionSurfaceProps,
} from "react-marquee-select";
