import { app } from "electron";
import path from "path";
import fs from "fs";

interface PerformanceLog {
    functionName: string;
    inputs?: Record<string, unknown>;
    startTime: number;
    steps: Record<string, { duration: number; timestamp: number }>;
    addStep(name: string): void;
    end(additionalInfo?: Record<string, unknown>): Record<string, unknown>;
}

interface PerformanceStats {
    functionName: string;
    totalInvocations: number;
    averageTotalDuration: number;
    medianTotalDuration: number;
    steps: Record<
        string,
        {
            average: number;
            median: number;
            percentOfTotal: number;
        }
    >;
    entries: PerformanceEntry[];
}

interface PerformanceEntry {
    timestamp: number;
    totalDuration: number;
    steps: Record<string, number>; // step name -> duration
}

const MAX_ENTRIES_PER_FUNCTION = 100;
const performanceHistory: Record<string, PerformanceEntry[]> = {};

// Load existing performance data from disk if available
async function loadPerformanceData() {
    try {
        const logsDir = getPerformanceLogsPath();

        // Create directory if it doesn't exist
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
            return; // No data to load
        }

        const files = await fs.promises.readdir(logsDir);

        for (const file of files) {
            if (file.endsWith(".json")) {
                try {
                    const filePath = path.join(logsDir, file);
                    const content = await fs.promises.readFile(
                        filePath,
                        "utf8",
                    );
                    const data = JSON.parse(content) as PerformanceStats;

                    // Extract function name from filename
                    const functionName = data.functionName;

                    // Load entries into memory
                    if (data.entries && Array.isArray(data.entries)) {
                        performanceHistory[functionName] = data.entries.slice(
                            -MAX_ENTRIES_PER_FUNCTION,
                        );
                    }
                } catch (err) {
                    console.error(
                        `Error loading performance data from ${file}:`,
                        err,
                    );
                }
            }
        }
    } catch (error) {
        console.error("Error loading performance data:", error);
    }
}

// Initialize by loading existing data
loadPerformanceData().catch((err) =>
    console.error("Failed to load performance data:", err),
);

/**
 * Calculates the median value from an array of numbers
 */
function calculateMedian(values: number[]): number {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);

    if (sorted.length % 2 === 0) {
        return (sorted[middle - 1] + sorted[middle]) / 2;
    }

    return sorted[middle];
}

/**
 * Calculates average and median statistics for a function's performance data
 */
function calculateStats(functionName: string): PerformanceStats {
    const entries = performanceHistory[functionName] || [];
    if (entries.length === 0) {
        return {
            functionName,
            totalInvocations: 0,
            averageTotalDuration: 0,
            medianTotalDuration: 0,
            steps: {},
            entries: [],
        };
    }

    // Calculate total duration stats
    const totalDurations = entries.map((entry) => entry.totalDuration);
    const averageTotalDuration =
        totalDurations.reduce((sum, duration) => sum + duration, 0) /
        entries.length;
    const medianTotalDuration = calculateMedian(totalDurations);

    // Collect all step names across all entries
    const allStepNames = new Set<string>();
    entries.forEach((entry) => {
        Object.keys(entry.steps).forEach((step) => allStepNames.add(step));
    });

    // Calculate step stats
    const steps: Record<
        string,
        { average: number; median: number; percentOfTotal: number }
    > = {};
    allStepNames.forEach((stepName) => {
        const stepDurations = entries
            .filter((entry) => stepName in entry.steps)
            .map((entry) => entry.steps[stepName]);

        const average =
            stepDurations.reduce((sum, duration) => sum + duration, 0) /
            stepDurations.length;
        const median = calculateMedian(stepDurations);
        const percentOfTotal = (average / averageTotalDuration) * 100;

        steps[stepName] = { average, median, percentOfTotal };
    });

    return {
        functionName,
        totalInvocations: entries.length,
        averageTotalDuration,
        medianTotalDuration,
        steps,
        entries: entries,
    };
}

