interface PerformanceLog {
    start: number;
    steps: Record<string, { duration: number; timestamp: number }>;
    addStep(name: string): void;
    end(additionalInfo?: Record<string, unknown>): Record<string, unknown>;
}

export function createPerformanceLogger(): PerformanceLog {
    const logger: PerformanceLog = {
        start: performance.now(),
        steps: {},
        addStep(name: string) {
            const now = performance.now();
            this.steps[name] = {
                duration:
                    now -
                    (this.steps[Object.keys(this.steps).pop() || ""]
                        ?.timestamp || this.start),
                timestamp: now,
            };
        },
        end(additionalInfo = {}) {
            const end = performance.now();
            const totalDuration = end - this.start;

            const result = {
                totalDuration: `${totalDuration.toFixed(2)}ms`,
                steps: Object.entries(this.steps).reduce(
                    (acc, [key, value]) => {
                        acc[key] =
                            `${value.duration.toFixed(2)}ms (${((value.duration / totalDuration) * 100).toFixed(1)}%)`;
                        return acc;
                    },
                    {} as Record<string, string>,
                ),
                ...additionalInfo,
            };

            console.log("Performance Log:", JSON.stringify(result, null, 2));
            return result;
        },
    };

    return logger;
}
