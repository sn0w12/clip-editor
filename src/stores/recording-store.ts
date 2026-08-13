import { useCallback, useEffect, useState } from "react";

import * as tauri from "@/lib/tauri";
import type { RecordingProfile, RecordingState } from "@/types";

const IDLE: RecordingState = {
    running: false,
    availableSeconds: 0,
    targetSeconds: 30,
    saving: false,
    error: null,
};

const RECORDING_PROFILE_PLACEHOLDER: RecordingProfile = {
    durationSeconds: 30,
    segmentSeconds: 1,
    monitor: "primary",
    fps: 60,
    codec: "auto",
    quality: 23,
    cursor: true,
    sampleRate: 48000,
    channels: 2,
    hotkey: "ctrl+shift+KeyQ",
    outputDir: "",
    filenameBase: "Replay",
    successSound: "",
    audioRouting: "all",
    processes: [],
    tracks: [
        {
            number: 1,
            name: "all",
            include: ["all_processes"],
            exclude: [],
        },
    ],
};

let loadedRecordingProfile: RecordingProfile | null = null;
let recordingProfileLoadPromise: Promise<RecordingProfile> | null = null;

export async function loadRecordingProfile(): Promise<RecordingProfile> {
    if (loadedRecordingProfile) {
        return loadedRecordingProfile;
    }
    if (recordingProfileLoadPromise) {
        return recordingProfileLoadPromise;
    }

    recordingProfileLoadPromise = tauri
        .getRecordingProfile()
        .then((profile) => {
            loadedRecordingProfile = profile;
            return profile;
        })
        .catch(() => {
            loadedRecordingProfile = RECORDING_PROFILE_PLACEHOLDER;
            return RECORDING_PROFILE_PLACEHOLDER;
        })
        .finally(() => {
            recordingProfileLoadPromise = null;
        });

    return recordingProfileLoadPromise;
}

export function getLoadedRecordingProfile(): RecordingProfile {
    return loadedRecordingProfile ?? RECORDING_PROFILE_PLACEHOLDER;
}

export function useRecordingStore(): RecordingState & {
    start: () => Promise<void>;
    save: () => Promise<void>;
    stop: () => Promise<void>;
    getProfile: () => Promise<RecordingProfile>;
    getProfileSync: () => RecordingProfile;
    setProfile: (profile: RecordingProfile) => Promise<void>;
    refresh: () => Promise<void>;
} {
    const [state, setState] = useState<RecordingState>(IDLE);
    const [profile, setProfileState] = useState<RecordingProfile>(getLoadedRecordingProfile());

    const refresh = useCallback(async () => {
        try {
            setState(await tauri.getRecordingState());
        } catch {
            // keep last known state
        }
    }, []);

    const refreshProfile = useCallback(async () => {
        try {
            const loaded = await tauri.getRecordingProfile();
            loadedRecordingProfile = loaded;
            setProfileState(loaded);
        } catch {
            // keep last known profile
        }
    }, []);

    useEffect(() => {
        // Initial load (setState happens in promise callbacks, not synchronously).
        void tauri
            .getRecordingState()
            .then(setState)
            .catch(() => {
                // keep last known state
            });
        void tauri
            .getRecordingProfile()
            .then((loaded) => {
                loadedRecordingProfile = loaded;
                setProfileState(loaded);
            })
            .catch(() => {
                // keep last known profile
            });

        const unlisteners: Promise<() => void>[] = [
            tauri.onRecordingState(setState),
            tauri.onRecordingProgress((p) =>
                setState((s) => ({
                    ...s,
                    availableSeconds: p.availableSeconds,
                    targetSeconds: p.targetSeconds,
                })),
            ),
            tauri.onRecordingSaving(() => setState((s) => ({ ...s, saving: true }))),
            tauri.onRecordingSaved(() => setState((s) => ({ ...s, saving: false }))),
            tauri.onRecordingError((p) =>
                setState((s) => ({
                    ...s,
                    running: false,
                    saving: false,
                    error: p.message,
                })),
            ),
        ];
        return () => {
            for (const unlisten of unlisteners) {
                void unlisten.then((fn) => fn());
            }
        };
    }, []);

    const start = useCallback(async () => {
        await tauri.startReplayBuffer();
        await refresh();
    }, [refresh]);

    const save = useCallback(async () => {
        await tauri.saveReplay();
    }, []);

    const stop = useCallback(async () => {
        await tauri.stopReplayBuffer();
        await refresh();
    }, [refresh]);

    const getProfile = useCallback(() => tauri.getRecordingProfile(), []);
    const getProfileSync = useCallback(() => profile, [profile]);
    const setProfile = useCallback(
        async (nextProfile: RecordingProfile) => {
            await tauri.setRecordingProfile(nextProfile);
            setProfileState(nextProfile);
            await refreshProfile();
        },
        [refreshProfile],
    );

    return {
        ...state,
        start,
        save,
        stop,
        getProfile,
        getProfileSync,
        setProfile,
        refresh,
    };
}
