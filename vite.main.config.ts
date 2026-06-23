import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
    build: {
        rolldownOptions: {
            external: [
                "ffmpeg-static",
                "ffprobe-static",
                "update-electron-app",
                "electron-squirrel-startup",
                "sharp",
            ],
        },
        chunkSizeWarningLimit: 1600,
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
});
