import { validateHotkey } from "@tanstack/hotkeys";
import type { HotkeyOptions, RegisterableHotkey } from "@tanstack/hotkeys";
import { useHotkey } from "@tanstack/react-hotkeys";

import type { ShortcutSettingKey } from "@/lib/settings/settings.generated";

import { useSettingValue } from "./use-setting";

interface UseSettingHotkeyOptions extends Omit<HotkeyOptions, "target"> {
    enabled?: boolean;
}

/** Registers the hotkey stored under a shortcut setting; an empty or
 * invalid binding disables registration (a cleared setting simply unbinds). */
export function useSettingHotkey(
    key: ShortcutSettingKey,
    callback: (event: KeyboardEvent) => void,
    options: UseSettingHotkeyOptions = {}
): void {
    const binding = useSettingValue(key);
    const { enabled = true, ...rest } = options;

    const valid = validateHotkey(binding).valid;
    // The fallback dummy needs a cast (bare strings aren't assignable to
    // RegisterableHotkey) and is never active: enabled gates registration.
    const safeBinding = (
        valid ? binding : { key: "F24" }
    ) as RegisterableHotkey;

    useHotkey(safeBinding, callback, {
        ...rest,
        enabled: valid && enabled,
    });
}
