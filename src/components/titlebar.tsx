"use client";

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import type { Modifiers } from "@dnd-kit/abstract";
import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useSelector } from "@tanstack/react-store";
import {
    ArrowDownToLine,
    ChevronLeft,
    ChevronRight,
    Copy,
    Plus,
    X,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useMemo, useRef } from "react";

import { WindowTitlebar } from "@/components/window-controls";
import { TabTitleContext } from "@/contexts/tab-title-context";
import { useActiveTabHistory } from "@/hooks/tabs/use-active-tab-router";
import {
    closeOtherTabsFully,
    closeTabFully,
    closeTabsToRightFully,
} from "@/lib/routing/tab-lifecycle";
import {
    openUpdateDialog,
    updaterController,
} from "@/lib/updates/update-manager";
import { cn, isMac } from "@/lib/utils";
import {
    activateTab,
    appStore,
    createTabRecord,
    DEFAULT_TAB_NAME,
    duplicateTab,
    moveTab,
    openTab,
    selectTabs,
} from "@/stores/app-store";
import type { TabRecord } from "@/stores/app-store";

import { RestrictToList } from "./dnd/restrict-to-list";
import { createTabCollisionDetector } from "./titlebar/tab-collision-detector";
import { Button } from "./ui/button";
import {
    ContextMenu,
    ContextMenuItem,
    ContextMenuItemSpacer,
    ContextMenuPopup,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuTrigger,
} from "./ui/context-menu";
import { ScrollArea } from "./ui/scroll-area";
import {
    TooltipCreateHandle,
    TooltipPayloadHost,
    TooltipProvider,
    TooltipTrigger,
} from "./ui/tooltip";

// WindowTitlebar has built in button styles, use spans with role button for custom styles.
export function Titlebar() {
    return (
        <WindowTitlebar className="relative z-30 shrink-0 bg-transparent">
            <div
                className={cn(
                    "flex h-full min-w-0 items-center gap-1 pl-2",
                    !isMac() && "pl-13"
                )}
                data-tauri-drag-region
            >
                <TitlebarHistory />
                <TitlebarTabList />
            </div>
        </WindowTitlebar>
    );
}

const tabCollisionDetector = createTabCollisionDetector();

const handle = TooltipCreateHandle<ComponentType>();
const BackContent = () => {
    return <span>Go Back</span>;
};
const ForwardContent = () => {
    return <span>Go Forward</span>;
};
const updateContent = () => {
    return <span>Install Update</span>;
};

export function TitlebarHistory() {
    // Drives the ACTIVE TAB's memory history, not the shell router's.
    const history = useActiveTabHistory();
    const updateAvailable = useSelector(
        updaterController.store,
        (state) => state.status === "available"
    );

    return (
        <div className="flex items-center gap-1" data-slot="titlebar-history">
            <TooltipProvider>
                <TooltipTrigger
                    handle={handle}
                    payload={BackContent}
                    render={
                        <Button
                            size="icon-xs"
                            variant="ghost"
                            disabled={!history.canGoBack}
                            onClick={() => {
                                history.back();
                            }}
                            style={
                                !history.canGoBack
                                    ? { opacity: "64%", pointerEvents: "none" }
                                    : {}
                            }
                            render={
                                <span role="button">
                                    <ChevronLeft />
                                </span>
                            }
                        />
                    }
                />
                <TooltipTrigger
                    handle={handle}
                    payload={ForwardContent}
                    render={
                        <Button
                            size="icon-xs"
                            variant="ghost"
                            disabled={!history.canGoForward}
                            onClick={() => {
                                history.forward();
                            }}
                            style={
                                !history.canGoForward
                                    ? { opacity: "64%", pointerEvents: "none" }
                                    : {}
                            }
                            render={
                                <span role="button">
                                    <ChevronRight />
                                </span>
                            }
                        />
                    }
                />
                {updateAvailable ? (
                    <TooltipTrigger
                        handle={handle}
                        payload={updateContent}
                        render={
                            <Button
                                size="pill"
                                variant="info"
                                className="mr-0.5"
                                aria-label="Install Update"
                                onClick={() => openUpdateDialog()}
                                render={
                                    <span role="button">
                                        <ArrowDownToLine className="size-3.5" />
                                    </span>
                                }
                            />
                        }
                    />
                ) : null}

                <TooltipPayloadHost handle={handle} />
            </TooltipProvider>
        </div>
    );
}

