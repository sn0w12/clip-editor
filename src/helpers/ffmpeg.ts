import ffmpeg from "fluent-ffmpeg";
import pathToFfmpeg from "ffmpeg-static";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobe = require("ffprobe-static");

function resolveUnpackedPath(originalPath: string): string {
    if (originalPath.includes("app.asar")) {
        return originalPath.replace("app.asar", "app.asar.unpacked");
    }
    return originalPath;
}

ffmpeg.setFfmpegPath(resolveUnpackedPath(pathToFfmpeg || ""));
ffmpeg.setFfprobePath(resolveUnpackedPath(ffprobe.path || ""));

export default ffmpeg;
