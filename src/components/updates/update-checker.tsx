import { useSelector } from "@tanstack/react-store";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect } from "react";
import type { ReactNode } from "react";

import { MarkdownView } from "@/components/markdown/markdown-view";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogPanel,
    DialogPopup,
    DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/format";
import { EASE_SNAPPY } from "@/lib/motion";
import type { UpdateState } from "@/lib/updates/update-controller";
import {
    closeUpdateDialog,
    updateDialogOpenStore,
    updaterController,
} from "@/lib/updates/update-manager";

/**
 * Runs the silent-on-startup update check and renders the install dialog.
 * The dialog is opened by the titlebar install button, which appears once
 * an update is detected; this component owns no updater state itself.
 */
export function UpdateChecker() {
    const open = useSelector(updateDialogOpenStore, (value) => value);
    const state = useSelector(updaterController.store, (value) => value);

    useEffect(() => {
        void updaterController.start();
    }, []);

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) closeUpdateDialog();
            }}
        >
            <DialogPopup data-testid="update-dialog">
                <UpdateDialogBody
                    state={state}
                    onInstall={() => void updaterController.install()}
                    onLater={closeUpdateDialog}
                />
            </DialogPopup>
        </Dialog>
    );
}

function UpdateDialogBody({
    state,
    onInstall,
    onLater,
}: {
    state: UpdateState;
    onInstall: () => void;
    onLater: () => void;
}) {
    const reducedMotion = useReducedMotion();
    let stageView: ReactNode;
    switch (state.status) {
        case "available":
            stageView = (
                <AvailableView
                    version={state.info.version}
                    body={state.info.body}
                    onInstall={onInstall}
                    onLater={onLater}
                />
            );
            break;
        case "downloading":
            stageView = (
                <DownloadingView
                    percent={state.percent}
                    receivedBytes={state.receivedBytes}
                    totalBytes={state.totalBytes}
                />
            );
            break;
        case "installing":
            stageView = <InstallingView />;
            break;
        case "failed":
            // A failed means download/install failed, not a failed check; the
            // check failure branch keeps the dialog closed on purpose.
            stageView = state.info ? (
                <FailedView
                    message={state.message}
                    version={state.info.version}
                    onRetry={onInstall}
                    onLater={onLater}
                />
            ) : null;
            break;
        default:
            stageView = null;
            break;
    }
    return (
        <AnimatePresence mode="wait" initial={false}>
            <motion.div
                key={state.status}
                className="ui-selectable flex min-h-0 w-full flex-col"
                initial={{
                    opacity: 0,
                    transform: reducedMotion
                        ? "translateY(0px)"
                        : "translateY(8px)",
                }}
                animate={{ opacity: 1, transform: "translateY(0px)" }}
                exit={{
                    opacity: 0,
                    transform: reducedMotion
                        ? "translateY(0px)"
                        : "translateY(-8px)",
                }}
                transition={{ duration: 0.16, ease: EASE_SNAPPY }}
            >
                {stageView}
            </motion.div>
        </AnimatePresence>
    );
}

function AvailableView({
    version,
    body,
    onInstall,
    onLater,
}: {
    version: string;
    body?: string;
    onInstall: () => void;
    onLater: () => void;
}) {
    return (
        <>
            <DialogHeader>
                <DialogTitle>Update available</DialogTitle>
                <DialogDescription>Version {version}</DialogDescription>
            </DialogHeader>
            {body ? (
                <DialogPanel className="ui-selectable text-sm text-muted-foreground">
                    <MarkdownView>{body}</MarkdownView>
                </DialogPanel>
            ) : null}
            <DialogFooter>
                <Button variant="ghost" onClick={onLater}>
                    Later
                </Button>
                <Button variant="info" onClick={onInstall}>
                    Restart and update
                </Button>
            </DialogFooter>
        </>
    );
}

function DownloadingView({
    percent,
    receivedBytes,
    totalBytes,
}: {
    percent: number | null;
    receivedBytes: number;
    totalBytes: number | null;
}) {
    return (
        <>
            <DialogHeader>
                <DialogTitle>Downloading update</DialogTitle>
                <DialogDescription>
                    {totalBytes !== null
                        ? `${formatBytes(receivedBytes)} of ${formatBytes(totalBytes)}`
                        : formatBytes(receivedBytes)}
                </DialogDescription>
            </DialogHeader>
            <DialogPanel>
                <Progress value={percent} />
                {percent !== null ? (
                    <div className="mt-2 text-right text-sm text-muted-foreground tabular-nums">
                        {Math.round(percent)}%
                    </div>
                ) : null}
            </DialogPanel>
        </>
    );
}

function InstallingView() {
    return (
        <>
            <DialogHeader>
                <DialogTitle>Installing update</DialogTitle>
                <DialogDescription>
                    The app will restart automatically.
                </DialogDescription>
            </DialogHeader>
            <DialogPanel>
                <Progress value={null} />
            </DialogPanel>
        </>
    );
}

function FailedView({
    message,
    version,
    onRetry,
    onLater,
}: {
    message: string;
    version: string;
    onRetry: () => void;
    onLater: () => void;
}) {
    return (
        <>
            <DialogHeader>
                <DialogTitle>Update failed</DialogTitle>
                <DialogDescription>Version {version}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
                <p className="text-sm text-destructive" role="alert">
                    {message}
                </p>
            </DialogPanel>
            <DialogFooter>
                <Button variant="ghost" onClick={onLater}>
                    Later
                </Button>
                <Button variant="info" onClick={onRetry}>
                    Try again
                </Button>
            </DialogFooter>
        </>
    );
}