// Built at drag time: reads live bounds so resize/scroll stay correct.
// Resolves through the tabs-strip slot rather than a part ref so no
// render-phase code touches React refs.
function restrictToStripBounds() {
    return RestrictToList.configure({
        getBounds: () =>
            document
                .querySelector('[data-slot="tabs-strip"]')
                ?.getBoundingClientRect() ?? null,
    });
}

export function TitlebarTabList() {
    const tabs = useSelector(appStore, selectTabs);
    const activeTabId = useSelector(appStore, (state) => state.activeTabId);
    const restrictToList = useMemo(() => restrictToStripBounds(), []);
    const viewportRef = useRef<HTMLDivElement | null>(null);

    // Standard mouse wheels only scroll vertically; translate that into
    // horizontal tab scrolling, since the viewport is a plain overflow box.
    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const viewport = viewportRef.current;
        if (!viewport || viewport.scrollWidth <= viewport.clientWidth + 1) {
            return;
        }
        event.preventDefault();
        const line = event.deltaMode === 1 ? 16 : 1;
        const delta = event.deltaX !== 0 ? event.deltaX : event.deltaY * line;
        viewport.scrollLeft += delta;
    };

    return (
        <DragDropProvider
            onDragEnd={(event) => {
                if (event.canceled) return;
                const { source } = event.operation;
                if (
                    isSortable(source) &&
                    source.initialIndex !== source.index
                ) {
                    moveTab(String(source.id), source.index);
                }
            }}
        >
            <TabsPrimitive.Root
                className="flex min-w-0 flex-1 flex-col gap-2"
                data-slot="tabs"
                value={activeTabId ?? ""}
                onValueChange={(value) => {
                    if (typeof value === "string" && value) activateTab(value);
                }}
            >
                <TabsPrimitive.List
                    className="relative z-10 flex min-w-0 flex-1 items-center"
                    data-slot="tabs-list"
                >
                    <ScrollArea
                        className="-ml-3 min-w-0 flex-1"
                        viewportRef={viewportRef}
                        onWheel={handleWheel}
                        scrollBar={false}
                        scrollFade
                        overscrollContain
                    >
                        <div
                            data-slot="tabs-strip"
                            className="flex w-max flex-nowrap items-center gap-1 pt-1 pr-4 pl-3"
                        >
                            {tabs.map((tab, index) => (
                                <TitlebarTabContextMenu
                                    key={tab.tabId}
                                    tab={tab}
                                    index={index}
                                    modifiers={[restrictToList]}
                                >
                                    <TitlebarTab tab={tab} />
                                </TitlebarTabContextMenu>
                            ))}
                        </div>
                    </ScrollArea>
                    <TitlebarNewTab />
                </TabsPrimitive.List>
            </TabsPrimitive.Root>
        </DragDropProvider>
    );
}

type CornerDirection =
    | "bottom-left"
    | "bottom-right"
    | "top-left"
    | "top-right";

interface CornerProps extends React.ComponentProps<"svg"> {
    size?: number;
    direction?: CornerDirection;
    className?: string;
    color?: string;
}

/** Rounded notch bridging the active tab into the inset below it. */
function Corner({
    size = 15,
    direction = "bottom-left",
    className = "",
    color = "var(--background)",
    ...restProps
}: CornerProps) {
    const transforms: Record<CornerDirection, string> = {
        "bottom-left": "",
        "bottom-right": "scale(-1, 1) translate(-15, 0)",
        "top-left": "scale(1, -1) translate(0, -15)",
        "top-right": "scale(-1, -1) translate(-15, -15)",
    };

    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 15 15"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
            {...restProps}
        >
            <g transform={transforms[direction]}>
                <path
                    d="M15 15H0C8.28427 15 15 8.28427 15 0V15Z"
                    fill={color}
                />
            </g>
        </svg>
    );
}

