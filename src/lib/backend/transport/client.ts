import type {
    ExportOptions,
    ExportResult,
    ExportedClip,
    ImportResult,
    ListGamesResult,
    OpResult,
    RecordingProfile,
    RecordingState,
    RenameResult,
    ScanResult,
    SteamDataResult,
    SteamGame,
    VideoFile,
    VideoGroup,
    VideoMetadata,
} from "../domain";
import type {
    AppInfo,
    EchoRequest,
    EchoResult,
    SessionDocument,
    SettingValue,
    SettingsSnapshot,
    ValuesSnapshot,
} from "../protocol";
import { invokeCommand } from "./invoke";
import { asResult } from "./result";
import type { Result } from "./result";

/**
 * The single place where raw Tauri command names exist. Everything else in
 * the app talks to this typed client.
 *
 * Every method returns a `Result`: the client NEVER rejects, so callers
 * are forced by the compiler to narrow on `ok` before using a value.
 */
function createRawBackendClient() {
    return {
        app: {
            info: () => invokeCommand<AppInfo>("app_info"),
            /** Liveness probe: the cheapest command there is. */
            ping: () => invokeCommand<string>("app_ping"),
            /** Blocking call routed through the backend scheduler. */
            echo: (request: EchoRequest) =>
                invokeCommand<EchoResult>("app_echo", { args: { request } }),
        },
        settings: {
            load: () => invokeCommand<SettingsSnapshot>("settings_load"),
            set: (key: string, value: SettingValue) =>
                invokeCommand<ValuesSnapshot>("settings_set", {
                    args: { key, value },
                }),
        },
        session: {
            load: () => invokeCommand<SessionDocument>("session_load"),
            save: (doc: SessionDocument) =>
                invokeCommand<void>("session_save", { args: { doc } }),
        },
        library: {
            mediaServerPort: () =>
                invokeCommand<number>("get_media_server_port"),
            selectDirectory: () =>
                invokeCommand<string | null>("select_directory"),
            getRoots: () => invokeCommand<string[]>("get_library_roots"),
            scan: () => invokeCommand<ScanResult>("scan_library"),
            addRoot: (path: string) =>
                invokeCommand<ScanResult>("add_library_root", {
                    args: { path },
                }),
            removeRoot: (path: string) =>
                invokeCommand<void>("remove_library_root", { args: { path } }),
        },
        clips: {
            list: () => invokeCommand<VideoFile[]>("get_clips"),
            metadata: (path: string) =>
                invokeCommand<VideoMetadata>("get_clip_metadata", {
                    args: { path },
                }),
            thumbnail: (path: string) =>
                invokeCommand<string>("get_thumbnail", { args: { path } }),
            playableVideo: (path: string) =>
                invokeCommand<string>("get_playable_video", { args: { path } }),
            waveform: (
                path: string,
                sampleCount?: number,
                audioTrack?: number
            ) =>
                invokeCommand<number[]>("get_waveform", {
                    args: { path, sampleCount, audioTrack },
                }),
            remove: (paths: string[]) =>
                invokeCommand<OpResult>("delete_clips", { args: { paths } }),
            rename: (path: string, newGameName: string) =>
                invokeCommand<RenameResult>("rename_clip", {
                    args: { path, newGameName },
                }),
            reveal: (path: string) =>
                invokeCommand<void>("show_in_folder", { args: { path } }),
            open: (path: string) =>
                invokeCommand<void>("open_file", { args: { path } }),
            previousExports: (path: string) =>
                invokeCommand<ExportedClip[]>("get_previous_exports", {
                    args: { path },
                }),
            removeExport: (outputPath: string) =>
                invokeCommand<void>("remove_export", { args: { outputPath } }),
            copyToClipboard: (path: string) =>
                invokeCommand<void>("copy_file_to_clipboard", {
                    args: { path },
                }),
            export: (path: string, options: ExportOptions) =>
                invokeCommand<ExportResult>("export_clip", {
                    args: { path, options },
                }),
        },
        groups: {
            list: () => invokeCommand<VideoGroup[]>("list_groups"),
            create: (name: string, color?: string | null) =>
                invokeCommand<VideoGroup>("create_group", {
                    args: { name, color },
                }),
            remove: (id: string) =>
                invokeCommand<void>("delete_group", { args: { id } }),
            clips: (groupId: string) =>
                invokeCommand<VideoFile[]>("get_group_clips", {
                    args: { groupId },
                }),
            assign: (clipPaths: string[], groupId: string) =>
                invokeCommand<void>("assign_clips_to_group", {
                    args: { clipPaths, groupId },
                }),
            unassign: (clipPaths: string[], groupId: string) =>
                invokeCommand<void>("remove_clips_from_group", {
                    args: { clipPaths, groupId },
                }),
        },
        recording: {
            start: () => invokeCommand<void>("start_replay_buffer"),
            save: () => invokeCommand<void>("save_replay"),
            stop: () => invokeCommand<void>("stop_replay_buffer"),
            state: () => invokeCommand<RecordingState>("get_recording_state"),
            profile: () =>
                invokeCommand<RecordingProfile>("get_recording_profile"),
            setProfile: (profile: RecordingProfile) =>
                invokeCommand<void>("set_recording_profile", {
                    args: { profile },
                }),
        },
        steam: {
            refresh: () => invokeCommand<SteamDataResult>("refresh_steam_data"),
            listGames: () => invokeCommand<ListGamesResult>("get_games"),
            refreshArtwork: (appId: string) =>
                invokeCommand<void>("refresh_steam_artwork", {
                    args: { appId },
                }),
            addCustomGame: (name: string) =>
                invokeCommand<SteamGame>("add_custom_game", { args: { name } }),
            removeCustomGame: (appId: string) =>
                invokeCommand<void>("remove_custom_game", { args: { appId } }),
            setCustomImage: (appId: string, role: string, pathOrUrl: string) =>
                invokeCommand<void>("set_custom_game_image", {
                    args: { appId, role, pathOrUrl },
                }),
            setAlias: (alias: string, appId: string) =>
                invokeCommand<void>("set_game_alias", {
                    args: { alias, appId },
                }),
            removeAlias: (alias: string) =>
                invokeCommand<void>("remove_game_alias", { args: { alias } }),
        },
        legacy: {
            importState: (path?: string | null) =>
                invokeCommand<ImportResult>("import_legacy_state", {
                    args: { path },
                }),
        },
    };
}

