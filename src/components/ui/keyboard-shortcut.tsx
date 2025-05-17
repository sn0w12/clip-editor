import React from "react";
import { useKeyPressed } from "@/hooks/use-keys-pressed";

interface KeyboardShortcutProps {
    keys: string[];
    className?: string;
}

function KeyboardShortcut({ keys, className = "" }: KeyboardShortcutProps) {
    const pressedKeys = useKeyPressed();

    return (
        <span
            className={`text-muted-foreground pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 gap-2 text-sm ${className}`}
        >
            {keys.map((key, index) => (
                <kbd
                    key={`${keys.join("-")}-${index}`}
                    className={`rounded-md border px-1 py-0.5 text-xs transition-colors ${
                        pressedKeys.has(key.toLowerCase())
                            ? "bg-accent-positive border-accent-positive text-primary-foreground"
                            : "bg-muted"
                    }`}
                >
                    {key}
                </kbd>
            ))}
        </span>
    );
}

function ContextKeyboardShortcut({
    keys,
    className = "",
}: KeyboardShortcutProps) {
    const pressedKeys = useKeyPressed();

    return (
        <span
            className={`text-muted-foreground pointer-events-none flex gap-2 text-sm ${className}`}
        >
            {keys.map((key, index) => (
                <kbd
                    key={`${keys.join("-")}-${index}`}
                    className={`rounded-md border px-1 py-0.5 text-xs transition-colors ${
                        pressedKeys.has(key.toLowerCase())
                            ? "bg-accent-positive border-accent-positive text-primary-foreground"
                            : "bg-muted"
                    }`}
                >
                    {key}
                </kbd>
            ))}
        </span>
    );
}

export { KeyboardShortcut, ContextKeyboardShortcut };
