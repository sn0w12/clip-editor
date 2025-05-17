import React, { useEffect, useRef, useState } from "react";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuTrigger,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuCheckboxItem,
    ContextMenuSub,
    ContextMenuSubTrigger,
    ContextMenuSubContent,
    ContextMenuGroup,
    ContextMenuLabel,
} from "@/components/ui/context-menu";
import {
    RefreshCw,
    Clipboard,
    Gauge,
    Smartphone,
    Store,
    Accessibility,
    Zap,
    LayoutGrid,
} from "lucide-react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/utils/tailwind";

// Interface to keep track of element paths in React component hierarchy
interface ComponentPathTracker {
    findComponentPath: (element: Element | null) => string;
    getPath: () => string | null;
}

// Add these interfaces at the top of the file, after existing imports
interface PerformanceEntryWithInput extends PerformanceEntry {
    hadRecentInput?: boolean;
    value?: number;
    processingStart?: number;
}

interface Position {
    x: number;
    y: number;
}

// Function to create a component path tracker
function createComponentPathTracker(): ComponentPathTracker {
    let currentPath: string | null = null;

    const getComponentName = (element: Element | null): string => {
        if (!element) return "Unknown";

        // Try to get component name from data attributes, common in React DevTools
        const name =
            element.getAttribute("data-component-name") ||
            element.getAttribute("data-testid") ||
            element.getAttribute("data-slot") ||
            element.getAttribute("data-sidebar");

        if (name) return name;

        // Try to infer from class name if any
        if (element.className && typeof element.className === "string") {
            // Extract potential component names from className
            // Looking for PascalCase patterns like "SomeComponent-wrapper"
            const matches = element.className.match(/([A-Z][a-z]+)+/g);
            if (matches && matches.length > 0) return matches[0];
        }

        // Extract from element tag
        return element.tagName.toLowerCase();
    };

    const findComponentPath = (element: Element | null): string => {
        if (!element) return "Unknown";

        const path: string[] = [];
        let currentElement: Element | null = element;
        let depth = 0;
        const maxDepth = 10; // Prevent infinite loops

        while (currentElement && depth < maxDepth) {
            const name = getComponentName(currentElement);
            path.unshift(name);
            currentElement = currentElement.parentElement;
            depth++;
        }

        currentPath = path.join(" > ");
        return currentPath;
    };

    return {
        findComponentPath,
        getPath: () => currentPath,
    };
}

function PerformanceSkeleton() {
    return (
        <Card className="w-64 overflow-hidden border p-3 font-mono text-xs opacity-40">
            <div className="mb-2 flex items-center justify-between">
                <div className="bg-muted h-4 w-20 animate-pulse rounded"></div>
                <div className="bg-muted h-4 w-12 animate-pulse rounded"></div>
            </div>
            <div className="space-y-2">
                <div className="bg-muted h-20 w-full animate-pulse rounded"></div>
                <div className="space-y-1">
                    <div className="bg-muted h-4 w-full animate-pulse rounded"></div>
                    <div className="bg-muted h-2 w-full animate-pulse rounded"></div>
                </div>
                <div className="space-y-1">
                    <div className="bg-muted h-4 w-full animate-pulse rounded"></div>
                    <div className="bg-muted h-2 w-full animate-pulse rounded"></div>
                </div>
            </div>
        </Card>
    );
}

