import React, {
    createContext,
    useState,
    useEffect,
    useContext,
    ReactNode,
} from "react";
import { useSetting } from "@/utils/settings";

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
}

const SteamContext = createContext<SteamContextType>({
    games: {},
    libraryFolders: [],
    gameImages: {},
    loading: true,
    error: null,
    refreshSteamData: async () => {},
    addCustomGame: () => {},
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
    const steamDir = useSetting("steamDirectory");

    const loadCustomGamesFromStorage = () => {
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
    };

    const addCustomGame = (gameName: string) => {
        const customId = `custom-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

        const updatedGames = {
            ...games,
            [customId]: { appid: customId, displayName: gameName },
        };
        setGames(updatedGames);

        setGameImages({
            ...gameImages,
            [customId]: {},
        });

        // Save to localStorage
        const customGames = loadCustomGamesFromStorage();
        customGames[customId] = { appid: customId, displayName: gameName };
        try {
            localStorage.setItem(CUSTOM_GAMES_KEY, JSON.stringify(customGames));
        } catch (err) {
            console.error("Failed to save custom game to localStorage:", err);
        }
    };

    const refreshSteamData = async () => {
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

                // Merge Steam games with custom games
                const customGames = loadCustomGamesFromStorage();
                const mergedGames = { ...gamesResult, ...customGames };

                setGames(mergedGames);
                setLibraryFolders(foldersResult);

                // Add empty image entries for custom games
                const mergedImages = { ...imagesResult };
                Object.keys(customGames).forEach((id) => {
                    mergedImages[id] = mergedImages[id] || {};
                });
                setGameImages(mergedImages);
            } else {
                // Handle case where Steam API isn't available (e.g., in browser)
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
            setLoading(false);
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
            }}
        >
            {children}
        </SteamContext.Provider>
    );
};

export const useSteam = () => useContext(SteamContext);

export default SteamContext;
