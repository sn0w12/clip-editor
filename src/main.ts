import { app, BrowserWindow, nativeImage, protocol, ipcMain } from "electron";
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

// Define helper functions for protocol handling
function getMimeType(fileExt: string): string {
    // Video formats
    if (fileExt === ".mp4") return "video/mp4";
    else if (fileExt === ".webm") return "video/webm";
    else if (fileExt === ".mov") return "video/quicktime";
    else if (fileExt === ".avi") return "video/x-msvideo";
    else if (fileExt === ".mkv") return "video/x-matroska";
    // Image formats
    else if (fileExt === ".png") return "image/png";
    else if (fileExt === ".jpg" || fileExt === ".jpeg") return "image/jpeg";
    else if (fileExt === ".gif") return "image/gif";
    else if (fileExt === ".webp") return "image/webp";
    // Default
    return "application/octet-stream";
}

function isVideoFile(fileExt: string): boolean {
    return [".mp4", ".webm", ".mov", ".avi", ".mkv"].includes(fileExt);
}

function isImageFile(fileExt: string): boolean {
    return [".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(fileExt);
}

async function handleVideoRequest(
    filePath: string,
    request: Request,
    stats: fs.Stats,
): Promise<Response> {
    const fileExt = path.extname(filePath).toLowerCase();
    const contentType = getMimeType(fileExt);

    try {
        // Verify the file can be accessed
        await fs.promises.access(filePath, fs.constants.R_OK);

        // Handle range requests for video streaming
        const rangeHeader = request.headers.get("Range");

        if (rangeHeader) {
            try {
                // Parse the range header
                const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);

                if (match) {
                    const start = parseInt(match[1], 10);
                    const end = match[2]
                        ? parseInt(match[2], 10)
                        : stats.size - 1;
                    const chunkSize = end - start + 1;

                    // Check if range is valid
                    if (start >= stats.size || end >= stats.size) {
                        console.error(
                            `Invalid range request: start=${start}, end=${end}, size=${stats.size}`,
                        );
                        return new Response("Invalid range", {
                            status: 416,
                            headers: {
                                "Content-Range": `bytes */${stats.size}`,
                                "Accept-Ranges": "bytes",
                                "Content-Type": "text/plain",
                            },
                        });
                    }

                    // Use file stream instead of synchronous operations
                    const stream = fs.createReadStream(filePath, {
                        start,
                        end,
                    });

                    return new Response(stream as unknown as ReadableStream, {
                        status: 206,
                        headers: {
                            "Content-Type": contentType,
                            "Content-Length": String(chunkSize),
                            "Content-Range": `bytes ${start}-${end}/${stats.size}`,
                            "Accept-Ranges": "bytes",
                            "Cache-Control": "no-cache",
                        },
                    });
                }
            } catch (error) {
                console.error("Error processing video range request:", error);
                // Continue to serve the whole file if range request fails
            }
        }

        // Send initial part of the file
        const initialChunkSize = Math.min(1024 * 1024, stats.size); // 1MB or file size
        const stream = fs.createReadStream(filePath, {
            start: 0,
            end: initialChunkSize - 1,
        });

        return new Response(stream as unknown as ReadableStream, {
            status: 206,
            headers: {
                "Content-Type": contentType,
                "Accept-Ranges": "bytes",
                "Content-Length": String(initialChunkSize),
                "Content-Range": `bytes 0-${initialChunkSize - 1}/${stats.size}`,
                "Cache-Control": "no-cache",
            },
        });
    } catch (error) {
        console.error(`Error accessing video stream: ${error}`);
        throw error;
    }
}

async function handleImageRequest(
    filePath: string,
    url: URL,
    stats: fs.Stats,
): Promise<Response> {
    const fileExt = path.extname(filePath).toLowerCase();
    const contentType = getMimeType(fileExt);
    const fullImage = url.searchParams.get("full") === "true";

    if (fullImage) {
        // Return the full image
        const stream = fs.createReadStream(filePath);
        return new Response(stream as unknown as ReadableStream, {
            headers: {
                "Content-Type": contentType,
                "Content-Length": String(stats.size),
                "Cache-Control": "max-age=3600",
            },
        });
    } else {
        // Generate a thumbnail
        let width = parseInt(url.searchParams.get("w") || "0", 10);
        let height = parseInt(url.searchParams.get("h") || "0", 10);
        const size = parseInt(url.searchParams.get("s") || "200", 10);

        if (width === 0 && height === 0) {
            width = size;
            height = size;
        } else if (width === 0) {
            width = Math.round((height / size) * size);
        } else if (height === 0) {
            height = Math.round((width / size) * size);
        }

        const image = await nativeImage.createThumbnailFromPath(filePath, {
            width,
            height,
        });

        return new Response(image.toJPEG(70), {
            headers: {
                "Content-Type": "image/jpeg",
                "Cache-Control": "max-age=3600",
            },
        });
    }
}

app.commandLine.appendSwitch("enable-experimental-web-platform-features");
app.whenReady().then(async () => {
    // Register IPC handler for loading completion
    ipcMain.on("app-loading-complete", () => {
        manuallyCompleted = true;
        tryShowMainWindow();
    });

    // Handle the existing protocol (primarily for images)
    protocol.handle(imageProtocolName, async (request) => {
        try {
            const url = new URL(request.url);
            const encodedPath = url.pathname.substring(1); // Remove leading slash
            const filePath = decodeURIComponent(encodedPath); // Decode URL-encoded characters

            // Verify file exists before reading
            if (!fs.existsSync(filePath)) {
                console.error(`File not found: ${filePath}`);
                return new Response("File not found", {
                    status: 404,
                    headers: { "content-type": "text/plain" },
                });
            }

            const stats = fs.statSync(filePath);
            const fileExt = path.extname(filePath).toLowerCase();

            // Special handling to ensure the file is actually accessible
            try {
                // Test file access before attempting to serve it
                await fs.promises.access(filePath, fs.constants.R_OK);
            } catch (accessError) {
                console.error(`File access error: ${accessError}`);
                return new Response("File access denied", {
                    status: 403,
                    headers: { "content-type": "text/plain" },
                });
            }

            if (isVideoFile(fileExt)) {
                return await handleVideoRequest(filePath, request, stats);
            } else if (isImageFile(fileExt)) {
                return await handleImageRequest(filePath, url, stats);
            } else {
                return new Response("Unsupported file type", {
                    status: 400,
                    headers: { "content-type": "text/plain" },
                });
            }
        } catch (error) {
            const errorPath =
                error && typeof error === "object" && "path" in error
                    ? error.path
                    : "unknown path";
            console.error("Failed to process file:", error, {
                path: errorPath,
            });
            return new Response("File processing failed", {
                status: 500,
                headers: { "content-type": "text/plain" },
            });
        }
    });

    // Register a dedicated video protocol handler optimized for video streaming
    protocol.handle(videoProtocolName, async (request) => {
        try {
            const url = new URL(request.url);
            const encodedPath = url.pathname.substring(1);
            const filePath = decodeURIComponent(encodedPath);

            // Use async stat and access
            try {
                await fs.promises.access(filePath, fs.constants.R_OK);
            } catch {
                return new Response("Video file not found", { status: 404 });
            }

            const stats = await fs.promises.stat(filePath);
            const fileExt = path.extname(filePath).toLowerCase();

            if (!isVideoFile(fileExt)) {
                return new Response("Not a video file", { status: 400 });
            }

            // Use a smaller initial chunk for preview
            return await handleVideoRequest(filePath, request, stats);
        } catch {
            return new Response("Video processing failed", { status: 500 });
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
