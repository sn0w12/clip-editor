import { platform } from "@/platform";
import { useEffect, useCallback } from "react";

export type ShortcutOptions = {
    preventDefault?: boolean;
};

export function useShortcut(
    shortcutKey: string,
    callback: () => void,
    options: ShortcutOptions = {},
) {
    const parseShortcut = useCallback((shortcut: string): string[] => {
        return shortcut.toLowerCase().split("+");
    }, []);

    const matchesShortcut = useCallback(
        (event: KeyboardEvent, keys: string[]): boolean => {
            const pressedKeys = [];
            if (event.ctrlKey) pressedKeys.push("ctrl");
            if (event.shiftKey) pressedKeys.push("shift");
            if (event.altKey) pressedKeys.push("alt");
            pressedKeys.push(event.key.toLowerCase());

            return JSON.stringify(pressedKeys) === JSON.stringify(keys);
        },
        [],
    );

    useEffect(() => {
        const keys = parseShortcut(shortcutKey);
        // Default preventDefault to true on web platform if not explicitly set
        const shouldPreventDefault =
            options.preventDefault !== undefined
                ? options.preventDefault
                : platform.isWeb();

        const handler = (event: KeyboardEvent) => {
            const activeElement = document.activeElement;
            const isInputFocused =
                activeElement instanceof HTMLElement &&
                (activeElement.tagName === "INPUT" ||
                    activeElement.tagName === "TEXTAREA" ||
                    activeElement.tagName === "SELECT" ||
                    activeElement.isContentEditable ||
                    activeElement.getAttribute("role") === "textbox");

            if (isInputFocused) {
                return;
            }

            if (matchesShortcut(event, keys)) {
                if (shouldPreventDefault) {
                    event.preventDefault();
                }
                callback();
            }
        };

        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [
        shortcutKey,
        callback,
        options.preventDefault,
        parseShortcut,
        matchesShortcut,
    ]);
}
