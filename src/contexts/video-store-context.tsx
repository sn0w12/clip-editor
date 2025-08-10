import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    useMemo,
    useRef,
    useCallback,
} from "react";
import { VideoFile, VideoGroup, VideoGroupAssignment } from "@/types/video";
import { VideoMetadata } from "@/types/video-editor";
import { APP_CONFIG } from "@/config";
import { v4 as uuidv4 } from "uuid";
import { videoMetadataIpc } from "@/helpers/ipc/video-metadata";
import { useSteam } from "./steam-context";

const SAVED_DIRECTORY_KEY = "saved-video-directory";
const SAVED_GROUPS_KEY = "video-groups";
const SAVED_VIDEO_GROUP_ASSIGNMENTS_KEY = "video-group-assignments";

interface VideoStoreContextType {
    directoryPath: string | null;
    isLoading: boolean;
    videos: VideoFile[];
    selectedVideos: string[];
    thumbnails: Record<string, string>;
    loadingThumbnails: Set<string>;
    videoMetadata: Record<string, VideoMetadata>;
    loadingMetadata: Set<string>;
    startDate: Date | undefined;
    endDate: Date | undefined;
    selectedGames: string[];
    uniqueGames: string[];
    groups: VideoGroup[];
    videoGroupAssignments: VideoGroupAssignment[];
    selectedGroupIds: string[];
    videoGroupMap: Record<string, string[]>;
    isCreateGroupDialogOpen: boolean;
    filteredVideos: VideoFile[];
    setDirectoryPath: React.Dispatch<React.SetStateAction<string | null>>;
    setSelectedVideos: React.Dispatch<React.SetStateAction<string[]>>;
    setStartDate: React.Dispatch<React.SetStateAction<Date | undefined>>;
    setEndDate: React.Dispatch<React.SetStateAction<Date | undefined>>;
    setSelectedGames: React.Dispatch<React.SetStateAction<string[]>>;
    setSelectedGroupIds: React.Dispatch<React.SetStateAction<string[]>>;
    setIsCreateGroupDialogOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setVideoGame: (video: VideoFile, game: string) => void;
    handleSelectDirectory: () => Promise<void>;
    handleCreateGroup: (name: string, color?: string) => string;
    handleDeleteGroup: (groupId: string) => void;
    handleAddToGroup: (videoPaths: string[], groupId: string) => void;
    handleRemoveFromGroup: (videoPaths: string[], groupId: string) => void;
    handleDeleteVideos: (videoPaths: string[]) => Promise<void>;
    clearAllFilters: () => void;
    loadVideosFromDirectory: (dirPath: string) => Promise<void>;
    handleUpdateVideoGames: (videoPaths: string[], game: string) => void;
}

const VideoStoreContext = createContext<VideoStoreContextType | undefined>(
    undefined,
);

export function useVideoStore() {
    const context = useContext(VideoStoreContext);
    if (context === undefined) {
        throw new Error(
            "useVideoStore must be used within a VideoStoreProvider",
        );
    }
    return context;
}

