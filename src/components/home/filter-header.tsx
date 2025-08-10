import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MemoizedUnifiedFilterPanel } from "@/components/home/unified-filter-panel";
import { FolderOpen, Grid, List } from "lucide-react";
import React, { useMemo } from "react";
import { VideoGroup } from "@/types/video";
import { useSteam } from "@/contexts/steam-context";
import { getGameId, imgSrc } from "@/utils/games";
import { formatFileSize } from "@/utils/format";
import { ViewMode } from "@/pages/home-page";
import { Separator } from "../ui/separator";
import { useSetting } from "@/utils/settings";
import { cn } from "@/utils/tailwind";

interface FilterHeaderProps {
    directoryPath: string;
    filteredVideosCount: number;
    totalVideosCount: number;
    totalSize?: number;
    groups: VideoGroup[];
    selectedGroupIds: string[];
    startDate: Date | undefined;
    endDate: Date | undefined;
    games: string[];
    selectedGames: string[];
    clipCountByDate: Record<string, number>;
    viewMode: ViewMode;
    onSelectGroup: (groupIds: string[]) => void;
    onGameSelect: (games: string[]) => void;
    onDateRangeChange: (from: Date | undefined, to: Date | undefined) => void;
    onClearFilters: () => void;
    onChangeDirectory: () => Promise<void>;
    onSetViewMode: (mode: ViewMode) => void;
}

/**
 * Formats the total size to be displayed
 */
const formatSize = (sizeInBytes?: number): string => {
    if (sizeInBytes === undefined) return "";
    return formatFileSize(sizeInBytes);
};

/**
 * Header component with filtering options and directory info
 */
export function FilterHeader({
    directoryPath,
    filteredVideosCount,
    totalVideosCount,
    totalSize,
    groups,
    selectedGroupIds,
    startDate,
    endDate,
    games,
    selectedGames,
    clipCountByDate = {},
    viewMode,
    onSelectGroup,
    onGameSelect,
    onDateRangeChange,
    onClearFilters,
    onChangeDirectory,
    onSetViewMode,
}: FilterHeaderProps) {
    const { games: steamGames, gameImages, loading } = useSteam();
    const isCustomWindow = useSetting("windowIconsStyle") === "custom";

    const gameOptions = useMemo(() => {
        return games.map((game) => {
            const appId = getGameId(game, steamGames, loading);
            const gameImage = appId ? gameImages[appId] : null;

            return {
                label: game,
                value: game,
                icon: gameImage ? (
                    <img
                        src={imgSrc(gameImage.icon)}
                        alt={game}
                        className="h-4 w-4 rounded object-cover"
                    />
                ) : (
                    <div className="bg-muted h-4 w-4 rounded" />
                ),
            };
        });
    }, [games, steamGames, gameImages, loading]);

    const formattedTotalSize = formatSize(totalSize);

    return (
        <div className="flex items-start justify-between">
            <div>
                <h1 className="text-3xl font-bold">Clips</h1>
                <div className="mt-1 flex items-center gap-2">
                    <p className="text-muted-foreground">
                        {directoryPath}
                        {formattedTotalSize && (
                            <span className="text-muted-foreground ml-1">
                                ({formattedTotalSize})
                            </span>
                        )}
                    </p>
                    {filteredVideosCount !== totalVideosCount && (
                        <Badge variant="secondary">
                            Showing {filteredVideosCount} of {totalVideosCount}{" "}
                            videos
                        </Badge>
                    )}
                </div>
            </div>

            <div
                className={cn("flex items-center gap-2", {
                    "pr-32": isCustomWindow,
                })}
            >
                <Button
                    variant={viewMode === "list" ? "default" : "secondary"}
                    onClick={() => onSetViewMode("list")}
                >
                    <List className="h-4 w-4" />
                </Button>
                <Button
                    variant={viewMode === "grid" ? "default" : "secondary"}
                    onClick={() => onSetViewMode("grid")}
                >
                    <Grid className="h-4 w-4" />
                </Button>
                <Separator orientation="vertical" className="h-9!" />
                <MemoizedUnifiedFilterPanel
                    startDate={startDate}
                    endDate={endDate}
                    gameOptions={gameOptions}
                    selectedGames={selectedGames}
                    groups={groups}
                    selectedGroupIds={selectedGroupIds}
                    clipCountByDate={clipCountByDate}
                    onDateRangeChange={onDateRangeChange}
                    onGameSelect={onGameSelect}
                    onGroupSelect={onSelectGroup}
                    onClearFilters={onClearFilters}
                />
                <Button
                    onClick={onChangeDirectory}
                    variant="outline"
                    className="gap-2"
                >
                    <FolderOpen size={18} />
                    Change Directory
                </Button>
            </div>
        </div>
    );
}
