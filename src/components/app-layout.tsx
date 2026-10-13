import type { ReactNode } from "react";

import { SelectionContextMenu } from "@/components/selection/selection-context-menu";
import { ConfirmProvider } from "@/contexts/confirm-context";
import { useInsetBackdropClip } from "@/hooks/use-inset-backdrop-clip";

import { AppShortcuts } from "./app-shortcuts";
import { AppShortcutsHelp } from "./app-shortcuts-help";
import { AppSidebar } from "./app-sidebar";
import { Titlebar } from "./titlebar";
import { SidebarInset, SidebarProvider } from "./ui/sidebar";
import { ToastProvider } from "./ui/toast";
import { UpdateChecker } from "./updates/update-checker";

export function AppLayout({ children }: { children: ReactNode }) {
    useInsetBackdropClip();

    return (
        <div className="w-vw flex h-svh flex-col bg-sidebar">
            <ToastProvider>
                <ConfirmProvider>
                    <AppShortcuts />
                    <Titlebar />
                    <SidebarProvider open={false} className="min-h-0 flex-1">
                        <AppSidebar />
                        <SidebarInset className="min-h-0">
                            <div className="min-h-0 flex-1 overflow-hidden">
                                <SelectionContextMenu />
                                <AppShortcutsHelp />
                                <UpdateChecker />
                                {children}
                            </div>
                        </SidebarInset>
                    </SidebarProvider>
                </ConfirmProvider>
            </ToastProvider>
        </div>
    );
}