export function VideoStoreProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const { gameAliases } = useSteam();
    const [directoryPath, setDirectoryPath] = useState<string | null>(() => {
        return localStorage.getItem(SAVED_DIRECTORY_KEY);
    });
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [videos, setVideos] = useState<VideoFile[]>([]);
    const [selectedVideos, setSelectedVideos] = useState<string[]>([]);
    const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
    const [loadingThumbnails, setLoadingThumbnails] = useState<Set<string>>(
        new Set(),
    );
    const [videoMetadata, setVideoMetadata] = useState<
        Record<string, VideoMetadata>
    >({});
    const [loadingMetadata, setLoadingMetadata] = useState<Set<string>>(
        new Set(),
    );

    const newVideoListenerCleanup = useRef<(() => void) | null>(null);
    const [startDate, setStartDate] = useState<Date | undefined>(undefined);
    const [endDate, setEndDate] = useState<Date | undefined>(undefined);
    const [selectedGames, setSelectedGames] = useState<string[]>([]);
    const initialMountRef = useRef(true);

    const [groups, setGroups] = useState<VideoGroup[]>(() => {
        try {
            const savedGroups = localStorage.getItem(SAVED_GROUPS_KEY);
            return savedGroups ? JSON.parse(savedGroups) : [];
        } catch (error) {
            console.error("Error loading saved groups:", error);
            return [];
        }
    });

    const [videoGroupAssignments, setVideoGroupAssignments] = useState<
        VideoGroupAssignment[]
    >(() => {
        try {
            const savedAssignments = localStorage.getItem(
                SAVED_VIDEO_GROUP_ASSIGNMENTS_KEY,
            );
            return savedAssignments ? JSON.parse(savedAssignments) : [];
        } catch (error) {
            console.error(
                "Error loading saved video group assignments:",
                error,
            );
            return [];
        }
    });
    const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
    const [isCreateGroupDialogOpen, setIsCreateGroupDialogOpen] =
        useState(false);

    const videoGroupMap = useMemo(() => {
        const map: Record<string, string[]> = {};

        videoGroupAssignments.forEach((assignment) => {
            if (!map[assignment.videoPath]) {
                map[assignment.videoPath] = [];
            }
            map[assignment.videoPath].push(assignment.groupId);
        });

        return map;
    }, [videoGroupAssignments]);

    const dateFilteredVideos = videos.filter((video) => {
        if (!startDate && !endDate) return true;

        const videoDate = new Date(video.lastModified);

        const startOfDay = startDate ? new Date(startDate) : null;
        if (startOfDay) startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = endDate ? new Date(endDate) : null;
        if (endOfDay) endOfDay.setHours(23, 59, 59, 999);

        if (startOfDay && endOfDay) {
            return videoDate >= startOfDay && videoDate <= endOfDay;
        }

        if (startOfDay && !endOfDay) {
            return videoDate >= startOfDay;
        }

        if (!startOfDay && endOfDay) {
            return videoDate <= endOfDay;
        }

        return true;
    });

    const gameFilteredVideos = useMemo(() => {
        if (selectedGames.length === 0) return dateFilteredVideos;

        return dateFilteredVideos.filter((video) =>
            selectedGames.includes(video.game),
        );
    }, [dateFilteredVideos, selectedGames]);

    const filteredVideos = useMemo(() => {
        if (selectedGroupIds.length === 0) return gameFilteredVideos;

        return gameFilteredVideos.filter((video) => {
            const groupsForVideo = videoGroupMap[video.path] || [];
            return groupsForVideo.some((groupId) =>
                selectedGroupIds.includes(groupId),
            );
        });
    }, [gameFilteredVideos, selectedGroupIds, videoGroupMap]);
    const handleCreateGroup = useCallback(
        (name: string, color?: string) => {
            const newGroup: VideoGroup = {
                id: uuidv4(),
                name,
                color:
                    color ||
                    `hsl(${Math.floor(Math.random() * 360)}, 70%, 50%)`,
            };

            const updatedGroups = [...groups, newGroup];
            setGroups(updatedGroups);
            localStorage.setItem(
                SAVED_GROUPS_KEY,
                JSON.stringify(updatedGroups),
            );

            return newGroup.id;
        },
        [groups],
    );

    const handleAddToGroup = useCallback(
        (videoPaths: string[], groupId: string) => {
            const filteredAssignments = videoGroupAssignments.filter(
                (assignment) =>
                    !(
                        videoPaths.includes(assignment.videoPath) &&
                        assignment.groupId === groupId
                    ),
            );

            const newAssignments = videoPaths.map((videoPath) => ({
                videoPath,
                groupId,
            }));

            const updatedAssignments = [
                ...filteredAssignments,
                ...newAssignments,
            ];
            setVideoGroupAssignments(updatedAssignments);
            localStorage.setItem(
                SAVED_VIDEO_GROUP_ASSIGNMENTS_KEY,
                JSON.stringify(updatedAssignments),
            );
        },
        [videoGroupAssignments],
    );

    const handleRemoveFromGroup = useCallback(
        (videoPaths: string[], groupId: string) => {
            const updatedAssignments = videoGroupAssignments.filter(
                (assignment) =>
                    !(
                        videoPaths.includes(assignment.videoPath) &&
                        assignment.groupId === groupId
                    ),
            );

            setVideoGroupAssignments(updatedAssignments);
            localStorage.setItem(
                SAVED_VIDEO_GROUP_ASSIGNMENTS_KEY,
                JSON.stringify(updatedAssignments),
            );
        },
        [videoGroupAssignments],
    );

    const handleDeleteGroup = useCallback(
        (groupId: string) => {
            const videosInGroup = videoGroupAssignments
                .filter((assignment) => assignment.groupId === groupId)
                .map((assignment) => assignment.videoPath);

            if (videosInGroup.length > 0) {
                handleRemoveFromGroup(videosInGroup, groupId);
            }

            const updatedGroups = groups.filter((g) => g.id !== groupId);
            setGroups(updatedGroups);
            localStorage.setItem(
                SAVED_GROUPS_KEY,
                JSON.stringify(updatedGroups),
            );
        },
        [groups, videoGroupAssignments, handleRemoveFromGroup],
    );

    const loadVideosFromDirectory = async (dirPath: string) => {
        if (!dirPath) return;

        setIsLoading(true);
        try {
            const videoFiles =
                await window.videos.getVideosFromDirectory(dirPath);

            const aliasedVideos = videoFiles.map((video) => {
                const aliasGameName = gameAliases[video.game];
                if (aliasGameName) {
                    return {
                        ...video,
                        game: aliasGameName || video.game,
                    };
                }
                return video;
            });

            setVideos(aliasedVideos);
            setSelectedVideos([]);
            localStorage.setItem(SAVED_DIRECTORY_KEY, dirPath);

            if (aliasedVideos.length > 0) {
                const newLoadingThumbnails = new Set<string>();
                const newLoadingMetadata = new Set<string>();

                aliasedVideos.forEach((video) => {
                    newLoadingThumbnails.add(video.path);
                    newLoadingMetadata.add(video.path);
                });

                setLoadingThumbnails(newLoadingThumbnails);
                setLoadingMetadata(newLoadingMetadata);

                loadThumbnails(aliasedVideos);
                loadVideoMetadata(aliasedVideos);
            }
        } catch (error) {
            console.error("Error loading videos:", error);
        } finally {
            setIsLoading(false);
        }
    };

    const startWatchingDirectory = async (dirPath: string) => {
        if (!dirPath) return;

        try {
            await window.directoryWatcher.watchDirectory(dirPath);

            const cleanup = window.directoryWatcher.onNewVideoFound(
                (videoFile) => {
                    const aliasGameName = gameAliases[videoFile.game];
                    const aliasedVideo = aliasGameName
                        ? { ...videoFile, game: aliasGameName }
                        : videoFile;

                    setVideos((prevVideos) => {
                        if (
                            prevVideos.some((v) => v.path === aliasedVideo.path)
                        ) {
                            return prevVideos;
                        }

                        return [...prevVideos, aliasedVideo];
                    });

                    loadThumbnails([aliasedVideo]);
                    loadVideoMetadata([aliasedVideo]);
                },
            );

            newVideoListenerCleanup.current = cleanup;
        } catch (error) {
            console.error("Error watching directory:", error);
        }
    };

    const loadVideoMetadata = async (videoFiles: VideoFile[]) => {
        try {
            const videoPaths = videoFiles.map((video) => video.path);
            const metadataResults =
                await videoMetadataIpc.getBatchVideoMetadata(videoPaths);

            setVideoMetadata((prevMetadata) => ({
                ...prevMetadata,
                ...metadataResults,
            }));

            setLoadingMetadata(new Set());
        } catch (error) {
            console.error("Error loading video metadata:", error);
            setLoadingMetadata(new Set());
        }
    };

    const loadThumbnails = async (videoFiles: VideoFile[]) => {
        const newThumbnails: Record<string, string> = { ...thumbnails };
        const batchSize = 8;

        for (let i = 0; i < videoFiles.length; i += batchSize) {
            const batch = videoFiles.slice(i, i + batchSize);

            await Promise.all(
                batch.map(async (video) => {
                    try {
                        const thumbnailPath =
                            await window.videos.getVideoThumbnail(video.path);
                        if (thumbnailPath) {
                            const customProtocolPath = `${APP_CONFIG.protocolName}:///${thumbnailPath}?full=true`;
                            newThumbnails[video.path] = customProtocolPath;

                            setThumbnails((current) => ({
                                ...current,
                                [video.path]: customProtocolPath,
                            }));

                            setLoadingThumbnails((prev) => {
                                const updated = new Set(prev);
                                updated.delete(video.path);
                                return updated;
                            });
                        }
                    } catch (error) {
                        console.error(
                            `Error loading thumbnail for ${video.name}:`,
                            error,
                        );
                        setLoadingThumbnails((prev) => {
                            const updated = new Set(prev);
                            updated.delete(video.path);
                            return updated;
                        });
                    }
                }),
            );
        }
    };
    const handleSelectDirectory = useCallback(async () => {
        try {
            const selectedDir = await window.videos.selectDirectory();

            if (selectedDir) {
                setDirectoryPath(selectedDir);
                await loadVideosFromDirectory(selectedDir);
            }
        } catch (error) {
            console.error("Error selecting directory:", error);
        }
    }, [loadVideosFromDirectory]);

    const handleDeleteVideos = async (videoPaths: string[]) => {
        if (!videoPaths.length) return;

        try {
            const result = await window.videos.deleteVideoFiles(videoPaths);

            if (result.success) {
                // Remove deleted videos from state
                setVideos((currentVideos) =>
                    currentVideos.filter(
                        (video) => !videoPaths.includes(video.path),
                    ),
                );

                // Clear selections if they were deleted
                setSelectedVideos((current) =>
                    current.filter(
                        (videoPath) => !videoPaths.includes(videoPath),
                    ),
                );

                // Remove thumbnails for deleted videos
                setThumbnails((current) => {
                    const newThumbnails = { ...current };
                    videoPaths.forEach((path) => {
                        delete newThumbnails[path];
                    });
                    return newThumbnails;
                });

                // Remove metadata for deleted videos
                setVideoMetadata((current) => {
                    const newMetadata = { ...current };
                    videoPaths.forEach((path) => {
                        delete newMetadata[path];
                    });
                    return newMetadata;
                });

                // Remove group assignments for deleted videos
                const updatedAssignments = videoGroupAssignments.filter(
                    (assignment) => !videoPaths.includes(assignment.videoPath),
                );
                setVideoGroupAssignments(updatedAssignments);
                localStorage.setItem(
                    SAVED_VIDEO_GROUP_ASSIGNMENTS_KEY,
                    JSON.stringify(updatedAssignments),
                );
            } else if (result.failed.length > 0) {
                console.error("Failed to delete some videos:", result.failed);
                // Handle partial failure if needed
            }
        } catch (error) {
            console.error("Error deleting videos:", error);
        }
    };

    const handleUpdateVideoGames = async (
        videoPaths: string[],
        game: string,
    ) => {
        const updatedVideos = [...videos];
        const renamePromises: Promise<{
            success: boolean;
            oldPath: string;
            newPath?: string;
        }>[] = [];

        for (const videoPath of videoPaths) {
            renamePromises.push(window.videos.renameFile(videoPath, game));
        }

        const renameResults = await Promise.all(renamePromises);
        let updatedAssignments = [...videoGroupAssignments];

        for (const result of renameResults) {
            if (result.success && result.newPath) {
                const videoIndex = updatedVideos.findIndex(
                    (v) => v.path === result.oldPath,
                );

                if (videoIndex !== -1) {
                    updatedVideos[videoIndex] = {
                        ...updatedVideos[videoIndex],
                        path: result.newPath,
                        name: result.newPath.split(/[/\\]/).pop() || "",
                        game: game,
                    };

                    // Update any thumbnail references
                    if (thumbnails[result.oldPath]) {
                        setThumbnails((prev) => {
                            const updated = { ...prev };
                            updated[result.newPath!] = prev[result.oldPath];
                            delete updated[result.oldPath];
                            return updated;
                        });
                    }

                    // Update any metadata references
                    if (videoMetadata[result.oldPath]) {
                        setVideoMetadata((prev) => {
                            const updated = { ...prev };
                            updated[result.newPath!] = prev[result.oldPath];
                            delete updated[result.oldPath];
                            return updated;
                        });
                    }

                    // Update selected videos if this one was selected
                    setSelectedVideos((prev) =>
                        prev.map((p) =>
                            p === result.oldPath ? result.newPath! : p,
                        ),
                    );

                    // Update group assignments
                    updatedAssignments = updatedAssignments.map((assignment) =>
                        assignment.videoPath === result.oldPath
                            ? { ...assignment, videoPath: result.newPath! }
                            : assignment,
                    );
                }
            }
        }

        setVideos(updatedVideos);

        // Update video group assignments with the new paths
        setVideoGroupAssignments(updatedAssignments);

        // Save the updated assignments to localStorage
        localStorage.setItem(
            SAVED_VIDEO_GROUP_ASSIGNMENTS_KEY,
            JSON.stringify(updatedAssignments),
        );
    };

    function setVideoGame(video: VideoFile, game: string) {
        setVideos((prev) =>
            prev.map((v) => (v.path === video.path ? { ...v, game } : v)),
        );
    }

    useEffect(() => {
        if (initialMountRef.current && directoryPath) {
            loadVideosFromDirectory(directoryPath);
            initialMountRef.current = false;
        }
    }, []);

    useEffect(() => {
        if (directoryPath) {
            startWatchingDirectory(directoryPath);

            return () => {
                if (directoryPath) {
                    window.directoryWatcher
                        .stopWatchingDirectory(directoryPath)
                        .catch(console.error);
                }

                if (newVideoListenerCleanup.current) {
                    newVideoListenerCleanup.current();
                    newVideoListenerCleanup.current = null;
                }
            };
        }
    }, []);

    const uniqueGames = useMemo(() => {
        const games = videos.map((video) => video.game).filter(Boolean);
        return [...new Set(games)].sort();
    }, [videos]);

    const clearAllFilters = () => {
        setStartDate(undefined);
        setEndDate(undefined);
        setSelectedGames([]);
        setSelectedGroupIds([]);
    };

    const contextValue = {
        directoryPath,
        isLoading,
        videos,
        selectedVideos,
        thumbnails,
        loadingThumbnails,
        videoMetadata,
        loadingMetadata,
        startDate,
        endDate,
        selectedGames,
        uniqueGames,
        groups,
        videoGroupAssignments,
        selectedGroupIds,
        videoGroupMap,
        isCreateGroupDialogOpen,
        filteredVideos,

        setDirectoryPath,
        setSelectedVideos,
        setStartDate,
        setEndDate,
        setSelectedGames,
        setSelectedGroupIds,
        setIsCreateGroupDialogOpen,
        setVideoGame,

        handleSelectDirectory,
        handleCreateGroup,
        handleAddToGroup,
        handleRemoveFromGroup,
        handleDeleteGroup,
        handleDeleteVideos,
        handleUpdateVideoGames,
        clearAllFilters,
        loadVideosFromDirectory,
    };

    return (
        <VideoStoreContext.Provider value={contextValue}>
            {children}
        </VideoStoreContext.Provider>
    );
}
