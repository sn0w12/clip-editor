import { fileURLToPath } from "node:url";

import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

// react-scan must evaluate before React to hook the DevTools global, and
// prepending it here instead of in main.tsx keeps the import sorter from
// moving it below React. apply: "serve" keeps it out of production builds.
function reactScanDev(): Plugin {
    return {
        name: "seraphis:react-scan-dev",
        apply: "serve",
        transform(code, id) {
            const path = id.split("?")[0].replace(/\\/g, "/");
            if (!path.endsWith("/src/main.tsx")) return;
            return `import { scan } from "react-scan";\nscan({ enabled: true });\n${code}`;
        },
    };
}

export default defineConfig({
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
    plugins: [
        tailwindcss(),
        babel({ presets: [reactCompilerPreset()] }),
        viteReact(),
        reactScanDev(),
    ],
    server: {
        port: 3000,
        strictPort: true,
        watch: {
            ignored: ["**/target/**"],
        },
    },
});
