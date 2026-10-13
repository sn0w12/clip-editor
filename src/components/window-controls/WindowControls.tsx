import { useEffect, useMemo, useState } from "react";
import type { ButtonHTMLAttributes, HTMLProps } from "react";

import { cn } from "@/lib/utils";

import { detectPlatform } from "./platform";
import { styles } from "./styles";
import type { WindowControlsProps } from "./types";
import type { WindowControlsApi } from "./window";
import { createWindowControls } from "./window";
import { Icons } from "./window-icons";

function TitlebarButton({
    className,
    children,
    ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
    return (
        <button className={cn(styles.baseButton, className)} {...props}>
            {children}
        </button>
    );
}

interface PlatformControlsProps {
    windowApi: WindowControlsApi;
    isMaximized: boolean;
    className?: string;
}

function WindowsControls({
    windowApi,
    isMaximized,
    className,
}: PlatformControlsProps) {
    return (
        <div className={cn(styles.windows.container, className)}>
            <TitlebarButton
                onClick={() => void windowApi.minimize()}
                className={styles.windows.button}
            >
                <Icons.minimizeWin />
            </TitlebarButton>
            <TitlebarButton
                id="seraphis-snap-maximize"
                onClick={() =>
                    void (isMaximized
                        ? windowApi.unmaximize()
                        : windowApi.maximize())
                }
                className={styles.windows.button}
            >
                {isMaximized ? (
                    <Icons.maximizeRestoreWin />
                ) : (
                    <Icons.maximizeWin />
                )}
            </TitlebarButton>
            <TitlebarButton
                onClick={() => void windowApi.close()}
                className={styles.windows.closeButton}
            >
                <Icons.closeWin />
            </TitlebarButton>
        </div>
    );
}

function MacOSControls({
    windowApi,
    className,
}: Omit<PlatformControlsProps, "isMaximized">) {
    const [isAltKeyPressed, setIsAltKeyPressed] = useState(false);
    const [isHovering, setIsHovering] = useState(false);
    const [isFocused, setIsFocused] = useState(() => document.hasFocus());

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Alt") setIsAltKeyPressed(true);
        };
        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.key === "Alt") setIsAltKeyPressed(false);
        };
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
        };
    }, []);

    useEffect(() => {
        const onFocus = () => setIsFocused(true);
        const onBlur = () => setIsFocused(false);
        window.addEventListener("focus", onFocus);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("focus", onFocus);
            window.removeEventListener("blur", onBlur);
        };
    }, []);

    const dot = (active: string) =>
        isFocused ? active : styles.macos.inactive;

    return (
        <div
            className={cn(styles.macos.container, className)}
            onMouseEnter={() => setIsHovering(true)}
            onMouseLeave={() => setIsHovering(false)}
        >
            <TitlebarButton
                onClick={() => void windowApi.close()}
                className={cn(styles.macos.button, dot(styles.macos.close))}
            >
                {isHovering && <Icons.closeMac />}
            </TitlebarButton>
            <TitlebarButton
                onClick={() => void windowApi.minimize()}
                className={cn(styles.macos.button, dot(styles.macos.minimize))}
            >
                {isHovering && <Icons.minMac />}
            </TitlebarButton>
            <TitlebarButton
                onClick={() =>
                    void (isAltKeyPressed
                        ? windowApi.maximize()
                        : windowApi.fullscreen())
                }
                className={cn(
                    styles.macos.button,
                    dot(styles.macos.fullscreen)
                )}
            >
                {isHovering &&
                    (isAltKeyPressed ? <Icons.plusMac /> : <Icons.fullMac />)}
            </TitlebarButton>
        </div>
    );
}

function GnomeControls({
    windowApi,
    isMaximized,
    className,
}: PlatformControlsProps) {
    return (
        <div className={cn(styles.gnome.container, className)}>
            <TitlebarButton
                onClick={() => void windowApi.minimize()}
                className={styles.gnome.button}
            >
                <Icons.minimizeWin className="h-[9px] w-[9px]" />
            </TitlebarButton>
            <TitlebarButton
                onClick={() =>
                    void (isMaximized
                        ? windowApi.unmaximize()
                        : windowApi.maximize())
                }
                className={styles.gnome.button}
            >
                {isMaximized ? (
                    <Icons.maximizeRestoreWin className="h-[9px] w-[9px]" />
                ) : (
                    <Icons.maximizeWin className="h-2 w-2" />
                )}
            </TitlebarButton>
            <TitlebarButton
                onClick={() => void windowApi.close()}
                className={styles.gnome.button}
            >
                <Icons.closeWin className="h-2 w-2" />
            </TitlebarButton>
        </div>
    );
}

export function WindowControls({
    platform: platformOverride,
    justify = false,
    hide = false,
    hideMethod = "display",
    className,
    ...props
}: WindowControlsProps &
    Omit<HTMLProps<HTMLDivElement>, keyof WindowControlsProps>) {
    const detected = useMemo(() => detectPlatform(), []);
    const platform = platformOverride ?? detected;
    const [isMaximized, setIsMaximized] = useState(false);
    const [windowApi] = useState<WindowControlsApi>(() =>
        createWindowControls()
    );

    useEffect(() => {
        let cleanup: (() => void) | undefined;
        void windowApi.onMaximizedChange(setIsMaximized).then((unlisten) => {
            cleanup = unlisten;
        });
        return () => cleanup?.();
    }, [windowApi]);

    const customClass = cn(
        "flex",
        className,
        hide && (hideMethod === "display" ? "hidden" : "invisible"),
        justify && (platform === "macos" ? "ml-0" : "ml-auto")
    );

    switch (platform) {
        case "macos":
            return (
                <MacOSControls windowApi={windowApi} className={customClass} />
            );
        case "gnome":
            return (
                <GnomeControls
                    windowApi={windowApi}
                    isMaximized={isMaximized}
                    className={customClass}
                    {...props}
                />
            );
        default:
            return (
                <WindowsControls
                    windowApi={windowApi}
                    isMaximized={isMaximized}
                    className={customClass}
                    {...props}
                />
            );
    }
}
