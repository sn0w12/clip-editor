import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { syncThemeWithLocal } from "./helpers/theme-helpers";
import { router } from "./routes/router";
import { RouterProvider } from "@tanstack/react-router";
import { SidebarProvider } from "./components/ui/sidebar";
import { loadingManager } from "./helpers/loading-manager";

export default function App() {
    const [appReady, setAppReady] = useState(false);

    useEffect(() => {
        // Set up initialization tasks
        const initialize = async () => {
            try {
                // Sync theme with local storage
                await syncThemeWithLocal();

                // Simulate some loading time (remove in production)
                if (process.env.NODE_ENV === "development") {
                    await new Promise((r) => setTimeout(r, 1000));
                }

                // Mark app as ready
                setAppReady(true);

                // Signal the loading window that app is ready to be displayed
                // Use a small timeout to ensure the loadingManager is fully initialized
                setTimeout(() => {
                    loadingManager.completeLoading();
                }, 100);
            } catch (error) {
                console.error("Error during app initialization:", error);
                // Still mark as ready even if there's an error
                setAppReady(true);
                loadingManager.completeLoading();
            }
        };

        initialize();
    }, []);

    // Optional: Show a fallback while initializing
    if (!appReady) {
        return null;
    }
    return (
        <SidebarProvider defaultOpen={false}>
            <RouterProvider router={router} />
        </SidebarProvider>
    );
}

// Store root in window object to ensure it persists across all HMR updates
declare global {
    interface Window {
        __APP_ROOT__?: ReturnType<typeof createRoot>;
    }
}

function renderApp() {
    const rootElement = document.getElementById("app");
    if (!rootElement) {
        throw new Error("Root element not found");
    }

    // Check if we already have a root in the window object
    if (!window.__APP_ROOT__) {
        console.log("Creating new React root");
        window.__APP_ROOT__ = createRoot(rootElement);
    } else {
        console.log("Reusing existing React root");
    }

    window.__APP_ROOT__.render(
        <React.StrictMode>
            <App />
        </React.StrictMode>,
    );
}

renderApp();
