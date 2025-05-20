const inDevelopment = process.env.NODE_ENV === "development";

export function assetSrc(path: string) {
    if (inDevelopment) {
        return `/src${path}`;
    } else {
        return `../../../..${path}`;
    }
}
