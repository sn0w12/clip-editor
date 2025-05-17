import { contextBridge, ipcRenderer } from "electron";
import exposeContexts from "./helpers/ipc/context-exposer";
import { APP_CONFIG } from "./config";

// Expose all contexts
exposeContexts();

contextBridge.exposeInMainWorld("appConfig", APP_CONFIG);
contextBridge.exposeInMainWorld("loadingManager", {
    completeLoading: () => ipcRenderer.send("app-loading-complete"),
    onAppReady: (callback: () => void) => {
        ipcRenderer.on("app-ready-to-show", () => callback());
    },
});
