import { Film, FolderKanban, Gamepad2, Settings } from "lucide-react";
import type { ComponentType } from "react";

import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarSeparator,
} from "@/components/ui/sidebar";
import {
    TooltipCreateHandle,
    TooltipPayloadHost,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useActiveTabPathname } from "@/hooks/tabs/use-active-tab-pathname";
import { useActiveTabRouter } from "@/hooks/tabs/use-active-tab-router";
import { cn } from "@/lib/utils";

const handle = TooltipCreateHandle<ComponentType>();
const ACTIVE_NAV_ITEM_CLASS = "bg-foreground/10 hover:bg-foreground/10";

interface NavItem {
    to: "/" | "/games" | "/groups";
    label: string;
    icon: typeof Film;
    payload: () => React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
    { to: "/", label: "Clips", icon: Film, payload: () => <span>Clips</span> },
    {
        to: "/games",
        label: "Games",
        icon: Gamepad2,
        payload: () => <span>Games</span>,
    },
    {
        to: "/groups",
        label: "Groups",
        icon: FolderKanban,
        payload: () => <span>Groups</span>,
    },
];

function NavSidebarItem({ item }: { item: NavItem }) {
    const router = useActiveTabRouter();
    const pathname = useActiveTabPathname();
    const isActive = pathname === item.to;
    const Icon = item.icon;

    return (
        <SidebarMenuItem>
            <TooltipTrigger
                handle={handle}
                payload={item.payload}
                render={
                    <SidebarMenuButton
                        variant="ghost"
                        aria-current={isActive ? "page" : undefined}
                        className={cn(isActive && ACTIVE_NAV_ITEM_CLASS)}
                        onClick={() => void router?.navigate({ to: item.to })}
                    >
                        <Icon />
                        <span>{item.label}</span>
                    </SidebarMenuButton>
                }
            />
        </SidebarMenuItem>
    );
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
    const router = useActiveTabRouter();
    const pathname = useActiveTabPathname();
    const settingsActive = pathname === "/settings";

    return (
        <Sidebar variant="inset" collapsible="icon" {...props}>
            <TooltipProvider>
                <SidebarContent className="gap-1">
                    <SidebarGroup className="gap-1">
                        <SidebarGroupLabel>Library</SidebarGroupLabel>
                        {NAV_ITEMS.map((item) => (
                            <NavSidebarItem key={item.to} item={item} />
                        ))}
                    </SidebarGroup>
                </SidebarContent>
                <SidebarFooter>
                    <SidebarSeparator className="mx-0 data-[orientation=horizontal]:w-auto" />
                    <SidebarMenuItem>
                        <TooltipTrigger
                            handle={handle}
                            payload={() => <span>Settings</span>}
                            render={
                                <SidebarMenuButton
                                    variant="ghost"
                                    aria-current={
                                        settingsActive ? "page" : undefined
                                    }
                                    className={cn(
                                        settingsActive && ACTIVE_NAV_ITEM_CLASS
                                    )}
                                    onClick={() =>
                                        void router?.navigate({
                                            to: "/settings",
                                        })
                                    }
                                >
                                    <Settings />
                                    <span>Settings</span>
                                </SidebarMenuButton>
                            }
                        />
                    </SidebarMenuItem>
                </SidebarFooter>
                <TooltipPayloadHost handle={handle} side="right" />
            </TooltipProvider>
        </Sidebar>
    );
}
