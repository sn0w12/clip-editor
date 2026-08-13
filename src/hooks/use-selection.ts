import { useCallback, useMemo, useRef, useState } from "react";

import { useShortcutSetting } from "@/lib/settings";

export function useSelection<T>(items: T[], getId: (item: T) => string) {
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const lastIndexRef = useRef<number>(-1);

    const toggle = useCallback(
        (id: string, index: number, additive: boolean, range: boolean) => {
            setSelected((prev) => {
                const next = new Set(prev);
                if (range && lastIndexRef.current >= 0 && index !== lastIndexRef.current) {
                    const [from, to] = [
                        Math.min(lastIndexRef.current, index),
                        Math.max(lastIndexRef.current, index),
                    ];
                    for (let i = from; i <= to; i++) {
                        const itemId = getId(items[i]);
                        if (itemId) {
                            if (additive) next.add(itemId);
                            else next.delete(itemId);
                        }
                    }
                    lastIndexRef.current = index;
                    return next;
                }
                if (next.has(id)) {
                    next.delete(id);
                } else {
                    next.add(id);
                    lastIndexRef.current = index;
                }
                return next;
            });
        },
        [getId, items],
    );

    const clear = useCallback(() => setSelected(new Set()), []);
    const setAll = useCallback(
        (all: boolean) => {
            setSelected(all ? new Set(items.map(getId)) : new Set());
        },
        [items, getId],
    );

    const toggleAll = useCallback(() => {
        setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map(getId))));
    }, [items, getId]);

    const invert = useCallback(() => {
        setSelected((prev) => {
            const next = new Set<string>();
            for (const item of items) {
                const id = getId(item);
                if (!prev.has(id)) next.add(id);
            }
            return next;
        });
    }, [items, getId]);

    useShortcutSetting("selectAll", toggleAll);
    useShortcutSetting("selectNone", clear);
    useShortcutSetting("selectInvert", invert);

    return useMemo(
        () => ({ selected, toggle, clear, setAll, toggleAll, invert }),
        [selected, toggle, clear, setAll, toggleAll, invert],
    );
}