function TitlebarTab({ tab }: { tab: TabRecord }) {
    const hasMoreTabs = useSelector(appStore, (state) => state.tabs.length > 1);
    const isActive = useSelector(
        appStore,
        (state) => state.activeTabId === tab.tabId
    );
    const close = (event: React.MouseEvent | React.KeyboardEvent) => {
        event.stopPropagation();
        event.preventDefault();
        void closeTabFully(tab.tabId);
    };

    return (
        <TabsPrimitive.Tab
            className={cn(
                "group/tab relative flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-t-md pl-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-[color] duration-150 hover:text-foreground/64 data-disabled:pointer-events-none data-disabled:opacity-64 data-active:h-7 data-active:rounded-t-lg data-active:bg-background data-active:text-foreground data-active:hover:text-foreground/84",
                "data-active:filter-[drop-shadow(0px_-1px_1px_oklab(from_rgb(0_0_0_/_0.1)_l_a_b_/_9%))]",
                "dark:data-active:filter-[drop-shadow(0px_-1px_1px_oklab(from_rgb(255_255_255_/_0.1)_l_a_b_/_12%))]",
                "not-data-active:mb-1 not-data-active:h-6 not-data-active:rounded-b-md not-data-active:transition-colors not-data-active:hover:bg-accent",
                hasMoreTabs ? "pr-0.5" : "pr-2.5"
            )}
            data-slot="tabs-tab"
            id={tab.tabId}
            value={tab.tabId}
            render={<span />}
        >
            {isActive && (
                <>
                    <Corner
                        size={14}
                        direction="bottom-left"
                        data-corner="bottom-left"
                        className="absolute bottom-0 -left-[calc(var(--spacing)*-3.5)-1px]"
                    />
                    <Corner
                        size={14}
                        direction="bottom-right"
                        data-corner="bottom-right"
                        className="absolute -right-[calc(var(--spacing)*-3.5)-1px] bottom-0"
                    />
                </>
            )}
            <span
                className={cn(
                    "max-w-60 truncate text-xs text-edge-text",
                    isActive && "mb-1"
                )}
            >
                {tab.titleBadge ? (
                    <TabTitleContext value={tab.tabId}>
                        <tab.titleBadge.component />
                    </TabTitleContext>
                ) : (
                    tab.title
                )}
            </span>
            <Button
                variant="destructive-ghost"
                size="icon-2xs"
                className={cn(isActive && "mb-1", !hasMoreTabs && "hidden")}
                onClick={close}
                onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ")
                        close(event);
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                render={
                    <span
                        role="button"
                        tabIndex={-1}
                        aria-label={`Close ${tab.title}`}
                    >
                        <X />
                    </span>
                }
            />
        </TabsPrimitive.Tab>
    );
}

function TitlebarNewTab() {
    const NewTabContent = () => {
        return (
            <span>
                New Tab <ContextMenuShortcut shortcut="newTabShortcut" />
            </span>
        );
    };

    return (
        <TooltipTrigger
            handle={handle}
            payload={NewTabContent}
            render={
                <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="New tab"
                    className="-ml-3"
                    onClick={() => {
                        openTab(createTabRecord({ title: DEFAULT_TAB_NAME }));
                    }}
                    render={
                        <span role="button">
                            <Plus />
                        </span>
                    }
                />
            }
        />
    );
}

function TitlebarTabContextMenu({
    tab,
    index,
    modifiers,
    children,
}: {
    tab: TabRecord;
    index: number;
    modifiers: Modifiers;
    children: ReactNode;
}) {
    const hasMoreTabs = useSelector(appStore, (state) => state.tabs.length > 1);
    const hasTabsToRight = useSelector(appStore, (state) => {
        return index !== -1 && index < state.tabs.length - 1;
    });
    const { ref } = useSortable({
        id: tab.tabId,
        index,
        modifiers,
        // Midpoint crossing with a dead zone; the default detector swaps on
        // any rectangle overlap, which misfires between tabs of unequal width.
        collisionDetector: tabCollisionDetector,
    });

    return (
        <ContextMenu>
            <ContextMenuTrigger ref={ref}>{children}</ContextMenuTrigger>
            <ContextMenuPopup>
                <ContextMenuItem
                    onClick={() => void closeTabFully(tab.tabId)}
                    disabled={!hasMoreTabs}
                >
                    <X aria-hidden="true" />
                    Close
                    <ContextMenuShortcut shortcut="closeTabShortcut" />
                </ContextMenuItem>
                <ContextMenuItem
                    onClick={() => void closeOtherTabsFully(tab.tabId)}
                    disabled={!hasMoreTabs}
                >
                    <ContextMenuItemSpacer />
                    Close Others
                </ContextMenuItem>
                <ContextMenuItem
                    onClick={() => void closeTabsToRightFully(tab.tabId)}
                    disabled={!hasTabsToRight}
                >
                    <ContextMenuItemSpacer />
                    Close to the Right
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => duplicateTab(tab)}>
                    <Copy aria-hidden="true" />
                    Duplicate
                </ContextMenuItem>
            </ContextMenuPopup>
        </ContextMenu>
    );
}
