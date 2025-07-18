import { defineConfig } from "vite";
import path from "path";

// https://vitejs.dev/config
export default defineConfig({
    build: {
        rollupOptions: {
            external: [
                "ffmpeg-static",
                "update-electron-app",
                "electron-squirrel-startup",
            ],
        },
    },
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    define: {
        "process.env.GOOGLE_CLIENT_ID": JSON.stringify(
            process.env.GOOGLE_CLIENT_ID,
        ),
        "process.env.GOOGLE_CLIENT_SECRET": JSON.stringify(
            process.env.GOOGLE_CLIENT_SECRET,
        ),
    },
});
