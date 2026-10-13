import { createContext, useContext } from "react";

import type { AppServices } from "@/lib/bootstrap/app-runtime";

export const AppServicesContext = createContext<AppServices | null>(null);

export function useAppServices(): AppServices {
    const services = useContext(AppServicesContext);
    if (!services) {
        throw new Error(
            "AppServicesContext is missing; wrap your tree in <AppServicesProvider>"
        );
    }
    return services;
}
