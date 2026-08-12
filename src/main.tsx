import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";

import "@fontsource-variable/geist/wght.css";
import "@fontsource-variable/geist-mono/wght.css";
import "./globals.css";
import { createRoot } from "react-dom/client";

import { ToastProvider } from "@/components/ui/toast";
import { ConfirmProvider } from "@/contexts/confirm-context";
import { loadSettings } from "@/lib/settings";
import { router } from "@/routes/router";
import { loadRecordingProfile } from "@/stores/recording-store";

async function bootstrap() {
    try {
        await loadSettings();
    } catch (e) {
        console.error("failed to load settings; rendering with defaults", e);
    }
    try {
        await loadRecordingProfile();
    } catch {
        // loadRecordingProfile already falls back to a placeholder profile.
    }
    createRoot(document.getElementById("root")!).render(
        <StrictMode>
            <ToastProvider>
                <ConfirmProvider>
                    <RouterProvider router={router} />
                </ConfirmProvider>
            </ToastProvider>
        </StrictMode>,
    );
}

void bootstrap();
