import { createStore } from "@tanstack/store";
import type { Store } from "@tanstack/store";
import type { Update } from "@tauri-apps/plugin-updater";

export interface UpdateInfo {
    version: string;
    currentVersion: string;
    body?: string;
    date?: string;
}

export type UpdateState =
    | { status: "idle" }
    | { status: "checking" }
    | { status: "none" }
    | { status: "available"; info: UpdateInfo }
    | {
          status: "downloading";
          info: UpdateInfo;
          percent: number | null;
          receivedBytes: number;
          totalBytes: number | null;
      }
    | { status: "installing"; info: UpdateInfo }
    | { status: "failed"; info: UpdateInfo | null; message: string };

interface UpdaterRuntime {
    check: () => Promise<Update | null>;
    relaunch: () => Promise<void>;
}

function initialState(): UpdateState {
    return { status: "idle" };
}

function describe(update: Update): UpdateInfo {
    return {
        version: update.version,
        currentVersion: update.currentVersion,
        body: update.body,
        date: update.date,
    };
}

/**
 * Drives a single update cycle: silent check on startup, then a one-shot
 * download-and-install that relaunches the app. The owning UI only surfaces
 * a dialog when a new version actually exists.
 */
export class UpdateController {
    readonly store: Store<UpdateState>;

    private update: Update | null = null;
    private info: UpdateInfo | null = null;
    private started = false;

    constructor(private runtime: UpdaterRuntime) {
        this.store = createStore<UpdateState>(initialState());
    }

    /** Whether the controller has already polled the update endpoint. */
    get hasChecked(): boolean {
        return this.started;
    }

    /**
     * Checks for a new version exactly once. Repeated calls after the first
     * are no-ops. Failures settle silently into a non-dialog state so a
     * misconfigured endpoint never nags the user on every launch.
     */
    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;

        this.store.setState(() => ({ status: "checking" }));
        let update: Update | null;
        try {
            update = await this.runtime.check();
        } catch (error) {
            this.store.setState(() => ({
                status: "failed",
                info: null,
                message: error instanceof Error ? error.message : String(error),
            }));
            return;
        }

        if (!update) {
            this.store.setState(() => ({ status: "none" }));
            return;
        }

        this.update = update;
        this.info = describe(update);
        this.store.setState(() => ({
            status: "available",
            info: describe(update),
        }));
    }

    /**
     * Downloads and installs the pending update, then relaunches. On failure
     * returns to an available state so the user can retry.
     */
    async install(): Promise<void> {
        const update = this.update;
        const info = this.info;
        if (!update || !info) return;

        let receivedBytes = 0;
        let totalBytes: number | null = null;

        this.store.setState(() => ({
            status: "downloading",
            info,
            percent: null,
            receivedBytes: 0,
            totalBytes: null,
        }));

        try {
            await update.downloadAndInstall((event) => {
                if (event.event === "Started") {
                    receivedBytes = 0;
                    totalBytes = event.data.contentLength ?? null;
                } else if (event.event === "Progress") {
                    receivedBytes += event.data.chunkLength;
                }
                this.store.setState(() => ({
                    status: "downloading",
                    info,
                    percent:
                        totalBytes !== null && totalBytes > 0
                            ? Math.min(100, (receivedBytes / totalBytes) * 100)
                            : null,
                    receivedBytes,
                    totalBytes,
                }));
            });

            this.store.setState(() => ({ status: "installing", info }));
            await this.runtime.relaunch();
        } catch (error) {
            this.store.setState(() => ({
                status: "failed",
                info,
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    }

    /** Closes any surfaced dialog; a later launch checks again. */
    reset(): void {
        this.update = null;
        this.info = null;
        this.store.setState(() => initialState());
    }
}
