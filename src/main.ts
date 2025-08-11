import { app, BrowserWindow, protocol, ipcMain } from "electron";
import registerListeners from "./helpers/ipc/listeners-register";
// "electron-squirrel-startup" seems broken when packaging with vite
//import started from "electron-squirrel-startup";
import path from "path";
import fs from "fs";
import {
    installExtension,
    REACT_DEVELOPER_TOOLS,
} from "electron-devtools-installer";
import { shell } from "electron";
import { APP_CONFIG } from "./config";
import { updateElectronApp } from "update-electron-app";
import dotenv from "dotenv";
import { isImageFile, isVideoFile, nodeAssetSrc } from "./utils/assets";
import { WorkerPool } from "./utils/worker-pool";

dotenv.config();

// eslint-disable-next-line @typescript-eslint/no-require-imports
if (require("electron-squirrel-startup")) app.quit();

updateElectronApp({
    repo: "sn0w12/clip-editor",
    updateInterval: "1 hour",
    notifyUser: true,
});

const inDevelopment = process.env.NODE_ENV === "development";

const imageProtocolName = APP_CONFIG.protocolName;
const videoProtocolName = "clip-video";

// Register both protocols with necessary privileges
protocol.registerSchemesAsPrivileged([
    { scheme: imageProtocolName, privileges: { bypassCSP: true } },
    {
        scheme: videoProtocolName,
        privileges: {
            bypassCSP: true,
            supportFetchAPI: true,
            corsEnabled: true,
        },
    },
]);

// Global reference to windows to avoid garbage collection
let mainWindow: BrowserWindow | null = null;
let loadingWindow: BrowserWindow | null = null;
let mainWindowReady = false;
let manuallyCompleted = false;

function createLoadingWindow() {
    // Skip creating loading window if it's disabled in config
    if (!APP_CONFIG.useLoadingWindow) return null;

    loadingWindow = new BrowserWindow({
        width: 400,
        height: 300,
        frame: false,
        transparent: false,
        resizable: false,
        show: false,
        backgroundColor: "#0a0a0a",
        webPreferences: {
            devTools: true,
        },
    });

    let splashPath;
    if (app.isPackaged) {
        splashPath = path.join(process.resourcesPath, "splash.html");
    } else {
        splashPath = path.join(process.cwd(), "splash.html");
    }

    loadingWindow.loadFile(splashPath, { query: { appName: APP_CONFIG.name } });

    loadingWindow.once("ready-to-show", () => {
        loadingWindow?.show();
    });

    return loadingWindow;
}

