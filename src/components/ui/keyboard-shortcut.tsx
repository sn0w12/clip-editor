import React from "react";
import { useKeyPressed } from "@/hooks/use-keys-pressed";

interface KeyboardShortcutProps {
    keys: string[] | string;
    className?: string;
}

function ParseShortcutKeys(keys: string[] | string): string[] {
    if (Array.isArray(keys)) {
        return keys.map((key) => key.toLowerCase());
    }
    return keys
        .toLowerCase()
        .split("+")
        .map((key) => (key === "space" ? " " : key));
}

function KeyboardShortcut({ keys, className = "" }: KeyboardShortcutProps) {
    const parsedKeys = ParseShortcutKeys(keys);
    const pressedKeys = useKeyPressed();

    return (
        <span
            className={`text-muted-foreground pointer-events-none absolute top-1/2 right-3 flex -translate-y-1/2 gap-2 text-sm ${className}`}
        >
            {parsedKeys.map((key, index) => (
                <kbd
                    key={`${parsedKeys.join("-")}-${index}`}
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
    const parsedKeys = ParseShortcutKeys(keys);
    const pressedKeys = useKeyPressed();

    return (
        <span
            className={`text-muted-foreground pointer-events-none flex gap-1 text-sm ${className}`}
        >
            {parsedKeys.map((key, index) => (
                <kbd
                    key={`${parsedKeys.join("-")}-${index}`}
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
