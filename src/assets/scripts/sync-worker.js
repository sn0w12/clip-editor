import { parentPort, workerData } from "worker_threads";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

const GOOGLE_DRIVE_FOLDER_NAME = "Clip Editor Videos";
const GOOGLE_REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob";

function log(...args) {
    console.log("[SyncWorker]", ...args);
}

function getFileHash(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(fileBuffer).digest("hex");
}

async function getOrCreateAppFolder(drive) {
    log("Checking for app folder in Google Drive...");
    const res = await drive.files.list({
        q: `name='${GOOGLE_DRIVE_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id, name)",
        spaces: "drive",
    });
    if (res.data.files && res.data.files.length > 0) {
        log("App folder found:", res.data.files[0].name);
        return res.data.files[0].id ?? null;
    }
    log("App folder not found, creating...");
    const folder = await drive.files.create({
        requestBody: {
            name: GOOGLE_DRIVE_FOLDER_NAME,
            mimeType: "application/vnd.google-apps.folder",
        },
        fields: "id",
    });
    log("App folder created:", folder.data.id);
    return folder.data.id ?? null;
}

async function syncVideos(tokens, localVideoDir) {
    log("Starting syncVideos...");
    const oAuth2Client = new OAuth2Client(
        workerData.GOOGLE_CLIENT_ID,
        workerData.GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI,
    );
    oAuth2Client.setCredentials(tokens);
    const drive = google.drive({ version: "v3", auth: oAuth2Client });

    const folderId = await getOrCreateAppFolder(drive);
    if (!folderId) {
        log("Error: Google Drive folder not found");
        throw new Error("Google Drive folder not found");
    }

    log("Fetching remote files...");
    const remoteRes = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: "files(id, name, md5Checksum, modifiedTime)",
        spaces: "drive",
    });
    const remoteFiles = remoteRes.data.files ?? [];
    log(`Found ${remoteFiles.length} remote files.`);

    const localFiles = fs
        .readdirSync(localVideoDir)
        .filter((f) => f.endsWith(".mp4"))
        .map((name) => {
            const filePath = path.join(localVideoDir, name);
            return {
                name,
                path: filePath,
                hash: getFileHash(filePath),
                mtime: fs.statSync(filePath).mtimeMs,
            };
        });
    log(`Found ${localFiles.length} local files.`);

    const remoteMap = Object.fromEntries(remoteFiles.map((f) => [f.name, f]));
    const localMap = Object.fromEntries(localFiles.map((f) => [f.name, f]));

    for (const local of localFiles) {
        const remote = remoteMap[local.name];
        if (!remote) {
            log(`Uploading new local file: ${local.name}`);
            await drive.files.create({
                requestBody: {
                    name: local.name,
                    parents: [folderId],
                    mimeType: "video/mp4",
                },
                media: {
                    mimeType: "video/mp4",
                    body: fs.createReadStream(local.path),
                },
                fields: "id",
            });
            log(`Uploaded: ${local.name}`);
        }
    }

    for (const remote of remoteFiles) {
        if (!remote.name) continue;
        const local = localMap[remote.name];
        if (!local) {
            log(`Downloading remote file: ${remote.name}`);
            const destPath = path.join(localVideoDir, remote.name);
            const dest = fs.createWriteStream(destPath);
            const res = drive.files.get(
                { fileId: remote.id, alt: "media" },
                { responseType: "stream" },
            );
            await new Promise((resolve, reject) => {
                res.data.pipe(dest);
                res.data.on("end", () => {
                    log(`Downloaded: ${remote.name}`);
                    resolve();
                });
                res.data.on("error", (err) => {
                    log(`Error downloading ${remote.name}:`, err);
                    reject(err);
                });
            });
        }
    }

    log("Sync complete.");
    return { success: true };
}

(async () => {
    try {
        log("Worker started.");
        const result = await syncVideos(
            workerData.tokens,
            workerData.localVideoDir,
        );
        parentPort.postMessage(result);
        log("Worker finished successfully.");
    } catch (error) {
        log("Worker error:", error.message);
        parentPort.postMessage({ success: false, error: error.message });
    }
})();
