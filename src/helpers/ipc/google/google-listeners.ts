import { app, ipcMain } from "electron";
import { Credentials } from "google-auth-library";
import fs from "fs";
import path from "path";
import { Worker } from "worker_threads";
import {
    GOOGLE_AUTH_URL_CHANNEL,
    GOOGLE_EXCHANGE_CODE_CHANNEL,
    GOOGLE_UPLOAD_FILE_CHANNEL,
    GOOGLE_DOWNLOAD_FILE_CHANNEL,
    GOOGLE_GET_PROFILE_CHANNEL,
    GOOGLE_GET_SAVED_TOKENS_CHANNEL,
    GOOGLE_SIGN_OUT_CHANNEL,
    GOOGLE_GET_VIDEO_FOLDER_FILES_CHANNEL,
    GOOGLE_SYNC_FILE_CHANNEL,
    GOOGLE_GET_STORAGE_CHANNEL,
} from "./google-channels";
import { OAuth2Client } from "google-auth-library";
import { drive_v3, people_v1 } from "googleapis";
import dotenv from "dotenv";
import { nodeAssetSrc } from "@/utils/assets";

dotenv.config();

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";
const GOOGLE_DRIVE_FOLDER_NAME = "Clip Editor Videos";
const TOKEN_PATH = path.join(
    app.getPath("userData"),
    ".clip-editor-google-tokens.json",
);

