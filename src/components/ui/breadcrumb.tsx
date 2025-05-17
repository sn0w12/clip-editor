import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { Link as TanStackLink } from "@tanstack/react-router";

import { cn } from "@/utils/tailwind";

function Breadcrumb({ ...props }: React.ComponentProps<"nav">) {
    return <nav aria-label="breadcrumb" data-slot="breadcrumb" {...props} />;
}

function BreadcrumbList({ className, ...props }: React.ComponentProps<"ol">) {
    return (
        <ol
            data-slot="breadcrumb-list"
            className={cn(
                "text-muted-foreground flex flex-wrap items-center gap-1.5 text-sm break-words",
                className,
            )}
            {...props}
        />
    );
}

function BreadcrumbItem({ className, ...props }: React.ComponentProps<"li">) {
    return (
        <li
            data-slot="breadcrumb-item"
            className={cn("inline-flex items-center gap-1.5", className)}
            {...props}
        />
    );
}

function BreadcrumbLink({
    asChild,
    className,
    href,
    children,
    ...props
}: Omit<React.ComponentProps<typeof TanStackLink>, "children"> & {
    asChild?: boolean;
    children?: React.ReactNode;
}) {
    const Comp = asChild ? Slot : TanStackLink;

    return (
        <Comp
            data-slot="breadcrumb-link"
            to={href}
            className={cn(
                "hover:text-foreground cursor-pointer transition-colors",
                className,
            )}
            style={
                {
                    WebkitAppRegion: "no-drag",
                } as React.CSSProperties
            }
            {...props}
        >
            {children}
        </Comp>
    );
}

function BreadcrumbPage({ className, ...props }: React.ComponentProps<"span">) {
    return (
        <span
            data-slot="breadcrumb-page"
            role="link"
            aria-disabled="true"
            aria-current="page"
            className={cn("text-foreground font-normal", className)}
            {...props}
        />
    );
}

function BreadcrumbSeparator({
    children,
    className,
    ...props
}: React.ComponentProps<"li">) {
    return (
        <li
            data-slot="breadcrumb-separator"
            role="presentation"
            aria-hidden="true"
            className={cn("[&>svg]:size-3.5", className)}
            {...props}
        >
            {children ?? <ChevronRight />}
        </li>
    );
}

function BreadcrumbEllipsis({
    className,
    ...props
}: React.ComponentProps<"span">) {
    return (
        <span
            data-slot="breadcrumb-ellipsis"
            role="presentation"
            aria-hidden="true"
            className={cn("flex size-9 items-center justify-center", className)}
            {...props}
        >
            <MoreHorizontal className="size-4" />
            <span className="sr-only">More</span>
        </span>
    );
}

export {
    Breadcrumb,
    BreadcrumbList,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbPage,
    BreadcrumbSeparator,
    BreadcrumbEllipsis,
};
