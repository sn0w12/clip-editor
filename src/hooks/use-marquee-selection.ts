import { useCallback, useEffect, useMemo, useState } from "react";

import { createHandle } from "@/components/ui/marquee";
import type {
    ModifierHandler,
    SelectionHandleRef,
} from "@/components/ui/marquee";
import { parseShortcut, useSetting, useShortcutSetting } from "@/lib/settings";
import type { Shortcut } from "@/lib/settings";

function modifiersHeld(
    shortcut: Shortcut | null,
    event: MouseEvent | PointerEvent
): boolean {
    if (!shortcut) return false;
    if (!shortcut.ctrl && !shortcut.shift && !shortcut.alt && !shortcut.meta)
        return false;
    return (
        (!shortcut.shift || event.shiftKey) &&
        (!shortcut.ctrl || event.ctrlKey) &&
        (!shortcut.alt || event.altKey) &&
        (!shortcut.meta || event.metaKey)
    );
}

export interface MarqueeSelection {
    selected: ReadonlySet<string>;
    value: string[];
    handle: SelectionHandleRef;
    onValueChange: (value: string[]) => void;
    extendModifier: ModifierHandler;
}

export function useMarqueeSelection(): MarqueeSelection {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const handle = useMemo(() => createHandle(), []);
    const value = useMemo(() => [...selected], [selected]);

    const onValueChange = useCallback((next: string[]) => {
        setSelected(new Set(next));
    }, []);

    const selectAll = useCallback(() => handle.current?.selectAll(), [handle]);
    const selectNone = useCallback(
        () => handle.current?.selectNone(),
        [handle]
    );
    const selectInvert = useCallback(() => handle.current?.invert(), [handle]);

    useShortcutSetting("selectAll", selectAll);
    useShortcutSetting("selectNone", selectNone);
    useShortcutSetting("selectInvert", selectInvert);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") handle.current?.clear();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [handle]);

    const continueSelectionText = useSetting<string>(
        "shortcut_continueSelection"
    );
    const continueShortcut = useMemo(
        () =>
            parseShortcut(
                typeof continueSelectionText === "string"
                    ? continueSelectionText
                    : undefined
            ),
        [continueSelectionText]
    );
    const extendModifier = useCallback<ModifierHandler>(
        (event) => modifiersHeld(continueShortcut, event),
        [continueShortcut]
    );

    return useMemo(
        () => ({ selected, value, handle, onValueChange, extendModifier }),
        [selected, value, handle, onValueChange, extendModifier]
    );
}
