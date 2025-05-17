import {
    WIN_MINIMIZE_CHANNEL,
    WIN_MAXIMIZE_CHANNEL,
    WIN_CLOSE_CHANNEL,
} from "./window-channels";

export function exposeWindowContext() {
    const { contextBridge, ipcRenderer } = window.require("electron");
    type WindowStateChangeCallback = (isMaximized: boolean) => void;

    interface ElectronWindowAPI {
        minimize: () => Promise<void>;
        maximize: () => Promise<void>;
        close: () => Promise<void>;
        isMaximized: () => Promise<boolean>;
        onWindowStateChange: (callback: WindowStateChangeCallback) => void;
    }

    // Expose the typed API to the main world
    contextBridge.exposeInMainWorld("electronWindow", {
        minimize: () => ipcRenderer.invoke(WIN_MINIMIZE_CHANNEL),
        maximize: () => ipcRenderer.invoke(WIN_MAXIMIZE_CHANNEL),
        close: () => ipcRenderer.invoke(WIN_CLOSE_CHANNEL),
        isMaximized: () => ipcRenderer.invoke("window-is-maximized"),
        onWindowStateChange: (callback: WindowStateChangeCallback) => {
            ipcRenderer.on(
                "window-state-change",
                (_: never, isMaximized: boolean) => {
                    callback(isMaximized);
                },
            );
        },
        inspectElement: (x: number, y: number) =>
            ipcRenderer.invoke("dev:inspect-element", { x, y }),
        isElectron: () => true,
    } as ElectronWindowAPI);
}
