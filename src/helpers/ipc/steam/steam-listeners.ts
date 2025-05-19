import { ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { createPerformanceLogger } from "@/helpers/performance";

const readFile = promisify(fs.readFile);
const readdir = promisify(fs.readdir);
const stat = promisify(fs.stat);

export interface GameImage {
    header?: string;
    library_600x900?: string;
    library_hero?: string;
    library_hero_blur?: string;
    logo?: string;
    icon?: string; // The random filename is the icon
}

/**
 * Parses the Steam libraryfolders.vdf file to extract library paths
 * @param steamDir The path to the Steam installation directory
 * @returns An array of Steam library folder paths
 */
async function getSteamLibraryFolders(steamDir: string): Promise<string[]> {
    try {
        const libraryFoldersPath = path.join(
            steamDir,
            "steamapps",
            "libraryfolders.vdf",
        );

        const data = await readFile(libraryFoldersPath, "utf8");
        const libraryPaths: string[] = [];

        // Extract library paths using regex
        // Look for "path" followed by a path string in quotes
        const pathRegex = /"path"\s*"([^"]*)"/g;
        let match;

        while ((match = pathRegex.exec(data)) !== null) {
            // match[1] contains the path
            libraryPaths.push(match[1].replace(/\\\\/g, "\\"));
        }

        return libraryPaths;
    } catch (error) {
        console.error("Error reading Steam library folders:", error);
        return [];
    }
}

/**
 * Reads and parses a Steam app manifest file
 * @param filePath Path to the manifest file
 * @returns Object containing appid and name, or null if parsing failed
 */
async function parseAppManifest(
    filePath: string,
): Promise<{ appid: string; name: string } | null> {
    try {
        const data = await readFile(filePath, "utf8");

        // Extract appid
        const appidMatch = /"appid"\s*"([^"]*)"/.exec(data);
        if (!appidMatch) return null;
        const appid = appidMatch[1];

        // Extract name
        const nameMatch = /"name"\s*"([^"]*)"/.exec(data);
        if (!nameMatch) return null;
        const name = nameMatch[1];

        return { appid, name };
    } catch (error) {
        console.error(`Error parsing manifest file ${filePath}:`, error);
        return null;
    }
}

/**
 * Gets all Steam games from all library folders
 * @param steamDir The path to the Steam installation directory
 * @returns Dictionary with game names (lowercase, no special chars) as keys and appids as values
 */
async function getAllSteamGames(
    steamDir: string,
): Promise<Record<string, { appid: string; displayName: string }>> {
    const games: Record<string, { appid: string; displayName: string }> = {};
    const libraryPaths = await getSteamLibraryFolders(steamDir);

    for (const libraryPath of libraryPaths) {
        const steamappsPath = path.join(libraryPath, "steamapps");

        try {
            const files = await readdir(steamappsPath);

            // Process each appmanifest file
            for (const file of files) {
                if (file.startsWith("appmanifest_") && file.endsWith(".acf")) {
                    const manifestPath = path.join(steamappsPath, file);
                    const gameInfo = await parseAppManifest(manifestPath);

                    if (gameInfo) {
                        // Create normalized key from name: lowercase with no special characters
                        const normalizedName = gameInfo.name
                            .toLowerCase()
                            .replace(/[^a-z0-9]/g, "");

                        const displayName = gameInfo.name.replace(
                            /[\\/:*?"<>|]/g,
                            "",
                        );

                        games[normalizedName] = {
                            appid: gameInfo.appid,
                            displayName,
                        };
                    }
                }
            }
        } catch (error) {
            console.error(
                `Error reading steamapps directory ${steamappsPath}:`,
                error,
            );
        }
    }

    return games;
}

/**
 * Gets all image assets for all Steam games
 * @param steamDir The path to the Steam installation directory
 * @returns Dictionary with appids as keys and image paths as values
 */
async function getAllSteamGameImages(
    steamDir: string,
): Promise<Record<string, GameImage>> {
    try {
        // Steam library cache directory
        const libraryCachePath = path.join(
            steamDir,
            "appcache",
            "librarycache",
        );

        // Get all entries in the directory
        const entries = await readdir(libraryCachePath, {
            withFileTypes: true,
        });
        const gameImages: Record<string, GameImage> = {};

        // Process files directly in librarycache
        const filesInRoot = entries.filter((entry) => !entry.isDirectory());
        for (const file of filesInRoot) {
            const fileName = file.name;
            const filePath = path.join(libraryCachePath, fileName);

            // Parse the filename to extract appId and image type
            const match = fileName.match(/^(\d+)_(.+)\.([a-zA-Z]+)$/);
            if (!match) continue;

            const [, appId, imageType] = match;

            // Initialize the game entry if it doesn't exist
            if (!gameImages[appId]) {
                gameImages[appId] = {};
            }

            categorizeImage(gameImages[appId], imageType, filePath);
        }

        // Process app ID folders
        const directories = entries.filter((entry) => entry.isDirectory());
        for (const dir of directories) {
            const appId = dir.name;
            // Skip if not a numeric app ID folder
            if (!/^\d+$/.test(appId)) continue;

            const appDirPath = path.join(libraryCachePath, appId);

            // Initialize the game entry if it doesn't exist
            if (!gameImages[appId]) {
                gameImages[appId] = {};
            }

            // Recursively get all files in this app's directory
            await processAppDirectory(appDirPath, appId, gameImages[appId]);
        }

        return gameImages;
    } catch (error) {
        console.error("Error getting Steam game images:", error);
        return {};
    }
}

/**
 * Processes a directory recursively to find all image files
 * @param dirPath The directory path to process
 * @param appId The app ID
 * @param gameImage The game image object to populate
 */
async function processAppDirectory(
    dirPath: string,
    appId: string,
    gameImage: GameImage,
): Promise<void> {
    try {
        const entries = await readdir(dirPath, { withFileTypes: true });

        // Process all files in this directory
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                // Recursively process subdirectories
                await processAppDirectory(fullPath, appId, gameImage);
            } else {
                // Process this file
                const fileName = entry.name;

                // Extract image type from filename
                let imageType: string;
                // If filename matches appId_type.ext pattern
                const match = fileName.match(/^(\d+)_(.+)\.([a-zA-Z]+)$/);
                if (match) {
                    imageType = match[2];
                } else {
                    // If just a file, extract type from filename before extension
                    imageType = path.basename(fileName, path.extname(fileName));
                }

                categorizeImage(gameImage, imageType, fullPath);
            }
        }
    } catch (error) {
        console.error(`Error processing directory ${dirPath}:`, error);
    }
}

