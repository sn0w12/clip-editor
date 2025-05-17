import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

import { spawn } from "node:child_process";
import * as fs from "fs";
import * as path from "path";

const config: ForgeConfig = {
    packagerConfig: {
        asar: false,
        icon: "./src/assets/icons/icon",
        extraResource: ["splash.html", "src/assets/fonts"],
    },
    hooks: {
        packageAfterPrune: async (config, build_path) => {
            const vite_config = await import("./vite.main.config.ts");
            const external =
                vite_config?.default?.build?.rollupOptions?.external || [];

            // Filter and convert external dependencies to strings only
            const stringDependencies = (
                Array.isArray(external) ? external : [external]
            )
                .filter(Boolean)
                .filter((dep): dep is string => typeof dep === "string")
                .filter((dep) => !dep.startsWith("@types/"));

            // If no dependencies to install, exit early
            if (stringDependencies.length === 0) {
                return;
            }

            // Create a temp directory and install the dependencies there to avoid issues.
            const tempDir = path.join(build_path, "temp_node_modules");
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }

            const commands = [
                "install",
                "--prefix",
                tempDir,
                "--no-package-lock",
                "--no-save",
                ...stringDependencies,
            ];

            await new Promise((resolve, reject) => {
                const npm = spawn("npm", commands, {
                    stdio: "inherit",
                    shell: true,
                });

                npm.on("close", (code) => {
                    if (code === 0) {
                        resolve(null);
                    } else {
                        reject(`Process exited with code: ${code}`);
                    }
                });

                npm.on("error", reject);
            });

            // Move installed modules to the actual node_modules directory
            const targetNodeModules = path.join(build_path, "node_modules");
            const tempNodeModules = path.join(tempDir, "node_modules");

            if (fs.existsSync(tempNodeModules)) {
                if (!fs.existsSync(targetNodeModules)) {
                    fs.mkdirSync(targetNodeModules, { recursive: true });
                }

                // Move each module individually
                for (const module of fs.readdirSync(tempNodeModules)) {
                    const source = path.join(tempNodeModules, module);
                    const target = path.join(targetNodeModules, module);

                    // Skip if module is already in target
                    if (fs.existsSync(target)) {
                        continue;
                    }

                    // Move the module
                    fs.renameSync(source, target);
                }

                // Clean up temp directory
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        },
    },
    rebuildConfig: {},
    makers: [
        new MakerSquirrel({}),
        new MakerZIP({}, ["darwin"]),
        new MakerRpm({}),
        new MakerDeb({}),
    ],
    plugins: [
        new VitePlugin({
            // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
            // If you are familiar with Vite configuration, it will look really familiar.
            build: [
                {
                    // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
                    entry: "src/main.ts",
                    config: "vite.main.config.ts",
                    target: "main",
                },
                {
                    entry: "src/preload.ts",
                    config: "vite.preload.config.ts",
                    target: "preload",
                },
            ],
            renderer: [
                {
                    name: "main_window",
                    config: "vite.renderer.config.mts",
                },
            ],
        }),
        // Fuses are used to enable/disable various Electron functionality
        // at package time, before code signing the application
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
        }),
    ],
};

export default config;
