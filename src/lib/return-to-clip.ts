const KEY = "clip-editor:return-to-clip";

/** Remember the clip to scroll to when returning to the library. */
export function rememberReturnToClip(path: string): void {
    sessionStorage.setItem(KEY, path);
}

/** Read and clear the return target (consumed once by the library page). */
export function takeReturnToClip(): string | null {
    const path = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return path;
}
