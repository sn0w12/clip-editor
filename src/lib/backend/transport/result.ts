import { normalizeError } from "./invoke";
import type { BackendError } from "./invoke";

/**
 * Explicit error channel for every backend operation. The typed client
 * NEVER rejects: callers must narrow on `ok` before touching `value`,
 * which makes unhandled IPC failures a compile error instead of a runtime
 * surprise.
 */
export type Result<T, TError = BackendError> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: TError };

/** Runs a throwing backend operation, capturing any failure as a value. */
export async function asResult<T>(
    operation: () => Promise<T>
): Promise<Result<T>> {
    try {
        return { ok: true, value: await operation() };
    } catch (error) {
        return { ok: false, error: normalizeError(error) };
    }
}

/**
 * Unwraps a Result at react-query boundaries: queries and mutations model
 * failure through rejection, so an Err becomes a thrown BackendError.
 * Never use this outside a query/mutation context, which is exactly the
 * "ignore the error" hole this type exists to close.
 */
export function expectOk<T>(result: Result<T>): T {
    if (result.ok) return result.value;
    throw result.error;
}
