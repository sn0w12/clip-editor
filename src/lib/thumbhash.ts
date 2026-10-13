import { thumbHashToDataURL } from "thumbhash";

/** Decode a base64 ThumbHash into a data URL, or null when unusable. */
export function thumbHashBase64ToDataURL(
    b64: string | null | undefined
): string | null {
    if (!b64) return null;
    try {
        const hash = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return thumbHashToDataURL(hash);
    } catch {
        return null;
    }
}

export const thumbhashDataUrl = thumbHashBase64ToDataURL;
