import * as React from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Dialog,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogPanel,
    DialogPopup,
    DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

export type ConfirmVariant = "default" | "destructive";

export interface ConfirmCheckboxOptions {
    label: React.ReactNode;
    defaultChecked?: boolean;
}

export interface ConfirmOptions {
    title: React.ReactNode;
    /** Static copy, or a function of the checkbox state for dynamic copy. */
    description?: React.ReactNode | ((checked: boolean) => React.ReactNode);
    checkbox?: ConfirmCheckboxOptions;
    confirmText?: React.ReactNode;
    cancelText?: React.ReactNode;
    variant?: ConfirmVariant;
}

export interface ConfirmResult {
    confirmed: boolean;
    /** Checkbox state when `checkbox` was passed; absent otherwise. */
    checkboxChecked?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
    id: number;
    resolve: (value: ConfirmResult) => void;
}

interface ConfirmContextType {
    confirm: (options: ConfirmOptions) => Promise<ConfirmResult>;
}

const ConfirmContext = React.createContext<ConfirmContextType | undefined>(
    undefined
);

function useConfirmContext() {
    const context = React.useContext(ConfirmContext);
    if (!context) {
        throw new Error("useConfirm must be used within a ConfirmProvider");
    }
    return context;
}

export function useConfirm() {
    return useConfirmContext();
}

type ConfirmActionResult = boolean | void;

interface ConfirmContentProps {
    onConfirm: () => ConfirmActionResult | Promise<ConfirmActionResult>;
    onCancel?: () => void;
    confirmText?: React.ReactNode;
    cancelText?: React.ReactNode;
    variant?: ConfirmVariant;
}

function ConfirmActions({
    onConfirm,
    onCancel,
    confirmText = "Confirm",
    cancelText = "Cancel",
    variant = "default",
}: ConfirmContentProps) {
    const [loading, startTransition] = React.useTransition();
    const handleConfirm = async () => {
        startTransition(async () => {
            try {
                const result = await Promise.resolve(onConfirm());
                if (result === false) return;
            } catch (e) {
                console.error("Confirm action unsuccessful", e);
            }
        });
    };

    return (
        <>
            <Button variant="outline" onClick={onCancel} disabled={loading}>
                {cancelText}
            </Button>
            <Button
                variant={variant === "destructive" ? "destructive" : "default"}
                onClick={handleConfirm}
                loading={loading}
            >
                {confirmText}
            </Button>
        </>
    );
}

interface ConfirmDialogProps extends ConfirmOptions {
    requestId: number;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: (checkboxChecked: boolean) => void;
    onCancel?: () => void;
}

function ConfirmDialog({
    requestId,
    open,
    onOpenChange,
    title,
    description,
    checkbox,
    onConfirm,
    onCancel,
    confirmText = "Confirm",
    cancelText = "Cancel",
    variant = "default",
}: ConfirmDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogPopup>
                <ConfirmDialogBody
                    key={requestId}
                    title={title}
                    description={description}
                    checkbox={checkbox}
                    confirmText={confirmText}
                    cancelText={cancelText}
                    variant={variant}
                    onConfirm={onConfirm}
                    onCancel={onCancel}
                    onClose={() => onOpenChange(false)}
                />
            </DialogPopup>
        </Dialog>
    );
}

interface ConfirmDialogBodyProps extends ConfirmOptions {
    onConfirm: (
        checkboxChecked: boolean
    ) => ConfirmActionResult | Promise<ConfirmActionResult>;
    onCancel?: () => void;
    onClose: () => void;
}

