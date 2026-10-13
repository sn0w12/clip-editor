import { useState } from "react";
import type { ReactNode } from "react";

import {
    Dialog,
    DialogDescription,
    DialogHeader,
    DialogPanel,
    DialogPopup,
    DialogTitle,
} from "@/components/ui/dialog";
import { Kbd, KbdGroup, KeyboardShortcut } from "@/components/ui/kbd";
import {
    useSettingsSchema,
    visibleSettings,
} from "@/hooks/settings/use-setting";
import { useSettingHotkey } from "@/hooks/settings/use-setting-hotkey";
import type { ShortcutSettingKey } from "@/lib/settings/settings.generated";
import { displayToken, splitChord } from "@/lib/shortcuts";

/** Bindings with no settings key; they cannot be rebound. */
const FIXED_BINDINGS: { label: string; chord: string }[] = [
    { label: "Go to tab", chord: "Mod+1-9" },
];

function StaticChord({ chord }: { chord: string }) {
    const parts = splitChord(chord);
    if (parts.length === 0) return null;

    return (
        <KbdGroup>
            {parts.map((part, index) => (
                <Kbd key={`${part}-${index}`}>{displayToken(part)}</Kbd>
            ))}
        </KbdGroup>
    );
}

function ShortcutRow({ label, badge }: { label: string; badge: ReactNode }) {
    return (
        <li className="flex min-h-7 items-center justify-between gap-4 py-0.5 text-sm">
            <span className="min-w-0">{label}</span>
            {badge}
        </li>
    );
}

export function AppShortcutsHelp() {
    const [open, setOpen] = useState(false);
    useSettingHotkey("openShortcutsHelpShortcut", () =>
        setOpen((value) => !value)
    );

    const schema = useSettingsSchema();
    // Same source as the Settings Shortcuts tab: labels and bindings live
    // in the Rust schema, values resolve live from the settings store.
    const sections = (
        schema.tabs.find((tab) => tab.id === "shortcuts")?.sections ?? []
    )
        .map((section) => ({
            title: section.title,
            entries: visibleSettings(section).filter(
                (definition) => definition.kind === "shortcut"
            ),
        }))
        .filter((section) => section.entries.length > 0);

    return (
        <Dialog onOpenChange={setOpen} open={open}>
            <DialogPopup className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Keyboard shortcuts</DialogTitle>
                    <DialogDescription>
                        Rebind shortcuts in Settings under Shortcuts.
                    </DialogDescription>
                </DialogHeader>
                <DialogPanel className="grid gap-x-8 gap-y-6 pb-6 sm:grid-cols-2">
                    {sections.map((section) => (
                        <section
                            key={section.title}
                            className="flex flex-col gap-1.5"
                        >
                            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
                                {section.title}
                            </h3>
                            <ul className="flex flex-col">
                                {section.entries.map((definition) => (
                                    <ShortcutRow
                                        key={definition.key}
                                        label={definition.label}
                                        // Schema-verified at runtime; the
                                        // cast ties to the generated union.
                                        badge={
                                            <KeyboardShortcut
                                                shortcut={
                                                    definition.key as ShortcutSettingKey
                                                }
                                            />
                                        }
                                    />
                                ))}
                            </ul>
                        </section>
                    ))}
                    <section className="flex flex-col gap-1.5">
                        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">
                            Fixed
                        </h3>
                        <ul className="flex flex-col">
                            {FIXED_BINDINGS.map((binding) => (
                                <ShortcutRow
                                    key={binding.label}
                                    label={binding.label}
                                    badge={
                                        <StaticChord chord={binding.chord} />
                                    }
                                />
                            ))}
                        </ul>
                    </section>
                </DialogPanel>
            </DialogPopup>
        </Dialog>
    );
}
