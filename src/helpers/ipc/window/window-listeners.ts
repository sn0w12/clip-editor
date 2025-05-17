import { BrowserWindow, ipcMain } from "electron";
import {
    WIN_CLOSE_CHANNEL,
    WIN_MAXIMIZE_CHANNEL,
    WIN_MINIMIZE_CHANNEL,
} from "./window-channels";

export function addWindowEventListeners(mainWindow: BrowserWindow) {
    ipcMain.handle(WIN_MINIMIZE_CHANNEL, () => {
        mainWindow.minimize();
    });
    ipcMain.handle(WIN_MAXIMIZE_CHANNEL, () => {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    });
    ipcMain.handle(WIN_CLOSE_CHANNEL, () => {
        mainWindow.close();
    });
    ipcMain.handle("window-is-maximized", () => {
        return mainWindow.isMaximized();
    });
    if (process.env.NODE_ENV === "development") {
        ipcMain.handle("dev:inspect-element", (_, { x, y }) => {
            mainWindow.webContents.inspectElement(x, y);
        });
    }
}
