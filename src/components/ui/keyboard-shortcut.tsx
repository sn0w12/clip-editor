import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

interface KeyboardShortcutProps {
    keys: string;
    className?: string;
}

/** Track currently-pressed keys (for visual pressed state). */
function useHeldKeys(): string[] {
    const [held, setHeld] = useState<string[]>([]);
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            setHeld((prev) => (prev.includes(e.key) ? prev : [...prev, e.key]));
        };
        const up = (e: KeyboardEvent) => {
            setHeld((prev) => prev.filter((k) => k !== e.key));
        };
        const onBlur = () => setHeld([]);
        window.addEventListener("keydown", down);
        window.addEventListener("keyup", up);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("keydown", down);
            window.removeEventListener("keyup", up);
            window.removeEventListener("blur", onBlur);
        };
    }, []);
    return held;
}

function formatForDisplay(key: string): string {
    const map: Record<string, string> = {
        ARROWUP: "↑",
        ARROWDOWN: "↓",
        ARROWLEFT: "←",
        ARROWRIGHT: "→",
        " ": "Space",
    };
    return map[key] ?? key;
}

function Kbd({
    className,
    isPressed,
    ...props
}: React.ComponentProps<"kbd"> & { isPressed: boolean }): React.ReactElement {
    const bg = isPressed
        ? "bg-success text-background dark:text-foreground"
        : "bg-muted text-muted-foreground";
    return (
        <kbd
            className={cn(
                "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded-[.25rem] px-1 font-medium text-xs transition-colors duration-50 ease-snappy [&_svg:not([class*='size-'])]:size-3",
                bg,
                className,
            )}
            data-slot="kbd"
            {...props}
        />
    );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"kbd">): React.ReactElement {
    return (
        <kbd
            className={cn("inline-flex items-center gap-1", className)}
            data-slot="kbd-group"
            {...props}
        />
    );
}

function KeyboardShortcut({ keys, className }: KeyboardShortcutProps) {
    const pressedKeys = useHeldKeys();
    const formattedPressedKeys = pressedKeys.map((key) => {
        if (key === "Control") return "Ctrl";
        return formatForDisplay(key);
    });

    return (
        <KbdGroup className={cn("absolute top-1/2 right-3 flex -translate-y-1/2", className)}>
            {keys.split("+").map((key, index) => (
                <Kbd key={`${index}-${key}`} isPressed={formattedPressedKeys.includes(key)}>
                    {formatForDisplay(key)}
                </Kbd>
            ))}
        </KbdGroup>
    );
}

function ContextKeyboardShortcut({ keys, className }: KeyboardShortcutProps) {
    const pressedKeys = useHeldKeys();
    const formattedPressedKeys = pressedKeys.map((key) => {
        if (key === "Control") return "Ctrl";
        return formatForDisplay(key);
    });

    return (
        <KbdGroup className={className}>
            {keys.split("+").map((key, index) => (
                <Kbd key={`${index}-${key}`} isPressed={formattedPressedKeys.includes(key)}>
                    {formatForDisplay(key)}
                </Kbd>
            ))}
        </KbdGroup>
    );
}

export { ContextKeyboardShortcut, KeyboardShortcut };