/**
 * Categorizes an image file into the appropriate type in the GameImage object
 */
function categorizeImage(
    gameImage: GameImage,
    imageType: string,
    filePath: string,
): void {
    const knownTypes = [
        "header",
        "library_600x900",
        "library_hero",
        "library_hero_blur",
        "logo",
    ];

    if (knownTypes.includes(imageType)) {
        // It's one of the known image types
        gameImage[imageType as keyof GameImage] = filePath;
    } else {
        // If it's not one of the known types, it's probably the icon
        gameImage.icon = filePath;
    }
}

/**
 * Gets image assets for a specific Steam game
 * @param steamDir The path to the Steam installation directory
 * @param appId The Steam app ID
 * @returns Object containing paths to the game's images
 */
async function getSteamGameImages(
    steamDir: string,
    appId: string,
): Promise<GameImage | null> {
    try {
        const libraryCachePath = path.join(
            steamDir,
            "appcache",
            "librarycache",
        );
        const gameImages: GameImage = {};

        // Check for files in the root directory that match the app ID
        const rootFiles = await readdir(libraryCachePath);
        for (const file of rootFiles) {
            if (file.startsWith(`${appId}_`)) {
                const filePath = path.join(libraryCachePath, file);
                const imageType = file.substring(
                    appId.length + 1,
                    file.lastIndexOf("."),
                );
                categorizeImage(gameImages, imageType, filePath);
            }
        }

        // Check if there's a dedicated folder for this app ID
        const appDirPath = path.join(libraryCachePath, appId);
        try {
            const dirStat = await stat(appDirPath);

            if (dirStat.isDirectory()) {
                const appFiles = await readdir(appDirPath);

                for (const file of appFiles) {
                    const filePath = path.join(appDirPath, file);

                    // Extract image type
                    let imageType: string;
                    const match = file.match(/^(\d+)_(.+)\.([a-zA-Z]+)$/);
                    if (match) {
                        imageType = match[2];
                    } else {
                        imageType = path.basename(file, path.extname(file));
                    }

                    categorizeImage(gameImages, imageType, filePath);
                }
            }
        } catch {
            // App directory doesn't exist, just continue
        }

        return Object.keys(gameImages).length > 0 ? gameImages : null;
    } catch (error) {
        console.error(`Error getting images for app ID ${appId}:`, error);
        return null;
    }
}

export function addSteamEventListeners() {
    ipcMain.handle("steam:get-library-paths", async (_, steamDir: string) => {
        const perfLog = createPerformanceLogger("steam:get-library-paths", {
            steamDir,
        });

        try {
            perfLog.addStep("getSteamLibraryFolders");
            const libraryPaths = await getSteamLibraryFolders(steamDir);

            perfLog.end({
                foundPaths: libraryPaths.length,
            });

            return libraryPaths;
        } catch (error) {
            perfLog.end({
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            });

            return [];
        }
    });

    ipcMain.handle("steam:get-all-games", async (_, steamDir: string) => {
        const perfLog = createPerformanceLogger("steam:get-all-games", {
            steamDir,
        });

        try {
            perfLog.addStep("getAllSteamGames");
            const games = await getAllSteamGames(steamDir);

            perfLog.end({
                gamesFound: Object.keys(games).length,
            });

            return games;
        } catch (error) {
            perfLog.end({
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            });

            return {};
        }
    });

    ipcMain.handle("steam:get-all-game-images", async (_, steamDir: string) => {
        const perfLog = createPerformanceLogger("steam:get-all-game-images", {
            steamDir,
        });

        try {
            perfLog.addStep("getAllSteamGameImages");
            const gameImages = await getAllSteamGameImages(steamDir);

            perfLog.end({
                gamesWithImages: Object.keys(gameImages).length,
            });

            return gameImages;
        } catch (error) {
            perfLog.end({
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
            });

            return {};
        }
    });

    ipcMain.handle(
        "steam:get-game-images",
        async (_, steamDir: string, appId: string) => {
            const perfLog = createPerformanceLogger("steam:get-game-images", {
                steamDir,
                appId,
            });

            try {
                perfLog.addStep("getSteamGameImages");
                const images = await getSteamGameImages(steamDir, appId);

                perfLog.end({
                    success: !!images,
                    imageTypes: images ? Object.keys(images).length : 0,
                });

                return images;
            } catch (error) {
                perfLog.end({
                    success: false,
                    error:
                        error instanceof Error
                            ? error.message
                            : "Unknown error",
                });

                return null;
            }
        },
    );
}

export default addSteamEventListeners;