type RawClient = ReturnType<typeof createRawBackendClient>;

/** `(...args) => Promise<T>` becomes `(...args) => Promise<Result<T>>`. */
type Resultified<TFn> = TFn extends (
    ...args: infer Args
) => Promise<infer TValue>
    ? (...args: Args) => Promise<Result<TValue>>
    : never;

type ResultifiedGroup<TGroup> = {
    [TKey in keyof TGroup]: Resultified<TGroup[TKey]>;
};

export type BackendClient = {
    [TGroup in keyof RawClient]: ResultifiedGroup<RawClient[TGroup]>;
};

function resultifyGroup<TGroup extends Record<string, unknown>>(
    group: TGroup
): ResultifiedGroup<TGroup> {
    const out = {} as ResultifiedGroup<TGroup>;
    for (const key of Object.keys(group) as Array<keyof TGroup & string>) {
        const method = group[key] as (...args: never[]) => Promise<unknown>;
        out[key] = ((...args: never[]) =>
            asResult(() => method(...args))) as Resultified<TGroup[typeof key]>;
    }
    return out;
}

/**
 * The public client: identical signatures to the raw one, but every call
 * resolves to a Result instead of rejecting.
 */
export function createBackendClient(): BackendClient {
    const raw = createRawBackendClient();
    return {
        app: resultifyGroup(raw.app),
        settings: resultifyGroup(raw.settings),
        session: resultifyGroup(raw.session),
        library: resultifyGroup(raw.library),
        clips: resultifyGroup(raw.clips),
        groups: resultifyGroup(raw.groups),
        recording: resultifyGroup(raw.recording),
        steam: resultifyGroup(raw.steam),
        legacy: resultifyGroup(raw.legacy),
    };
}
