import { useEffect } from "react";

import { toastManager } from "@/components/ui/toast";
import { notify } from "@/lib/notify";
import { getRecordingState, onRecordingError } from "@/lib/tauri";

/**
 * Surfaces replay-buffer failures as toasts and desktop notifications. The
 * recording settings page shows the last error inline, but only while it is
 * mounted; this watcher lives in the layout so a buffer that dies with the
 * window hidden still tells the user.
 */
export function RecordingErrorWatcher(): null {
    useEffect(() => {
        let active = true;

        // A start failure from autostart or the tray toggle happened before
        // this component mounted, so recover the persisted error.
        void getRecordingState()
            .then((state) => {
                if (active && state.error) {
                    toastManager.add({
                        title: "Replay buffer failed",
                        description: state.error,
                        type: "error",
                    });
                    void notify("Replay buffer stopped", state.error);
                }
            })
            .catch(() => {});

        const unlisten = onRecordingError(({ message, fatal }) => {
            const options = {
                title: fatal ? "Replay buffer stopped" : "Replay save failed",
                description: message,
                type: "error",
            };
            toastManager.add(fatal ? { ...options, timeout: 15000 } : options);
            if (fatal) {
                void notify("Replay buffer stopped", message);
            }
        });

        return () => {
            active = false;
            void unlisten.then((fn) => fn());
        };
    }, []);

    return null;
}
