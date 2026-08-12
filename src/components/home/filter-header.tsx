import { FilterIcon, FolderOpenIcon, Grid2X2Icon, ListIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { displayPath } from "@/lib/utils";
import type { ViewMode } from "@/pages/home-page";
import type { GameImage } from "@/types";
import type { VideoGroup } from "@/types";

import { GameIcon } from "../game-icon";

export interface FilterHeaderProps {
    directoryPath: string;
    filteredCount: number;
    totalCount: number;
    totalSize?: number;
    groups: VideoGroup[];
    selectedGroupIds: string[];
    selectedGames: string[];
    games: string[];
    /** Steam games (artwork) for the game-filter icons. */
    steamGames: { displayName: string; artwork?: GameImage | null }[];
    clipCountByDate: Record<string, number>;
    viewMode: ViewMode;
    startDate: Date | undefined;
    endDate: Date | undefined;
    onSelectGroup: (ids: string[]) => void;
    onGameSelect: (games: string[]) => void;
    onDateRangeChange: (from?: Date, to?: Date) => void;
    onClearFilters: () => void;
    onChangeDirectory: () => Promise<unknown>;
    onSetViewMode: (mode: ViewMode) => void;
}

export function FilterHeader({
    directoryPath,
    filteredCount,
    totalCount,
    totalSize,
    groups,
    selectedGroupIds,
    selectedGames,
    games,
    steamGames,
    clipCountByDate = {},
    viewMode,
    startDate,
    endDate,
    onSelectGroup,
    onGameSelect,
    onDateRangeChange,
    onClearFilters,
    onChangeDirectory,
    onSetViewMode,
}: FilterHeaderProps): React.ReactElement {
    const gameOptions = useMemo(
        () =>
            games.map((game) => {
                const image = steamGames.find((g) => g.displayName === game)?.artwork ?? null;
                return { label: game, value: game, image };
            }),
        [games, steamGames],
    );

    const activeFilterCount =
        (startDate || endDate ? 1 : 0) +
        (selectedGames.length > 0 ? 1 : 0) +
        (selectedGroupIds.length > 0 ? 1 : 0);

    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
                <h1 className="text-3xl font-bold">Clips</h1>
                <div className="mt-1 flex items-center gap-2">
                    <p className="text-muted-foreground truncate text-sm">
                        {displayPath(directoryPath)}
                    </p>
                    {totalSize !== undefined && totalSize > 0 && (
                        <span className="text-muted-foreground text-sm">
                            ({formatSize(totalSize)})
                        </span>
                    )}
                    {filteredCount !== totalCount && (
                        <Badge variant="secondary" className="shrink-0">
                            Showing {filteredCount} of {totalCount} videos
                        </Badge>
                    )}
                </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
                <Button
                    size="icon"
                    variant={viewMode === "list" ? "default" : "secondary"}
                    onClick={() => onSetViewMode("list")}
                    aria-label="List view"
                >
                    <ListIcon className="size-4" />
                </Button>
                <Button
                    size="icon"
                    variant={viewMode === "grid" ? "default" : "secondary"}
                    onClick={() => onSetViewMode("grid")}
                    aria-label="Grid view"
                >
                    <Grid2X2Icon className="size-4" />
                </Button>
                <Separator orientation="vertical" className="h-9!" />
                <FilterPanel
                    games={gameOptions}
                    selectedGames={selectedGames}
                    groups={groups}
                    selectedGroupIds={selectedGroupIds}
                    startDate={startDate}
                    endDate={endDate}
                    clipCountByDate={clipCountByDate}
                    activeFilterCount={activeFilterCount}
                    onGameSelect={onGameSelect}
                    onGroupSelect={onSelectGroup}
                    onDateRangeChange={onDateRangeChange}
                    onClearFilters={onClearFilters}
                />
                <Button
                    variant="outline"
                    className="gap-2"
                    onClick={() => void onChangeDirectory()}
                >
                    <FolderOpenIcon className="size-4" />
                    Change Directory
                </Button>
            </div>
        </div>
    );
}