// Performance monitoring component
function PerformanceOverlay() {
    const [stats, setStats] = useState<{
        fps: number;
        memory: number;
        cpuUsage: number;
        renderTime: number;
        maxRenderTime: number;
        memoryUsagePercent: number;
        paintTime: number;
        layoutTime: number;
        eventLoopDelay: number;
        frameTimeHistory: number[];
        smoothedFrameTime: number;
        resourceTimings: {
            name: string;
            duration: number;
        }[];
        networkLatency: number;
        networkRequests: number;
        longTasks: { duration: number; timestamp: number }[];
        droppedFrames: number;
        domMutations: number;
        threadBlocking: number;
        tti: number;
        fid: number;
        fidHistory: { value: number; timestamp: number }[];
        tbt: number; // Total Blocking Time
        cls: number; // Cumulative Layout Shift
        fcp: number; // First Contentful Paint
        lcp: number; // Largest Contentful Paint
    }>({
        fps: 0,
        memory: 0,
        cpuUsage: 0,
        renderTime: 0,
        maxRenderTime: 33.33,
        memoryUsagePercent: 0,
        paintTime: 0,
        layoutTime: 0,
        eventLoopDelay: 0,
        frameTimeHistory: [],
        smoothedFrameTime: 0,
        resourceTimings: [],
        networkLatency: 0,
        networkRequests: 0,
        longTasks: [],
        droppedFrames: 0,
        domMutations: 0,
        threadBlocking: 0,
        tti: 0,
        fid: 0,
        fidHistory: [],
        tbt: 0,
        cls: 0,
        fcp: 0,
        lcp: 0,
    });

    const [dragging, setDragging] = useState(false);
    const [mousePos, setMousePos] = useState<Position>({ x: 0, y: 0 });
    const [corner, setCorner] = useState<
        "bottom-left" | "bottom-right" | "top-left" | "top-right"
    >(() => {
        const saved = localStorage.getItem("performance-overlay-corner");
        return (
            (saved as
                | "bottom-left"
                | "bottom-right"
                | "top-left"
                | "top-right") || "bottom-left"
        );
    });
    const overlayRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);
    const dragStartPosRef = useRef({ x: 0, y: 0 });

    const lastTimeRef = useRef(performance.now());
    const frameTimeRef = useRef<number[]>([]);
    const mutationRef = useRef({ count: 0 });
    const expectedFrameTimeRef = useRef(performance.now());
    const fidRef = useRef<number | null>(null);
    const ttiRef = useRef<number | null>(null);
    const tbtRef = useRef(0);
    const clsRef = useRef(0);

    // Add smoothing factor
    const SMOOTHING_FACTOR = 0.1; // Adjust this value between 0 and 1 for more/less smoothing

    // Save corner position when it changes
    useEffect(() => {
        localStorage.setItem("performance-overlay-corner", corner);
    }, [corner]);

    // Handle drag start
    const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
        if (!overlayRef.current) return;
        isDraggingRef.current = true;
        setDragging(true);
        setMousePos({ x: e.clientX, y: e.clientY });

        // Set a transparent drag image
        const dragImg = document.createElement("div");
        dragImg.style.opacity = "0";
        document.body.appendChild(dragImg);
        e.dataTransfer.setDragImage(dragImg, 0, 0);
        setTimeout(() => document.body.removeChild(dragImg), 0);

        // Store initial positions
        dragStartPosRef.current = {
            x: e.clientX - overlayRef.current.getBoundingClientRect().left,
            y: e.clientY - overlayRef.current.getBoundingClientRect().top,
        };

        // Add dragging class for styling
        overlayRef.current.style.opacity = "0.4";
    };

    // Handle drag
    const handleDrag = (e: React.DragEvent<HTMLDivElement>) => {
        if (!isDraggingRef.current || !e.clientX || !e.clientY) return;
        setMousePos({ x: e.clientX, y: e.clientY });

        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;

        // Determine which corner we're closest to
        const isCloserToRight = e.clientX > windowWidth / 2;
        const isCloserToBottom = e.clientY > windowHeight / 2;

        // Update corner state
        const newCorner =
            `${isCloserToBottom ? "bottom" : "top"}-${isCloserToRight ? "right" : "left"}` as const;
        setCorner(newCorner);
    };

    // Handle drag end
    const handleDragEnd = () => {
        if (!overlayRef.current) return;
        isDraggingRef.current = false;
        setDragging(false);
        overlayRef.current.style.opacity = "1";
    };

    useEffect(() => {
        let animationFrameId: number;
        let lastEventLoopCheck = performance.now();
        let frameCounter = 0;
        let lastFpsUpdate = performance.now();
        const UPDATE_INTERVAL = 250; // Update every 250ms
        const FRAME_SAMPLE_SIZE = 5; // Update every 5 frames

        // Track DOM mutations
        const mutationObserver = new MutationObserver((mutations) => {
            mutationRef.current.count += mutations.length;
        });

        mutationObserver.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
        });

        // Track long tasks
        const longTaskObserver = new PerformanceObserver((entries) => {
            entries.getEntries().forEach((entry) => {
                // Only count blocking time over 50ms threshold
                const blockingTime = entry.duration - 50;
                if (blockingTime > 0) {
                    tbtRef.current += blockingTime;
                }
            });

            // Update Total Blocking Time
            setStats((prev) => ({
                ...prev,
                tbt: tbtRef.current,
            }));

            // Estimate TTI as the end of the last long task plus a quiet window
            const lastTask = entries.getEntries().pop();
            if (lastTask && !ttiRef.current) {
                const quietWindowStart = lastTask.startTime + lastTask.duration;
                // Check if we have a 5-second quiet window
                if (performance.now() - quietWindowStart >= 5000) {
                    ttiRef.current = quietWindowStart;
                    setStats((prev) => ({
                        ...prev,
                        tti: ttiRef.current!,
                    }));
                }
            }
        });

        // Network performance
        const networkObserver = new PerformanceObserver((list) => {
            const entries = list.getEntries();
            const resources = entries.filter(
                (entry) => entry.entryType === "resource",
            );

            if (resources.length > 0) {
                const avgLatency =
                    resources.reduce((sum, entry) => sum + entry.duration, 0) /
                    resources.length;
                setStats((prev) => ({
                    ...prev,
                    networkLatency: avgLatency,
                    networkRequests: prev.networkRequests + resources.length,
                }));
            }
        });

        // Track First Input Delay more accurately
        const firstInputObserver = new PerformanceObserver((entryList) => {
            const firstInput =
                entryList.getEntries()[0] as PerformanceEntryWithInput;
            if (firstInput && !fidRef.current && firstInput.processingStart) {
                const delay = firstInput.processingStart - firstInput.startTime;
                fidRef.current = delay;
                setStats((prev) => ({
                    ...prev,
                    fid: delay,
                    fidHistory: [
                        ...prev.fidHistory,
                        { value: delay, timestamp: Date.now() },
                    ].slice(-5),
                }));
            }
        });

        // Track Largest Contentful Paint
        const lcpObserver = new PerformanceObserver((entryList) => {
            const entries = entryList.getEntries();
            const lastEntry = entries[entries.length - 1];
            setStats((prev) => ({
                ...prev,
                lcp: lastEntry.startTime,
            }));
        });

        // Track First Contentful Paint
        const fcpObserver = new PerformanceObserver((entryList) => {
            const entries = entryList.getEntries();
            const firstPaint = entries[0];
            setStats((prev) => ({
                ...prev,
                fcp: firstPaint.startTime,
            }));
        });

        // Track Cumulative Layout Shift
        const clsObserver = new PerformanceObserver((entryList) => {
            for (const entry of entryList.getEntries() as PerformanceEntryWithInput[]) {
                if (!entry.hadRecentInput && typeof entry.value === "number") {
                    clsRef.current += entry.value;
                    setStats((prev) => ({
                        ...prev,
                        cls: clsRef.current,
                    }));
                }
            }
        });

        const updateStats = () => {
            const now = performance.now();
            frameCounter++;

            // Only update on every Nth frame
            if (frameCounter % FRAME_SAMPLE_SIZE === 0) {
                const frameTime = now - lastTimeRef.current;
                const normalizedFrameTime = Math.min(frameTime, 100);

                frameTimeRef.current.push(normalizedFrameTime);
                if (frameTimeRef.current.length > 120) {
                    frameTimeRef.current.shift();
                }

                // Update FPS every UPDATE_INTERVAL ms
                if (now - lastFpsUpdate >= UPDATE_INTERVAL) {
                    const timeDiff = now - lastFpsUpdate;
                    const fps = (frameCounter * 1000) / timeDiff;
                    frameCounter = 0;
                    lastFpsUpdate = now;

                    setStats((prev) => ({
                        ...prev,
                        fps,
                        frameTimeHistory: [...frameTimeRef.current],
                        smoothedFrameTime:
                            prev.smoothedFrameTime * (1 - SMOOTHING_FACTOR) +
                            normalizedFrameTime * SMOOTHING_FACTOR,
                        renderTime:
                            frameTimeRef.current.length > 0
                                ? frameTimeRef.current.reduce(
                                      (a, b) => a + b,
                                      0,
                                  ) / frameTimeRef.current.length
                                : 0,
                        eventLoopDelay: Math.max(0, frameTime - 16.67),
                        droppedFrames: Math.floor(
                            (now - expectedFrameTimeRef.current) / 16.67,
                        ),
                        threadBlocking: Math.max(
                            0,
                            now - lastEventLoopCheck - 16.67,
                        ),
                    }));

                    // Update these refs for next cycle
                    expectedFrameTimeRef.current = now;
                    mutationRef.current.count = 0;
                }
            }

            lastEventLoopCheck = now;
            lastTimeRef.current = now;

            // Schedule next frame
            animationFrameId = requestAnimationFrame(updateStats);
        };

        try {
            const observeLayoutThrashing = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                const layoutTime = entries
                    .filter((entry) => entry.entryType === "layout-shift")
                    .reduce((sum, entry) => sum + entry.duration, 0);

                setStats((prev) => ({
                    ...prev,
                    layoutTime,
                }));
            });

            const observePaint = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                const paintTime = entries
                    .filter((entry) => entry.entryType === "paint")
                    .reduce((sum, entry) => sum + entry.duration, 0);

                setStats((prev) => ({
                    ...prev,
                    paintTime,
                }));
            });

            const observeResource = new PerformanceObserver((list) => {
                const entries = list.getEntries();
                const resourceTimings = entries
                    .filter((entry) => entry.entryType === "resource")
                    .map((entry) => ({
                        name: entry.name,
                        duration: entry.duration,
                    }));

                setStats((prev) => ({
                    ...prev,
                    resourceTimings,
                }));
            });

            observeLayoutThrashing.observe({ entryTypes: ["layout-shift"] });
            observePaint.observe({ entryTypes: ["paint"] });
            observeResource.observe({ entryTypes: ["resource"] });
            longTaskObserver.observe({ entryTypes: ["longtask"] });
            networkObserver.observe({ entryTypes: ["resource"] });
            firstInputObserver.observe({ entryTypes: ["first-input"] });
            lcpObserver.observe({ entryTypes: ["largest-contentful-paint"] });
            fcpObserver.observe({ entryTypes: ["paint"] });
            clsObserver.observe({ entryTypes: ["layout-shift"] });
        } catch (error: unknown) {
            console.warn(
                "Some performance observers not supported:",
                error instanceof Error ? error.message : String(error),
            );
        }

        animationFrameId = requestAnimationFrame(updateStats);

        return () => {
            cancelAnimationFrame(animationFrameId);
            mutationObserver.disconnect();
            try {
                longTaskObserver.disconnect();
                networkObserver.disconnect();
                firstInputObserver.disconnect();
                lcpObserver.disconnect();
                fcpObserver.disconnect();
                clsObserver.disconnect();
            } catch (error: unknown) {
                console.warn(
                    "Error disconnecting observers:",
                    error instanceof Error ? error.message : String(error),
                );
            }
        };
    }, []);

    const getFpsColor = (fps: number) => {
        if (fps >= 55) return "text-accent-positive";
        if (fps >= 30) return "text-accent-warning";
        return "text-accent-negative";
    };

    const getRenderTimeColor = (time: number, prefix = "text") => {
        if (time < 16) return `${prefix}-accent-positive`;
        if (time < 33) return `${prefix}-accent-warning`;
        return "text-accent-negative";
    };

    return (
        <>
            {/* Ghost overlay that follows the mouse while dragging */}
            {dragging && (
                <Card
                    className="pointer-events-none fixed z-50 h-96 w-64 overflow-hidden border p-3 font-mono text-xs shadow-lg backdrop-blur-sm"
                    style={{
                        left: mousePos.x - dragStartPosRef.current.x,
                        top: mousePos.y - dragStartPosRef.current.y,
                    }}
                >
                    <div className="space-y-2 select-none">
                        {/* ...existing stats content... */}
                    </div>
                </Card>
            )}

            {/* Skeleton overlay that shows where it will be placed */}
            {dragging && (
                <div
                    className={cn("fixed z-40 transition-all duration-150", {
                        "bottom-4 left-4": corner === "bottom-left",
                        "right-4 bottom-4": corner === "bottom-right",
                        "top-4 left-4": corner === "top-left",
                        "top-4 right-4": corner === "top-right",
                    })}
                >
                    <PerformanceSkeleton />
                </div>
            )}

            {/* Main overlay - hide when dragging */}
            <Card
                ref={overlayRef}
                draggable
                onDragStart={handleDragStart}
                onDrag={handleDrag}
                onDragEnd={handleDragEnd}
                className={cn(
                    "fixed z-50 w-64 cursor-move overflow-hidden border p-3 font-mono text-xs shadow-lg backdrop-blur-sm",
                    "border-border bg-background/90",
                    "transition-all duration-150 ease-out",
                    {
                        "bottom-4 left-4": corner === "bottom-left",
                        "right-4 bottom-4": corner === "bottom-right",
                        "top-4 left-4": corner === "top-left",
                        "top-4 right-4": corner === "top-right",
                        "opacity-0": dragging,
                    },
                )}
            >
                <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium select-none">
                        Performance
                    </span>
                    <span
                        className={`font-bold ${getFpsColor(stats.fps)} select-none`}
                    >
                        {Math.round(stats.fps)} FPS
                    </span>
                </div>

                {/* Make the content non-draggable to prevent interference */}
                <div className="space-y-2 select-none">
                    <div className="h-20 w-full">
                        <div className="flex h-full items-end space-x-0">
                            {stats.frameTimeHistory.map((time, i) => {
                                const smoothedHeight = Math.min(
                                    (time / 33.33) * 100,
                                    100,
                                );
                                const color = getRenderTimeColor(time, "bg");
                                const opacity = Math.min(
                                    0.4 +
                                        (i / stats.frameTimeHistory.length) *
                                            0.6,
                                    1,
                                );

                                return (
                                    <div
                                        key={i}
                                        className={`w-1 ${color} transition-all duration-150 ease-out`}
                                        style={{
                                            height: `${smoothedHeight}%`,
                                            opacity,
                                        }}
                                    />
                                );
                            })}
                        </div>
                    </div>

                    <div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">
                                Average Frame Time
                            </span>
                            <span
                                className={getRenderTimeColor(
                                    stats.smoothedFrameTime,
                                )}
                            >
                                {stats.smoothedFrameTime.toFixed(1)}ms
                            </span>
                        </div>
                        <Progress
                            value={
                                (stats.renderTime / stats.maxRenderTime) * 100
                            }
                            className="h-1.5"
                        />
                    </div>

                    {stats.memory > 0 && (
                        <div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">
                                    Memory
                                </span>
                                <span>{stats.memory}MB</span>
                            </div>
                            <Progress
                                value={stats.memoryUsagePercent}
                                className="h-1.5"
                            />
                        </div>
                    )}

                    <div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">
                                Event Loop
                            </span>
                            <span
                                className={getRenderTimeColor(
                                    stats.eventLoopDelay,
                                )}
                            >
                                +{stats.eventLoopDelay.toFixed(1)}ms
                            </span>
                        </div>
                    </div>

                    {(stats.layoutTime > 0 || stats.paintTime > 0) && (
                        <div className="space-y-1">
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">
                                    Layout
                                </span>
                                <span>{stats.layoutTime.toFixed(1)}ms</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">
                                    Paint
                                </span>
                                <span>{stats.paintTime.toFixed(1)}ms</span>
                            </div>
                        </div>
                    )}

                    {stats.resourceTimings.length > 0 && (
                        <div className="border-border mt-2 border-t pt-2">
                            <span className="text-muted-foreground">
                                Recent Resources
                            </span>
                            {stats.resourceTimings.map((resource, i) => (
                                <div
                                    key={i}
                                    className="flex items-center justify-between text-[10px]"
                                >
                                    <span className="truncate">
                                        {resource.name}
                                    </span>
                                    <span>
                                        {resource.duration.toFixed(0)}ms
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {stats.networkRequests > 0 && (
                        <div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">
                                    Network
                                </span>
                                <span>
                                    {stats.networkRequests} req (
                                    {stats.networkLatency.toFixed(0)}ms)
                                </span>
                            </div>
                        </div>
                    )}

                    {stats.threadBlocking > 1 && (
                        <div>
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">
                                    Thread Blocking
                                </span>
                                <span
                                    className={getRenderTimeColor(
                                        stats.threadBlocking,
                                    )}
                                >
                                    {stats.threadBlocking.toFixed(1)}ms
                                </span>
                            </div>
                        </div>
                    )}

                    <div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">
                                DOM Changes
                            </span>
                            <span
                                className={
                                    stats.domMutations > 100
                                        ? "text-accent-warning"
                                        : "text-muted-foreground"
                                }
                            >
                                {stats.domMutations}/s
                            </span>
                        </div>
                    </div>

                    <div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">
                                Dropped Frames
                            </span>
                            <span
                                className={
                                    stats.droppedFrames > 0
                                        ? "text-accent-negative"
                                        : "text-muted-foreground"
                                }
                            >
                                {stats.droppedFrames}
                            </span>
                        </div>
                    </div>

                    {stats.longTasks.length > 0 && (
                        <div className="border-border mt-2 border-t pt-2">
                            <span className="text-muted-foreground">
                                Long Tasks
                            </span>
                            {stats.longTasks.map((task, i) => (
                                <div
                                    key={i}
                                    className="flex items-center justify-between text-[10px]"
                                >
                                    <span>
                                        {new Date(
                                            task.timestamp,
                                        ).toLocaleTimeString()}
                                    </span>
                                    <span className="text-accent-negative">
                                        {task.duration.toFixed(0)}ms
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Web Vitals */}
                    <div className="border-border mt-2 border-t pt-2">
                        <span className="text-muted-foreground">
                            Web Vitals
                        </span>
                        {stats.fcp > 0 && (
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">
                                    FCP
                                </span>
                                <span>{(stats.fcp / 1000).toFixed(2)}s</span>
                            </div>
                        )}
                        {stats.lcp > 0 && (
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">
                                    LCP
                                </span>
                                <span>{(stats.lcp / 1000).toFixed(2)}s</span>
                            </div>
                        )}
                        {stats.cls > 0 && (
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">
                                    CLS
                                </span>
                                <span>{stats.cls.toFixed(3)}</span>
                            </div>
                        )}
                        {stats.tti > 0 && (
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">
                                    TTI
                                </span>
                                <span>{(stats.tti / 1000).toFixed(2)}s</span>
                            </div>
                        )}
                        {stats.tbt > 0 && (
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">
                                    TBT
                                </span>
                                <span className={getRenderTimeColor(stats.tbt)}>
                                    {stats.tbt.toFixed(0)}ms
                                </span>
                            </div>
                        )}
                        {stats.fid > 0 && (
                            <div className="flex items-center justify-between">
                                <span className="text-muted-foreground">
                                    FID
                                </span>
                                <span className={getRenderTimeColor(stats.fid)}>
                                    {stats.fid.toFixed(1)}ms
                                </span>
                            </div>
                        )}
                        {stats.fidHistory.length > 0 && (
                            <div className="border-border/50 mt-1 space-y-1 border-t pt-1 text-[10px]">
                                <span className="text-muted-foreground">
                                    Recent Input Delays
                                </span>
                                {stats.fidHistory.map((entry, i) => (
                                    <div
                                        key={i}
                                        className="flex items-center justify-between"
                                    >
                                        <span>
                                            {new Date(
                                                entry.timestamp,
                                            ).toLocaleTimeString()}
                                        </span>
                                        <span
                                            className={getRenderTimeColor(
                                                entry.value,
                                            )}
                                        >
                                            {entry.value.toFixed(1)}ms
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </Card>
        </>
    );
}

export function DevContextMenu({ children }: { children: React.ReactNode }) {
    const inDevelopment = process.env.NODE_ENV === "development";
    const triggerRef = useRef<HTMLDivElement>(null);
    const [showOutlines, setShowOutlines] = useState(false);
    const [showPerformanceOverlay, setShowPerformanceOverlay] = useState(false);
    const componentPathTracker = useRef(createComponentPathTracker());

    // Keep track of the last clicked element for context
    const [lastTargetElement, setLastTargetElement] = useState<Element | null>(
        null,
    );

    useEffect(() => {
        const handleContextMenu = (e: MouseEvent) => {
            setLastTargetElement(e.target as Element);
        };

        document.addEventListener("contextmenu", handleContextMenu);
        return () => {
            document.removeEventListener("contextmenu", handleContextMenu);
        };
    }, []);

    if (!inDevelopment) {
        return <>{children}</>;
    }

    const handleToggleOutlines = () => {
        setShowOutlines(!showOutlines);
        document.body.classList.toggle("debug-outline");
    };

    const handleForceRerender = () => {
        // Force a re-render of the selected component
        if (lastTargetElement) {
            // Re-render by temporarily modifying and reverting a data attribute
            const tempAttr = "data-force-rerender";
            lastTargetElement.setAttribute(tempAttr, Date.now().toString());
            setTimeout(() => {
                lastTargetElement.removeAttribute(tempAttr);
            }, 10);
        }
        toast("Component re-render triggered");
    };

    const handleCopyComponentPath = () => {
        // Trace and copy component path using our tracker
        const path =
            componentPathTracker.current.findComponentPath(lastTargetElement);
        navigator.clipboard.writeText(path);
        toast(`Component path copied: ${path}`);
    };

    const handleTogglePerformance = () => {
        setShowPerformanceOverlay(!showPerformanceOverlay);
    };

    const handleAccessibilityCheck = () => {
        if (lastTargetElement) {
            // Check for basic accessibility issues
            const a11yIssues = [];

            // Check for missing alt text on images
            if (
                lastTargetElement.tagName === "IMG" &&
                !lastTargetElement.hasAttribute("alt")
            ) {
                a11yIssues.push("Image missing alt text");
            }

            // Check for contrast ratio (simplified)
            const checkContrastRatio = (element: Element) => {
                const style = window.getComputedStyle(element);
                const backgroundColor = style.backgroundColor;
                const color = style.color;

                // This is a simplified check - in a real app you would use a proper contrast calculation
                if (
                    backgroundColor === "transparent" ||
                    color === "transparent"
                ) {
                    a11yIssues.push(
                        "Potential contrast issues with transparent colors",
                    );
                }
            };

            checkContrastRatio(lastTargetElement);

            // Check for aria attributes
            if (
                lastTargetElement.getAttribute("role") &&
                !lastTargetElement.hasAttribute("aria-label")
            ) {
                a11yIssues.push("Element with role is missing aria-label");
            }

            // Check for interactive elements that are not focusable
            if (
                ["button", "a", "input", "select", "textarea"].includes(
                    lastTargetElement.tagName.toLowerCase(),
                )
            ) {
                if (lastTargetElement.getAttribute("tabindex") === "-1") {
                    a11yIssues.push(
                        "Interactive element is not focusable (tabindex=-1)",
                    );
                }
            }

            // Use toast instead of console for issues
            if (a11yIssues.length > 0) {
                toast.warning("Accessibility Issues Found");
                a11yIssues.forEach((issue) => toast.warning(`- ${issue}`));
            } else {
                toast.success(
                    "No accessibility issues found in the selected element",
                );
            }
        } else {
            toast.info("No element selected for accessibility check");
        }
    };

    const handleSimulateEvent = (event: string) => {
        toast(`Simulating ${event} event`);

        if (lastTargetElement) {
            try {
                let eventObj;

                switch (event) {
                    case "click":
                        eventObj = new MouseEvent("click", {
                            bubbles: true,
                            cancelable: true,
                            view: window,
                        });
                        break;

                    case "focus":
                        eventObj = new FocusEvent("focus", {
                            bubbles: true,
                            cancelable: true,
                            view: window,
                        });
                        break;

                    case "blur":
                        eventObj = new FocusEvent("blur", {
                            bubbles: true,
                            cancelable: true,
                            view: window,
                        });
                        break;

                    case "mouseover":
                        eventObj = new MouseEvent("mouseover", {
                            bubbles: true,
                            cancelable: true,
                            view: window,
                        });
                        break;

                    default:
                        eventObj = new Event(event, {
                            bubbles: true,
                            cancelable: true,
                        });
                }

                lastTargetElement.dispatchEvent(eventObj);
            } catch (error) {
                console.error(`Error dispatching ${event} event:`, error);
                toast.error(`Failed to dispatch ${event} event`);
            }
        } else {
            toast.error("No element selected to simulate event");
        }
    };

    const handleShowGlobalState = () => {
        let globalState: Record<string, unknown> = {};

        // Check for Redux DevTools Extension
        if (window.__REDUX_DEVTOOLS_EXTENSION__) {
            try {
                console.info("Redux state found. Check Redux DevTools.");
            } catch (error: unknown) {
                console.error(
                    "Failed to access Redux state",
                    error instanceof Error ? error.message : String(error),
                );
            }
        }

        globalState = {
            url: window.location.href,
            time: new Date().toISOString(),
            localStorage: Object.keys(localStorage).length,
            sessionStorage: Object.keys(sessionStorage).length,
            cookies: document.cookie.split(";").length,
        };

        // Log state to console in a nice format
        console.group(
            "%c🌐 Global State Overview",
            "font-weight: bold; font-size: 14px",
        );
        console.table(globalState);

        // Add more detailed logging for specific items
        console.group("%c📦 localStorage Items", "color: #0066cc");
        const localStorageItems: Record<string, string | null> = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) {
                try {
                    localStorageItems[key] = localStorage.getItem(key);
                } catch {
                    localStorageItems[key] = "[Error reading value]";
                }
            }
        }
        console.table(localStorageItems);
        console.groupEnd();

        console.group("%c🔄 sessionStorage Items", "color: #6600cc");
        const sessionStorageItems: Record<string, string | null> = {};
        for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (key) {
                try {
                    sessionStorageItems[key] = sessionStorage.getItem(key);
                } catch {
                    sessionStorageItems[key] = "[Error reading value]";
                }
            }
        }
        console.table(sessionStorageItems);
        console.groupEnd();

        console.group("%c🍪 Cookies", "color: #cc6600");
        const cookieItems: Record<string, string> = {};
        document.cookie.split(";").forEach((cookie) => {
            const parts = cookie.trim().split("=");
            if (parts.length >= 2) {
                const key = parts[0];
                const value = parts.slice(1).join("=");
                cookieItems[key] = value;
            }
        });
        console.table(cookieItems);
        console.groupEnd();

        console.groupEnd();

        // Show a single toast to notify user to check console
        toast.info("Global state logged to console", {
            description: "Press CTRL+SHIFT+I to view detailed information",
        });
    };

    return (
        <>
            {/* Hidden trigger element - the actual context menu will be shown via the global listener */}
            <div ref={triggerRef} style={{ display: "none" }} />

            {showOutlines && (
                <style>{`
                    /* Base outline for all elements */
                    .debug-outline * {
                        outline: 1px dashed rgba(128, 128, 128, 0.2) !important;
                        outline-offset: -1px !important;
                    }

                    /* Interactive elements */
                    .debug-outline button,
                    .debug-outline a,
                    .debug-outline [role="button"],
                    .debug-outline input,
                    .debug-outline select,
                    .debug-outline textarea {
                        outline: 2px solid rgba(0, 150, 255, 0.3) !important;
                        outline-offset: -1px !important;
                    }

                    /* Clickable elements with no accessible name */
                    .debug-outline button:not([aria-label]):not(:has(span)),
                    .debug-outline a:not([aria-label]):empty,
                    .debug-outline [role="button"]:not([aria-label]) {
                        outline: 2px solid rgba(255, 50, 50, 0.8) !important;
                        outline-offset: -1px !important;
                    }

                    /* Images */
                    .debug-outline img {
                        outline: 2px solid rgba(255, 165, 0, 0.4) !important;
                        outline-offset: -1px !important;
                    }

                    /* Images without alt text */
                    .debug-outline img:not([alt]) {
                        outline: 2px solid rgba(255, 0, 0, 0.6) !important;
                        outline-offset: -1px !important;
                    }

                    /* Layout elements */
                    .debug-outline div:has(> div),
                    .debug-outline section,
                    .debug-outline main,
                    .debug-outline aside,
                    .debug-outline nav {
                        outline: 1px solid rgba(75, 0, 130, 0.2) !important;
                        outline-offset: -1px !important;
                    }

                    /* Text content */
                    .debug-outline p,
                    .debug-outline h1,
                    .debug-outline h2,
                    .debug-outline h3,
                    .debug-outline h4,
                    .debug-outline h5,
                    .debug-outline h6,
                    .debug-outline span {
                        outline: 1px solid rgba(0, 128, 0, 0.2) !important;
                        outline-offset: -1px !important;
                    }

                    /* Flex and grid containers */
                    .debug-outline [class*="flex"],
                    .debug-outline [class*="grid"] {
                        outline: 1px dotted rgba(138, 43, 226, 0.3) !important;
                        outline-offset: -1px !important;
                    }

                    /* Hide outlines for pseudo-elements and invisible elements */
                    .debug-outline ::before,
                    .debug-outline ::after,
                    .debug-outline [aria-hidden="true"],
                    .debug-outline [hidden],
                    .debug-outline .invisible {
                        outline: none !important;
                    }
                `}</style>
            )}

            {showPerformanceOverlay && <PerformanceOverlay />}

            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <div className="h-full w-full">{children}</div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuLabel>Developer Tools</ContextMenuLabel>

                    <ContextMenuSeparator />

                    <ContextMenuGroup>
                        <ContextMenuCheckboxItem
                            checked={showOutlines}
                            onCheckedChange={handleToggleOutlines}
                        >
                            <LayoutGrid className="mr-2 h-4 w-4" />
                            Show Element Outlines
                        </ContextMenuCheckboxItem>
                        <ContextMenuCheckboxItem
                            checked={showPerformanceOverlay}
                            onCheckedChange={handleTogglePerformance}
                        >
                            <Gauge className="mr-2 h-4 w-4" />
                            Performance Overlay
                        </ContextMenuCheckboxItem>
                    </ContextMenuGroup>

                    <ContextMenuSeparator />

                    <ContextMenuSub>
                        <ContextMenuSubTrigger>
                            <Smartphone className="mr-2 h-4 w-4" />
                            Responsive Preview
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                            <ContextMenuItem
                                onClick={() =>
                                    (document.body.style.width = "320px")
                                }
                            >
                                Mobile (320px)
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() =>
                                    (document.body.style.width = "768px")
                                }
                            >
                                Tablet (768px)
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() =>
                                    (document.body.style.width = "1024px")
                                }
                            >
                                Desktop (1024px)
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() =>
                                    (document.body.style.width = "100%")
                                }
                            >
                                Reset
                            </ContextMenuItem>
                        </ContextMenuSubContent>
                    </ContextMenuSub>

                    <ContextMenuSub>
                        <ContextMenuSubTrigger>
                            <Zap className="mr-2 h-4 w-4" />
                            Simulate Event
                        </ContextMenuSubTrigger>
                        <ContextMenuSubContent>
                            <ContextMenuItem
                                onClick={() => handleSimulateEvent("click")}
                            >
                                Click
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() => handleSimulateEvent("focus")}
                            >
                                Focus
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() => handleSimulateEvent("blur")}
                            >
                                Blur
                            </ContextMenuItem>
                            <ContextMenuItem
                                onClick={() => handleSimulateEvent("mouseover")}
                            >
                                Hover
                            </ContextMenuItem>
                        </ContextMenuSubContent>
                    </ContextMenuSub>

                    <ContextMenuSeparator />

                    <ContextMenuItem onClick={handleForceRerender}>
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Force Re-render
                    </ContextMenuItem>

                    <ContextMenuItem onClick={handleCopyComponentPath}>
                        <Clipboard className="mr-2 h-4 w-4" />
                        Copy Component Path
                    </ContextMenuItem>

                    <ContextMenuItem onClick={handleAccessibilityCheck}>
                        <Accessibility className="mr-2 h-4 w-4" />
                        Accessibility Checker
                    </ContextMenuItem>

                    <ContextMenuItem onClick={handleShowGlobalState}>
                        <Store className="mr-2 h-4 w-4" />
                        Show Global State
                    </ContextMenuItem>

                    {/* The Inspect Element option will be added by the ContextMenuContent component */}
                </ContextMenuContent>
            </ContextMenu>
        </>
    );
}
