/** True when the webview is WebKit-based (macOS WKWebView; Windows WebView2 is Chromium). */
export function useIsWebKit(): boolean {
    return (
        typeof navigator !== "undefined" &&
        /AppleWebKit/i.test(navigator.userAgent) &&
        !/Chrome|Edg/i.test(navigator.userAgent)
    );
}