/**
 * Returns the path to the performance logs directory
 */
function getPerformanceLogsPath(): string {
    return path.join(app.getPath("userData"), "performance-logs");
}

async function writePerformanceLog(functionName: string, content: string) {
    try {
        const logsDir = getPerformanceLogsPath();

        // Create directory if it doesn't exist
        if (!fs.existsSync(logsDir)) {
            fs.mkdirSync(logsDir, { recursive: true });
        }

        // Sanitize function name for use as filename
        const sanitizedName = functionName.replace(/[^a-zA-Z0-9]/g, "_");
        const filePath = path.join(logsDir, `${sanitizedName}.json`);

        await fs.promises.writeFile(filePath, content, "utf8");
        return { success: true, filePath };
    } catch (error) {
        console.error("Error writing performance log:", error);
        return { success: false, error: error };
    }
}

/**
 * Writes performance statistics to a file for the given function
 */
async function writePerformanceStatsToFile(
    functionName: string,
): Promise<void> {
    try {
        const stats = calculateStats(functionName);
        const content = JSON.stringify(stats, null, 2);
        await writePerformanceLog(functionName, content);
    } catch (error) {
        console.error(
            `Failed to write performance stats for ${functionName}:`,
            error,
        );
    }
}

/**
 * Adds a performance entry to the history and updates the stats file
 */
function addPerformanceEntry(
    functionName: string,
    totalDuration: number,
    steps: Record<string, { duration: number; timestamp: number }>,
): void {
    if (!performanceHistory[functionName]) {
        performanceHistory[functionName] = [];
    }

    // Create entry with step durations, excluding unnecessary info
    const entry: PerformanceEntry = {
        timestamp: Date.now(),
        totalDuration,
        steps: Object.entries(steps).reduce(
            (acc, [name, data]) => {
                acc[name] = data.duration;
                return acc;
            },
            {} as Record<string, number>,
        ),
    };

    // Add to history and limit size
    performanceHistory[functionName].push(entry);
    if (performanceHistory[functionName].length > MAX_ENTRIES_PER_FUNCTION) {
        performanceHistory[functionName].shift();
    }
    writePerformanceStatsToFile(functionName);
}

/**
 * Creates a performance logger to track execution time of a function and its steps.
 * The logger provides methods to record timestamps for different steps of execution
 * and calculates the duration and percentage of total time for each step.
 *
 * @param functionName - Name of the function being logged
 * @param inputs - Optional object containing input parameters to the function
 * @returns A PerformanceLog object with methods to track execution steps and end logging
 */
