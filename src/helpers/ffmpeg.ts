import ffmpeg from "fluent-ffmpeg";
import pathToFfmpeg from "ffmpeg-static";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffprobe = require("ffprobe-static");

ffmpeg.setFfmpegPath(pathToFfmpeg || "");
ffmpeg.setFfprobePath(ffprobe.path || "");

export default ffmpeg;
