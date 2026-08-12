import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";

import { appWindow, isWindowMaximized } from "@/lib/tauri";

export function WindowControls() {
    const [isMaximized, setIsMaximized] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void isWindowMaximized().then((maximized) => {
            if (!cancelled) setIsMaximized(maximized);
        });
        const unlisten = appWindow.onResized(async () => {
            setIsMaximized(await isWindowMaximized());
        });
        return () => {
            cancelled = true;
            void unlisten.then((fn) => fn());
        };
    }, []);

    return (
        <div className="flex h-full">
            <button
                type="button"
                title="Minimize"
                className="hover:bg-primary/20 h-full cursor-default px-4"
                onClick={() => void appWindow.minimize()}
            >
                <Minus className="h-4 w-4" />
            </button>
            <button
                type="button"
                title={isMaximized ? "Restore Down" : "Maximize"}
                className="hover:bg-primary/20 h-full cursor-default px-4"
                onClick={() => void appWindow.toggleMaximize()}
            >
                {isMaximized ? (
                    <Copy className="h-4 w-4 scale-x-[-1]" />
                ) : (
                    <Square className="h-4 w-4" />
                )}
            </button>
            <button
                type="button"
                title="Close"
                className="hover:bg-destructive h-full cursor-default px-4"
                onClick={() => void appWindow.close()}
            >
                <X className="h-4 w-4" />
            </button>
        </div>
    );
}