export function createPerformanceLogger(
    functionName: string,
    inputs?: Record<string, unknown>,
): PerformanceLog {
    const logger: PerformanceLog = {
        functionName,
        inputs,
        startTime: performance.now(),
        steps: {},
        addStep(name: string) {
            const now = performance.now();
            this.steps[name] = {
                duration:
                    now -
                    (this.steps[Object.keys(this.steps).pop() || ""]
                        ?.timestamp || this.startTime),
                timestamp: now,
            };
        },
        end(additionalInfo = {}) {
            const endTimestamp = performance.now();
            const totalDuration = endTimestamp - this.startTime;

            const RESET = "\x1b[0m";
            const RED = "\x1b[31m"; // For high percentage
            const GREEN = "\x1b[32m"; // For low percentage
            const YELLOW = "\x1b[33m"; // For medium percentage

            /**
             * Determines the ANSI color code based on the percentage.
             * @param percentage The percentage of total time.
             * @returns ANSI color code string.
             */
            const getColor = (percentage: number): string => {
                if (isNaN(percentage) || !isFinite(percentage)) return GREEN; // Default for NaN, Infinity
                if (percentage >= 40) return RED; // 40% and above
                if (percentage >= 15) return YELLOW; // 15% to 39.99...%
                return GREEN; // Below 15%
            };

            const plainStepsData: Record<string, string> = {};
            Object.entries(this.steps).forEach(([key, value]) => {
                const stepDuration = value.duration;
                let percentage = 0;
                if (totalDuration > 0) {
                    percentage = (stepDuration / totalDuration) * 100;
                } else if (stepDuration > 0 && totalDuration === 0) {
                    // Step took time, total is zero
                    percentage = Infinity;
                } else if (stepDuration === 0 && totalDuration === 0) {
                    // 0 / 0 case
                    percentage = 0;
                }

                const percentageDisplay = isFinite(percentage)
                    ? percentage.toFixed(1)
                    : "Inf";
                plainStepsData[key] =
                    `${stepDuration.toFixed(2)}ms (${percentageDisplay}%)`;
            });

            const resultToReturn: Record<string, unknown> = {
                functionName: this.functionName,
                ...(this.inputs && { inputs: this.inputs }),
                totalDuration: `${totalDuration.toFixed(2)}ms`,
                steps: plainStepsData,
                ...additionalInfo,
            };

            const logOutputLines: string[] = [
                `${JSON.stringify(this.functionName)}:`,
                "{",
            ];
            const mainLogEntries: string[] = []; // Holds each "key": "value" line for the main object

            if (this.inputs) {
                if (Object.keys(this.inputs).length > 0) {
                    const inputKeyValuePairs: string[] = [];
                    Object.entries(this.inputs).forEach(([key, value]) => {
                        inputKeyValuePairs.push(
                            `    ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
                        );
                    });
                    mainLogEntries.push(
                        `  "inputs": {\n${inputKeyValuePairs.join(",\n")}\n  }`,
                    );
                } else {
                    mainLogEntries.push(`  "inputs": {}`); // Handle empty inputs object
                }
            }
            mainLogEntries.push(
                `  "totalDuration": ${JSON.stringify(resultToReturn.totalDuration)}`,
            );

            if (Object.keys(this.steps).length > 0) {
                const coloredStepKeyValuePairs: string[] = []; // For "key": "colored_value" lines inside steps {}
                Object.entries(this.steps).forEach(([key, stepData]) => {
                    const stepDuration = stepData.duration;
                    let percentage = 0;
                    if (totalDuration > 0) {
                        percentage = (stepDuration / totalDuration) * 100;
                    } else if (stepDuration > 0 && totalDuration === 0) {
                        percentage = Infinity;
                    } else if (stepDuration === 0 && totalDuration === 0) {
                        percentage = 0;
                    }

                    const colorAnsiCode = getColor(percentage);
                    const percentageDisplay = isFinite(percentage)
                        ? percentage.toFixed(1)
                        : "Inf";
                    const stepValueString = `${stepDuration.toFixed(2)}ms (${percentageDisplay}%)`;

                    // JSON.stringify for key and the string value itself to handle escaping
                    coloredStepKeyValuePairs.push(
                        `    ${JSON.stringify(key)}: ${colorAnsiCode}${JSON.stringify(stepValueString)}${RESET}`,
                    );
                });
                mainLogEntries.push(
                    `  "steps": {\n${coloredStepKeyValuePairs.join(",\n")}\n  }`,
                );
            } else {
                mainLogEntries.push(`  "steps": {}`);
            }

            // Add additionalInfo entries
            Object.entries(additionalInfo).forEach(([key, value]) => {
                // Stringify value compactly. If it's a complex object, it will be a single line JSON string.
                mainLogEntries.push(
                    `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`,
                );
            });

            logOutputLines.push(mainLogEntries.join(",\n"));
            logOutputLines.push("}");

            addPerformanceEntry(this.functionName, totalDuration, this.steps);
            console.log(logOutputLines.join("\n"));
            return resultToReturn; // Return the clean object, suitable for programmatic use
        },
    };

    return logger;
}
