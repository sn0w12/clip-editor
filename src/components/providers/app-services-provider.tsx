import { QueryClientProvider } from "@tanstack/react-query";
import { useMemo } from "react";
import type { ReactNode } from "react";

import { AppServicesContext } from "@/contexts/services-context";
import { getAppRuntime } from "@/lib/bootstrap/app-runtime";

/**
 * Fast Refresh boundary: this file must export ONLY this component. Any
 * additional export disqualifies the module as a refresh boundary, and every
 * HMR update beneath it would remount the document shell (html/head/body).
 */
export function AppServicesProvider({ children }: { children: ReactNode }) {
    // No unmount reset: the runtime is a process-lifetime singleton, and a
    // StrictMode remount would orphan the QueryClient captured by context.
    const services = useMemo(() => getAppRuntime(), []);

    return (
        <AppServicesContext.Provider value={services}>
            <QueryClientProvider client={services.queryClient}>
                {children}
            </QueryClientProvider>
        </AppServicesContext.Provider>
    );
}
