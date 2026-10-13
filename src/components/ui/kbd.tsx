import type { RegisterableHotkey } from "@tanstack/react-hotkeys";
import type * as React from "react";
import { Fragment } from "react";

import { useSettingValue } from "@/hooks/settings/use-setting";
import {
    SHORTCUT_SETTING_KEYS,
    type ShortcutSettingKey,
} from "@/lib/settings/settings.generated";
import { displayToken, splitChord } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";

export function Kbd({
    className,
    ...props
}: React.ComponentProps<"kbd">): React.ReactElement {
    return (
        <kbd
            className={cn(
                "pointer-events-none inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded-[.25rem] bg-muted px-1 text-xs font-medium text-muted-foreground select-none [&_svg:not([class*='size-'])]:size-3",
                className
            )}
            data-slot="kbd"
            {...props}
        />
    );
}

export function KbdGroup({
    className,
    ...props
}: React.ComponentProps<"kbd">): React.ReactElement {
    return (
        <kbd
            className={cn("inline-flex items-center gap-1", className)}
            data-slot="kbd-group"
            {...props}
        />
    );
}

function InternalKeyboardShortcut({
    shortcut,
    className,
}: {
    shortcut: string[];
    className?: string;
}) {
    if (shortcut.length === 0) return null;

    return (
        <KbdGroup className={className}>
            {shortcut.map((part, index) => (
                <Fragment key={`${part}-${index}`}>
                    <Kbd>{displayToken(part)}</Kbd>
                </Fragment>
            ))}
        </KbdGroup>
    );
}

function isShortcutSettingKey(value: unknown): value is ShortcutSettingKey {
    return (
        typeof value === "string" &&
        SHORTCUT_SETTING_KEYS.includes(value as ShortcutSettingKey)
    );
}

export type AnyShortcut = RegisterableHotkey | ShortcutSettingKey;

export function KeyboardShortcut({
    shortcut,
    className,
}: {
    shortcut: AnyShortcut;
    className?: string;
}) {
    if (isShortcutSettingKey(shortcut)) {
        return (
            <SettingKeyboardShortcut
                shortcut={shortcut}
                className={className}
            />
        );
    }

    return <HotkeyKeyboardShortcut shortcut={shortcut} className={className} />;
}

function HotkeyKeyboardShortcut({
    shortcut,
    className,
}: {
    shortcut: RegisterableHotkey;
    className?: string;
}) {
    return (
        <InternalKeyboardShortcut
            shortcut={shortcut.toString().split("+")}
            className={className}
        />
    );
}

function SettingKeyboardShortcut({
    shortcut,
    className,
}: {
    shortcut: ShortcutSettingKey;
    className?: string;
}) {
    const chord = useSettingValue(shortcut);
    const parts = splitChord(chord);

    return <InternalKeyboardShortcut shortcut={parts} className={className} />;
}
