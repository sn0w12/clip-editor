import { useState } from "react";

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
    NumberField,
    NumberFieldDecrement,
    NumberFieldGroup,
    NumberFieldIncrement,
    NumberFieldInput,
} from "@/components/ui/number-field";
import {
    Select,
    SelectItem,
    SelectPopup,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { VisibleSettingDefinition } from "@/hooks/settings/use-setting";
import { useSetting } from "@/hooks/settings/use-setting";
import type {
    SettingKey,
    SettingsValues,
} from "@/lib/settings/settings.generated";
import { cn } from "@/lib/utils";

import { ShortcutControl } from "./shortcut-control";

export function SettingField({
    definition,
}: {
    definition: VisibleSettingDefinition;
}) {
    // `definition.key` is schema-verified at runtime; the cast ties the
    // generic hook to the generated key union.
    const { value, setValue } = useSetting(definition.key as SettingKey);

    return (
        <div
            className="flex items-center justify-between gap-8"
            data-slot="setting-field"
        >
            <Field className="min-w-0 gap-0">
                <FieldLabel className="cursor-text">
                    {definition.label}
                </FieldLabel>
                {definition.description && (
                    <FieldDescription>
                        {definition.description}
                    </FieldDescription>
                )}
            </Field>
            <div
                className="flex shrink-0 justify-end"
                data-slot="setting-control"
            >
                <SettingControl
                    definition={definition}
                    value={value as boolean | number | string}
                    // The control set is fixed by the renderer, so it is wider
                    // than the generated union whenever the schema has no
                    // number setting to widen it.
                    onChange={(next) =>
                        setValue(next as SettingsValues[SettingKey])
                    }
                />
            </div>
        </div>
    );
}

const FIELD_WIDTH =
    "min-w-8 w-[clamp(calc(var(--spacing)*8),calc(var(--spacing)*56),calc(var(--spacing)*56))]";

function SettingControl({
    definition,
    value,
    onChange,
}: {
    definition: VisibleSettingDefinition;
    value: boolean | number | string;
    onChange: (value: boolean | number | string) => void;
}) {
    switch (definition.kind) {
        case "boolean":
            return (
                <Switch
                    checked={Boolean(value)}
                    onCheckedChange={(checked) => onChange(checked)}
                />
            );

        case "select":
            return (
                <Select
                    value={String(value)}
                    onValueChange={(next) => {
                        if (typeof next === "string") onChange(next);
                    }}
                    items={definition.options}
                >
                    <SelectTrigger className={FIELD_WIDTH}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                        {definition.options.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectPopup>
                </Select>
            );

        case "number": {
            const numeric = typeof value === "number" ? value : 0;
            return (
                <NumberField
                    className={FIELD_WIDTH}
                    value={numeric}
                    min={definition.min ?? undefined}
                    max={definition.max ?? undefined}
                    step={definition.step ?? undefined}
                    onValueChange={(next) => {
                        if (typeof next === "number") onChange(next);
                    }}
                >
                    <NumberFieldGroup>
                        <NumberFieldDecrement />
                        <NumberFieldInput />
                        <NumberFieldIncrement />
                    </NumberFieldGroup>
                </NumberField>
            );
        }

        case "string":
            return (
                <Input
                    className={FIELD_WIDTH}
                    value={String(value)}
                    onChange={(event) => onChange(event.target.value)}
                />
            );

        case "multilineString":
            return (
                <MultilineStringControl
                    value={String(value)}
                    onChange={(next) => onChange(next)}
                />
            );

        case "shortcut":
            return (
                <ShortcutControl
                    value={String(value)}
                    onChange={(next) => onChange(next)}
                />
            );
    }
}

/**
 * Multiline text control. Edits stay local while typing and persist on
 * blur: every persisted change rebuilds the merged excludes file and
 * refreshes all open repositories, so per-keystroke saves would refetch
 * status across every tab.
 */
function MultilineStringControl({
    value,
    onChange,
}: {
    value: string;
    onChange: (value: string) => void;
}) {
    const [draft, setDraft] = useState(value);
    const [editing, setEditing] = useState(false);
    const [syncedValue, setSyncedValue] = useState(value);

    // Adopt outside changes (e.g. the canonical snapshot after a save)
    // while the user is not typing. Done during render so no effect is
    // needed to stay in sync.
    if (value !== syncedValue && !editing) {
        setSyncedValue(value);
        setDraft(value);
    }

    return (
        <Textarea
            className={cn("min-h-24", FIELD_WIDTH)}
            rows={6}
            spellCheck={false}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => setEditing(true)}
            onBlur={() => {
                setEditing(false);
                if (draft !== value) {
                    onChange(draft);
                }
            }}
        />
    );
}