async function getOrCreateAppFolder(
    drive: drive_v3.Drive,
): Promise<string | null> {
    // Search for folder
    const res = await drive.files.list({
        q: `name='${GOOGLE_DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id, name)",
        spaces: "drive",
    });
    if (res.data.files && res.data.files.length > 0) {
        return res.data.files[0].id ?? null;
    }
    // Create folder if not found
    const folder = await drive.files.create({
        requestBody: {
            name: GOOGLE_DRIVE_FOLDER_NAME,
            mimeType: "application/vnd.google-apps.folder",
        },
        fields: "id",
    });
    return folder.data.id ?? null;
}

function saveTokens(tokens: Credentials) {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens), { encoding: "utf-8" });
}

// Load tokens from disk
function loadTokens(): Credentials | null {
    if (fs.existsSync(TOKEN_PATH)) {
        try {
            const raw = fs.readFileSync(TOKEN_PATH, "utf-8");
            return JSON.parse(raw);
        } catch {
            return null;
        }
    }
    return null;
}

export function addGoogleEventListeners() {
    ipcMain.handle(GOOGLE_AUTH_URL_CHANNEL, () => {
        const oAuth2Client = new OAuth2Client(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            GOOGLE_REDIRECT_URI,
        );
        return oAuth2Client.generateAuthUrl({
            access_type: "offline",
            scope: [
                "https://www.googleapis.com/auth/drive.file",
                "https://www.googleapis.com/auth/drive.metadata.readonly",
                "https://www.googleapis.com/auth/userinfo.profile",
                "https://www.googleapis.com/auth/userinfo.email",
                "openid",
            ],
            prompt: "consent",
        });
    });

    ipcMain.handle(GOOGLE_EXCHANGE_CODE_CHANNEL, async (_, code: string) => {
        const oAuth2Client = new OAuth2Client(
            GOOGLE_CLIENT_ID,
            GOOGLE_CLIENT_SECRET,
            GOOGLE_REDIRECT_URI,
        );
        const { tokens } = await oAuth2Client.getToken(code);
        saveTokens(tokens);
        return tokens;
    });

    ipcMain.handle(
        GOOGLE_UPLOAD_FILE_CHANNEL,
        async (_, filePath: string, tokens: Credentials) => {
            const oAuth2Client = new OAuth2Client(
                GOOGLE_CLIENT_ID,
                GOOGLE_CLIENT_SECRET,
                GOOGLE_REDIRECT_URI,
            );
            oAuth2Client.setCredentials(tokens);
            const drive = new drive_v3.Drive({ auth: oAuth2Client });

            // Ensure folder exists
            const folderId = await getOrCreateAppFolder(drive);

            const fileMetadata: drive_v3.Schema$File = {
                name: path.basename(filePath),
                ...(folderId ? { parents: [folderId] } : {}),
            };
            const media = {
                mimeType: "video/mp4",
                body: fs.createReadStream(filePath),
            };
            const response = await drive.files.create({
                requestBody: fileMetadata,
                media,
                fields: "id, webViewLink",
            });
            return {
                success: true,
                fileId: response.data.id,
                webViewLink: response.data.webViewLink,
            };
        },
    );

    ipcMain.handle(
        GOOGLE_DOWNLOAD_FILE_CHANNEL,
        async (_, fileId: string, savePath: string, tokens: Credentials) => {
            const oAuth2Client = new OAuth2Client(
                GOOGLE_CLIENT_ID,
                GOOGLE_CLIENT_SECRET,
                GOOGLE_REDIRECT_URI,
            );
            oAuth2Client.setCredentials(tokens);
            const drive = new drive_v3.Drive({ auth: oAuth2Client });
            const dest = fs.createWriteStream(savePath);
            const res = await drive.files.get(
                { fileId, alt: "media" },
                { responseType: "stream" },
            );
            await new Promise((resolve, reject) => {
                res.data.pipe(dest);
                res.data.on("end", resolve);
                res.data.on("error", reject);
            });
            return { success: true, savePath };
        },
    );

    ipcMain.handle(
        GOOGLE_GET_PROFILE_CHANNEL,
        async (_, tokens: Credentials) => {
            const oAuth2Client = new OAuth2Client(
                GOOGLE_CLIENT_ID,
                GOOGLE_CLIENT_SECRET,
                GOOGLE_REDIRECT_URI,
            );
            oAuth2Client.setCredentials(tokens);
            const people = new people_v1.People({ auth: oAuth2Client });
            const profile = await people.people.get({
                resourceName: "people/me",
                personFields: "names,emailAddresses,photos",
            });
            return {
                name: profile.data.names?.[0]?.displayName ?? "",
                email: profile.data.emailAddresses?.[0]?.value ?? "",
                photo: profile.data.photos?.[0]?.url ?? "",
            };
        },
    );

    ipcMain.handle(GOOGLE_GET_SAVED_TOKENS_CHANNEL, () => {
        return loadTokens();
    });

    ipcMain.handle(GOOGLE_SIGN_OUT_CHANNEL, () => {
        try {
            if (fs.existsSync(TOKEN_PATH)) {
                fs.unlinkSync(TOKEN_PATH);
            }
            return { success: true };
        } catch (err) {
            return {
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    });

    ipcMain.handle(
        GOOGLE_GET_VIDEO_FOLDER_FILES_CHANNEL,
        async (_, tokens: Credentials) => {
            const oAuth2Client = new OAuth2Client(
                GOOGLE_CLIENT_ID,
                GOOGLE_CLIENT_SECRET,
                GOOGLE_REDIRECT_URI,
            );
            oAuth2Client.setCredentials(tokens);
            const drive = new drive_v3.Drive({ auth: oAuth2Client });

            const folderId = await getOrCreateAppFolder(drive);
            if (!folderId) {
                return { success: false, error: "App folder not found." };
            }

            const res = await drive.files.list({
                q: `'${folderId}' in parents and trashed=false`,
                fields: "files(id, name, mimeType, webViewLink)",
                spaces: "drive",
            });

            return {
                success: true,
                files: res.data.files ?? [],
            };
        },
    );

    ipcMain.handle(
        GOOGLE_SYNC_FILE_CHANNEL,
        async (_, tokens: Credentials, localVideoDir: string) => {
            return new Promise((resolve, reject) => {
                const worker = new Worker(
                    path.join(
                        __dirname,
                        nodeAssetSrc("/assets/scripts/sync-worker.js"),
                    ),
                    {
                        workerData: {
                            tokens,
                            localVideoDir,
                            GOOGLE_CLIENT_ID,
                            GOOGLE_CLIENT_SECRET,
                        },
                    },
                );
                worker.on("message", resolve);
                worker.on("error", reject);
                worker.on("exit", (code: number) => {
                    if (code !== 0)
                        reject(
                            new Error(`Worker stopped with exit code ${code}`),
                        );
                });
            });
        },
    );

    ipcMain.handle(
        GOOGLE_GET_STORAGE_CHANNEL,
        async (_, tokens: Credentials) => {
            const oAuth2Client = new OAuth2Client(
                GOOGLE_CLIENT_ID,
                GOOGLE_CLIENT_SECRET,
                GOOGLE_REDIRECT_URI,
            );
            oAuth2Client.setCredentials(tokens);
            const drive = new drive_v3.Drive({ auth: oAuth2Client });
            const about = await drive.about.get({ fields: "storageQuota" });
            return about.data.storageQuota;
        },
    );
}
