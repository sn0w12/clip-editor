// Mirror of `src-tauri/src/types.rs` — the IPC contract. Keep in sync.

export interface VideoFile {
    name: string;
    game: string;
    /** Canonical absolute path (identity key). */
    path: string;
    size: number;
    /** ISO-8601 UTC. */
    lastModified: string;
    metadata?: VideoMetadata | null;
    scanError?: string | null;
    gameImages?: GameImage | null;
    groupIds: string[];
    /** Cached thumbnail path, returned inline so cards render without a per-card request. */
    thumbnail?: string | null;
    /** Base64 ThumbHash placeholder, rendered instantly while the JPEG loads. */
    thumbhash?: string | null;
}

export interface VideoMetadata {
    duration: number;
    width: number;
    height: number;
    fps: number;
    bitrate?: number | null;
    size?: number | null;
    videoCodec?: string | null;
    audioCodec?: string | null;
    audioTracks: AudioTrackInfo[];
}

export interface AudioTrackInfo {
    index: number;
    label: string;
}

export interface ExportOptions {
    startTime: number;
    endTime: number;
    outputFormat: string;
    quality?: string | null;
    targetSize?: number | null;
    qualityMode: "preset" | "targetSize";
    width?: number | null;
    height?: number | null;
    fps?: number | null;
    audioBitrate?: number | null;
    removeAudio?: boolean | null;
    speedFactor?: number | null;
    audioTracks?: number[] | null;
    chooseExportLocation?: boolean | null;
    cuts?: Cut[] | null;
}

export interface TimeRange {
    start: number;
    end: number;
}

export interface Cut {
    start: number;
    end: number;
}

export interface ExportedClip {
    path: string;
    name: string;
    timestamp: string;
    duration: number;
    thumbnail: string;
    size: number;
}

export interface VideoGroup {
    id: string;
    name: string;
    color?: string | null;
}

export interface GameImage {
    header?: string | null;
    library_600x900?: string | null;
    library_hero?: string | null;
    library_hero_blur?: string | null;
    logo?: string | null;
    icon?: string | null;
}

export interface SteamGame {
    appId: string;
    displayName: string;
    normalizedName: string;
    source: "steam" | "custom";
    artwork?: GameImage | null;
    artworkError?: string | null;
    pendingRoles: string[];
}

export interface GameAlias {
    alias: string;
    appId: string;
}

export interface AudioProcessConfig {
    id: string;
    executable: string;
    tags: string[];
    includeChildren: boolean;
}

export interface AudioTrackConfig {
    number: number;
    name: string;
    include: string[];
    exclude: string[];
}

export interface RecordingProfile {
    durationSeconds: number;
    segmentSeconds: number;
    monitor: string;
    fps: number;
    codec: string;
    quality: number;
    cursor: boolean;
    sampleRate: number;
    channels: number;
    hotkey: string;
    outputDir: string;
    filenameBase: string;
    successSound: string;
    audioRouting: "all" | "all+mic";
    processes: AudioProcessConfig[];
    tracks: AudioTrackConfig[];
}

export interface RecordingState {
    running: boolean;
    availableSeconds: number;
    targetSeconds: number;
    saving: boolean;
    error?: string | null;
}

export interface ScanResult {
    roots: string[];
    clips: number;
    failures: string[];
}

export interface RenameResult {
    oldPath: string;
    newPath: string;
}

export interface OpResult {
    success: string[];
    failed: string[];
    error?: string | null;
}

export interface ExportResult {
    outputPath: string;
    fileAlreadyExists: boolean;
}

export interface ImportResult {
    imported: boolean;
    warning?: string | null;
    directory?: string | null;
    groups: number;
    assignments: number;
    customGames: number;
    aliases: number;
}

export interface ScanDiagnostic {
    path: string;
    reason: string;
}

export interface SteamDataResult {
    games: SteamGame[];
    diagnostics: ScanDiagnostic[];
    aliases: GameAlias[];
}

export interface ListGamesResult {
    games: SteamGame[];
    aliases: GameAlias[];
}

export interface LibraryChanged {
    root?: string | null;
    kind: "full" | "incremental" | "watcher-error";
    message?: string | null;
}

export interface ExportProgress {
    progress: number;
    currentTime: number;
    totalDuration: number;
}

export interface ExportComplete {
    outputPath: string;
}

export interface ExportError {
    message: string;
}

export interface SteamArtworkUpdated {
    appId: string;
    roles: string[];
    error?: string | null;
}

export type SettingsMap = Record<string, string | number | boolean | string[]>;
