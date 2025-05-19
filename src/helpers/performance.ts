interface PerformanceLog {
    functionName: string;
    inputs?: Record<string, unknown>;
    startTime: number;
    steps: Record<string, { duration: number; timestamp: number }>;
    addStep(name: string): void;
    end(additionalInfo?: Record<string, unknown>): Record<string, unknown>;
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

            console.log(logOutputLines.join("\n"));

            return resultToReturn; // Return the clean object, suitable for programmatic use
        },
    };

    return logger;
}
