import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import {
    Tooltip,
    TooltipTrigger,
    TooltipContent,
} from "@/components/ui/tooltip";
import { Filter, X } from "lucide-react";
import React, { JSX, useCallback, useMemo, useState } from "react";
import { VideoGroup } from "@/types/video";
import { MultiSelect } from "@/components/ui/multi-select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/utils/tailwind";

interface UnifiedFilterPanelProps {
    startDate: Date | undefined;
    endDate: Date | undefined;
    gameOptions: {
        label: string;
        value: string;
        icon?: JSX.Element;
    }[];
    selectedGames: string[];
    groups: VideoGroup[];
    selectedGroupIds: string[];
    clipCountByDate: Record<string, number>;
    onDateRangeChange: (from: Date | undefined, to: Date | undefined) => void;
    onGameSelect: (games: string[]) => void;
    onGroupSelect: (groupIds: string[]) => void;
    onClearFilters: () => void;
}

/**
 * Unified filter panel component that combines date, game, and group filters
 */
export function UnifiedFilterPanel({
    startDate,
    endDate,
    gameOptions,
    selectedGames,
    groups,
    selectedGroupIds,
    clipCountByDate = {},
    onDateRangeChange,
    onGameSelect,
    onGroupSelect,
    onClearFilters,
}: UnifiedFilterPanelProps) {
    const [isOpen, setIsOpen] = useState(false);

    // Count active filters
    const activeFilterCount = useMemo(() => {
        let count = 0;
        if (startDate || endDate) count++;
        if (selectedGames.length > 0) count++;
        if (selectedGroupIds.length > 0) count++;
        return count;
    }, [startDate, endDate, selectedGames, selectedGroupIds]);

    const maxClipCount = useMemo(() => {
        return Object.values(clipCountByDate).reduce(
            (max, count) => (count > max ? count : max),
            0,
        );
    }, [clipCountByDate]);

    const formatDateKey = (date: Date): string => {
        return date.toISOString().split("T")[0];
    };

    // Create modifiers for days with clips
    const dayWithClipsModifier = (date: Date) => {
        const dateKey = formatDateKey(date);
        return dateKey in clipCountByDate && clipCountByDate[dateKey] > 0;
    };

    // Function to render day content with clip indicator
    const renderDayContent = useCallback(
        (day: Date) => {
            const dateKey = formatDateKey(day);
            const clipCount = clipCountByDate[dateKey] || 0;

            // Calculate relative percentage (0-100%)
            const percentage =
                maxClipCount > 0 ? (clipCount / maxClipCount) * 100 : 0;

            // Calculate width class (w-1 to w-5) based on percentage
            let widthClass = "w-0";
            if (clipCount > 0) {
                if (percentage >= 90) widthClass = "w-5";
                else if (percentage >= 80) widthClass = "w-4.5";
                else if (percentage >= 70) widthClass = "w-4";
                else if (percentage >= 60) widthClass = "w-3.5";
                else if (percentage >= 50) widthClass = "w-3";
                else if (percentage >= 40) widthClass = "w-2.5";
                else if (percentage >= 30) widthClass = "w-2";
                else if (percentage >= 20) widthClass = "w-1.5";
                else if (percentage >= 10) widthClass = "w-1";
                else widthClass = "w-0.5";
            }

            // Calculate opacity based on percentage
            const opacity =
                clipCount > 0
                    ? Math.max(0.4, Math.min(1, 0.4 + (percentage / 100) * 0.6))
                    : 0;

            return (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <div className="relative flex h-full w-full items-center justify-center">
                            {day.getDate()}
                            {clipCount > 0 && (
                                <div className="absolute bottom-0.5 left-1/2 -translate-x-1/2 transform">
                                    <div
                                        className={cn(
                                            "h-1 rounded-full",
                                            widthClass,
                                        )}
                                        style={{
                                            backgroundColor: "var(--primary)",
                                            opacity: opacity,
                                        }}
                                    />
                                </div>
                            )}
                        </div>
                    </TooltipTrigger>
                    {clipCount > 0 && (
                        <TooltipContent side="top" className="text-center">
                            <span>
                                {clipCount} {clipCount === 1 ? "clip" : "clips"}
                            </span>
                        </TooltipContent>
                    )}
                </Tooltip>
            );
        },
        [clipCountByDate, maxClipCount, formatDateKey],
    );

    const groupOptions = useMemo(
        () =>
            groups.map((group) => ({
                label: group.name,
                value: group.id,
                icon: group.color && (
                    <span
                        className="inline-block h-3 w-3 rounded-full"
                        style={{ backgroundColor: group.color }}
                    />
                ),
            })),
        [groups],
    );

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
                <Button variant="outline" className="gap-2">
                    <Filter size={18} />
                    Filters
                    {activeFilterCount > 0 && (
                        <Badge
                            variant="secondary"
                            className="ml-1 rounded-full px-1.5 py-0.5"
                        >
                            {activeFilterCount}
                        </Badge>
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64 p-0" align="end">
                <div className="p-4">
                    <div className="mb-2 flex items-center justify-between">
                        <h4 className="font-medium">Filter Videos</h4>
                        {activeFilterCount > 0 && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                    onClearFilters();
                                }}
                                className="h-8 gap-1 px-2"
                            >
                                <X size={14} />
                                Clear All
                            </Button>
                        )}
                    </div>
                    {/* Game Filter */}
                    <div className="mb-4">
                        <p className="text-muted-foreground mb-1.5 text-sm">
                            Game
                        </p>
                        <MultiSelect
                            options={gameOptions}
                            placeholder="Select games"
                            selected={selectedGames}
                            onChange={onGameSelect}
                            emptyText="No games found"
                        />
                    </div>
                    {/* Group Filter */}
                    <Separator className="my-4" />
                    {groups.length > 0 && (
                        <>
                            <div className="mb-4">
                                <p className="text-muted-foreground mb-1.5 text-sm">
                                    Group
                                </p>
                                <MultiSelect
                                    options={groupOptions}
                                    placeholder="Select groups"
                                    selected={selectedGroupIds}
                                    onChange={onGroupSelect}
                                    emptyText="No groups found"
                                />
                            </div>
                            <Separator className="my-4" />
                        </>
                    )}
                    {/* Date Filter */}
                    <div>
                        <div className="mb-1.5 flex items-center justify-between">
                            <p className="text-muted-foreground text-sm">
                                Date Range
                            </p>
                            {(startDate || endDate) && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        onDateRangeChange(undefined, undefined);
                                    }}
                                    className="h-7 gap-1 px-2"
                                >
                                    <X size={12} />
                                    Clear
                                </Button>
                            )}
                        </div>
                        <Calendar
                            mode="range"
                            selected={{
                                from: startDate,
                                to: endDate,
                            }}
                            onSelect={(range) => {
                                onDateRangeChange(range?.from, range?.to);
                            }}
                            initialFocus
                            numberOfMonths={1}
                            className="p-0"
                            modifiers={{
                                withClips: dayWithClipsModifier,
                            }}
                            modifiersClassNames={{
                                withClips: "has-clips",
                            }}
                            components={{
                                DayContent: ({ date }) =>
                                    renderDayContent(date),
                            }}
                        />
                    </div>
                </div>
            </PopoverContent>
        </Popover>
    );
}

export const MemoizedUnifiedFilterPanel = React.memo(UnifiedFilterPanel);
