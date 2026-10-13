import { toastManager } from "@/components/ui/toast";

export function toastError(title: string, error: unknown): void {
    toastManager.add({
        title,
        description: error instanceof Error ? error.message : String(error),
        type: "error",
    });
}
