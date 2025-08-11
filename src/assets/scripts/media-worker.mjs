import { parentPort } from "worker_threads";
import path from "path";
import fs from "fs";
import { Buffer } from "buffer";

const processRef =
    typeof globalThis.process !== "undefined" ? globalThis.process : undefined;

let sharp;
try {
    sharp = (await import("sharp")).default;
} catch {
    try {
        const sharpMain = path.join(
            processRef.resourcesPath,
            "app.asar.unpacked",
            "node_modules",
            "sharp",
            "lib",
            "index.js",
        );
        sharp = (await import(`file://${sharpMain}`)).default;
    } catch (e2) {
        console.error("Error loading sharp from unpacked path:", e2);
    }
}

function getMimeType(fileExt) {
    if (fileExt === ".mp4") return "video/mp4";
    else if (fileExt === ".webm") return "video/webm";
    else if (fileExt === ".mov") return "video/quicktime";
    else if (fileExt === ".avi") return "video/x-msvideo";
    else if (fileExt === ".mkv") return "video/x-matroska";
    else if (fileExt === ".png") return "image/png";
    else if (fileExt === ".jpg" || fileExt === ".jpeg") return "image/jpeg";
    else if (fileExt === ".gif") return "image/gif";
    else if (fileExt === ".webp") return "image/webp";
    return "application/octet-stream";
}

async function handleVideoRequest(filePath, requestHeaders, stats) {
    const fileExt = path.extname(filePath).toLowerCase();
    const contentType = getMimeType(fileExt);

    try {
        await fs.promises.access(filePath, fs.constants.R_OK);
        const rangeHeader = requestHeaders["Range"] || requestHeaders["range"];
        if (rangeHeader) {
            const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (match) {
                const start = parseInt(match[1], 10);
                const end = match[2] ? parseInt(match[2], 10) : stats.size - 1;
                const chunkSize = end - start + 1;
                if (start >= stats.size || end >= stats.size) {
                    return {
                        status: 416,
                        headers: {
                            "Content-Range": `bytes */${stats.size}`,
                            "Accept-Ranges": "bytes",
                            "Content-Type": "text/plain",
                        },
                        body: Buffer.from("Invalid range"),
                    };
                }
                return {
                    status: 206,
                    headers: {
                        "Content-Type": contentType,
                        "Content-Length": String(chunkSize),
                        "Content-Range": `bytes ${start}-${end}/${stats.size}`,
                        "Accept-Ranges": "bytes",
                        "Cache-Control": "no-cache",
                    },
                    range: { start, end },
                };
            }
        }

        const initialChunkSize = Math.min(1024 * 1024, stats.size);
        return {
            status: 200,
            headers: {
                "Content-Type": contentType,
                "Accept-Ranges": "bytes",
                "Content-Length": String(initialChunkSize),
                "Content-Range": `bytes 0-${initialChunkSize - 1}/${stats.size}`,
                "Cache-Control": "no-cache",
            },
            range: { start: 0, end: initialChunkSize - 1 },
        };
    } catch {
        return {
            status: 500,
            headers: { "content-type": "text/plain" },
            body: Buffer.from("Error accessing video stream"),
        };
    }
}

async function handleImageRequest(filePath, requestUrl) {
    const url = new URL(requestUrl);
    const fileExt = path.extname(filePath).toLowerCase();
    const contentType = getMimeType(fileExt);

    let width = parseInt(url.searchParams.get("width") || "0", 10);
    let height = parseInt(url.searchParams.get("height") || "0", 10);
    let quality = parseInt(url.searchParams.get("quality") || "80", 10);

    if (width <= 0 && height <= 0) {
        const buffer = await sharp(filePath).webp({ quality }).toBuffer();
        return {
            status: 200,
            headers: {
                "Content-Type": contentType,
                "Content-Length": String(buffer.length),
                "Cache-Control": "max-age=3600",
            },
            body: buffer,
        };
    } else {
        if (width > 0 && height === 0) {
            const metadata = await sharp(filePath).metadata();
            if (metadata.width && metadata.height) {
                height = Math.round(width * (metadata.height / metadata.width));
            }
        } else if (height > 0 && width === 0) {
            const metadata = await sharp(filePath).metadata();
            if (metadata.width && metadata.height) {
                width = Math.round(height * (metadata.width / metadata.height));
            }
        }

        const buffer = await sharp(filePath)
            .resize(width, height)
            .webp({ quality })
            .toBuffer();

        return {
            status: 200,
            headers: {
                "Content-Type": "image/webp",
                "Cache-Control": "max-age=3600",
            },
            body: buffer,
        };
    }
}

parentPort.on("message", async (message) => {
    const { type, data, id } = message;
    try {
        let result;
        if (type === "video") {
            const { filePath, requestHeaders, stats } = data;
            result = await handleVideoRequest(filePath, requestHeaders, stats);
        } else if (type === "image") {
            const { filePath, requestUrl } = data;
            result = await handleImageRequest(filePath, requestUrl);
        } else {
            throw new Error("Unknown type: " + type);
        }
        parentPort.postMessage({
            type: "result",
            id,
            success: true,
            data: result,
        });
    } catch (error) {
        parentPort.postMessage({
            type: "result",
            id,
            success: false,
            error: error?.message || String(error),
        });
    }
});
