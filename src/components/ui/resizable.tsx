"use client";

import { Group, Panel, Separator } from "motion-panels/react";
import type { SeparatorProps, Size } from "motion-panels/react";
import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
} from "react";
import type { ComponentProps, CSSProperties, ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";

export interface GroupImperativeHandle {
    /** Percent size per panel id; matches the old imperative layout API. */
    setLayout(layout: Record<string, number>): void;
}

interface PanelGroupContextValue {
    register: (
        id: string,
        setPercent: (percent: number) => void,
        initial: number
    ) => void;
    unregister: (id: string) => void;
    report: (id: string, percent: number) => void;
}

const PanelGroupContext = createContext<PanelGroupContextValue | null>(null);

function toPercent(size: number | string): number {
    const parsed = parseFloat(String(size));
    return Number.isFinite(parsed) ? parsed : 0;
}

function ResizablePanelGroup({
    orientation = "horizontal",
    className,
    groupRef,
    onLayoutChanged,
    children,
    ...props
}: ComponentProps<typeof Group> & {
    groupRef?: Ref<GroupImperativeHandle>;
    onLayoutChanged?: (
        layout: Record<string, number>,
        meta: { isUserInteraction: boolean }
    ) => void;
}) {
    const setters = useRef(new Map<string, (percent: number) => void>());
    const layoutRef = useRef<Record<string, number>>({});
    const onLayoutChangedRef = useRef(onLayoutChanged);

    useEffect(() => {
        onLayoutChangedRef.current = onLayoutChanged;
    }, [onLayoutChanged]);

    const register = useCallback(
        (
            id: string,
            setPercent: (percent: number) => void,
            initial: number
        ) => {
            setters.current.set(id, setPercent);
            layoutRef.current[id] = initial;
        },
        []
    );

    const unregister = useCallback((id: string) => {
        setters.current.delete(id);
        delete layoutRef.current[id];
    }, []);

    const report = useCallback((id: string, percent: number) => {
        layoutRef.current[id] = percent;
        onLayoutChangedRef.current?.(
            { ...layoutRef.current },
            { isUserInteraction: true }
        );
    }, []);

    useImperativeHandle(
        groupRef,
        () => ({
            setLayout(layout) {
                for (const [id, percent] of Object.entries(layout)) {
                    layoutRef.current[id] = percent;
                    setters.current.get(id)?.(percent);
                }
            },
        }),
        []
    );

    const value = useMemo(
        () => ({ register, unregister, report }),
        [register, unregister, report]
    );

    return (
        <PanelGroupContext.Provider value={value}>
            <Group
                data-slot="resizable-panel-group"
                orientation={orientation}
                className={cn(
                    "flex h-full w-full aria-[orientation=vertical]:flex-col",
                    className
                )}
                {...props}
            >
                {children}
            </Group>
        </PanelGroupContext.Provider>
    );
}

function ResizablePanel({
    id,
    defaultSize,
    minSize,
    maxSize,
    className,
    style,
    children,
}: {
    id?: string;
    defaultSize?: number | string;
    minSize?: Size;
    maxSize?: Size;
    className?: string;
    style?: CSSProperties;
    children?: ReactNode;
}) {
    const context = useContext(PanelGroupContext);
    if (!context) {
        throw new Error(
            "ResizablePanel must be used within ResizablePanelGroup"
        );
    }

    const sized = defaultSize !== undefined;
    const [percent, setPercent] = useState(() =>
        sized ? toPercent(defaultSize ?? 0) : 0
    );

    useEffect(() => {
        if (!sized || id === undefined) return;
        context.register(id, setPercent, toPercent(defaultSize ?? 0));
        return () => context.unregister(id);
    }, [context, id, sized, defaultSize]);

    if (!sized) {
        return (
            <Panel
                data-slot="resizable-panel"
                className={className}
                style={style}
            >
                {children}
            </Panel>
        );
    }

    return (
        <Panel
            data-slot="resizable-panel"
            size={`${percent}%`}
            minSize={minSize}
            maxSize={maxSize}
            onSizeChange={(size) => {
                const next = toPercent(size);
                setPercent(next);
                if (id !== undefined) context.report(id, next);
            }}
            className={className}
            style={style}
        >
            {children}
        </Panel>
    );
}

function ResizableHandle({
    withHandle,
    className,
    ...props
}: Omit<SeparatorProps, "children"> & {
    withHandle?: boolean;
}) {
    return (
        <Separator
            data-slot="resizable-handle"
            className={cn(
                "relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
                className
            )}
            {...props}
        >
            {withHandle && (
                <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
            )}
        </Separator>
    );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
