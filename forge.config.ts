import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

import * as fs from "fs";
import * as path from "path";

const config: ForgeConfig = {
    packagerConfig: {
        asar: {
            unpack: "**/{ffprobe-static,ffmpeg-static,sharp,detect-libc,color,semver,color-string,color-name,simple-swizzle,is-arrayish,color-convert,node-addon-api}/**",
        },
        ignore: [
            /node_modules\/(?!(ms|github-url-to-object|is-url|debug|ffmpeg-static|ffprobe-static|update-electron-app|electron-squirrel-startup|sharp|detect-libc|color|semver|color-string|color-name|simple-swizzle|is-arrayish|color-convert|node-addon-api)\/)/,
        ],
        icon: "./src/assets/icons/icon",
        extraResource: ["splash.html", "src/assets"],
        executableName: "clip-editor",
        win32metadata: {
            CompanyName: "Sn0w12",
            OriginalFilename: "clip-editor.exe",
            ProductName: "Clip Editor",
            InternalName: "ClipEditor",
        },
    },
    hooks: {
        postPackage: async (config, options) => {
            const ffprobeBinDir = path.join(
                options.outputPaths[0],
                "resources",
                "app.asar.unpacked",
                "node_modules",
                "ffprobe-static",
                "bin",
            );

            const platformMap: Record<string, string> = {
                win32: "win32",
                linux: "linux",
                darwin: "darwin",
            };
            const archMap: Record<string, string> = {
                x64: "x64",
                ia32: "ia32",
                arm64: "arm64",
            };

            const currentPlatform = platformMap[process.platform];
            const currentArch = archMap[process.arch];

            const binaryName =
                currentPlatform === "win32" ? "ffprobe.exe" : "ffprobe";
            const keep = [path.join(currentPlatform, currentArch, binaryName)];

            if (fs.existsSync(ffprobeBinDir)) {
                for (const platform of fs.readdirSync(ffprobeBinDir)) {
                    const platformDir = path.join(ffprobeBinDir, platform);
                    if (!fs.statSync(platformDir).isDirectory()) continue;

                    for (const arch of fs.readdirSync(platformDir)) {
                        const archDir = path.join(platformDir, arch);
                        if (!fs.statSync(archDir).isDirectory()) continue;

                        for (const file of fs.readdirSync(archDir)) {
                            const relPath = path.join(platform, arch, file);
                            if (!keep.includes(relPath)) {
                                fs.rmSync(path.join(ffprobeBinDir, relPath), {
                                    force: true,
                                });
                            }
                        }

                        if (fs.readdirSync(archDir).length === 0) {
                            fs.rmdirSync(archDir);
                        }
                    }

                    if (fs.readdirSync(platformDir).length === 0) {
                        fs.rmdirSync(platformDir);
                    }
                }
            }
        },
    },
    rebuildConfig: {},
    makers: [
        new MakerSquirrel({
            iconUrl:
                "https://raw.githubusercontent.com/sn0w12/clip-editor/main/src/assets/icons/icon.ico",
            setupIcon: "./src/assets/icons/icon.ico",
            setupExe: "ClipEditorSetup.exe",
        }),
        new MakerZIP({}, ["darwin"]),
        new MakerRpm({}),
        new MakerDeb({}),
    ],
    publishers: [
        {
            name: "@electron-forge/publisher-github",
            config: {
                repository: {
                    owner: "sn0w12",
                    name: "clip-editor",
                },
                prerelease: false,
                draft: true,
                releaseNotes: process.env.RELEASE_NOTES,
            },
        },
    ],
    plugins: [
        new AutoUnpackNativesPlugin({}),
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
