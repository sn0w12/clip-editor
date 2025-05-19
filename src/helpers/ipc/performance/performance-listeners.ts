import { ipcMain } from "electron";
import path from "path";
import fs from "fs";
import { app } from "electron";
import { createPerformanceLogger } from "@/helpers/performance";

/**
 * Get the path to the performance logs directory
 */
function getPerformanceLogsPath(): string {
    return path.join(app.getPath("userData"), "performance-logs");
}

/**
 * Add performance monitoring related event listeners
 */
export function addPerformanceEventListeners() {
    // Get all available performance data
    ipcMain.handle("performance:get-all-data", async () => {
        const perfLog = createPerformanceLogger("performance:get-all-data");

        try {
            perfLog.addStep("getLogsDirectory");
            const logsDir = getPerformanceLogsPath();

            // Check if directory exists
            if (!fs.existsSync(logsDir)) {
                perfLog.end({
                    success: false,
                    error: "Logs directory not found",
                });
                return { success: false, data: {} };
            }

            perfLog.addStep("listFiles");
            const files = await fs.promises.readdir(logsDir);
            const performanceFiles = files.filter((file) =>
                file.endsWith(".json"),
            );

            perfLog.addStep("readFiles");
            const performanceData: Record<string, unknown> = {};

            for (const file of performanceFiles) {
                try {
                    const filePath = path.join(logsDir, file);
                    const content = await fs.promises.readFile(
                        filePath,
                        "utf8",
                    );
                    const data = JSON.parse(content);

                    // Use the function name as the key
                    if (data && data.functionName) {
                        performanceData[data.functionName] = data;
                    }
                } catch (err) {
                    console.error(
                        `Error reading performance file ${file}:`,
                        err,
                    );
                }
            }

            perfLog.end({ success: true, fileCount: performanceFiles.length });
            return { success: true, data: performanceData };
        } catch (error) {
            console.error("Error getting performance data:", error);

            perfLog.end({
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            });

            return {
                success: false,
                data: {},
                error: error instanceof Error ? error.message : "Unknown error",
            };
        }
    });

    // Get performance data for a specific function
    ipcMain.handle(
        "performance:get-function-data",
        async (_, functionName: string) => {
            const perfLog = createPerformanceLogger(
                "performance:get-function-data",
                { functionName },
            );

            try {
                perfLog.addStep("sanitizeName");
                // Sanitize function name for file system
                const sanitizedName = functionName.replace(
                    /[^a-zA-Z0-9]/g,
                    "_",
                );
                const filePath = path.join(
                    getPerformanceLogsPath(),
                    `${sanitizedName}.json`,
                );

                perfLog.addStep("checkFileExists");
                if (!fs.existsSync(filePath)) {
                    perfLog.end({
                        success: false,
                        error: "Function data not found",
                    });
                    return {
                        success: false,
                        data: null,
                        error: "Performance data not found for this function",
                    };
                }

                perfLog.addStep("readFile");
                const content = await fs.promises.readFile(filePath, "utf8");
                const data = JSON.parse(content);

                perfLog.end({ success: true });
                return { success: true, data };
            } catch (error) {
                console.error(
                    `Error getting performance data for ${functionName}:`,
                    error,
                );

                perfLog.end({
                    success: false,
                    error:
                        error instanceof Error
                            ? error.message
                            : "Unknown error",
                });

                return {
                    success: false,
                    data: null,
                    error:
                        error instanceof Error
                            ? error.message
                            : "Unknown error",
                };
            }
        },
    );
}
