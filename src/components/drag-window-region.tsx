import {
    closeWindow,
    maximizeWindow,
    minimizeWindow,
} from "@/helpers/window-helpers";
import React, { useEffect, useState, type ReactNode } from "react";
import { SidebarTrigger } from "./ui/sidebar";
import { TopRight } from "./header/top-right";
import { Button } from "@/components/ui/button";
import { Copy, Minus, Square, X } from "lucide-react";
import { useSetting } from "@/utils/settings";
import { platform } from "@/platform";

interface DragWindowRegionProps {
    title?: ReactNode;
    children?: ReactNode;
}

export default function DragWindowRegion({ children }: DragWindowRegionProps) {
    return (
        <div className="bg-sidebar flex w-screen items-stretch justify-between overflow-visible">
            <div className="draglayer bg-sidebar flex w-full items-center overflow-visible">
                <SidebarTrigger
                    className="z-20 ml-2 h-8 w-8 overflow-visible"
                    style={
                        {
                            WebkitAppRegion: "no-drag",
                        } as React.CSSProperties
                    }
                />
                {children && <div className="h-full flex-1">{children}</div>}
            </div>
            <TopRight />
            <WindowButtons />
        </div>
    );
}

function WindowButtons() {
    const [isMaximized, setIsMaximized] = useState(false);
    const windowIconsStyle = useSetting("windowIconsStyle");

    useEffect(() => {
        if (window.electronWindow?.isMaximized) {
            window.electronWindow
                .isMaximized()
                .then((maximized) => {
                    setIsMaximized(maximized);
                })
                .catch((err) =>
                    console.error("Error checking maximized state:", err),
                );
        }

        // Listen for changes
        const handleWindowStateChange = (maximized: boolean) => {
            setIsMaximized(maximized);
        };

        if (window.electronWindow?.onWindowStateChange) {
            window.electronWindow.onWindowStateChange(handleWindowStateChange);
        }
    }, []);

    if (platform.isWeb()) {
        return null; // Don't show window buttons on web platform
    }

    if (windowIconsStyle === "traditional") {
        return (
            <div className="flex">
                <button
                    title="Minimize"
                    type="button"
                    className="p-2 hover:bg-slate-300"
                    onClick={minimizeWindow}
                >
                    <Minus className="h-4 w-4" />
                </button>
                <button
                    title={isMaximized ? "Restore Down" : "Maximize"}
                    type="button"
                    className="p-2 hover:bg-slate-300"
                    onClick={maximizeWindow}
                >
                    {isMaximized ? (
                        <Copy className="h-4 w-4 scale-x-[-1]" />
                    ) : (
                        <Square className="h-4 w-4" />
                    )}
                </button>
                <button
                    type="button"
                    title="Close"
                    className="p-2 hover:bg-red-300"
                    onClick={closeWindow}
                >
                    <X className="h-4 w-4" />
                </button>
            </div>
        );
    }

    return (
        <div
            className="absolute top-1.5 right-1.5 z-50 flex items-center justify-end gap-1 overflow-visible"
            style={
                {
                    WebkitAppRegion: "no-drag",
                } as React.CSSProperties
            }
        >
            <Button
                variant="ghost"
                size="icon"
                className="hover:bg-primary/20 h-10 w-10"
                onClick={minimizeWindow}
                title="Minimize"
            >
                <Minus className="h-4 w-4" />
            </Button>
            <Button
                variant="ghost"
                size="icon"
                className="hover:bg-primary/20 h-10 w-10"
                onClick={maximizeWindow}
                title={isMaximized ? "Restore Down" : "Maximize"}
            >
                {isMaximized ? (
                    <Copy className="h-4 w-4 scale-x-[-1]" />
                ) : (
                    <Square className="h-4 w-4" />
                )}
            </Button>
            <Button
                variant="ghost"
                size="icon"
                className="hover-bg-accent-negative h-10 w-10"
                onClick={closeWindow}
                title="Close"
            >
                <X className="h-4 w-4" />
            </Button>
        </div>
    );
}
