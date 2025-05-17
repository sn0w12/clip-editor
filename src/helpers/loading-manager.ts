/**
 * LoadingManager provides functionality to control the app's loading screen
 * from renderer processes.
 */
class LoadingManager {
    private isReady = false;
    private readyCallbacks: (() => void)[] = [];

    constructor() {
        // Initialize with a small delay to ensure window APIs are available
        setTimeout(() => this.initialize(), 0);
    }

    /**
     * Set up handlers for loading manager
     */
    private initialize() {
        // Use the exposed API from preload.js
        if (window.loadingManager) {
            // Listen for main process telling us the app is ready to show
            window.loadingManager.onAppReady(() => {
                this.isReady = true;
                this.runCallbacks();
            });
        } else {
            console.warn("Loading manager API not found in window object");
        }
    }

    /**
     * Register a callback to be executed when the app is ready
     * @param callback Function to call when app is ready
     */
    onReady(callback: () => void) {
        if (this.isReady) {
            callback();
        } else {
            this.readyCallbacks.push(callback);
        }
    }

    /**
     * Signal that the app is ready to be displayed
     * Use this to manually control when the loading screen should be dismissed
     */
    completeLoading() {
        if (window.loadingManager) {
            window.loadingManager.completeLoading();
        } else {
            console.warn(
                "Unable to complete loading: loading manager API not found",
            );
        }
    }

    private runCallbacks() {
        this.readyCallbacks.forEach((callback) => callback());
        this.readyCallbacks = [];
    }
}

// Export a singleton instance
export const loadingManager = new LoadingManager();
