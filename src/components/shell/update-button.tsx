import { Download, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { useUpdateAvailable } from "@/hooks/use-update";

export function UpdateButton() {
    const { available, installAndRestart } = useUpdateAvailable();
    const [installing, setInstalling] = useState(false);

    if (!available) return null;

    const handleClick = async () => {
        if (installing) return;
        setInstalling(true);
        try {
            await installAndRestart();
        } catch (e) {
            setInstalling(false);
            toastManager.add({ title: `Update failed: ${String(e)}`, type: "error" });
        }
    };

    return (
        <Button
            variant="ghost"
            size="icon"
            className="text-primary hover:bg-primary/20 h-full"
            onClick={() => void handleClick()}
            loading={installing}
        >
            {installing ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
            ) : (
                <Download className="h-4 w-4" />
            )}
        </Button>
    );
}
