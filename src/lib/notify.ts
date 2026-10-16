import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from "@tauri-apps/plugin-notification";

/**
 * Sends a desktop notification, requesting permission the first time. Best
 * effort: a denied or unsupported notification API resolves quietly, since the
 * in-app toast is the fallback surface.
 */
export async function notify(title: string, body: string): Promise<void> {
    try {
        let granted = await isPermissionGranted();
        if (!granted) {
            granted = (await requestPermission()) === "granted";
        }
        if (granted) {
            sendNotification({ title, body });
        }
    } catch {
        // Notification support is unavailable; the caller still showed a toast.
    }
}
