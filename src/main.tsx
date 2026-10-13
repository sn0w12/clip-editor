import { MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ActiveTabHost } from "@/components/active-tab-host";
import { AppLayout } from "@/components/app-layout";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { Button } from "@/components/ui/button";
import { WindowReveal } from "@/components/window-reveal";
import { expectOk } from "@/lib/backend/transport/result";
import { getAppRuntime } from "@/lib/bootstrap/app-runtime";
import { bootMark } from "@/lib/bootstrap/boot-timing";
import {
    initSessionPersistence,
    restoreSession,
    shouldRestoreTabs,
} from "@/lib/bootstrap/session-persistence";
import { replaceTabs } from "@/stores/app-store";
import {
    configureSettingsSaver,
    initializeSettings,
} from "@/stores/settings-store";
import { startThemeEngine } from "@/stores/theme-store";

import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");
const root = createRoot(container);

async function loadSettingsSnapshot() {
    const loaded = await getAppRuntime().backend.settings.load();
    bootMark("settings.load");
    if (!loaded.ok) throw loaded.error;
    return loaded.value;
}

function BootstrapError({ message }: { message: string }) {
    return (
        <div className="flex h-svh items-center justify-center p-6">
            <WindowReveal />
            <div className="max-w-sm space-y-2 text-center">
                <h1 className="text-lg font-semibold tracking-tight">
                    seraphis failed to start
                </h1>
                <p className="text-sm text-muted-foreground">{message}</p>
                <Button
                    variant="outline"
                    onClick={() => window.location.reload()}
                >
                    Retry
                </Button>
            </div>
        </div>
    );
}

/** A failed session read aborts bootstrap: persisting over a file we could
 * not read would destroy the user's tabs. */
async function bootstrap(): Promise<void> {
    const services = getAppRuntime();

    // Settings and session are independent disk reads; loading them
    // concurrently removes one IPC round trip from the pre-render path.
    const [snapshot, restored] = await Promise.all([
        loadSettingsSnapshot(),
        restoreSession(services.backend),
    ]);

    // Settings must be ready before any component reads them.
    configureSettingsSaver((key, value) =>
        services.backend.settings.set(key, value).then(expectOk)
    );
    initializeSettings(snapshot);

    if (restored.kind === "loadFailed") {
        root.render(<BootstrapError message={restored.message} />);
        return;
    }

    if (restored.kind === "restored" && !shouldRestoreTabs()) {
        replaceTabs([], null);
    }

    startThemeEngine();

    // Save failures are logged loudly: silent data loss is worse than noise.
    const disposePersistence = initSessionPersistence(async (doc) => {
        const saved = await services.backend.session.save(doc);
        if (!saved.ok) {
            console.error("session save failed:", saved.error.message);
        }
    });
    // Best-effort flush of the debounce tail when the window goes away.
    window.addEventListener("pagehide", disposePersistence, { once: true });

    root.render(
        <StrictMode>
            <AppServicesProvider>
                <WindowReveal />
                <MotionConfig reducedMotion="user">
                    <AppLayout>
                        <ActiveTabHost />
                    </AppLayout>
                </MotionConfig>
            </AppServicesProvider>
        </StrictMode>
    );
    bootMark("first.render");
}

bootstrap().catch((error: unknown) => {
    root.render(
        <BootstrapError
            message={error instanceof Error ? error.message : String(error)}
        />
    );
});
