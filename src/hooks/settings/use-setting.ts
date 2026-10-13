import { useSelector } from "@tanstack/react-store";
import { useCallback } from "react";

import type {
    SettingDefinition,
    SettingsSchema,
    SettingsSection,
} from "@/lib/backend/protocol";
import type {
    SettingKey,
    SettingsValues,
} from "@/lib/settings/settings.generated";
import { getSetting, setSetting, settingsStore } from "@/stores/settings-store";

/**
 * Typed reactive read/write for one setting: writes apply synchronously to
 * the store; persistence is coalesced and serialized in the background.
 */
export function useSetting<TKey extends SettingKey>(
    key: TKey
): {
    value: SettingsValues[TKey];
    setValue: (value: SettingsValues[TKey]) => void;
} {
    const value = useSettingValue(key);
    const setValue = useCallback(
        (next: SettingsValues[TKey]) => setSetting(key, next),
        [key]
    );

    return { value, setValue };
}

/** Reactive read of one setting value; throws before initialization. */
export function useSettingValue<TKey extends SettingKey>(
    key: TKey
): SettingsValues[TKey] {
    return useSelector(settingsStore, (state) => {
        if (!state.ready) {
            throw new Error(
                `setting \`${key}\` read before settings were initialized`
            );
        }
        return state.values[key];
    });
}

export function useSettingsSchema(): SettingsSchema {
    return useSelector(settingsStore, (state) => state.schema);
}

export type VisibleSettingDefinition = Extract<
    SettingDefinition,
    {
        kind:
            | "boolean"
            | "select"
            | "number"
            | "string"
            | "multilineString"
            | "shortcut";
    }
>;

/** Filters out hidden definitions and kinds the UI cannot render. */
export function visibleSettings(
    section: SettingsSection
): VisibleSettingDefinition[] {
    return section.settings.filter(
        (definition): definition is VisibleSettingDefinition =>
            !definition.hidden && definition.kind !== "stringList"
    );
}

export { getSetting };
