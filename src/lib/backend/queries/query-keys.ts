/**
 * Single owner of query keys. Every `queryOptions` factory in this folder
 * builds its key here, so a mutation can invalidate a scope by prefix
 * without knowing which factories exist.
 */
export const appKeys = {
    all: ["app"] as const,
    info: () => ["app", "info"] as const,
    ping: () => ["app", "ping"] as const,
};

export const libraryKeys = {
    all: ["library"] as const,
    clips: () => ["library", "clips"] as const,
    roots: () => ["library", "roots"] as const,
    groups: () => ["library", "groups"] as const,
    groupClips: (groupId: string) =>
        ["library", "group-clips", groupId] as const,
    games: () => ["library", "games"] as const,
    metadata: (path: string) => ["library", "metadata", path] as const,
    waveform: (path: string, track: number, count: number) =>
        ["library", "waveform", path, track, count] as const,
    exports: (path: string) => ["library", "exports", path] as const,
};

export const recordingKeys = {
    all: ["recording"] as const,
    state: () => ["recording", "state"] as const,
    profile: () => ["recording", "profile"] as const,
};
