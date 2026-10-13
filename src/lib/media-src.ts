import { convertFileSrc } from "@tauri-apps/api/core";

import { expectOk } from "@/lib/backend/transport/result";
import { getAppRuntime } from "@/lib/bootstrap/app-runtime";

let portPromise: Promise<number> | null = null;

function mediaServerPort(): Promise<number> {
    portPromise ??= getAppRuntime()
        .backend.library.mediaServerPort()
        .then(expectOk)
        .catch((error) => {
            portPromise = null;
            throw error;
        });
    return portPromise;
}

/**
 * Local file URL for the `<video>` element. WebView2's intercepted protocols
 * (asset/custom schemes) play video but drop audio, so clips stream from the
 * embedded localhost server, which plays with sound and supports seeking.
 */
export async function videoSrc(path: string): Promise<string> {
    const port = await mediaServerPort();
    return `http://127.0.0.1:${port}/${encodeURIComponent(path)}`;
}

/** Local file via the asset protocol (thumbnails, artwork, exports). */
export function imgSrc(path: string): string {
    return convertFileSrc(path);
}
