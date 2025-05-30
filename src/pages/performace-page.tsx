import React, { useEffect, useState, useMemo } from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    ResponsiveContainer,
    PieChart,
    Pie,
    Cell,
} from "recharts";
import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    ChartLegend,
    ChartLegendContent,
} from "@/components/ui/chart";
import {
    AlertCircle,
    Clock,
    FileCode,
    ChevronDown,
    ChevronRight,
    BarChart4,
    PieChart as PieChartIcon,
    Table as TableIcon,
    Search,
    RefreshCw,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { cn } from "@/utils/tailwind";

// Types for the performance data
interface PerformanceStep {
    average: number;
    median: number;
    percentOfTotal: number;
}

interface PerformanceEntry {
    timestamp: number;
    totalDuration: number;
    steps: Record<string, number>;
    cached?: boolean;
}

interface PerformanceData {
    functionName: string;
    totalInvocations: number;
    averageTotalDuration: number;
    medianTotalDuration: number;
    steps: Record<string, PerformanceStep>;
    entries: PerformanceEntry[];
}

export default function PerformancePage() {
    const [isLoading, setIsLoading] = useState(true);
    const [performanceData, setPerformanceData] = useState<
        Record<string, PerformanceData>
    >({});
    const [selectedFunction, setSelectedFunction] = useState<string | null>(
        null,
    );
    const [searchQuery, setSearchQuery] = useState("");
    const [sortBy, setSortBy] = useState<
        "invocations" | "averageDuration" | "medianDuration"
    >("averageDuration");
    const [activeTab, setActiveTab] = useState("overview");
    const [expandedEntries, setExpandedEntries] = useState<
        Record<string, boolean>
    >({});
    const [cacheView, setCacheView] = useState<"all" | "cached" | "uncached">(
        "all",
    );

    const loadPerformanceData = async () => {
        setIsLoading(true);
        try {
            const result = await window.performanceMonitor.getAllData();
            console.log(result);
            if (result.success) {
                setPerformanceData(
                    result.data as Record<string, PerformanceData>,
                );
                if (!selectedFunction && Object.keys(result.data).length > 0) {
                    // Select the function with the highest average duration by default
                    const functionNames = Object.keys(result.data);
                    const highestDurationFunction = functionNames.reduce(
                        (prev, curr) => {
                            const prevData = result.data[
                                prev
                            ] as PerformanceData;
                            const currData = result.data[
                                curr
                            ] as PerformanceData;
                            return prevData.averageTotalDuration >
                                currData.averageTotalDuration
                                ? prev
                                : curr;
                        },
                    );
                    setSelectedFunction(highestDurationFunction);
                }
            } else {
                console.error("Failed to load performance data:", result.error);
            }
        } catch (error) {
            console.error("Error loading performance data:", error);
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        loadPerformanceData();
    }, []);

    const toggleEntryExpansion = (entryId: string) => {
        setExpandedEntries((prev) => ({
            ...prev,
            [entryId]: !prev[entryId],
        }));
    };

    const filteredFunctions = useMemo(() => {
        return Object.entries(performanceData)
            .filter(([name]) =>
                name.toLowerCase().includes(searchQuery.toLowerCase()),
            )
            .sort(([, a], [, b]) => {
                switch (sortBy) {
                    case "invocations":
                        return b.totalInvocations - a.totalInvocations;
                    case "averageDuration":
                        return b.averageTotalDuration - a.averageTotalDuration;
                    case "medianDuration":
                        return b.medianTotalDuration - a.medianTotalDuration;
                    default:
                        return 0;
                }
            })
            .map(([name, data]) => ({ name, data }));
    }, [performanceData, searchQuery, sortBy]);

    const selectedFunctionData = selectedFunction
        ? performanceData[selectedFunction]
        : null;

    // Prepare chart data for the selected function
    const stepChartData = useMemo(() => {
        if (!selectedFunctionData) return [];

        return Object.entries(selectedFunctionData.steps)
            .map(([name, step]) => ({
                name: name.length > 20 ? `${name.substring(0, 18)}...` : name,
                fullName: name,
                average: step.average,
                median: step.median,
                percentage: step.percentOfTotal,
            }))
            .sort((a, b) => b.average - a.average);
    }, [selectedFunctionData]);

    // Prepare pie chart data
    const pieChartData = useMemo(() => {
        if (!selectedFunctionData) return [];

        const steps = Object.entries(selectedFunctionData.steps)
            .map(([name, step]) => ({
                name,
                value: step.average,
                percentage: step.percentOfTotal,
            }))
            .sort((a, b) => b.value - a.value);

        // If we have more than 5 steps, group the smaller ones
        if (steps.length > 5) {
            const topSteps = steps.slice(0, 4);
            const otherSteps = steps.slice(4);
            const otherValue = otherSteps.reduce(
                (sum, step) => sum + step.value,
                0,
            );
            const otherPercentage = otherSteps.reduce(
                (sum, step) => sum + step.percentage,
                0,
            );

            return [
                ...topSteps,
                {
                    name: "Other Steps",
                    value: otherValue,
                    percentage: otherPercentage,
                },
            ];
        }

        return steps;
    }, [selectedFunctionData]);

    // Colors for the charts
    const COLORS = [
        "#0088FE",
        "#00C49F",
        "#FFBB28",
        "#FF8042",
        "#8884d8",
        "#82ca9d",
    ];

    const getColorForDuration = (duration: number) => {
        if (duration < 10) return "text-green-500";
        if (duration < 50) return "text-yellow-500";
        return "text-red-500";
    };

    // Chart config for our components
    const chartConfig = useMemo(() => {
        const config: Record<string, { color: string; label: string }> = {};

        if (stepChartData) {
            config.average = { color: "#0088FE", label: "Average" };
            config.median = { color: "#00C49F", label: "Median" };
        }

        if (pieChartData) {
            pieChartData.forEach((item, index) => {
                config[item.name] = {
                    color: COLORS[index % COLORS.length],
                    label: item.name,
                };
            });
        }

        return config;
    }, [stepChartData, pieChartData]);

    // Format a time value for display
    const formatTime = (time: number) => {
        if (time >= 1000) {
            return `${(time / 1000).toFixed(2)}s`;
        }
        return `${time.toFixed(2)}ms`;
    };

    // Function to filter entries based on cache status
    const filterEntriesByCacheStatus = (
        entries: PerformanceEntry[],
    ): PerformanceEntry[] => {
        if (cacheView === "all") return entries;
        if (cacheView === "cached")
            return entries.filter((entry) => entry.cached);
        return entries.filter((entry) => !entry.cached);
    };

    // Get filtered entries for the selected function
    const getFilteredEntries = useMemo(() => {
        if (!selectedFunctionData) return [];
        return filterEntriesByCacheStatus(selectedFunctionData.entries);
    }, [selectedFunctionData, cacheView]);

    // Check if the selected function has cached data
    const hasCachedData = useMemo(() => {
        if (!selectedFunctionData) return false;
        return selectedFunctionData.entries.some((entry) => entry.cached);
    }, [selectedFunctionData]);

    // Check if the selected function has uncached data
    const hasUncachedData = useMemo(() => {
        if (!selectedFunctionData) return false;
        return selectedFunctionData.entries.some((entry) => !entry.cached);
    }, [selectedFunctionData]);

    // Calculate average duration for filtered entries
    const calculateAverageDuration = (entries: PerformanceEntry[]): number => {
        if (entries.length === 0) return 0;
        return (
            entries.reduce((sum, entry) => sum + entry.totalDuration, 0) /
            entries.length
        );
    };

    // Prepare chart data for comparison between cached and uncached
    const cacheComparisonData = useMemo(() => {
        if (!selectedFunctionData || !hasCachedData || !hasUncachedData)
            return [];

        const cachedEntries = selectedFunctionData.entries.filter(
            (entry) => entry.cached,
        );
        const uncachedEntries = selectedFunctionData.entries.filter(
            (entry) => !entry.cached,
        );

        const cachedDuration = calculateAverageDuration(cachedEntries);
        const uncachedDuration = calculateAverageDuration(uncachedEntries);

        // Get all step names across both cached and uncached entries
        const allStepNames = new Set<string>();
        cachedEntries.forEach((entry) =>
            Object.keys(entry.steps).forEach((step) => allStepNames.add(step)),
        );
        uncachedEntries.forEach((entry) =>
            Object.keys(entry.steps).forEach((step) => allStepNames.add(step)),
        );

        // Calculate average step durations
        const result = Array.from(allStepNames).map((step) => {
            const cachedSteps = cachedEntries.filter(
                (entry) => step in entry.steps,
            );
            const uncachedSteps = uncachedEntries.filter(
                (entry) => step in entry.steps,
            );

            const cachedAvg =
                cachedSteps.length > 0
                    ? cachedSteps.reduce(
                          (sum, entry) => sum + entry.steps[step],
                          0,
                      ) / cachedSteps.length
                    : 0;

            const uncachedAvg =
                uncachedSteps.length > 0
                    ? uncachedSteps.reduce(
                          (sum, entry) => sum + entry.steps[step],
                          0,
                      ) / uncachedSteps.length
                    : 0;

            return {
                name: step.length > 20 ? `${step.substring(0, 18)}...` : step,
                fullName: step,
                cached: cachedAvg,
                uncached: uncachedAvg,
                difference: uncachedAvg - cachedAvg,
                improvement:
                    uncachedAvg > 0
                        ? ((uncachedAvg - cachedAvg) / uncachedAvg) * 100
                        : 0,
            };
        });

        // Add total duration comparison
        result.unshift({
            name: "Total",
            fullName: "Total Duration",
            cached: cachedDuration,
            uncached: uncachedDuration,
            difference: uncachedDuration - cachedDuration,
            improvement:
                uncachedDuration > 0
                    ? ((uncachedDuration - cachedDuration) / uncachedDuration) *
                      100
                    : 0,
        });

        return result.sort((a, b) => b.difference - a.difference);
    }, [selectedFunctionData, hasCachedData, hasUncachedData]);

    // Compute stats based on filtered entries
    const computeFilteredStats = useMemo(() => {
        if (!selectedFunctionData) return null;

        const filteredEntries = getFilteredEntries;
        if (filteredEntries.length === 0) return null;

        const avgDuration = calculateAverageDuration(filteredEntries);

        // Get all step names
        const stepNames = new Set<string>();
        filteredEntries.forEach((entry) =>
            Object.keys(entry.steps).forEach((step) => stepNames.add(step)),
        );

        // Calculate step stats
        const stepStats: Record<
            string,
            { average: number; percentage: number }
        > = {};
        stepNames.forEach((step) => {
            const entriesWithStep = filteredEntries.filter(
                (entry) => step in entry.steps,
            );
            if (entriesWithStep.length > 0) {
                const avgStepDuration =
                    entriesWithStep.reduce(
                        (sum, entry) => sum + entry.steps[step],
                        0,
                    ) / entriesWithStep.length;
                stepStats[step] = {
                    average: avgStepDuration,
                    percentage:
                        avgDuration > 0
                            ? (avgStepDuration / avgDuration) * 100
                            : 0,
                };
            }
        });

        return {
            count: filteredEntries.length,
            avgDuration,
            stepStats,
        };
    }, [selectedFunctionData, getFilteredEntries]);

    // Update the chart data based on the filtered entries
    const filteredStepChartData = useMemo(() => {
        if (!computeFilteredStats || !selectedFunctionData) return [];

        return Object.entries(computeFilteredStats.stepStats)
            .map(([name, stats]) => ({
                name: name.length > 20 ? `${name.substring(0, 18)}...` : name,
                fullName: name,
                average: stats.average,
                percentage: stats.percentage,
            }))
            .sort((a, b) => b.average - a.average);
    }, [computeFilteredStats, selectedFunctionData]);

    // Get the cache view label for display
    const getCacheTypeLabel = () => {
        if (cacheView === "all") return "All Executions";
        if (cacheView === "cached") return "Cached Executions";
        return "Uncached Executions";
    };

    return (
        <div className="container mx-auto space-y-6 p-4">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold">Performance Analysis</h1>
                    <p className="text-muted-foreground mt-1">
                        Analyze function execution times and identify
                        performance bottlenecks
                    </p>
                </div>
                <Button
                    onClick={loadPerformanceData}
                    variant="outline"
                    className="flex items-center gap-2"
                >
                    <RefreshCw className="h-4 w-4" />
                    Refresh Data
                </Button>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
                {/* Function List */}
                <Card className="lg:col-span-1">
                    <CardHeader className="pb-3">
                        <CardTitle>Functions</CardTitle>
                        <CardDescription>
                            {isLoading ? (
                                <Skeleton className="h-5 w-32" />
                            ) : (
                                `${Object.keys(performanceData).length} functions recorded`
                            )}
                        </CardDescription>
                        <div className="mt-2 flex flex-col gap-2">
                            <div className="relative">
                                <Search className="text-muted-foreground absolute top-2.5 left-2 h-4 w-4" />
                                <Input
                                    placeholder="Search functions..."
                                    className="pl-8"
                                    value={searchQuery}
                                    onChange={(e) =>
                                        setSearchQuery(e.target.value)
                                    }
                                />
                            </div>
                            <Select
                                value={sortBy}
                                onValueChange={(value) =>
                                    setSortBy(
                                        value as
                                            | "invocations"
                                            | "averageDuration"
                                            | "medianDuration",
                                    )
                                }
                            >
                                <SelectTrigger className="w-full">
                                    <SelectValue placeholder="Sort by" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="averageDuration">
                                        Average Duration
                                    </SelectItem>
                                    <SelectItem value="medianDuration">
                                        Median Duration
                                    </SelectItem>
                                    <SelectItem value="invocations">
                                        Invocation Count
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </CardHeader>
                    <CardContent className="max-h-[calc(100vh-22rem)] overflow-hidden p-0">
                        {isLoading ? (
                            <div className="space-y-2 px-3 pb-3">
                                {Array.from({ length: 5 }).map((_, i) => (
                                    <Skeleton key={i} className="h-14 w-full" />
                                ))}
                            </div>
                        ) : (
                            <ScrollArea className="h-full">
                                <div className="space-y-1 px-3 pb-3">
                                    {filteredFunctions.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center py-8 text-center">
                                            <AlertCircle className="text-muted-foreground mb-2 h-8 w-8" />
                                            <p className="text-muted-foreground">
                                                No functions found
                                            </p>
                                            <p className="text-muted-foreground text-sm">
                                                Try adjusting your search or
                                                filter criteria
                                            </p>
                                        </div>
                                    ) : (
                                        filteredFunctions.map(
                                            ({ name, data }) => (
                                                <Button
                                                    key={name}
                                                    variant={
                                                        selectedFunction ===
                                                        name
                                                            ? "default"
                                                            : "ghost"
                                                    }
                                                    className={cn(
                                                        "h-auto w-full justify-start px-3 py-3 text-left",
                                                        selectedFunction ===
                                                            name &&
                                                            "bg-primary text-primary-foreground",
                                                    )}
                                                    onClick={() =>
                                                        setSelectedFunction(
                                                            name,
                                                        )
                                                    }
                                                >
                                                    <div className="flex w-full flex-col items-start">
                                                        <div className="w-full truncate font-medium">
                                                            {name}
                                                        </div>
                                                        <div className="mt-1 flex w-full items-center gap-3 text-xs">
                                                            <span
                                                                className={cn(
                                                                    "font-mono",
                                                                    selectedFunction !==
                                                                        name &&
                                                                        getColorForDuration(
                                                                            data.averageTotalDuration,
                                                                        ),
                                                                )}
                                                            >
                                                                {formatTime(
                                                                    data.averageTotalDuration,
                                                                )}
                                                            </span>
                                                            <span
                                                                className={
                                                                    selectedFunction ===
                                                                    name
                                                                        ? ""
                                                                        : "text-muted-foreground"
                                                                }
                                                            >
                                                                {
                                                                    data.totalInvocations
                                                                }{" "}
                                                                calls
                                                            </span>
                                                        </div>
                                                    </div>
                                                </Button>
                                            ),
                                        )
                                    )}
                                </div>
                            </ScrollArea>
                        )}
                    </CardContent>
                </Card>

                {/* Function Details */}
                <div className="space-y-6 lg:col-span-3">
                    {isLoading ? (
                        <Card>
                            <CardHeader>
                                <Skeleton className="mb-2 h-8 w-64" />
                                <Skeleton className="h-4 w-full" />
                            </CardHeader>
                            <CardContent>
                                <div className="space-y-4">
                                    <Skeleton className="h-auto w-full" />
                                    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                                        <Skeleton className="h-28 w-full" />
                                        <Skeleton className="h-28 w-full" />
                                        <Skeleton className="h-28 w-full" />
                                    </div>
                                </div>
                            </CardContent>
                        </Card>
                    ) : selectedFunctionData ? (
                        <>
                            <Card className="h-full">
                                <CardHeader>
                                    <div className="flex items-start justify-between">
                                        <div>
                                            <CardTitle className="flex items-center gap-2 text-xl font-bold">
                                                <FileCode className="h-5 w-5" />
                                                {selectedFunction}
                                            </CardTitle>
                                            <CardDescription>
                                                Function execution time analysis
                                            </CardDescription>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {hasCachedData &&
                                                hasUncachedData && (
                                                    <Badge
                                                        variant="outline"
                                                        className="flex items-center gap-1 bg-amber-100 dark:bg-amber-950"
                                                    >
                                                        <Clock className="h-3 w-3" />
                                                        {(
                                                            ((calculateAverageDuration(
                                                                selectedFunctionData.entries.filter(
                                                                    (e) =>
                                                                        !e.cached,
                                                                ),
                                                            ) -
                                                                calculateAverageDuration(
                                                                    selectedFunctionData.entries.filter(
                                                                        (e) =>
                                                                            e.cached,
                                                                    ),
                                                                )) /
                                                                calculateAverageDuration(
                                                                    selectedFunctionData.entries.filter(
                                                                        (e) =>
                                                                            !e.cached,
                                                                    ),
                                                                )) *
                                                            100
                                                        ).toFixed(0)}
                                                        % faster with cache
                                                    </Badge>
                                                )}
                                            <Badge
                                                variant="outline"
                                                className="flex items-center gap-1"
                                            >
                                                <Clock className="h-3 w-3" />
                                                {formatTime(
                                                    selectedFunctionData.averageTotalDuration,
                                                )}{" "}
                                                avg
                                            </Badge>
                                            <Badge variant="outline">
                                                {
                                                    selectedFunctionData.totalInvocations
                                                }{" "}
                                                invocations
                                            </Badge>
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent className="pb-0">
                                    {/* Cache type selector */}
                                    {hasCachedData && hasUncachedData && (
                                        <div className="mb-4">
                                            <Tabs
                                                value={cacheView}
                                                onValueChange={(v) =>
                                                    setCacheView(
                                                        v as
                                                            | "all"
                                                            | "cached"
                                                            | "uncached",
                                                    )
                                                }
                                                className="w-full"
                                            >
                                                <TabsList className="grid w-full grid-cols-3">
                                                    <TabsTrigger value="all">
                                                        All (
                                                        {
                                                            selectedFunctionData
                                                                .entries.length
                                                        }
                                                        )
                                                    </TabsTrigger>
                                                    <TabsTrigger value="cached">
                                                        Cached (
                                                        {
                                                            selectedFunctionData.entries.filter(
                                                                (e) => e.cached,
                                                            ).length
                                                        }
                                                        )
                                                    </TabsTrigger>
                                                    <TabsTrigger value="uncached">
                                                        Uncached (
                                                        {
                                                            selectedFunctionData.entries.filter(
                                                                (e) =>
                                                                    !e.cached,
                                                            ).length
                                                        }
                                                        )
                                                    </TabsTrigger>
                                                </TabsList>
                                            </Tabs>
                                        </div>
                                    )}

                                    <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
                                        <Card>
                                            <CardHeader className="px-4 py-3">
                                                <CardTitle className="text-sm font-medium">
                                                    {getCacheTypeLabel()}{" "}
                                                    Average
                                                </CardTitle>
                                            </CardHeader>
                                            <CardContent className="px-4 py-2">
                                                <div
                                                    className={cn(
                                                        "text-2xl font-bold",
                                                        getColorForDuration(
                                                            computeFilteredStats?.avgDuration ||
                                                                0,
                                                        ),
                                                    )}
                                                >
                                                    {formatTime(
                                                        computeFilteredStats?.avgDuration ||
                                                            0,
                                                    )}
                                                </div>
                                                {computeFilteredStats && (
                                                    <p className="text-muted-foreground text-sm">
                                                        Based on{" "}
                                                        {
                                                            computeFilteredStats.count
                                                        }{" "}
                                                        executions
                                                    </p>
                                                )}
                                            </CardContent>
                                        </Card>
                                        <Card>
                                            <CardHeader className="px-4 py-3">
                                                <CardTitle className="text-sm font-medium">
                                                    Median Duration
                                                </CardTitle>
                                            </CardHeader>
                                            <CardContent className="px-4 py-2">
                                                <div
                                                    className={cn(
                                                        "text-2xl font-bold",
                                                        getColorForDuration(
                                                            selectedFunctionData.medianTotalDuration,
                                                        ),
                                                    )}
                                                >
                                                    {formatTime(
                                                        selectedFunctionData.medianTotalDuration,
                                                    )}
                                                </div>
                                            </CardContent>
                                        </Card>
                                        <Card>
                                            <CardHeader className="px-4 py-3">
                                                <CardTitle className="text-sm font-medium">
                                                    Steps
                                                </CardTitle>
                                            </CardHeader>
                                            <CardContent className="px-4 py-2">
                                                <div className="text-2xl font-bold">
                                                    {
                                                        Object.keys(
                                                            selectedFunctionData.steps,
                                                        ).length
                                                    }
                                                </div>
                                            </CardContent>
                                        </Card>
                                    </div>

                                    <Tabs
                                        value={activeTab}
                                        onValueChange={setActiveTab}
                                    >
                                        <TabsList className="mb-4">
                                            <TabsTrigger
                                                value="overview"
                                                className="flex items-center gap-1"
                                            >
                                                <BarChart4 className="h-4 w-4" />
                                                Overview
                                            </TabsTrigger>
                                            {hasCachedData &&
                                                hasUncachedData && (
                                                    <TabsTrigger
                                                        value="cache-comparison"
                                                        className="flex items-center gap-1"
                                                    >
                                                        <BarChart4 className="h-4 w-4" />
                                                        Cache Comparison
                                                    </TabsTrigger>
                                                )}
                                            <TabsTrigger
                                                value="steps"
                                                className="flex items-center gap-1"
                                            >
                                                <PieChartIcon className="h-4 w-4" />
                                                Steps
                                            </TabsTrigger>
                                            <TabsTrigger
                                                value="history"
                                                className="flex items-center gap-1"
                                            >
                                                <TableIcon className="h-4 w-4" />
                                                History
                                            </TabsTrigger>
                                        </TabsList>

                                        <TabsContent
                                            value="overview"
                                            className="space-y-4"
                                        >
                                            <div className="h-72 w-full">
                                                <ChartContainer
                                                    config={chartConfig}
                                                >
                                                    <ResponsiveContainer
                                                        width="100%"
                                                        height="100%"
                                                    >
                                                        <BarChart
                                                            data={
                                                                filteredStepChartData
                                                            }
                                                            margin={{
                                                                top: 20,
                                                                right: 30,
                                                                left: 20,
                                                                bottom: 70,
                                                            }}
                                                        >
                                                            <CartesianGrid strokeDasharray="3 3" />
                                                            <XAxis
                                                                dataKey="name"
                                                                angle={-45}
                                                                textAnchor="end"
                                                                tick={{
                                                                    fontSize: 12,
                                                                }}
                                                                height={80}
                                                            />
                                                            <YAxis
                                                                label={{
                                                                    value: "Duration (ms)",
                                                                    angle: -90,
                                                                    position:
                                                                        "insideLeft",
                                                                    style: {
                                                                        textAnchor:
                                                                            "middle",
                                                                    },
                                                                }}
                                                            />
                                                            <ChartTooltip
                                                                content={
                                                                    <ChartTooltipContent
                                                                        formatter={(
                                                                            value,
                                                                            name,
                                                                        ) => {
                                                                            if (
                                                                                name ===
                                                                                "percentage"
                                                                            )
                                                                                return [
                                                                                    `${typeof value === "number" ? value.toFixed(1) : parseFloat(String(value)).toFixed(1)}%`,
                                                                                    "Percentage",
                                                                                ];
                                                                            return [
                                                                                `${typeof value === "number" ? value.toFixed(2) : parseFloat(String(value)).toFixed(2)}ms`,
                                                                                name ===
                                                                                "average"
                                                                                    ? "Average"
                                                                                    : "Median",
                                                                            ];
                                                                        }}
                                                                        labelFormatter={(
                                                                            label,
                                                                            items,
                                                                        ) => {
                                                                            const item =
                                                                                items[0]
                                                                                    ?.payload;
                                                                            return (
                                                                                item?.fullName ||
                                                                                label
                                                                            );
                                                                        }}
                                                                    />
                                                                }
                                                            />
                                                            <Bar
                                                                dataKey="average"
                                                                fill="#0088FE"
                                                                name="average"
                                                            />
                                                        </BarChart>
                                                    </ResponsiveContainer>
                                                </ChartContainer>
                                            </div>
                                        </TabsContent>

                                        {hasCachedData && hasUncachedData && (
                                            <TabsContent
                                                value="cache-comparison"
                                                className="space-y-4"
                                            >
                                                <div className="h-96 w-full">
                                                    <ChartContainer
                                                        config={{
                                                            cached: {
                                                                color: "#4ade80",
                                                                label: "Cached",
                                                            },
                                                            uncached: {
                                                                color: "#f87171",
                                                                label: "Uncached",
                                                            },
                                                        }}
                                                    >
                                                        <ResponsiveContainer
                                                            width="100%"
                                                            height="100%"
                                                        >
                                                            <BarChart
                                                                data={
                                                                    cacheComparisonData
                                                                }
                                                                margin={{
                                                                    top: 20,
                                                                    right: 30,
                                                                    left: 20,
                                                                    bottom: 70,
                                                                }}
                                                            >
                                                                <CartesianGrid strokeDasharray="3 3" />
                                                                <XAxis
                                                                    dataKey="name"
                                                                    angle={-45}
                                                                    textAnchor="end"
                                                                    tick={{
                                                                        fontSize: 12,
                                                                    }}
                                                                    height={80}
                                                                />
                                                                <YAxis
                                                                    label={{
                                                                        value: "Duration (ms)",
                                                                        angle: -90,
                                                                        position:
                                                                            "insideLeft",
                                                                        style: {
                                                                            textAnchor:
                                                                                "middle",
                                                                        },
                                                                    }}
                                                                />
                                                                <ChartTooltip
                                                                    content={
                                                                        <ChartTooltipContent
                                                                            formatter={(
                                                                                value,
                                                                                name,
                                                                            ) => {
                                                                                if (
                                                                                    name ===
                                                                                    "improvement"
                                                                                )
                                                                                    return [
                                                                                        `${typeof value === "number" ? value.toFixed(1) : parseFloat(String(value)).toFixed(1)}%`,
                                                                                        "Improvement",
                                                                                    ];
                                                                                if (
                                                                                    name ===
                                                                                    "difference"
                                                                                )
                                                                                    return [
                                                                                        `${typeof value === "number" ? value.toFixed(2) : parseFloat(String(value)).toFixed(2)}ms`,
                                                                                        "Time Saved",
                                                                                    ];
                                                                                return [
                                                                                    `${typeof value === "number" ? value.toFixed(2) : parseFloat(String(value)).toFixed(2)}ms`,
                                                                                    name ===
                                                                                    "cached"
                                                                                        ? "Cached"
                                                                                        : "Uncached",
                                                                                ];
                                                                            }}
                                                                            labelFormatter={(
                                                                                label,
                                                                                items,
                                                                            ) => {
                                                                                const item =
                                                                                    items[0]
                                                                                        ?.payload;
                                                                                return (
                                                                                    item?.fullName ||
                                                                                    label
                                                                                );
                                                                            }}
                                                                        />
                                                                    }
                                                                />
                                                                <Bar
                                                                    dataKey="cached"
                                                                    fill="#4ade80"
                                                                    name="cached"
                                                                />
                                                                <Bar
                                                                    dataKey="uncached"
                                                                    fill="#f87171"
                                                                    name="uncached"
                                                                />
                                                            </BarChart>
                                                        </ResponsiveContainer>
                                                    </ChartContainer>
                                                </div>

                                                <Card>
                                                    <CardHeader className="py-3">
                                                        <CardTitle className="text-sm">
                                                            Cache Performance
                                                            Improvement
                                                        </CardTitle>
                                                    </CardHeader>
                                                    <CardContent className="p-0">
                                                        <Table>
                                                            <TableHeader>
                                                                <TableRow>
                                                                    <TableHead>
                                                                        Step
                                                                    </TableHead>
                                                                    <TableHead className="text-right">
                                                                        Uncached
                                                                        (ms)
                                                                    </TableHead>
                                                                    <TableHead className="text-right">
                                                                        Cached
                                                                        (ms)
                                                                    </TableHead>
                                                                    <TableHead className="text-right">
                                                                        Time
                                                                        Saved
                                                                    </TableHead>
                                                                    <TableHead className="text-right">
                                                                        Improvement
                                                                    </TableHead>
                                                                </TableRow>
                                                            </TableHeader>
                                                            <TableBody>
                                                                {cacheComparisonData.map(
                                                                    (
                                                                        step,
                                                                        idx,
                                                                    ) => (
                                                                        <TableRow
                                                                            key={
                                                                                idx
                                                                            }
                                                                        >
                                                                            <TableCell className="font-medium">
                                                                                {
                                                                                    step.fullName
                                                                                }
                                                                            </TableCell>
                                                                            <TableCell className="text-right font-mono">
                                                                                {step.uncached.toFixed(
                                                                                    2,
                                                                                )}
                                                                            </TableCell>
                                                                            <TableCell className="text-right font-mono">
                                                                                {step.cached.toFixed(
                                                                                    2,
                                                                                )}
                                                                            </TableCell>
                                                                            <TableCell className="text-right font-mono">
                                                                                {step.difference >
                                                                                0 ? (
                                                                                    <span className="text-green-500">
                                                                                        {step.difference.toFixed(
                                                                                            2,
                                                                                        )}
                                                                                        ms
                                                                                    </span>
                                                                                ) : (
                                                                                    <span className="text-gray-500">
                                                                                        {step.difference.toFixed(
                                                                                            2,
                                                                                        )}
                                                                                        ms
                                                                                    </span>
                                                                                )}
                                                                            </TableCell>
                                                                            <TableCell className="text-right">
                                                                                {step.improvement >
                                                                                1 ? (
                                                                                    <Badge
                                                                                        variant="outline"
                                                                                        className="bg-green-100 dark:bg-green-900"
                                                                                    >
                                                                                        {step.improvement.toFixed(
                                                                                            1,
                                                                                        )}
                                                                                        %
                                                                                    </Badge>
                                                                                ) : step.improvement <
                                                                                  0 ? (
                                                                                    <Badge
                                                                                        variant="outline"
                                                                                        className="bg-red-100 dark:bg-red-900"
                                                                                    >
                                                                                        {step.improvement.toFixed(
                                                                                            1,
                                                                                        )}
                                                                                        %
                                                                                    </Badge>
                                                                                ) : (
                                                                                    <Badge variant="outline">
                                                                                        {step.improvement.toFixed(
                                                                                            1,
                                                                                        )}
                                                                                        %
                                                                                    </Badge>
                                                                                )}
                                                                            </TableCell>
                                                                        </TableRow>
                                                                    ),
                                                                )}
                                                            </TableBody>
                                                        </Table>
                                                    </CardContent>
                                                </Card>
                                            </TabsContent>
                                        )}

                                        <TabsContent
                                            value="steps"
                                            className="space-y-6"
                                        >
                                            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                                                <Card>
                                                    <CardHeader className="py-3">
                                                        <CardTitle className="text-sm">
                                                            Step Duration
                                                            Distribution
                                                        </CardTitle>
                                                    </CardHeader>
                                                    <CardContent>
                                                        <div className="h-64">
                                                            <ChartContainer
                                                                config={
                                                                    chartConfig
                                                                }
                                                            >
                                                                <ResponsiveContainer
                                                                    width="100%"
                                                                    height="100%"
                                                                >
                                                                    <PieChart>
                                                                        <Pie
                                                                            data={
                                                                                pieChartData
                                                                            }
                                                                            cx="50%"
                                                                            cy="50%"
                                                                            labelLine={
                                                                                false
                                                                            }
                                                                            outerRadius={
                                                                                80
                                                                            }
                                                                            fill="#8884d8"
                                                                            dataKey="value"
                                                                            nameKey="name"
                                                                            label={({
                                                                                name,
                                                                                percent,
                                                                            }) =>
                                                                                `${name}: ${(percent * 100).toFixed(1)}%`
                                                                            }
                                                                        >
                                                                            {pieChartData.map(
                                                                                (
                                                                                    entry,
                                                                                    index,
                                                                                ) => (
                                                                                    <Cell
                                                                                        key={`cell-${index}`}
                                                                                        fill={
                                                                                            COLORS[
                                                                                                index %
                                                                                                    COLORS.length
                                                                                            ]
                                                                                        }
                                                                                    />
                                                                                ),
                                                                            )}
                                                                        </Pie>
                                                                        <ChartTooltip
                                                                            content={
                                                                                <ChartTooltipContent
                                                                                    formatter={(
                                                                                        value,
                                                                                    ) => [
                                                                                        `${typeof value === "number" ? value.toFixed(2) : parseFloat(String(value)).toFixed(2)}ms`,
                                                                                        "Duration",
                                                                                    ]}
                                                                                />
                                                                            }
                                                                        />
                                                                        <ChartLegend
                                                                            content={
                                                                                <ChartLegendContent
                                                                                    verticalAlign="bottom"
                                                                                    nameKey="name"
                                                                                />
                                                                            }
                                                                        />
                                                                    </PieChart>
                                                                </ResponsiveContainer>
                                                            </ChartContainer>
                                                        </div>
                                                    </CardContent>
                                                </Card>

                                                <Card>
                                                    <CardHeader className="py-3">
                                                        <CardTitle className="text-sm">
                                                            Step Details
                                                        </CardTitle>
                                                    </CardHeader>
                                                    <CardContent className="p-0">
                                                        <Table>
                                                            <TableHeader>
                                                                <TableRow>
                                                                    <TableHead>
                                                                        Step
                                                                        Name
                                                                    </TableHead>
                                                                    <TableHead className="text-right">
                                                                        Avg
                                                                        Duration
                                                                    </TableHead>
                                                                    <TableHead className="text-right">
                                                                        % of
                                                                        Total
                                                                    </TableHead>
                                                                </TableRow>
                                                            </TableHeader>
                                                            <TableBody>
                                                                {Object.entries(
                                                                    selectedFunctionData.steps,
                                                                )
                                                                    .sort(
                                                                        (
                                                                            a,
                                                                            b,
                                                                        ) =>
                                                                            b[1]
                                                                                .average -
                                                                            a[1]
                                                                                .average,
                                                                    )
                                                                    .map(
                                                                        ([
                                                                            stepName,
                                                                            stepData,
                                                                        ]) => (
                                                                            <TableRow
                                                                                key={
                                                                                    stepName
                                                                                }
                                                                            >
                                                                                <TableCell className="font-medium">
                                                                                    {
                                                                                        stepName
                                                                                    }
                                                                                </TableCell>
                                                                                <TableCell className="text-right font-mono">
                                                                                    {formatTime(
                                                                                        stepData.average,
                                                                                    )}
                                                                                </TableCell>
                                                                                <TableCell className="text-right">
                                                                                    <div className="flex items-center justify-end gap-2">
                                                                                        <Progress
                                                                                            value={
                                                                                                stepData.percentOfTotal
                                                                                            }
                                                                                            className="w-16"
                                                                                        />
                                                                                        {stepData.percentOfTotal.toFixed(
                                                                                            1,
                                                                                        )}

                                                                                        %
                                                                                    </div>
                                                                                </TableCell>
                                                                            </TableRow>
                                                                        ),
                                                                    )}
                                                            </TableBody>
                                                        </Table>
                                                    </CardContent>
                                                </Card>
                                            </div>
                                        </TabsContent>

                                        <TabsContent value="history">
                                            <Card>
                                                <CardHeader className="py-3">
                                                    <CardTitle className="text-sm">
                                                        Execution History
                                                    </CardTitle>
                                                    <CardDescription>
                                                        {getFilteredEntries.length ===
                                                        0 ? (
                                                            <span>
                                                                No {cacheView}{" "}
                                                                executions found
                                                            </span>
                                                        ) : (
                                                            <span>
                                                                Showing{" "}
                                                                {
                                                                    getFilteredEntries.length
                                                                }{" "}
                                                                {cacheView}{" "}
                                                                executions
                                                            </span>
                                                        )}
                                                    </CardDescription>
                                                </CardHeader>
                                                <CardContent className="p-0">
                                                    <Table>
                                                        <TableHeader>
                                                            <TableRow>
                                                                <TableHead>
                                                                    Timestamp
                                                                </TableHead>
                                                                <TableHead className="text-right">
                                                                    Duration
                                                                </TableHead>
                                                                <TableHead className="text-right">
                                                                    Steps
                                                                </TableHead>
                                                                {hasCachedData &&
                                                                    hasUncachedData && (
                                                                        <TableHead className="text-center">
                                                                            Cache
                                                                        </TableHead>
                                                                    )}
                                                                <TableHead className="w-8"></TableHead>
                                                            </TableRow>
                                                        </TableHeader>
                                                        <TableBody>
                                                            {getFilteredEntries
                                                                .sort(
                                                                    (a, b) =>
                                                                        b.timestamp -
                                                                        a.timestamp,
                                                                )
                                                                .map(
                                                                    (
                                                                        entry,
                                                                        idx,
                                                                    ) => {
                                                                        const entryId = `${selectedFunction}-${entry.timestamp}-${idx}`;
                                                                        const isExpanded =
                                                                            expandedEntries[
                                                                                entryId
                                                                            ] ||
                                                                            false;

                                                                        return (
                                                                            <React.Fragment
                                                                                key={
                                                                                    entryId
                                                                                }
                                                                            >
                                                                                <TableRow>
                                                                                    <TableCell>
                                                                                        {new Date(
                                                                                            entry.timestamp,
                                                                                        ).toLocaleString()}
                                                                                    </TableCell>
                                                                                    <TableCell
                                                                                        className={cn(
                                                                                            "text-right font-mono",
                                                                                            getColorForDuration(
                                                                                                entry.totalDuration,
                                                                                            ),
                                                                                        )}
                                                                                    >
                                                                                        {formatTime(
                                                                                            entry.totalDuration,
                                                                                        )}
                                                                                    </TableCell>
                                                                                    <TableCell className="text-right">
                                                                                        {
                                                                                            Object.keys(
                                                                                                entry.steps,
                                                                                            )
                                                                                                .length
                                                                                        }
                                                                                    </TableCell>
                                                                                    {hasCachedData &&
                                                                                        hasUncachedData && (
                                                                                            <TableCell className="text-center">
                                                                                                {entry.cached ? (
                                                                                                    <Badge
                                                                                                        variant="outline"
                                                                                                        className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100"
                                                                                                    >
                                                                                                        Cached
                                                                                                    </Badge>
                                                                                                ) : (
                                                                                                    <Badge
                                                                                                        variant="outline"
                                                                                                        className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100"
                                                                                                    >
                                                                                                        Uncached
                                                                                                    </Badge>
                                                                                                )}
                                                                                            </TableCell>
                                                                                        )}
                                                                                    <TableCell>
                                                                                        <Button
                                                                                            variant="ghost"
                                                                                            size="sm"
                                                                                            className="h-8 w-8 p-0"
                                                                                            onClick={() =>
                                                                                                toggleEntryExpansion(
                                                                                                    entryId,
                                                                                                )
                                                                                            }
                                                                                        >
                                                                                            {isExpanded ? (
                                                                                                <ChevronDown className="h-4 w-4" />
                                                                                            ) : (
                                                                                                <ChevronRight className="h-4 w-4" />
                                                                                            )}
                                                                                        </Button>
                                                                                    </TableCell>
                                                                                </TableRow>
                                                                                {isExpanded && (
                                                                                    <TableRow>
                                                                                        <TableCell
                                                                                            colSpan={
                                                                                                4
                                                                                            }
                                                                                            className="bg-muted/50 p-0"
                                                                                        >
                                                                                            <div className="p-3">
                                                                                                <Table>
                                                                                                    <TableHeader>
                                                                                                        <TableRow>
                                                                                                            <TableHead>
                                                                                                                Step
                                                                                                            </TableHead>
                                                                                                            <TableHead className="text-right">
                                                                                                                Duration
                                                                                                            </TableHead>
                                                                                                            <TableHead className="text-right">
                                                                                                                %
                                                                                                                of
                                                                                                                Total
                                                                                                            </TableHead>
                                                                                                        </TableRow>
                                                                                                    </TableHeader>
                                                                                                    <TableBody>
                                                                                                        {Object.entries(
                                                                                                            entry.steps,
                                                                                                        )
                                                                                                            .sort(
                                                                                                                (
                                                                                                                    a,
                                                                                                                    b,
                                                                                                                ) =>
                                                                                                                    b[1] -
                                                                                                                    a[1],
                                                                                                            )
                                                                                                            .map(
                                                                                                                ([
                                                                                                                    stepName,
                                                                                                                    duration,
                                                                                                                ]) => {
                                                                                                                    const percentage =
                                                                                                                        (duration /
                                                                                                                            entry.totalDuration) *
                                                                                                                        100;

                                                                                                                    return (
                                                                                                                        <TableRow
                                                                                                                            key={
                                                                                                                                stepName
                                                                                                                            }
                                                                                                                        >
                                                                                                                            <TableCell>
                                                                                                                                {
                                                                                                                                    stepName
                                                                                                                                }
                                                                                                                            </TableCell>
                                                                                                                            <TableCell className="text-right font-mono">
                                                                                                                                {formatTime(
                                                                                                                                    duration,
                                                                                                                                )}
                                                                                                                            </TableCell>
                                                                                                                            <TableCell className="text-right">
                                                                                                                                <div className="flex items-center justify-end gap-2">
                                                                                                                                    <Progress
                                                                                                                                        value={
                                                                                                                                            percentage
                                                                                                                                        }
                                                                                                                                        className="w-16"
                                                                                                                                    />
                                                                                                                                    {percentage.toFixed(
                                                                                                                                        1,
                                                                                                                                    )}

                                                                                                                                    %
                                                                                                                                </div>
                                                                                                                            </TableCell>
                                                                                                                        </TableRow>
                                                                                                                    );
                                                                                                                },
                                                                                                            )}
                                                                                                    </TableBody>
                                                                                                </Table>
                                                                                            </div>
                                                                                        </TableCell>
                                                                                    </TableRow>
                                                                                )}
                                                                            </React.Fragment>
                                                                        );
                                                                    },
                                                                )}
                                                        </TableBody>
                                                    </Table>
                                                </CardContent>
                                            </Card>
                                        </TabsContent>
                                    </Tabs>
                                </CardContent>
                            </Card>
                        </>
                    ) : (
                        <Card>
                            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                                <AlertCircle className="text-muted-foreground mb-4 h-12 w-12" />
                                <h3 className="mb-2 text-xl font-semibold">
                                    No function selected
                                </h3>
                                <p className="text-muted-foreground max-w-md">
                                    Select a function from the list to view
                                    detailed performance metrics and analysis
                                </p>
                            </CardContent>
                        </Card>
                    )}
                </div>
            </div>
        </div>
    );
}
