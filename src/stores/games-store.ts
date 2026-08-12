import { useCallback, useEffect, useState } from "react";

import * as tauri from "@/lib/tauri";
import type { GameAlias, GameImage, SteamGame } from "@/types";

export interface GamesStoreState {
    games: SteamGame[];
    aliases: GameAlias[];
    loading: boolean;
    error: string | null;
    diagnostics: { path: string; reason: string }[];
}

/** Module-level cache so re-mounting a page doesn't refetch and flash a loader. */
let cachedGames: { games: SteamGame[]; aliases: GameAlias[] } | null = null;
/** Last serialized snapshot; an unchanged reload skips state updates. */
let lastGamesJson: string | null = null;

export function useGamesStore(): GamesStoreState & {
    reload: () => Promise<void>;
    refreshSteam: () => Promise<void>;
    refreshArtwork: (appId: string) => Promise<void>;
    addCustomGame: (name: string) => Promise<SteamGame>;
    removeCustomGame: (appId: string) => Promise<void>;
    setCustomImage: (appId: string, role: string, pathOrUrl: string) => Promise<void>;
    setAlias: (alias: string, appId: string) => Promise<void>;
    removeAlias: (alias: string) => Promise<void>;
} {
    const [games, setGames] = useState<SteamGame[]>(cachedGames?.games ?? []);
    const [aliases, setAliases] = useState<GameAlias[]>(cachedGames?.aliases ?? []);
    const [loading, setLoading] = useState<boolean>(!cachedGames);
    const [error, setError] = useState<string | null>(null);
    const [diagnostics, setDiagnostics] = useState<{ path: string; reason: string }[]>([]);

    const reload = useCallback(async () => {
        try {
            const result = await tauri.getGames();
            cachedGames = { games: result.games, aliases: result.aliases };
            const nextJson = JSON.stringify(cachedGames);
            if (nextJson === lastGamesJson) return;
            lastGamesJson = nextJson;
            setGames(result.games);
            setAliases(result.aliases);
            setError(null);
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        const load = async () => {
            try {
                const result = await tauri.getGames();
                cachedGames = { games: result.games, aliases: result.aliases };
                const nextJson = JSON.stringify(cachedGames);
                if (nextJson === lastGamesJson) return;
                lastGamesJson = nextJson;
                setGames(result.games);
                setAliases(result.aliases);
                setError(null);
            } catch (e) {
                setError(String(e));
            } finally {
                setLoading(false);
            }
        };
        void load();
    }, []);

    // Artwork fallback results trigger a reload so the resolved paths show up.
    useEffect(() => {
        const unlisten = tauri.onSteamArtworkUpdated(() => {
            void reload();
        });
        return () => {
            void unlisten.then((fn) => fn());
        };
    }, [reload]);

    const refreshSteam = useCallback(async () => {
        setLoading(true);
        try {
            const result = await tauri.refreshSteamData();
            setGames(result.games);
            setAliases(result.aliases);
            setDiagnostics(result.diagnostics);
            setError(null);
        } catch (e) {
            setError(String(e));
        } finally {
            setLoading(false);
        }
    }, []);

    const refreshArtwork = useCallback(
        async (appId: string) => {
            await tauri.refreshSteamArtwork(appId);
            await reload();
        },
        [reload],
    );

    const addCustomGame = useCallback(async (name: string) => {
        const game = await tauri.addCustomGame(name);
        setGames((g) => [...g, game]);
        return game;
    }, []);

    const removeCustomGame = useCallback(
        async (appId: string) => {
            await tauri.removeCustomGame(appId);
            await reload();
        },
        [reload],
    );

    const setCustomImage = useCallback(
        async (appId: string, role: string, pathOrUrl: string) => {
            await tauri.setCustomGameImage(appId, role, pathOrUrl);
            await reload();
        },
        [reload],
    );

    const setAlias = useCallback(
        async (alias: string, appId: string) => {
            await tauri.setGameAlias(alias, appId);
            await reload();
        },
        [reload],
    );

    const removeAlias = useCallback(
        async (alias: string) => {
            await tauri.removeGameAlias(alias);
            await reload();
        },
        [reload],
    );

    return {
        games,
        aliases,
        loading,
        error,
        diagnostics,
        reload,
        refreshSteam,
        refreshArtwork,
        addCustomGame,
        removeCustomGame,
        setCustomImage,
        setAlias,
        removeAlias,
    };
}

/** Resolve a clip's raw game name through aliases to the target game's
 * display name (legacy `gameAliases[video.game] ?? video.game`). */
export function resolveGameName(
    games: SteamGame[],
    aliases: GameAlias[],
    gameName: string,
): string {
    if (!gameName || gameName === "Unknown") return gameName;
    const alias = aliases.find((a) => a.alias === gameName);
    if (alias) {
        const target = games.find((g) => g.appId === alias.appId);
        if (target) return target.displayName;
    }
    return gameName;
}

/** Best artwork for a clip's game name (alias -> normalized -> exact). */
export function gameImageFor(
    games: SteamGame[],
    aliases: GameAlias[],
    gameName: string,
): GameImage | null {
    if (!gameName || gameName === "Unknown") return null;
    const alias = aliases.find((a) => a.alias === gameName);
    if (alias) {
        const viaAlias = games.find((g) => g.appId === alias.appId);
        if (viaAlias?.artwork) return viaAlias.artwork;
    }
    const normalized = gameName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const byName = games.find((g) => g.normalizedName === normalized);
    if (byName?.artwork) return byName.artwork;
    const exact = games.find((g) => g.displayName === gameName);
    return exact?.artwork ?? null;
}
