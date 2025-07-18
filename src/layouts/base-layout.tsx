import { scan } from "react-scan";
import React from "react";
import DragWindowRegion from "@/components/drag-window-region";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar,
} from "@/components/ui/sidebar";
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Disc3, Folder, Gamepad2, SettingsIcon } from "lucide-react";
import { useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { SelectionProvider } from "@/contexts/selection-context";
import { SelectionOverlay } from "@/components/selection/selection-overlay";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmProvider } from "@/contexts/confirm-context";
import { DevContextMenu } from "@/components/dev/dev-context-menu";
import { platform } from "@/platform";
import { VideoStoreProvider } from "@/contexts/video-store-context";
import { SteamProvider } from "@/contexts/steam-context";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { BadgeProvider, useBadge } from "@/contexts/badge-context";
import { useSetting } from "@/utils/settings";
import { GoogleProvider } from "@/contexts/google-context";

const inDevelopment = process.env.NODE_ENV === "development";
scan({
    enabled: inDevelopment,
});

const MainElementContext =
    React.createContext<React.RefObject<HTMLElement | null> | null>(null);
export function useMainElement() {
    const context = React.useContext(MainElementContext);
    if (!context) {
        throw new Error("useMainElement must be used within a BaseLayout");
    }
    return context;
}

function BaseLayoutContent({
    children,
    mainRef,
}: {
    children: React.ReactNode;
    mainRef: React.RefObject<HTMLElement | null>;
}) {
    const router = useRouter();
    const navigate = useNavigate();
    const routerState = useRouterState();
    const [segments, setSegments] = React.useState<string[]>([]);
    const [lastPathname, setLastPathname] = React.useState<string>("/");
    const { state: sidebarState } = useSidebar();
    const isSidebarCollapsed = sidebarState === "collapsed";
    const { badgeContent, badgeVisible } = useBadge();
    const windowIconsStyle = useSetting("windowIconsStyle");

    React.useEffect(() => {
        sessionStorage.setItem("lastPathname", lastPathname);
        const pathname = routerState.location.pathname;
        setLastPathname(pathname);
        let segments = pathname.split("/").filter(Boolean);

        if (segments.length === 0) {
            segments = ["clips"];
        }

        setSegments(segments);
    }, [routerState.location.pathname]);

    const getSegmentDisplayName = (segment: string) => {
        // First decode the URL component, then apply capitalization
        const decodedSegment = decodeURIComponent(segment);
        return decodedSegment.charAt(0).toUpperCase() + decodedSegment.slice(1);
    };

    function getSegmentLink(
        segment: string,
        index: number,
        segments: string[],
    ) {
        if (segment === "clips") {
            return "/";
        }

        return `/${segments.slice(0, index + 1).join("/")}`;
    }

    return (
        <div className="flex h-screen flex-col">
            <DragWindowRegion title="App Template">
                <div
                    className={`flex h-full w-full items-center justify-between pr-2 transition-all ${isSidebarCollapsed ? "pl-2" : "pl-1"}`}
                >
                    <Breadcrumb>
                        <BreadcrumbList>
                            {inDevelopment && (
                                <div className="bg-accent-negative h-2 w-2 rounded-full"></div>
                            )}
                            {segments.map((segment, index) => (
                                <React.Fragment key={index}>
                                    {index != 0 && <BreadcrumbSeparator />}
                                    <BreadcrumbItem>
                                        <BreadcrumbLink
                                            href={getSegmentLink(
                                                segment,
                                                index,
                                                segments,
                                            )}
                                        >
                                            {getSegmentDisplayName(segment)}
                                        </BreadcrumbLink>
                                    </BreadcrumbItem>
                                </React.Fragment>
                            ))}
                        </BreadcrumbList>
                    </Breadcrumb>
                    <Badge
                        className={`${windowIconsStyle === "custom" ? "mr-40" : ""} h-6 px-1 transition-all ${badgeVisible ? "opacity-100" : "opacity-0"}`}
                    >
                        {badgeContent}
                    </Badge>
                </div>
            </DragWindowRegion>
            <div className="bg-sidebar flex flex-1 overflow-hidden">
                <Sidebar collapsible="icon">
                    <SidebarContent>
                        <SidebarMenu className="relative bottom-0.5 p-2">
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    tooltip="Clips"
                                    onClick={() => navigate({ to: "/" })}
                                    isActive={
                                        router.state.location.pathname === "/"
                                    }
                                >
                                    <Disc3 />
                                    <span>Clips</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>

                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    tooltip="Games"
                                    onClick={() => navigate({ to: "/games" })}
                                    isActive={
                                        router.state.location.pathname ===
                                        "/games"
                                    }
                                >
                                    <Gamepad2 />
                                    <span>Games</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>

                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    tooltip="Groups"
                                    onClick={() => navigate({ to: "/groups" })}
                                    isActive={
                                        router.state.location.pathname ===
                                        "/groups"
                                    }
                                >
                                    <Folder />
                                    <span>Groups</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>

                            {inDevelopment && (
                                <SidebarMenuItem>
                                    <SidebarMenuButton
                                        tooltip="Performance"
                                        onClick={() =>
                                            navigate({
                                                to: "/performance",
                                            })
                                        }
                                        isActive={
                                            router.state.location.pathname ===
                                            "/performance"
                                        }
                                    >
                                        <div className="bg-accent-negative h-2 w-2 rounded-full"></div>
                                        <span>Performance</span>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            )}
                        </SidebarMenu>
                    </SidebarContent>
                    <SidebarFooter>
                        <Separator />

                        <SidebarMenuItem>
                            <SidebarMenuButton
                                tooltip="Settings"
                                onClick={() =>
                                    navigate({
                                        to: `/settings`,
                                    })
                                }
                                isActive={
                                    router.state.location.pathname ===
                                    "/settings"
                                }
                            >
                                <SettingsIcon />
                                <span>Settings</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarFooter>
                </Sidebar>
                <main
                    ref={mainRef}
                    className="bg-background flex-1 overflow-auto overflow-x-hidden border-t md:rounded-tl-xl md:border-l"
                >
                    <div className="h-full p-0">{children}</div>
                    <Toaster />
                </main>
            </div>
        </div>
    );
}

export default function BaseLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const mainRef = React.useRef<HTMLElement>(null);
    const isWeb = platform.isWeb();

    return (
        <MainElementContext.Provider value={mainRef}>
            <SteamProvider>
                <GoogleProvider>
                    <VideoStoreProvider>
                        <SelectionProvider>
                            <ConfirmProvider>
                                <BadgeProvider>
                                    <SelectionOverlay containerRef={mainRef} />
                                    {isWeb ? (
                                        <BaseLayoutContent mainRef={mainRef}>
                                            {children}
                                        </BaseLayoutContent>
                                    ) : (
                                        <DevContextMenu>
                                            <BaseLayoutContent
                                                mainRef={mainRef}
                                            >
                                                {children}
                                            </BaseLayoutContent>
                                        </DevContextMenu>
                                    )}
                                </BadgeProvider>
                            </ConfirmProvider>
                        </SelectionProvider>
                    </VideoStoreProvider>
                </GoogleProvider>
            </SteamProvider>
        </MainElementContext.Provider>
    );
}
