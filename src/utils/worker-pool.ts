import { Worker } from "worker_threads";
import os from "os";
import path from "path";

export class WorkerPool {
    private workers: Worker[] = [];
    private availableWorkers: Worker[] = [];
    private pendingTasks: Map<
        string,
        {
            resolve: (value: unknown) => void;
            reject: (reason?: unknown) => void;
        }
    > = new Map();
    private readonly maxWorkers = Math.max(2, Math.min(4, os.cpus().length));
    private workerPath: string;

    constructor(workerPath: string) {
        this.workerPath = workerPath;
        this.initializeWorkers();
    }

    private initializeWorkers() {
        for (let i = 0; i < this.maxWorkers; i++) {
            const worker = new Worker(this.workerPath, {
                env: {
                    ...process.env,
                    NODE_PATH: path.join(
                        process.resourcesPath,
                        "app.asar.unpacked",
                        "node_modules",
                    ),
                },
                execArgv: ["--experimental-vm-modules"],
            });

            worker.on("message", (message) => {
                const { type, id, success, data, error } = message;

                if (type === "result") {
                    const task = this.pendingTasks.get(id);
                    if (task) {
                        this.pendingTasks.delete(id);
                        this.availableWorkers.push(worker);

                        if (success) {
                            task.resolve(data);
                        } else {
                            task.reject(new Error(error));
                        }
                    }
                } else if (type === "progress") {
                    // Handle progress updates if needed
                    // Could emit to renderer process for UI updates
                }
            });

            worker.on("error", (error) => {
                console.error("Worker error:", error);
                this.handleWorkerError(worker);
            });

            this.workers.push(worker);
            this.availableWorkers.push(worker);
        }
    }

    private handleWorkerError(faultyWorker: Worker) {
        // Remove faulty worker and create a new one
        const index = this.workers.indexOf(faultyWorker);
        if (index > -1) {
            this.workers.splice(index, 1);
            const availableIndex = this.availableWorkers.indexOf(faultyWorker);
            if (availableIndex > -1) {
                this.availableWorkers.splice(availableIndex, 1);
            }

            faultyWorker.terminate();

            // Create replacement worker
            const newWorker = new Worker(this.workerPath);
            this.workers.push(newWorker);
            this.availableWorkers.push(newWorker);
        }
    }

    async executeTask(type: string, data: unknown): Promise<unknown> {
        return new Promise((resolve, reject) => {
            const worker = this.availableWorkers.pop();
            if (!worker) {
                // Queue the task if no workers available
                setTimeout(() => {
                    this.executeTask(type, data).then(resolve).catch(reject);
                }, 10);
                return;
            }

            const id = Math.random().toString(36).substring(7);
            this.pendingTasks.set(id, { resolve, reject });

            worker.postMessage({ type, data, id });
        });
    }

    terminate() {
        this.workers.forEach((worker) => worker.terminate());
        this.workers = [];
        this.availableWorkers = [];
        this.pendingTasks.clear();
    }
}
