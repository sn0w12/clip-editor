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
    games: Record<string, string>;
    libraryFolders: string[];
    gameImages: Record<string, GameImage>;
    loading: boolean;
    error: string | null;
    refreshSteamData: () => Promise<void>;
}

const SteamContext = createContext<SteamContextType>({
    games: {},
    libraryFolders: [],
    gameImages: {},
    loading: true,
    error: null,
    refreshSteamData: async () => {},
});

interface SteamProviderProps {
    children: ReactNode;
}

export const SteamProvider: React.FC<SteamProviderProps> = ({ children }) => {
    const [games, setGames] = useState<Record<string, string>>({});
    const [libraryFolders, setLibraryFolders] = useState<string[]>([]);
    const [gameImages, setGameImages] = useState<Record<string, GameImage>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const steamDir = useSetting("steamDirectory");

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

                setGames(gamesResult);
                setLibraryFolders(foldersResult);
                setGameImages(imagesResult);
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
            }}
        >
            {children}
        </SteamContext.Provider>
    );
};

export const useSteam = () => useContext(SteamContext);

export default SteamContext;
