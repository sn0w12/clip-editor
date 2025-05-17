export function exposeSteamContext() {
    const { contextBridge, ipcRenderer } = window.require("electron");
    contextBridge.exposeInMainWorld("steam", {
        getAllSteamGames: (steamDir: string) =>
            ipcRenderer.invoke("steam:get-all-games", steamDir),
        getSteamLibraryFolders: (steamDir: string) =>
            ipcRenderer.invoke("steam:get-library-paths", steamDir),
        getAllGameImages: (steamDir: string) =>
            ipcRenderer.invoke("steam:get-all-game-images", steamDir),
        getGameImages: (steamDir: string, appId: string) =>
            ipcRenderer.invoke("steam:get-game-images", steamDir, appId),
    });
}
