import { useState } from "react";
import type { HTMLProps } from "react";

import { cn } from "@/lib/utils";

import { detectPlatform } from "./platform";
import { styles } from "./styles";
import type { Platform, WindowTitlebarProps } from "./types";
import { WindowControls } from "./WindowControls";

export function WindowTitlebar({
    children,
    controlsOrder = "system",
    className,
    windowControlsProps,
    ...props
}: WindowTitlebarProps &
    Omit<HTMLProps<HTMLDivElement>, keyof WindowTitlebarProps>) {
    const [platform] = useState<Platform>(() => detectPlatform());

    const left =
        controlsOrder === "left" ||
        (controlsOrder === "platform" &&
            windowControlsProps?.platform === "macos") ||
        (controlsOrder === "system" && platform === "macos");

    const controlsProps = {
        ...windowControlsProps,
        justify: false,
        className: cn(
            windowControlsProps?.className,
            left ? "ml-0" : "ml-auto"
        ),
    };

    return (
        <div
            className={cn(styles.titlebar, className)}
            data-tauri-drag-region
            {...props}
        >
            {left ? (
                <>
                    <WindowControls {...controlsProps} />
                    {children}
                </>
            ) : (
                <>
                    {children}
                    <WindowControls {...controlsProps} />
                </>
            )}
        </div>
    );
}
