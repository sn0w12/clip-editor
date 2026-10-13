import { QueryClient } from "@tanstack/react-query";

import { createBackendClient } from "../backend/transport/client";
import type { BackendClient } from "../backend/transport/client";
import { BackendError } from "../backend/transport/invoke";

export interface AppServices {
    backend: BackendClient;
    queryClient: QueryClient;
}

export function createAppServices(): AppServices {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                refetchOnWindowFocus: false,
                refetchOnReconnect: false,
                retry: (failureCount, error) =>
                    error instanceof BackendError &&
                    error.retryable &&
                    failureCount < 2,
            },
        },
    });

    return { backend: createBackendClient(), queryClient };
}

let runtimeInstance: AppServices | null = null;

/** Process-wide singleton; tests call resetAppRuntime first. */
export function getAppRuntime(): AppServices {
    runtimeInstance ??= createAppServices();
    return runtimeInstance;
}

export function resetAppRuntime(instance: AppServices | null = null): void {
    runtimeInstance?.queryClient.clear();
    runtimeInstance = instance;
}
