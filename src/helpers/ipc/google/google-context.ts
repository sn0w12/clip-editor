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
import { Credentials } from "google-auth-library";

export function exposeGoogleContext() {
    const { contextBridge, ipcRenderer } = window.require("electron");
    contextBridge.exposeInMainWorld("googleDrive", {
        getAuthUrl: () => ipcRenderer.invoke(GOOGLE_AUTH_URL_CHANNEL),
        exchangeCode: (code: string) =>
            ipcRenderer.invoke(GOOGLE_EXCHANGE_CODE_CHANNEL, code),
        uploadFile: (filePath: string, tokens: Credentials) =>
            ipcRenderer.invoke(GOOGLE_UPLOAD_FILE_CHANNEL, filePath, tokens),
        downloadFile: (fileId: string, savePath: string, tokens: Credentials) =>
            ipcRenderer.invoke(
                GOOGLE_DOWNLOAD_FILE_CHANNEL,
                fileId,
                savePath,
                tokens,
            ),
        getProfile: (tokens: Credentials) =>
            ipcRenderer.invoke(GOOGLE_GET_PROFILE_CHANNEL, tokens),
        getSavedTokens: () =>
            ipcRenderer.invoke(GOOGLE_GET_SAVED_TOKENS_CHANNEL),
        signOut: () => ipcRenderer.invoke(GOOGLE_SIGN_OUT_CHANNEL),
        getVideoFolderFiles: (tokens: Credentials) =>
            ipcRenderer.invoke(GOOGLE_GET_VIDEO_FOLDER_FILES_CHANNEL, tokens),
        syncVideos: (tokens: Credentials, localVideoDir: string) =>
            ipcRenderer.invoke(GOOGLE_SYNC_FILE_CHANNEL, tokens, localVideoDir),
        getStorage: (tokens: Credentials) =>
            ipcRenderer.invoke(GOOGLE_GET_STORAGE_CHANNEL, tokens),
    });
}
