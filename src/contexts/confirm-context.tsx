import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type * as React from "react";

import { ConfirmDialog, type ConfirmVariant } from "@/components/ui/confirm";

export interface ConfirmOptions {
    title: React.ReactNode;
    description?: React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    variant?: ConfirmVariant;
}

interface ConfirmContextValue {
    confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextValue | null>(null);

interface PendingConfirm extends ConfirmOptions {
    resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: React.ReactNode }): React.ReactElement {
    const [pending, setPending] = useState<PendingConfirm | null>(null);

    const confirm = useCallback((options: ConfirmOptions) => {
        return new Promise<boolean>((resolve) => {
            setPending({ ...options, resolve });
        });
    }, []);

    const handleClose = useCallback((result: boolean, current: PendingConfirm | null) => {
        setPending(null);
        current?.resolve(result);
    }, []);

    const value = useMemo(() => ({ confirm }), [confirm]);

    return (
        <ConfirmContext.Provider value={value}>
            {children}
            {pending && (
                <ConfirmDialog
                    open
                    onOpenChange={(open) => {
                        if (!open) handleClose(false, pending);
                    }}
                    title={pending.title}
                    description={pending.description}
                    confirmText={pending.confirmText}
                    cancelText={pending.cancelText}
                    variant={pending.variant}
                    onConfirm={() => handleClose(true, pending)}
                />
            )}
        </ConfirmContext.Provider>
    );
}

export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
    const context = useContext(ConfirmContext);
    if (!context) {
        throw new Error("useConfirm must be used within a ConfirmProvider");
    }
    return context.confirm;
}
