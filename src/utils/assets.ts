import { APP_CONFIG, inDevelopment } from "@/config";

export function assetSrc(path: string) {
    let normalizedPath = path.startsWith("/") ? path : `/${path}`;
    normalizedPath = normalizedPath.replace(/\/{2,}/g, "/");

    if (inDevelopment) {
        return `/src${normalizedPath}`;
    } else {
        return `../../../..${normalizedPath}`;
    }
}

export function nodeAssetSrc(path: string) {
    let normalizedPath = path.startsWith("/") ? path : `/${path}`;
    normalizedPath = normalizedPath.replace(/\/{2,}/g, "/");

    if (inDevelopment) {
        return `../../src${normalizedPath}`;
    } else {
        return `../../../../resources${normalizedPath}`;
    }
}

export type ImageParams = {
    width?: number;
    height?: number;
    quality?: number;
};

/**
 * Converts an absolute file path to an Electron protocol URL for display.
 * Automatically detects image/video protocol.
 * Supports optional query parameters (e.g. width, height).
 *
 * @param filePath Absolute path to the file
 * @param params Optional query parameters (e.g. { w: 300, h: 200 })
 * @returns Electron protocol URL
 */
export function toElectronProtocolUrl(
    filePath: string,
    params?: ImageParams,
): string {
    const ext = filePath
        ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase()
        : "";
    let protocol = APP_CONFIG.protocolName;
    if (isImageFile(ext)) {
        protocol += "-image";
    } else if (isVideoFile(ext)) {
        protocol += "-video";
    }

    let query = "";
    if (params && Object.keys(params).length > 0) {
        const searchParams = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            searchParams.append(key, String(value));
        }
        query = `?${searchParams.toString()}`;
    }

    return `${protocol}:///${filePath}${query}`;
}

export function isVideoFile(fileExt: string): boolean {
    return [".mp4", ".webm", ".mov", ".avi", ".mkv"].includes(fileExt);
}

export function isImageFile(fileExt: string): boolean {
    return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(fileExt);
}