/** Keyed per request so checkbox state never leaks between confirms. */
function ConfirmDialogBody({
    title,
    description,
    checkbox,
    onConfirm,
    onCancel,
    onClose,
    confirmText = "Confirm",
    cancelText = "Cancel",
    variant = "default",
}: ConfirmDialogBodyProps) {
    const [checked, setChecked] = React.useState(
        checkbox?.defaultChecked ?? false
    );
    const checkboxId = React.useId();
    const resolvedDescription =
        typeof description === "function" ? description(checked) : description;

    const handleConfirm = async () => {
        const result = await Promise.resolve(onConfirm(checked));
        if (result === false) return;
        onClose();
    };

    return (
        <>
            <DialogHeader>
                <DialogTitle>{title}</DialogTitle>
                {resolvedDescription && (
                    <DialogDescription>{resolvedDescription}</DialogDescription>
                )}
            </DialogHeader>
            {checkbox && (
                <DialogPanel>
                    <Label htmlFor={checkboxId}>
                        <Checkbox
                            id={checkboxId}
                            checked={checked}
                            onCheckedChange={(next) =>
                                setChecked(next === true)
                            }
                        />
                        {checkbox.label}
                    </Label>
                </DialogPanel>
            )}
            <DialogFooter>
                <ConfirmActions
                    onConfirm={handleConfirm}
                    onCancel={onCancel}
                    confirmText={confirmText}
                    cancelText={cancelText}
                    variant={variant}
                />
            </DialogFooter>
        </>
    );
}

/** How long a settled dialog stays mounted while closing, so chained
 * confirms don't flicker the popup away and back. */
const CLOSE_ANIMATION_MS = 200;

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
    const requestIdRef = React.useRef(0);
    const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
        null
    );
    const [queue, setQueue] = React.useState<ConfirmRequest[]>([]);
    const [displayed, setDisplayed] = React.useState<ConfirmRequest | null>(
        null
    );

    const confirm = React.useCallback(
        (options: ConfirmOptions) =>
            new Promise<ConfirmResult>((resolve) => {
                const request: ConfirmRequest = {
                    ...options,
                    id: ++requestIdRef.current,
                    resolve,
                };
                setQueue((current) => [...current, request]);
            }),
        []
    );

    const settle = React.useCallback(
        (request: ConfirmRequest, value: ConfirmResult) => {
            setQueue((current) =>
                current.filter((item) => item.id !== request.id)
            );
            // Hold the settled request mounted through the closing
            // animation; a chained confirm arriving meanwhile replaces it.
            setDisplayed(request);
            const pending = closeTimerRef.current;
            if (pending !== null) clearTimeout(pending);
            closeTimerRef.current = setTimeout(() => {
                closeTimerRef.current = null;
                setDisplayed((current) =>
                    current?.id === request.id ? null : current
                );
            }, CLOSE_ANIMATION_MS);
            request.resolve(value);
        },
        []
    );

    React.useEffect(() => {
        return () => {
            const pending = closeTimerRef.current;
            if (pending !== null) clearTimeout(pending);
            closeTimerRef.current = null;
        };
    }, []);

    const value = React.useMemo(() => ({ confirm }), [confirm]);

    const current = queue.length > 0 ? queue[0] : null;

    return (
        <ConfirmContext.Provider value={value}>
            {children}
            <ConfirmRenderer
                request={current}
                displayed={displayed}
                onSettle={settle}
            />
        </ConfirmContext.Provider>
    );
}

function ConfirmRenderer({
    request,
    displayed,
    onSettle,
}: {
    request: ConfirmRequest | null;
    displayed: ConfirmRequest | null;
    onSettle: (request: ConfirmRequest, value: ConfirmResult) => void;
}) {
    const activeRequest = request ?? displayed;

    const settleTrue = React.useCallback(
        (checkboxChecked: boolean) => {
            if (!request) return;
            onSettle(request, {
                confirmed: true,
                checkboxChecked: request.checkbox ? checkboxChecked : undefined,
            });
        },
        [request, onSettle]
    );

    const settleFalse = React.useCallback(() => {
        if (request) onSettle(request, { confirmed: false });
    }, [request, onSettle]);

    return (
        <ConfirmDialog
            requestId={activeRequest?.id ?? 0}
            open={!!request}
            onOpenChange={(open) => {
                if (!open && request) onSettle(request, { confirmed: false });
            }}
            title={activeRequest?.title ?? ""}
            description={activeRequest?.description}
            checkbox={activeRequest?.checkbox}
            confirmText={activeRequest?.confirmText ?? "Confirm"}
            cancelText={activeRequest?.cancelText ?? "Cancel"}
            variant={activeRequest?.variant ?? "default"}
            onConfirm={settleTrue}
            onCancel={settleFalse}
        />
    );
}
