import { Outlet, useRouterState } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Film, FolderKanban, Gamepad2, Settings } from "lucide-react";

import { UpdateButton } from "@/components/shell/update-button";
import { WindowControls } from "@/components/shell/window-controls";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuLink,
    SidebarProvider,
    SidebarTrigger,
    useSidebar,
} from "@/components/ui/sidebar";
import { BadgeProvider, useBadge } from "@/contexts/badge-context";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
    { to: "/" as const, label: "Clips", icon: Film },
    { to: "/games" as const, label: "Games", icon: Gamepad2 },
    { to: "/groups" as const, label: "Groups", icon: FolderKanban },
];

function TitleBar() {
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const crumbs = useRouteCrumbs(pathname);
    const { badgeContent, badgeVisible } = useBadge();
    return (
        <header
            data-tauri-drag-region
            className="bg-sidebar text-sidebar-foreground relative z-100 flex h-9 shrink-0 items-center gap-2"
        >
            <SidebarTrigger className="ml-2" />
            <nav
                aria-label="Breadcrumb"
                className="flex min-w-0 items-center gap-1 text-sm"
                data-tauri-drag-region
            >
                {crumbs.map((crumb, index) => (
                    <span key={index} className="flex items-center gap-1">
                        {index > 0 && <span className="text-muted-foreground select-none">/</span>}
                        {crumb.to ? (
                            <Link to={crumb.to} className="hover:underline">
                                {crumb.label}
                            </Link>
                        ) : (
                            <span className="text-muted-foreground">{crumb.label}</span>
                        )}
                    </span>
                ))}
            </nav>
            <div className="flex-1" />
            <Badge
                className={cn(
                    "h-6 pl-0 transition-all",
                    badgeVisible ? "opacity-100 blur-none" : "opacity-0 blur-[3px]",
                )}
                data-tauri-drag-region
            >
                {badgeContent}
            </Badge>
            <UpdateButton />
            <WindowControls />
        </header>
    );
}

function useRouteCrumbs(pathname: string): { label: string; to?: string }[] {
    if (pathname === "/clips/edit") return [{ label: "Clips", to: "/" }, { label: "Editor" }];
    if (pathname.startsWith("/games")) return [{ label: "Games", to: "/games" }, { label: "Game" }];
    if (pathname.startsWith("/groups"))
        return [{ label: "Groups", to: "/groups" }, { label: "Group" }];
    const item = NAV_ITEMS.find((i) => i.to === pathname);
    return item ? [{ label: item.label }] : [{ label: "Clip Editor" }];
}

function SidebarNavigation() {
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const settingsActive = pathname === "/settings";
    const { open } = useSidebar();
    return (
        <>
            <SidebarContent className="overflow-hidden">
                <SidebarGroup>
                    <SidebarGroupLabel>Library</SidebarGroupLabel>
                    <SidebarMenu>
                        {NAV_ITEMS.map((item) => {
                            const Icon = item.icon;
                            const active = pathname === item.to;
                            return (
                                <SidebarMenuItem key={item.to}>
                                    <SidebarMenuLink
                                        to={item.to}
                                        active={active}
                                        tooltip={item.label}
                                        className="p-0"
                                    >
                                        <Icon />
                                        <span
                                            className={cn(
                                                "truncate transition-[opacity,filter] duration-200 ease-snappy",
                                                open
                                                    ? "opacity-100 blur-none"
                                                    : "opacity-0 blur-[3px]",
                                            )}
                                        >
                                            {item.label}
                                        </span>
                                    </SidebarMenuLink>
                                </SidebarMenuItem>
                            );
                        })}
                    </SidebarMenu>
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuLink
                            to="/settings"
                            active={settingsActive}
                            tooltip="Settings"
                            className="p-0"
                        >
                            <Settings />
                            <span
                                className={cn(
                                    "truncate transition-[opacity,filter] duration-200 ease-snappy",
                                    open ? "opacity-100 blur-none" : "opacity-0 blur-[3px]",
                                )}
                            >
                                Settings
                            </span>
                        </SidebarMenuLink>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
        </>
    );
}

export function BaseLayout() {
    return (
        <BadgeProvider>
            <SidebarProvider>
                <div className="bg-sidebar text-primary flex h-screen w-full flex-col overflow-hidden">
                    <TitleBar />
                    <div className="flex flex-1 overflow-hidden">
                        <Sidebar collapsible="icon" aria-label="Main navigation">
                            <SidebarNavigation />
                        </Sidebar>
                        <main className="bg-background min-h-0 min-w-0 flex-1 overflow-hidden md:rounded-tl-xl md:border-t md:border-l">
                            <ScrollArea fill overflowX={false}>
                                <Outlet />
                            </ScrollArea>
                        </main>
                    </div>
                </div>
            </SidebarProvider>
        </BadgeProvider>
    );
}
