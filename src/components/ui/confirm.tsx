import type * as React from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogClose,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogPopup,
    DialogTitle,
} from "@/components/ui/dialog";

export type ConfirmVariant = "default" | "destructive";

export interface ConfirmDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: React.ReactNode;
    description?: React.ReactNode;
    confirmText?: string;
    cancelText?: string;
    variant?: ConfirmVariant;
    onConfirm: () => void;
}

/** App-level confirmation dialog (desktop-only, plain coss Dialog). */
export function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmText = "Confirm",
    cancelText = "Cancel",
    variant = "default",
    onConfirm,
}: ConfirmDialogProps): React.ReactElement {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogPopup className="w-full max-w-sm">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                    {description ? <DialogDescription>{description}</DialogDescription> : null}
                </DialogHeader>
                <DialogFooter>
                    <DialogClose render={<Button variant="ghost">{cancelText}</Button>} />
                    <Button
                        variant={variant === "destructive" ? "destructive" : "default"}
                        onClick={onConfirm}
                    >
                        {confirmText}
                    </Button>
                </DialogFooter>
            </DialogPopup>
        </Dialog>
    );
}
