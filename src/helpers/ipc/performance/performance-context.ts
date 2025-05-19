import { contextBridge, ipcRenderer } from "electron";

/**
 * Exposes performance data functionality to the renderer process
 */
export function exposePerformanceContext() {
    contextBridge.exposeInMainWorld("performanceMonitor", {
        /**
         * Gets all performance data collected by the application
         * @returns Object containing all performance data
         */
        getAllData: async (): Promise<{
            success: boolean;
            data: Record<string, unknown>;
            error?: string;
        }> => {
            return ipcRenderer.invoke("performance:get-all-data");
        },

        /**
         * Gets performance data for a specific function
         * @param functionName Name of the function to get performance data for
         * @returns Object containing performance data for the function
         */
        getFunctionData: async (
            functionName: string,
        ): Promise<{
            success: boolean;
            data: unknown;
            error?: string;
        }> => {
            return ipcRenderer.invoke(
                "performance:get-function-data",
                functionName,
            );
        },
    });
}
