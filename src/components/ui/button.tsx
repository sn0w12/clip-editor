"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type * as React from "react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export const COLORED_BASE =
    "shadow-xs not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] *:data-[slot=button-loading-indicator]:text-white [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none";

export const buttonVariants = cva(
    "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border text-base font-medium whitespace-nowrap transition-shadow outline-none before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 data-loading:text-transparent data-loading:select-none sm:text-sm pointer-coarse:after:absolute pointer-coarse:after:size-full pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 [&_svg]:pointer-events-none [&_svg]:-mx-0.5 [&_svg]:shrink-0 [&_svg:not([class*='opacity-'])]:opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4",
    {
        defaultVariants: {
            size: "default",
            variant: "default",
        },
        variants: {
            size: {
                default: "h-9 px-[calc(--spacing(3)-1px)] sm:h-8",
                icon: "size-9 sm:size-8",
                "icon-lg": "size-10 sm:size-9",
                "icon-sm": "size-8 sm:size-7",
                "icon-xl":
                    "size-11 sm:size-10 [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
                "icon-xs":
                    "size-7 rounded-md before:rounded-[calc(var(--radius-md)-1px)] sm:size-6 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-4 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3.5",
                "icon-2xs":
                    "size-6 rounded-md before:rounded-[calc(var(--radius-md)-1px)] sm:size-5 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-3",
                "icon-3xs":
                    "size-5 rounded-sm before:rounded-[calc(var(--radius-sm)-1px)] sm:size-4 not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-2.5 sm:not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-2",
                lg: "h-10 px-[calc(--spacing(3.5)-1px)] sm:h-9",
                sm: "h-8 gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7",
                xl: "h-11 px-[calc(--spacing(4)-1px)] text-lg sm:h-10 sm:text-base [&_svg:not([class*='size-'])]:size-5 sm:[&_svg:not([class*='size-'])]:size-4.5",
                xs: "h-7 gap-1 rounded-md px-[calc(--spacing(2)-1px)] text-sm before:rounded-[calc(var(--radius-md)-1px)] sm:h-6 sm:text-xs [&_svg:not([class*='size-'])]:size-4 sm:[&_svg:not([class*='size-'])]:size-3.5",
                pill: "size-5 rounded-full before:rounded-full not-in-data-[slot=input-group]:[&_svg:not([class*='size-'])]:size-2.5",
            },
            variant: {
                default:
                    "border-primary bg-primary text-primary-foreground shadow-xs shadow-primary/24 not-disabled:inset-shadow-[0_1px_--theme(--color-white/16%)] hover:bg-primary/90 data-pressed:bg-primary/90 *:data-[slot=button-loading-indicator]:text-primary-foreground [:active,[data-pressed]]:inset-shadow-[0_1px_--theme(--color-black/8%)] [:disabled,:active,[data-pressed]]:shadow-none",
                destructive: cn(
                    "border-destructive bg-destructive text-white shadow-destructive/24 hover:bg-destructive/90 data-pressed:bg-destructive/90",
                    COLORED_BASE
                ),
                info: cn(
                    "border-info bg-info text-black shadow-info/24 hover:bg-info/90 data-pressed:bg-info/90 dark:text-background",
                    COLORED_BASE
                ),
                "destructive-outline":
                    "border-input bg-popover text-destructive-foreground shadow-xs/5 not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] hover:border-destructive/32 hover:bg-destructive/4 data-pressed:border-destructive/32 data-pressed:bg-destructive/4 *:data-[slot=button-loading-indicator]:text-foreground dark:bg-input/32 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] [:disabled,:active,[data-pressed]]:shadow-none",
                "destructive-ghost":
                    "border-transparent text-foreground hover:bg-destructive/12 hover:text-destructive",
                ghost: "border-transparent text-foreground hover:bg-accent data-pressed:bg-accent *:data-[slot=button-loading-indicator]:text-foreground",
                link: "border-transparent text-foreground underline-offset-4 hover:underline data-pressed:underline *:data-[slot=button-loading-indicator]:text-foreground",
                outline:
                    "border-input bg-popover text-foreground shadow-xs/5 not-dark:bg-clip-padding not-disabled:not-active:not-data-pressed:before:shadow-[0_1px_--theme(--color-black/4%)] hover:bg-accent/50 data-pressed:bg-accent/50 *:data-[slot=button-loading-indicator]:text-foreground dark:bg-input/32 dark:not-disabled:before:shadow-[0_-1px_--theme(--color-white/2%)] dark:not-disabled:not-active:not-data-pressed:before:shadow-[0_-1px_--theme(--color-white/6%)] dark:hover:bg-input/64 dark:data-pressed:bg-input/64 [:disabled,:active,[data-pressed]]:shadow-none",
                secondary:
                    "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/90 data-pressed:bg-secondary/90 *:data-[slot=button-loading-indicator]:text-secondary-foreground [:active,[data-pressed]]:bg-secondary/80",
            },
        },
    }
);

export interface ButtonProps extends useRender.ComponentProps<"button"> {
    variant?: VariantProps<typeof buttonVariants>["variant"];
    size?: VariantProps<typeof buttonVariants>["size"];
    loading?: boolean;
}

export function Button({
    className,
    variant,
    size,
    render,
    children,
    loading = false,
    disabled: disabledProp,
    ...props
}: ButtonProps): React.ReactElement {
    const isDisabled = Boolean(loading || disabledProp);
    const typeValue: React.ButtonHTMLAttributes<HTMLButtonElement>["type"] =
        render ? undefined : "button";

    const defaultProps = {
        children: (
            <>
                <div
                    className={cn(
                        "flex items-center gap-[inherit]",
                        loading && "opacity-0"
                    )}
                >
                    {children}
                </div>
                {loading && (
                    <Spinner
                        className="pointer-events-none absolute"
                        data-slot="button-loading-indicator"
                    />
                )}
            </>
        ),
        className: cn(buttonVariants({ className, size, variant })),
        "aria-disabled": loading || undefined,
        "data-loading": loading ? "" : undefined,
        "data-slot": "button",
        disabled: isDisabled,
        type: typeValue,
    };

    return useRender({
        defaultTagName: "button",
        props: mergeProps<"button">(defaultProps, props),
        render,
    });
}
