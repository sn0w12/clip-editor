import React, {
    createContext,
    useState,
    useEffect,
    useContext,
    ReactNode,
    useMemo,
    useRef,
    useCallback,
} from "react";
import { useSetting } from "@/utils/settings";
import { normalizeGameName } from "@/utils/games";

interface GameImage {
    header?: string;
    library_600x900?: string;
    library_hero?: string;
    library_hero_blur?: string;
    logo?: string;
    icon?: string;
}

interface SteamContextType {
    games: Record<string, { appid: string; displayName: string }>;
    libraryFolders: string[];
    gameImages: Record<string, GameImage>;
    loading: boolean;
    error: string | null;
    refreshSteamData: () => Promise<void>;
    addCustomGame: (gameName: string) => void;
    removeCustomGame: (appId: string) => void;
    setCustomGameImage: (
        appId: string,
        imageUrl: string,
        imageType: keyof GameImage,
    ) => void;
}

const SteamContext = createContext<SteamContextType>({
    games: {},
    libraryFolders: [],
    gameImages: {},
    loading: true,
    error: null,
    refreshSteamData: async () => {},
    addCustomGame: () => {},
    removeCustomGame: () => {},
    setCustomGameImage: () => {},
});

const CUSTOM_GAMES_KEY = "clip-editor-custom-games";

interface SteamProviderProps {
    children: ReactNode;
}