function FilterPanel({
    games,
    selectedGames,
    groups,
    selectedGroupIds,
    startDate,
    endDate,
    clipCountByDate,
    activeFilterCount,
    onGameSelect,
    onGroupSelect,
    onDateRangeChange,
    onClearFilters,
}: {
    games: { label: string; value: string; image: GameImage | null }[];
    selectedGames: string[];
    groups: VideoGroup[];
    selectedGroupIds: string[];
    startDate?: Date;
    endDate?: Date;
    clipCountByDate: Record<string, number>;
    activeFilterCount: number;
    onGameSelect: (games: string[]) => void;
    onGroupSelect: (ids: string[]) => void;
    onDateRangeChange: (from?: Date, to?: Date) => void;
    onClearFilters: () => void;
}): React.ReactElement {
    const [isOpen, setIsOpen] = useState(false);
    const today = new Date();
    const todayKey = `${today.getFullYear()}-${(today.getMonth() + 1)
        .toString()
        .padStart(2, "0")}-${today.getDate().toString().padStart(2, "0")}`;

    const groupOptions = groups.map((group) => ({
        label: group.name,
        value: group.id,
        icon: group.color ?? null,
    }));

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger render={<Button variant="outline" className="gap-2" />}>
                <FilterIcon className="size-4" />
                Filters
                {activeFilterCount > 0 && (
                    <Badge variant="secondary" className="ml-1 rounded-full px-1.5 py-0.5">
                        {activeFilterCount}
                    </Badge>
                )}
            </PopoverTrigger>
            <PopoverContent align="end">
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
                            <XIcon className="size-3.5" />
                            Clear All
                        </Button>
                    )}
                </div>
                <div className="mb-4">
                    <p className="text-muted-foreground mb-1.5 text-sm">Game</p>
                    <Select
                        multiple
                        value={selectedGames}
                        items={games.map((g) => ({
                            label: g.label,
                            value: g.value,
                        }))}
                        onValueChange={onGameSelect}
                    >
                        <SelectTrigger>
                            <SelectValue placeholder="Select games" />
                        </SelectTrigger>
                        <SelectContent>
                            {games.map((game) => (
                                <SelectItem key={game.value} value={game.value}>
                                    <span className="flex items-center gap-2">
                                        <GameIcon game={game.value} gameImage={game.image} />
                                        {game.label}
                                    </span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <Separator className="my-4" />
                {groups.length > 0 && (
                    <>
                        <div className="mb-4">
                            <p className="text-muted-foreground mb-1.5 text-sm">Group</p>
                            <Select
                                multiple
                                value={selectedGroupIds}
                                items={groupOptions.map((g) => ({
                                    label: g.label,
                                    value: g.value,
                                }))}
                                onValueChange={onGroupSelect}
                            >
                                <SelectTrigger>
                                    <SelectValue placeholder="Select groups" />
                                </SelectTrigger>
                                <SelectContent>
                                    {groupOptions.map((group) => (
                                        <SelectItem key={group.value} value={group.value}>
                                            <span className="flex items-center gap-2">
                                                <span
                                                    className="inline-block size-3 rounded-full"
                                                    style={{
                                                        backgroundColor:
                                                            group.icon ?? "var(--accent-color)",
                                                    }}
                                                />
                                                {group.label}
                                            </span>
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <Separator className="my-4" />
                    </>
                )}
                <div>
                    <div className="mb-1.5 flex items-center justify-between">
                        <p className="text-muted-foreground text-sm">Date Range</p>
                        {(startDate || endDate) && (
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                    onDateRangeChange(undefined, undefined);
                                }}
                                className="h-7 gap-1 px-2"
                            >
                                <XIcon className="size-3" />
                                Clear
                            </Button>
                        )}
                    </div>
                    <Calendar
                        mode="range"
                        selected={{ from: startDate, to: endDate }}
                        onSelect={(range) => {
                            const from = range && "from" in range ? range.from : undefined;
                            const to = range && "to" in range ? range.to : undefined;
                            onDateRangeChange(from, to);
                        }}
                        numberOfMonths={1}
                        className="p-0"
                        modifiers={{
                            withClips: (day: Date) => {
                                const y = day.getFullYear();
                                const m = (day.getMonth() + 1).toString().padStart(2, "0");
                                const d = day.getDate().toString().padStart(2, "0");
                                const key = `${y}-${m}-${d}`;
                                // Today has its own indicator; don't add a clip dot.
                                return key !== todayKey && key in clipCountByDate;
                            },
                        }}
                    />
                </div>
            </PopoverContent>
        </Popover>
    );
}

function formatSize(sizeInBytes?: number): string {
    if (!sizeInBytes || sizeInBytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(Math.floor(Math.log(sizeInBytes) / Math.log(1024)), units.length - 1);
    const value = sizeInBytes / 1024 ** i;
    return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export type { ViewMode };
