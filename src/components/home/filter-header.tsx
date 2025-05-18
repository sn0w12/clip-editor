import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MemoizedUnifiedFilterPanel } from "@/components/home/unified-filter-panel";
import { FolderOpen } from "lucide-react";
import React, { useMemo } from "react";
import { VideoGroup } from "@/types/video";
import { useSteam } from "@/contexts/steam-context";
import { getGameId, imgSrc } from "@/utils/games";

interface FilterHeaderProps {
    directoryPath: string;
    filteredVideosCount: number;
    totalVideosCount: number;
    groups: VideoGroup[];
    selectedGroupIds: string[];
    startDate: Date | undefined;
    endDate: Date | undefined;
    games: string[];
    selectedGames: string[];
    clipCountByDate: Record<string, number>;
    onSelectGroup: (groupIds: string[]) => void;
    onGameSelect: (games: string[]) => void;
    onDateRangeChange: (from: Date | undefined, to: Date | undefined) => void;
    onClearFilters: () => void;
    onChangeDirectory: () => Promise<void>;
}

/**
 * Header component with filtering options and directory info
 */
export function FilterHeader({
    directoryPath,
    filteredVideosCount,
    totalVideosCount,
    groups,
    selectedGroupIds,
    startDate,
    endDate,
    games,
    selectedGames,
    clipCountByDate = {},
    onSelectGroup,
    onGameSelect,
    onDateRangeChange,
    onClearFilters,
    onChangeDirectory,
}: FilterHeaderProps) {
    const { games: steamGames, gameImages, loading } = useSteam();

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
                ) : undefined,
            };
        });
    }, [games, steamGames, gameImages, loading]);

    return (
        <div className="flex items-center justify-between">
            <div>
                <h1 className="text-3xl font-bold">Clips</h1>
                <div className="mt-1 flex items-center gap-2">
                    <p className="text-muted-foreground">{directoryPath}</p>
                    {filteredVideosCount !== totalVideosCount && (
                        <Badge variant="secondary">
                            Showing {filteredVideosCount} of {totalVideosCount}{" "}
                            videos
                        </Badge>
                    )}
                </div>
            </div>

            <div className="flex items-center gap-2">
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
