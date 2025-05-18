export function normalizeGameName(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function imgSrc(src: string | null | undefined) {
    if (!src) {
        return "";
    }

    const ext = src.split(".").pop();
    if (!ext) {
        console.error("Invalid image path, no file extension:", src);
        return src;
    }

    if (src.includes("?")) {
        return `clip-editor:///${src}`;
    }

    return `clip-editor:///${src}?full=true`;
}

export function getGameId(
    name: string,
    games: Record<string, { appid: string; displayName: string }>,
    loading: boolean,
) {
    if (loading || !name) return null;

    const normalizedName = normalizeGameName(name);
    for (const [, game] of Object.entries(games)) {
        if (normalizeGameName(game.displayName) === normalizedName) {
            return game.appid;
        }
    }

    // If not found and it's a custom game, create a custom ID
    if (name && !loading) {
        for (const [, game] of Object.entries(games)) {
            if (game.displayName === name) {
                return game.appid;
            }
        }
    }

    return null;
}
