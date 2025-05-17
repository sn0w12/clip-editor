import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "./src"),
        },
    },
    build: {
        outDir: "dist/server",
        emptyOutDir: true,
        ssr: true,
        target: "node16",
        sourcemap: true,
        rollupOptions: {
            input: {
                index: path.resolve(__dirname, "src/server/index.ts"),
            },
            output: {
                entryFileNames: "[name].js",
                format: "cjs",
            },
            external: [
                "express",
                "compression",
                "path",
                "fs",
                "path-to-regexp",
                /node:.*/,
            ],
        },
    },
    define: {
        "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
        "process.env.PLATFORM": JSON.stringify("web"),
    },
});
