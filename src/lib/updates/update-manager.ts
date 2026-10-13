import { createStore } from "@tanstack/store";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";

import { UpdateController } from "./update-controller";

// Dev builds have no update endpoint, so the whole dialog flow (available,
// downloading, installing) would be untestable without this fake cycle. It
// never runs in production.
function fakeDevUpdate(): Update {
    let progress = 0;
    const fake = {
        available: true,
        currentVersion: "0.0.0",
        version: "0.0.0-dev-update",
        body: "## Changes\n\n- Describe the release here",
        rawJson: {},
        downloadAndInstall: async (
            onEvent?: (event: {
                event: string;
                data?: { chunkLength?: number; contentLength?: number };
            }) => void
        ) => {
            const total = 200;
            onEvent?.({ event: "Started", data: { contentLength: total } });
            for (progress = 0; progress < total; progress += 20) {
                onEvent?.({ event: "Progress", data: { chunkLength: 20 } });
                await new Promise((resolve) => setTimeout(resolve, 120));
            }
            onEvent?.({ event: "Finished" });
        },
        close: async () => {},
    };
    return fake as unknown as Update;
}

/**
 * Process-wide updater singleton. Both the titlebar install button and the
 * update dialog subscribe to the same controller, and the dialog-open flag
 * is what turns a button click into a visible dialog. Dev builds run the
 * fake cycle above; the simulated relaunch never restarts the app, leaving
 * the dialog in its installing state until reload.
 */
export const updaterController = new UpdateController({
    check: () =>
        import.meta.env.PROD ? check() : Promise.resolve(fakeDevUpdate()),
    relaunch: () =>
        import.meta.env.PROD
            ? relaunch()
            : new Promise((resolve) => setTimeout(resolve, 1_500)),
});

export const updateDialogOpenStore = createStore(false);

export function openUpdateDialog(): void {
    updateDialogOpenStore.setState(() => true);
}

export function closeUpdateDialog(): void {
    updateDialogOpenStore.setState(() => false);
}
