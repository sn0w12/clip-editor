import * as React from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { CheckIcon, ChevronRightIcon, CircleIcon, Code } from "lucide-react";

import { cn } from "@/utils/tailwind";
import { ContextKeyboardShortcut } from "./keyboard-shortcut";
import { useConfirm } from "@/contexts/confirm-context";
import { platform } from "@/platform";

function ContextMenu({
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
    return <ContextMenuPrimitive.Root data-slot="context-menu" {...props} />;
}

function ContextMenuTrigger({
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
    return (
        <ContextMenuPrimitive.Trigger
            data-slot="context-menu-trigger"
            {...props}
        />
    );
}

function ContextMenuGroup({
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Group>) {
    return (
        <ContextMenuPrimitive.Group data-slot="context-menu-group" {...props} />
    );
}

function ContextMenuPortal({
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Portal>) {
    return (
        <ContextMenuPrimitive.Portal
            data-slot="context-menu-portal"
            {...props}
        />
    );
}

function ContextMenuSub({
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
    return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />;
}

function ContextMenuRadioGroup({
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
    return (
        <ContextMenuPrimitive.RadioGroup
            data-slot="context-menu-radio-group"
            {...props}
        />
    );
}

function ContextMenuSubTrigger({
    className,
    inset,
    children,
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
    inset?: boolean;
}) {
    return (
        <ContextMenuPrimitive.SubTrigger
            data-slot="context-menu-sub-trigger"
            data-inset={inset}
            className={cn(
                "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className,
            )}
            {...props}
        >
            {children}
            <ChevronRightIcon className="ml-auto" />
        </ContextMenuPrimitive.SubTrigger>
    );
}

function ContextMenuSubContent({
    className,
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
    return (
        <ContextMenuPrimitive.SubContent
            data-slot="context-menu-sub-content"
            className={cn(
                "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden rounded-md border p-1 shadow-lg",
                className,
            )}
            {...props}
        />
    );
}

function ContextMenuContent({
    className,
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
    const inDevelopment = process.env.NODE_ENV === "development";
    const isWeb = platform.isWeb();
    const [position, setPosition] = React.useState({ x: 0, y: 0 });

    React.useEffect(() => {
        if (!inDevelopment || isWeb) return;

        const handleContextMenu = (e: MouseEvent) => {
            e.preventDefault();
            setPosition({ x: e.clientX, y: e.clientY });
        };

        document.addEventListener("contextmenu", handleContextMenu);
        return () =>
            document.removeEventListener("contextmenu", handleContextMenu);
    }, [inDevelopment, isWeb]);

    const handleInspectElement = async () => {
        if (window.electronWindow) {
            await window.electronWindow.inspectElement(position.x, position.y);
        }
    };

    return (
        <ContextMenuPrimitive.Portal>
            <ContextMenuPrimitive.Content
                data-slot="context-menu-content"
                className={cn(
                    "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 max-h-(--radix-context-menu-content-available-height) min-w-[8rem] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border p-1 shadow-md",
                    className,
                )}
                {...props}
            >
                {props.children}
                {inDevelopment && !isWeb && (
                    <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={handleInspectElement}>
                            <Code className="mr-2 h-4 w-4" />
                            Inspect Element
                        </ContextMenuItem>
                    </>
                )}
            </ContextMenuPrimitive.Content>
        </ContextMenuPrimitive.Portal>
    );
}

function ContextMenuItem({
    className,
    inset,
    variant = "default",
    confirmDescription = null,
    onClick,
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
    inset?: boolean;
    variant?: "default" | "destructive";
    confirmDescription?: string | null;
}) {
    const { confirm } = useConfirm();
    // Store the pending action in a ref to execute after menu closes
    const pendingActionRef = React.useRef<
        ((event: React.MouseEvent<HTMLDivElement>) => void) | null
    >(null);

    // This gets called when user clicks the menu item
    const handleClick = React.useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
            if (variant === "destructive") {
                // Store the onClick handler to be executed later if confirmed
                pendingActionRef.current = onClick || null;
                setTimeout(async () => {
                    const confirmed = await confirm({
                        title: "Confirm Action",
                        description:
                            confirmDescription ??
                            "Are you sure you want to proceed with this action?",
                        confirmText: "Proceed",
                        cancelText: "Cancel",
                        variant: "destructive",
                    });

                    // If confirmed and we have a pending action, execute it
                    if (confirmed && pendingActionRef.current) {
                        pendingActionRef.current(event);
                        pendingActionRef.current = null;
                    }
                }, 100);

                return;
            }

            // For non-destructive actions, proceed normally
            onClick?.(event);
        },
        [onClick, variant, confirm, confirmDescription],
    );

    return (
        <ContextMenuPrimitive.Item
            data-slot="context-menu-item"
            data-inset={inset}
            data-variant={variant}
            className={cn(
                "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className,
            )}
            onClick={handleClick}
            {...props}
        />
    );
}

function ContextMenuShortcutItem({
    children,
    keys,
    className,
    onClick,
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
    keys?: string[];
}) {
    return (
        <ContextMenuPrimitive.Item
            data-slot="context-menu-item"
            className={cn(
                "focus:bg-accent focus:text-accent-foreground data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive data-[variant=destructive]:*:[svg]:!text-destructive [&_svg:not([class*='text-'])]:text-muted-foreground relative flex cursor-default items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className,
            )}
            onClick={onClick}
            {...props}
        >
            <div className="flex flex-row items-center gap-2">{children}</div>
            {keys && keys.length > 0 && <ContextKeyboardShortcut keys={keys} />}
        </ContextMenuPrimitive.Item>
    );
}

function ContextMenuCheckboxItem({
    className,
    children,
    checked,
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.CheckboxItem>) {
    return (
        <ContextMenuPrimitive.CheckboxItem
            data-slot="context-menu-checkbox-item"
            className={cn(
                "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className,
            )}
            checked={checked}
            {...props}
        >
            <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                <ContextMenuPrimitive.ItemIndicator>
                    <CheckIcon className="size-4" />
                </ContextMenuPrimitive.ItemIndicator>
            </span>
            {children}
        </ContextMenuPrimitive.CheckboxItem>
    );
}

function ContextMenuRadioItem({
    className,
    children,
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem>) {
    return (
        <ContextMenuPrimitive.RadioItem
            data-slot="context-menu-radio-item"
            className={cn(
                "focus:bg-accent focus:text-accent-foreground relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
                className,
            )}
            {...props}
        >
            <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
                <ContextMenuPrimitive.ItemIndicator>
                    <CircleIcon className="size-2 fill-current" />
                </ContextMenuPrimitive.ItemIndicator>
            </span>
            {children}
        </ContextMenuPrimitive.RadioItem>
    );
}

function ContextMenuLabel({
    className,
    inset,
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
    inset?: boolean;
}) {
    return (
        <ContextMenuPrimitive.Label
            data-slot="context-menu-label"
            data-inset={inset}
            className={cn(
                "text-foreground px-2 py-1.5 text-sm font-medium data-[inset]:pl-8",
                className,
            )}
            {...props}
        />
    );
}

function ContextMenuSeparator({
    className,
    ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
    return (
        <ContextMenuPrimitive.Separator
            data-slot="context-menu-separator"
            className={cn("bg-border -mx-1 my-1 h-px", className)}
            {...props}
        />
    );
}

function ContextMenuShortcut({
    className,
    ...props
}: React.ComponentProps<"span">) {
    return (
        <span
            data-slot="context-menu-shortcut"
            className={cn(
                "text-muted-foreground ml-auto text-xs tracking-widest",
                className,
            )}
            {...props}
        />
    );
}

export {
    ContextMenu,
    ContextMenuTrigger,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuShortcutItem,
    ContextMenuCheckboxItem,
    ContextMenuRadioItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuGroup,
    ContextMenuPortal,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuRadioGroup,
};
