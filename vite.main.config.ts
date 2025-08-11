import { defineConfig } from "vite";
import path from "path";

// https://vitejs.dev/config
export default defineConfig({
    build: {
        rollupOptions: {
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
