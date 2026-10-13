import { invoke } from "@tauri-apps/api/core";

import type { SerializedError } from "../protocol";

export interface InvokeOptions {
    args?: Record<string, unknown>;
}

export async function invokeCommand<T>(
    command: string,
    options: InvokeOptions = {}
): Promise<T> {
    try {
        return await invoke<T>(command, options.args);
    } catch (error) {
        throw normalizeError(error);
    }
}

export function normalizeError(error: unknown): BackendError {
    if (error instanceof BackendError) return error;
    if (isSerializedErrorShape(error)) return new BackendError(error);
    return new BackendError({
        code: "internal",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
    });
}

function isSerializedErrorShape(value: unknown): value is SerializedError {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as SerializedError).code === "string" &&
        typeof (value as SerializedError).message === "string"
    );
}

export class BackendError extends Error implements SerializedError {
    readonly code: string;
    readonly retryable: boolean;
    readonly detail?: string;

    constructor(serialized: SerializedError) {
        super(serialized.message);
        this.name = "BackendError";
        this.code = serialized.code;
        this.retryable = serialized.retryable;
        this.detail = serialized.detail;
    }

    get isStaleSnapshot(): boolean {
        return this.code === "staleSnapshot";
    }

    get isCancelled(): boolean {
        return this.code === "cancelled";
    }

    get isConflict(): boolean {
        return this.code === "conflict";
    }
}
