/**
 * Platform abstraction to handle differences between web and desktop environments
 */
export const platform = (() => {
    const isElectronEnvironment = (() => {
        try {
            return (
                typeof window !== "undefined" &&
                window.electronWindow &&
                window.electronWindow.isElectron()
            );
        } catch {
            return false;
        }
    })();

    return {
        isElectron: () => isElectronEnvironment,
        isWeb: () => !isElectronEnvironment,
    };
})();

if (typeof window !== "undefined") {
    window.platform = platform.isElectron() ? "electron" : "web";
}