function createMainWindow() {
    const preload = path.join(__dirname, "preload.js");
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        minWidth: 400,
        minHeight: 300,
        show: false,
        backgroundColor: "#0a0a0a",
        webPreferences: {
            devTools: inDevelopment,
            contextIsolation: true,
            nodeIntegration: true,
            nodeIntegrationInSubFrames: false,
            preload: preload,
        },
        titleBarStyle: "hidden",
    });

    mainWindow.on("maximize", () => {
        mainWindow?.webContents.send("window-state-change", true);
    });

    mainWindow.on("unmaximize", () => {
        mainWindow?.webContents.send("window-state-change", false);
    });

    registerListeners(mainWindow);

    mainWindow.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url);
        return { action: "deny" };
    });

    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
        mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    } else {
        mainWindow.loadFile(
            path.join(
                __dirname,
                `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
            ),
        );
    }

    // Set up ready-to-show handler
    mainWindow.once("ready-to-show", () => {
        mainWindowReady = true;
        tryShowMainWindow();
    });

    return mainWindow;
}

// Check if conditions are met to show the main window
function tryShowMainWindow() {
    // Show main window if it's ready AND either:
    // 1. The app has received the manual "complete" signal, or
    // 2. We're using the automatic transition (no manual control requested)
    // 3. The loading window is disabled in config
    const shouldShow =
        mainWindowReady &&
        (manuallyCompleted ||
            !app.isPackaged ||
            inDevelopment ||
            !APP_CONFIG.useLoadingWindow);

    if (shouldShow && mainWindow) {
        // Give a slight delay to prevent flashing
        setTimeout(() => {
            mainWindow?.maximize();
            mainWindow?.show();
            if (loadingWindow) {
                loadingWindow?.close();
                loadingWindow = null;
            }
        }, 500);
    }
}

async function installExtensions() {
    try {
        const result = await installExtension(REACT_DEVELOPER_TOOLS);
        console.log(`Extensions installed successfully: ${result.name}`);
    } catch {
        console.error("Failed to install extensions");
    }
}

app.commandLine.appendSwitch("enable-experimental-web-platform-features");
app.whenReady().then(async () => {
    // Register IPC handler for loading completion
    ipcMain.on("app-loading-complete", () => {
        manuallyCompleted = true;
        tryShowMainWindow();
    });

    const fileWorkerPath = path.join(
        __dirname,
        nodeAssetSrc("/assets/scripts/media-worker.mjs"),
    );
    const fileWorkerPool = new WorkerPool(fileWorkerPath);
    protocol.handle(imageProtocolName, async (request) => {
        try {
            const url = new URL(request.url);
            const encodedPath = url.pathname.substring(1);
            const filePath = decodeURIComponent(encodedPath);

            if (!fs.existsSync(filePath)) {
                return new Response("File not found", {
                    status: 404,
                    headers: { "content-type": "text/plain" },
                });
            }

            const stats = fs.statSync(filePath);
            const fileExt = path.extname(filePath).toLowerCase();

            try {
                await fs.promises.access(filePath, fs.constants.R_OK);
            } catch {
                return new Response("File access denied", {
                    status: 403,
                    headers: { "content-type": "text/plain" },
                });
            }

            let type: "image" | "video" | "unsupported" = "unsupported";
            if (isVideoFile(fileExt)) type = "video";
            else if (isImageFile(fileExt)) type = "image";

            if (type === "unsupported") {
                return new Response("Unsupported file type", {
                    status: 400,
                    headers: { "content-type": "text/plain" },
                });
            }

            const result = (await fileWorkerPool.executeTask(type, {
                filePath,
                requestUrl: request.url,
                requestHeaders: (() => {
                    const headersObj: Record<string, string> = {};
                    request.headers.forEach((value, key) => {
                        headersObj[key] = value;
                    });
                    return headersObj;
                })(),
                stats,
            })) as {
                status: number;
                headers: Record<string, string>;
                body: Buffer;
            };

            return new Response(new Uint8Array(result.body), {
                status: result.status,
                headers: result.headers,
            });
        } catch {
            return new Response("File processing failed", {
                status: 500,
                headers: { "content-type": "text/plain" },
            });
        }
    });

    // NOTE: for videos to play, they must have crossOrigin="anonymous"
    protocol.handle(videoProtocolName, async (request) => {
        try {
            const url = new URL(request.url);
            const encodedPath = url.pathname.substring(1);
            const filePath = decodeURIComponent(encodedPath);

            if (!fs.existsSync(filePath)) {
                return new Response("Video file not found", {
                    status: 404,
                    headers: { "content-type": "text/plain" },
                });
            }

            const stats = fs.statSync(filePath);
            const fileExt = path.extname(filePath).toLowerCase();

            if (!isVideoFile(fileExt)) {
                return new Response("Not a video file", {
                    status: 400,
                    headers: { "content-type": "text/plain" },
                });
            }

            const result = (await fileWorkerPool.executeTask("video", {
                filePath,
                requestUrl: request.url,
                requestHeaders: (() => {
                    const headersObj: Record<string, string> = {};
                    request.headers.forEach((value, key) => {
                        headersObj[key] = value;
                    });
                    return headersObj;
                })(),
                stats,
            })) as
                | {
                      status: number;
                      headers: Record<string, string>;
                      range: { start: number; end: number } | null;
                  }
                | {
                      status: number;
                      headers: Record<string, string>;
                      body: Buffer | null;
                  };

            if ("range" in result && result.range) {
                const { start, end } = result.range;
                const stream = fs.createReadStream(filePath, { start, end });

                return new Response(stream as unknown as ReadableStream, {
                    status: result.status,
                    headers: result.headers,
                });
            } else if ("body" in result && result.body) {
                return new Response(new Uint8Array(result.body), {
                    status: result.status,
                    headers: result.headers,
                });
            } else {
                return new Response("Invalid video processing result", {
                    status: 500,
                    headers: { "content-type": "text/plain" },
                });
            }
        } catch {
            return new Response("Video processing failed", {
                status: 500,
                headers: { "content-type": "text/plain" },
            });
        }
    });

    // First show loading window (if enabled), then create main window
    if (APP_CONFIG.useLoadingWindow) {
        createLoadingWindow();
    }
    createMainWindow();

    installExtensions();

    // If loading window is disabled, show main window immediately when it's ready
    if (!APP_CONFIG.useLoadingWindow) {
        mainWindow?.once("ready-to-show", () => {
            mainWindow?.maximize();
            mainWindow?.show();
        });
    }

    // Register custom protocol
    if (!app.isDefaultProtocolClient("app-protocol")) {
        app.setAsDefaultProtocolClient("app-protocol");
    }
});

//osX only
app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createLoadingWindow();
        createMainWindow();
    }
});
//osX only ends
