import { useHotkey } from "@tanstack/react-hotkeys";
import * as React from "react";

import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuShortcut } from "@/components/ui/menu";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import {
    clearSelection,
    getSelectionText,
    selectElementContents,
    selectionInSurface,
} from "@/lib/selection/text-selection";
import { displayToken } from "@/lib/shortcuts";

type SelectionSnapshot = {
    pointX: number;
    pointY: number;
    surface: Element;
    field: HTMLInputElement | HTMLTextAreaElement | null;
    hasSelection: boolean;
    text: string;
};

// Zero-size virtual element anchoring the popup at the cursor.
function rectAtPoint(x: number, y: number): DOMRect {
    return {
        x,
        y,
        width: 0,
        height: 0,
        top: y,
        right: x,
        bottom: y,
        left: x,
        toJSON() {
            return this;
        },
    } as DOMRect;
}

function ShortcutHint({ tokens }: { tokens: string[] }): React.ReactElement {
    return (
        <MenuShortcut>
            <KbdGroup>
                {tokens.map((token) => {
                    return <Kbd key={token}>{displayToken(token)}</Kbd>;
                })}
            </KbdGroup>
        </MenuShortcut>
    );
}

export function SelectionContextMenu(): React.ReactElement | null {
    const [snapshot, setSnapshot] = React.useState<SelectionSnapshot | null>(
        null
    );
    useHotkey("Mod+D", () => clearSelection(), {
        preventDefault: true,
    });

    React.useEffect(() => {
        function handleContextMenu(event: MouseEvent) {
            const target = event.target;

            if (!(target instanceof Element)) return;
            const field =
                target instanceof HTMLInputElement ||
                target instanceof HTMLTextAreaElement
                    ? target
                    : null;
            if (field && field.selectionStart === null) return;
            const surface = field ?? target.closest(".ui-selectable");
            if (!(surface instanceof Element)) return;

            event.preventDefault();
            const text = field
                ? field.value.slice(
                      field.selectionStart ?? 0,
                      field.selectionEnd ?? 0
                  )
                : getSelectionText();
            setSnapshot({
                pointX: event.clientX,
                pointY: event.clientY,
                surface,
                field,
                hasSelection: field
                    ? text.length > 0
                    : selectionInSurface(surface),
                text,
            });
        }

        document.addEventListener("contextmenu", handleContextMenu, true);
        return () => {
            document.removeEventListener(
                "contextmenu",
                handleContextMenu,
                true
            );
        };
    }, []);

    const anchor = React.useMemo(
        () =>
            snapshot
                ? {
                      getBoundingClientRect: () =>
                          rectAtPoint(snapshot.pointX, snapshot.pointY),
                  }
                : null,
        [snapshot]
    );

    const { copyToClipboard } = useCopyToClipboard();

    if (!snapshot || !anchor) return null;

    const handleCopy = () => {
        copyToClipboard(snapshot.text);
    };

    return (
        <Menu
            open
            modal={false}
            onOpenChange={(nextOpen) => {
                if (!nextOpen) setSnapshot(null);
            }}
        >
            <MenuPopup
                align="start"
                anchor={anchor}
                finalFocus={
                    snapshot.field
                        ? () =>
                              snapshot.field?.isConnected
                                  ? snapshot.field
                                  : false
                        : undefined
                }
                side="bottom"
            >
                <MenuItem
                    disabled={!snapshot.hasSelection}
                    onClick={handleCopy}
                >
                    Copy
                    <ShortcutHint tokens={["mod", "c"]} />
                </MenuItem>
                <MenuItem
                    disabled={!snapshot.hasSelection}
                    onClick={() => {
                        if (snapshot.field) {
                            if (snapshot.field.isConnected) {
                                const end = snapshot.field.selectionEnd ?? 0;
                                snapshot.field.focus({ preventScroll: true });
                                snapshot.field.setSelectionRange(end, end);
                            }
                        } else {
                            clearSelection();
                        }
                    }}
                >
                    Deselect
                    <ShortcutHint tokens={["mod", "d"]} />
                </MenuItem>
                <MenuItem
                    onClick={() => {
                        const field = snapshot.field;
                        if (field) {
                            if (!field.isConnected) return;
                            // The menu holds focus while open and restores it
                            // on close, which drops a synchronous selection.
                            // Select once the menu has finished closing.
                            window.setTimeout(() => {
                                if (!field.isConnected) return;
                                field.focus({ preventScroll: true });
                                field.select();
                            }, 0);
                        } else if (snapshot.surface.isConnected) {
                            selectElementContents(snapshot.surface);
                        }
                    }}
                >
                    Select all
                    <ShortcutHint tokens={["mod", "a"]} />
                </MenuItem>
            </MenuPopup>
        </Menu>
    );
}
