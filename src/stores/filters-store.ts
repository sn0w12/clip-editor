import { useCallback, useState } from "react";

import { dateKey } from "@/lib/utils";
import type { VideoFile } from "@/types";

export interface LibraryFilters {
    dateRange: { start?: Date; end?: Date };
    selectedGames: string[];
    selectedGroupIds: string[];
}

const EMPTY_FILTERS: LibraryFilters = {
    dateRange: {},
    selectedGames: [],
    selectedGroupIds: [],
};

/** Module-level filter state so the active filters survive page navigation
 * (home <-> edit) without a provider; consumers hydrate from it on mount. */
let sharedDateRange: { start?: Date; end?: Date } = {};
let sharedSelectedGames: string[] = [];
let sharedSelectedGroupIds: string[] = [];

/** Apply the library filters to a clip list. Shared by the home grid and the
 * edit header's filmstrip so both pages always show the same set. */
export function filterClips(clips: VideoFile[], filters: LibraryFilters): VideoFile[] {
    let result = [...clips];
    if (filters.dateRange.start) {
        const start = dateKey(filters.dateRange.start.toISOString());
        result = result.filter((c) => dateKey(c.lastModified) >= start);
    }
    if (filters.dateRange.end) {
        const end = dateKey(filters.dateRange.end.toISOString());
        result = result.filter((c) => dateKey(c.lastModified) <= end);
    }
    if (filters.selectedGames.length > 0) {
        result = result.filter((c) => filters.selectedGames.includes(c.game));
    }
    if (filters.selectedGroupIds.length > 0) {
        result = result.filter((c) =>
            c.groupIds.some((id) => filters.selectedGroupIds.includes(id)),
        );
    }
    return result;
}

export function useFiltersStore(): LibraryFilters & {
    setDateRange: (range: { start?: Date; end?: Date }) => void;
    setSelectedGames: (games: string[]) => void;
    setSelectedGroupIds: (ids: string[]) => void;
    clearFilters: () => void;
} {
    const [dateRange, setDateRangeState] = useState(sharedDateRange);
    const [selectedGames, setSelectedGamesState] = useState(sharedSelectedGames);
    const [selectedGroupIds, setSelectedGroupIdsState] = useState(sharedSelectedGroupIds);

    const setDateRange = useCallback((range: { start?: Date; end?: Date }) => {
        sharedDateRange = range;
        setDateRangeState(range);
    }, []);
    const setSelectedGames = useCallback((games: string[]) => {
        sharedSelectedGames = games;
        setSelectedGamesState(games);
    }, []);
    const setSelectedGroupIds = useCallback((ids: string[]) => {
        sharedSelectedGroupIds = ids;
        setSelectedGroupIdsState(ids);
    }, []);
    const clearFilters = useCallback(() => {
        const next = EMPTY_FILTERS;
        sharedDateRange = next.dateRange;
        sharedSelectedGames = next.selectedGames;
        sharedSelectedGroupIds = next.selectedGroupIds;
        setDateRangeState(next.dateRange);
        setSelectedGamesState(next.selectedGames);
        setSelectedGroupIdsState(next.selectedGroupIds);
    }, []);

    return {
        dateRange,
        selectedGames,
        selectedGroupIds,
        setDateRange,
        setSelectedGames,
        setSelectedGroupIds,
        clearFilters,
    };
}
