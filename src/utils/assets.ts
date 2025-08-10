import { inDevelopment } from "@/config";

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

export function isVideoFile(fileExt: string): boolean {
    return [".mp4", ".webm", ".mov", ".avi", ".mkv"].includes(fileExt);
}

export function isImageFile(fileExt: string): boolean {
    return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(fileExt);
}
