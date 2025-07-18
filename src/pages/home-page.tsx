import { useVideoStore } from "@/contexts/video-store-context";
import React, { useMemo } from "react";
import { CreateGroupDialog } from "@/components/home/create-group-dialog";
import { DirectorySelector } from "@/components/home/directory-selector";
import { FilterHeader } from "@/components/home/filter-header";
import { VideoGrid } from "@/components/home/video-grid";
import { usePageSelection } from "@/hooks/use-page-selection";

export default function HomePage() {
    const {
        directoryPath,
        isLoading,
        videos,
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
    } = useVideoStore();

    const sortedVideos = useMemo(() => {
        const groupedVideos: Record<string, typeof filteredVideos> = {};
        filteredVideos.forEach((video) => {
            const date = new Date(video.lastModified);
            const dateString = date.toISOString().split("T")[0];
            if (!groupedVideos[dateString]) groupedVideos[dateString] = [];
            groupedVideos[dateString].push(video);
        });

        return Object.entries(groupedVideos)
            .sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime())
            .flatMap(([, videos]) =>
                [...videos].sort(
                    (a, b) =>
                        new Date(b.lastModified).getTime() -
                        new Date(a.lastModified).getTime(),
                ),
            );
    }, [filteredVideos]);

    const clipCountByDate = useMemo(() => {
        const counts: Record<string, number> = {};
        videos.forEach((video) => {
            if (video.lastModified) {
                const dateKey = video.lastModified.split("T")[0];
                counts[dateKey] = (counts[dateKey] || 0) + 1;
            }
        });
        return counts;
    }, [videos]);

    const totalSize = useMemo(() => {
        return videos.reduce((total, video) => total + (video.size || 0), 0);
    }, [videos]);

    const { selectedItems } = usePageSelection({
        items: sortedVideos,
        itemSelector: ".selectable-item",
        getItemId: (video) => video.path,
        onSelectionChange: (selected) => {
            setSelectedVideos(selected.map((v) => v.path));
        },
        enableShortcuts: true,
    });

    // If no directory is selected, show the directory selector
    if (!directoryPath) {
        return (
            <DirectorySelector
                onSelectDirectory={handleSelectDirectory}
                isLoading={isLoading}
            />
        );
    }

    // Use SelectionContainer for video selection
    return (
        <div className="flex flex-col p-4 px-6">
            <FilterHeader
                directoryPath={directoryPath}
                filteredVideosCount={filteredVideos.length}
                totalVideosCount={videos.length}
                totalSize={totalSize}
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
                filteredVideos={sortedVideos}
                selectedVideos={selectedItems.map((v) => v.path)}
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
