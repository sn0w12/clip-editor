export function normalizeGameName(name: string) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function imgSrc(src: string | null | undefined) {
    if (!src) {
        return "";
    }

    const ext = src.split(".").pop();
    if (!ext) {
        console.error("Invalid image path, no file extension:", src);
        return src;
    }

    if (src.includes("?")) {
        return `clip-editor:///${src}`;
    }

    return `clip-editor:///${src}?full=true`;
}
