const inDevelopment = process.env.NODE_ENV === "development";

export function assetSrc(path: string) {
    if (inDevelopment) {
        return `/src${path}`;
    } else {
        return `../../../..${path}`;
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