export const SteamProvider: React.FC<SteamProviderProps> = ({ children }) => {
    const [games, setGames] = useState<
        Record<string, { appid: string; displayName: string }>
    >({});
    const [libraryFolders, setLibraryFolders] = useState<string[]>([]);
    const [gameImages, setGameImages] = useState<Record<string, GameImage>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const pendingGamesRef = useRef<string[]>([]);
    const steamDir = useSetting("steamDirectory");

    const loadCustomGamesFromStorage = useCallback(() => {
        try {
            const storedCustomGames = localStorage.getItem(CUSTOM_GAMES_KEY);
            if (storedCustomGames) {
                const customGames = JSON.parse(storedCustomGames);
                return customGames;
            }
        } catch (err) {
            console.error(
                "Failed to load custom games from localStorage:",
                err,
            );
        }
        return {};
    }, []);

    const addCustomGame = (gameName: string) => {
        // Workaround to check loading state since just checking will not work
        let currentlyLoading = false;
        setLoading((current) => {
            currentlyLoading = current;
            return current;
        });

        if (currentlyLoading) {
            console.log(
                "Loading in progress, queueing game addition:",
                gameName,
            );
            pendingGamesRef.current.push(gameName);
            return;
        }

        const existingGame = Object.values(games).find(
            (game) =>
                normalizeGameName(game.displayName) ===
                normalizeGameName(gameName),
        );

        if (existingGame) {
            return;
        }

        const customId = `custom-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
        setGames((prevGames) => ({
            ...prevGames,
            [customId]: { appid: customId, displayName: gameName },
        }));

        setGameImages((prevImages) => ({
            ...prevImages,
            [customId]: {},
        }));

        const customGames = loadCustomGamesFromStorage();
        customGames[customId] = { appid: customId, displayName: gameName };
        try {
            localStorage.setItem(CUSTOM_GAMES_KEY, JSON.stringify(customGames));
        } catch (err) {
            console.error("Failed to save custom game to localStorage:", err);
        }
    };

    useEffect(() => {
        if (!loading && pendingGamesRef.current.length > 0) {
            console.log("Processing pending games:", pendingGamesRef.current);
            const gamesToAdd = [...pendingGamesRef.current];
            pendingGamesRef.current = []; // Clear the pending games

            // Use setTimeout to ensure loading state is stable
            setTimeout(() => {
                // Add each pending game separately to avoid potential state issues
                gamesToAdd.forEach((game) => {
                    addCustomGame(game);
                });
            }, 0);
        }
    }, [loading, addCustomGame]);

    const refreshSteamData = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            // Access the Steam API through the window object
            if (window.steam) {
                const [gamesResult, foldersResult, imagesResult] =
                    await Promise.all([
                        window.steam.getAllSteamGames(steamDir),
                        window.steam.getSteamLibraryFolders(steamDir),
                        window.steam.getAllGameImages(steamDir),
                    ]);

                // Load custom games
                const customGames = loadCustomGamesFromStorage();

                // Filter out custom games that might duplicate Steam games by name
                const filteredCustomGames: Record<
                    string,
                    { appid: string; displayName: string }
                > = {};
                const steamGameNames = new Set(
                    Object.values(gamesResult).map((game) =>
                        game.displayName.toLowerCase(),
                    ),
                );

                Object.entries(
                    customGames as Record<
                        string,
                        { appid: string; displayName: string }
                    >,
                ).forEach(([id, game]) => {
                    if (!steamGameNames.has(game.displayName.toLowerCase())) {
                        filteredCustomGames[id] = game;
                    }
                });

                // Merge Steam games with filtered custom games
                const mergedGames = { ...gamesResult, ...filteredCustomGames };

                setGames(mergedGames);
                setLibraryFolders(foldersResult);

                // Load custom images from localStorage
                const customImagesKey = `${CUSTOM_GAMES_KEY}-images`;
                const storedImages = localStorage.getItem(customImagesKey);
                const customImages = storedImages
                    ? JSON.parse(storedImages)
                    : {};

                // Add empty image entries for custom games and merge with custom images
                const mergedImages = { ...imagesResult };
                Object.keys(filteredCustomGames).forEach((id) => {
                    mergedImages[id] = {
                        ...(mergedImages[id] || {}),
                        ...(customImages[id] || {}),
                    };
                });

                setGameImages(mergedImages);
            } else {
                // Handle case where Steam API isn't available
                setError("Steam API not available in this environment");
            }
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to load Steam data",
            );
            console.error("Error loading Steam data:", err);
        } finally {
            // Ensure loading is set to false after everything is done
            setLoading(false);
        }
    }, [steamDir, loadCustomGamesFromStorage]);

    const setCustomGameImage = (
        appId: string,
        imageUrl: string,
        imageType: keyof GameImage,
    ) => {
        if (!appId.startsWith("custom-")) {
            console.error("Cannot set image for non-custom game");
            return;
        }

        // Update the game images state
        setGameImages((prev) => ({
            ...prev,
            [appId]: {
                ...prev[appId],
                [imageType]: imageUrl,
            },
        }));

        // Save to localStorage
        try {
            const customImagesKey = `${CUSTOM_GAMES_KEY}-images`;
            const storedImages = localStorage.getItem(customImagesKey) || "{}";
            const customImages = JSON.parse(storedImages);

            customImages[appId] = {
                ...(customImages[appId] || {}),
                [imageType]: imageUrl,
            };

            localStorage.setItem(customImagesKey, JSON.stringify(customImages));
        } catch (err) {
            console.error(
                "Failed to save custom game image to localStorage:",
                err,
            );
        }
    };

    const removeCustomGame = (appId: string) => {
        if (!appId.startsWith("custom-")) {
            console.error("Cannot remove non-custom game");
            return;
        }

        // Update games state
        setGames((prevGames) => {
            const updatedGames = { ...prevGames };
            delete updatedGames[appId];
            return updatedGames;
        });

        // Update game images state
        setGameImages((prevImages) => {
            const updatedImages = { ...prevImages };
            delete updatedImages[appId];
            return updatedImages;
        });

        // Remove from localStorage
        try {
            // Remove from custom games
            const customGames = loadCustomGamesFromStorage();
            delete customGames[appId];
            localStorage.setItem(CUSTOM_GAMES_KEY, JSON.stringify(customGames));

            // Remove from custom images
            const customImagesKey = `${CUSTOM_GAMES_KEY}-images`;
            const storedImages = localStorage.getItem(customImagesKey) || "{}";
            const customImages = JSON.parse(storedImages);
            delete customImages[appId];
            localStorage.setItem(customImagesKey, JSON.stringify(customImages));
        } catch (err) {
            console.error(
                "Failed to remove custom game from localStorage:",
                err,
            );
        }
    };

    // Load Steam data on initial mount
    useEffect(() => {
        refreshSteamData();
    }, []);

    return (
        <SteamContext.Provider
            value={{
                games,
                libraryFolders,
                gameImages,
                loading,
                error,
                refreshSteamData,
                addCustomGame,
                removeCustomGame,
                setCustomGameImage,
            }}
        >
            {children}
        </SteamContext.Provider>
    );
};

export const useSteam = () => {
    const context = useContext(SteamContext);

    const isLoading = context.loading;
    const gamesCount = Object.keys(context.games || {}).length;
    const imagesCount = Object.keys(context.gameImages || {}).length;

    // Return memoized values to prevent unnecessary re-renders
    return useMemo(() => context, [isLoading, gamesCount, imagesCount]);
};

export default SteamContext;
