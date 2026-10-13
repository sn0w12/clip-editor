let returnToClip: string | null = null;

export function rememberReturnToClip(path: string): void {
    returnToClip = path;
}

export function takeReturnToClip(): string | null {
    const path = returnToClip;
    returnToClip = null;
    return path;
}
