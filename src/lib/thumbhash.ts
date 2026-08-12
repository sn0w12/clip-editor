import { thumbHashToDataURL } from "thumbhash";

export function thumbHashBase64ToDataURL(b64: string): string | null {
    try {
        const hash = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return thumbHashToDataURL(hash);
    } catch {
        return null;
    }
}
