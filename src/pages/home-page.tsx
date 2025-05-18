import { useSelection } from "@/contexts/selection-context";
import {
    getItemPositions,
    isInteractive,
    useSelectionShortcuts,
} from "@/utils/selection";
import React, { useEffect, useMemo, useRef } from "react";
// @ts-expect-error - Ignoring ESM/CommonJS module warning
import { boxesIntersect } from "@air/react-drag-to-select";
import { useSidebar } from "@/components/ui/sidebar";
import { CreateGroupDialog } from "@/components/home/create-group-dialog";
import { DirectorySelector } from "@/components/home/directory-selector";
import { FilterHeader } from "@/components/home/filter-header";
import { VideoGrid } from "@/components/home/video-grid";
import { useVideoStore } from "@/contexts/video-store-context";

export default function HomePage() {
    const {
        directoryPath,
        isLoading,
        videos,
        selectedVideos,
        setSelectedVideos,
        thumbnails,
        startDate,
        endDate,
        setStartDate,
        setEndDate,
        selectedGames,
        setSelectedGames,
        uniqueGames,
        groups,
        selectedGroupIds,
        setSelectedGroupIds,
        videoGroupMap,
        isCreateGroupDialogOpen,
        setIsCreateGroupDialogOpen,
        filteredVideos,
        handleSelectDirectory,
        handleCreateGroup,
        handleAddToGroup,
        handleRemoveFromGroup,
        clearAllFilters,
    } = useVideoStore(); // Selection state
    const contentRef = useRef<HTMLDivElement>(null);
    const selectableItems = useRef<DOMRect[]>([]);
    const {
        enableSelection,
        setOnSelectionChange,
        setShouldStartSelecting,
        getState,
    } = useSelection();
    const {
        state: sidebarState,
        isAnimating,
        onAnimationComplete,
    } = useSidebar();

    // Set up selection behavior
    useSelectionShortcuts(
        filteredVideos.map((v) => v.path),
        selectedVideos,
        setSelectedVideos,
    );

    // Setup selection functionality
    useEffect(() => {
        enableSelection(true);

        // Add click handler to clear selection when clicking the background
        const handleBackgroundClick = () => {
            // Only clear selection if we are not currently selecting
            if (!getState().isSelecting && selectedVideos.length > 0) {
                setSelectedVideos([]);
            }
        };

        window.addEventListener("click", handleBackgroundClick);

        setShouldStartSelecting((target) => {
            if (!(target instanceof HTMLElement)) return false;

            // Do not allow selection on sidebar
            const isWithinContent =
                contentRef.current?.parentElement?.contains(target);
            if (!isWithinContent) return false;

            return isInteractive(target);
        });

        setOnSelectionChange((box) => {
            if (!box || !filteredVideos.length) return;

            const videosToSelect: string[] = [];
            selectableItems.current.forEach((item, index) => {
                if (boxesIntersect(box, item)) {
                    videosToSelect.push(filteredVideos[index].path);
                }
            });
            setSelectedVideos(videosToSelect);
        });

        return () => {
            enableSelection(false);
            setOnSelectionChange(undefined);
            setShouldStartSelecting(undefined);
            window.removeEventListener("click", handleBackgroundClick);
        };
    }, [
        filteredVideos,
        enableSelection,
        setOnSelectionChange,
        setShouldStartSelecting,
        getState,
        setSelectedVideos,
    ]);

    useEffect(() => {
        if (filteredVideos.length) {
            // Small delay to ensure DOM is updated
            requestAnimationFrame(() => {
                selectableItems.current = getItemPositions(filteredVideos);
            });
        }
    }, [filteredVideos, sidebarState, isAnimating, onAnimationComplete]);

    // Update selectable items when videos change
    useEffect(() => {
        if (filteredVideos.length) {
            const gridItems = document.querySelectorAll(".selectable-item");

            // Create an array of objects that include both the rect and the video path
            const itemsWithData = Array.from(gridItems).map((item, index) => {
                // Ensure the order matches filteredVideos exactly by using a data attribute
                return {
                    rect: item.getBoundingClientRect(),
                    path: filteredVideos[index].path,
                };
            });

            // Store just the rects in selectableItems for intersection testing
            selectableItems.current = itemsWithData.map((item) => item.rect);
        }
    }, [filteredVideos, sidebarState, isAnimating, onAnimationComplete]);

    const clipCountByDate = useMemo(() => {
        const counts: Record<string, number> = {};

        videos.forEach((video) => {
            if (video.lastModified) {
                const dateKey = video.lastModified.split("T")[0]; // Format as YYYY-MM-DD
                counts[dateKey] = (counts[dateKey] || 0) + 1;
            }
        });

        return counts;
    }, [videos]);

    // If no directory is selected, show the directory selector
    if (!directoryPath) {
        return (
            <DirectorySelector
                onSelectDirectory={handleSelectDirectory}
                isLoading={isLoading}
            />
        );
    }

    // Otherwise show the video grid
    return (
        <div className="flex flex-col p-4 px-6" ref={contentRef}>
            <FilterHeader
                directoryPath={directoryPath}
                filteredVideosCount={filteredVideos.length}
                totalVideosCount={videos.length}
                groups={groups}
                selectedGroupIds={selectedGroupIds}
                startDate={startDate}
                endDate={endDate}
                games={uniqueGames}
                selectedGames={selectedGames}
                clipCountByDate={clipCountByDate}
                onSelectGroup={setSelectedGroupIds}
                onGameSelect={setSelectedGames}
                onDateRangeChange={(from, to) => {
                    setStartDate(from);
                    setEndDate(to);
                }}
                onClearFilters={clearAllFilters}
                onChangeDirectory={handleSelectDirectory}
            />
            <VideoGrid
                isLoading={isLoading}
                filteredVideos={filteredVideos}
                selectedVideos={selectedVideos}
                thumbnails={thumbnails}
                groups={groups}
                videoGroupMap={videoGroupMap}
                onSelectDirectory={handleSelectDirectory}
                onAddToGroup={handleAddToGroup}
                onShowCreateGroup={() => setIsCreateGroupDialogOpen(true)}
                onRemoveFromGroup={handleRemoveFromGroup}
            />
            <CreateGroupDialog
                open={isCreateGroupDialogOpen}
                onOpenChange={setIsCreateGroupDialogOpen}
                onCreateGroup={handleCreateGroup}
            />
        </div>
    );
}
