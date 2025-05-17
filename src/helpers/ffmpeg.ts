import ffmpeg from "fluent-ffmpeg";
import pathToFfmpeg from "ffmpeg-static";
ffmpeg.setFfmpegPath(pathToFfmpeg || "");

export default ffmpeg;
