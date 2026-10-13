/**
 * Hand-maintained twin of the Rust types that cross the IPC boundary.
 *
 * Nothing here is generated except `settings.generated.ts`, which narrows
 * this file's setting values to real keys. Keep the `camelCase` field names
 * in sync with the `#[serde(rename_all = "camelCase")]` structs in
 * `crates/core/src/api` and `crates/tauri/src/settings`.
 */

export interface SerializedError {
    code: string;
    message: string;
    retryable: boolean;
    detail?: string;
}

export interface AppInfo {
    name: string;
    version: string;
    identifier: string;
    os: string;
    arch: string;
    tauriVersion: string;
}

export interface EchoRequest {
    message: string;
}

export interface EchoResult {
    message: string;
    /** Character count, not byte count. */
    length: number;
}

export interface SelectOption {
    value: string;
    label: string;
}

/** Raw setting payload as it crosses the IPC boundary. */
export type SettingValue = boolean | number | string | string[];

interface SettingDefinitionBase {
    /** Stable camelCase key; also the key inside the values file. */
    key: string;
    label: string;
    description?: string;
    defaultValue: SettingValue;
    /** Hidden settings are persisted but never rendered in the UI. */
    hidden: boolean;
}

/**
 * Discriminated union matching Rust's flattened `SettingType`. Renderers
 * switch on `kind` to pick a control.
 */
export type SettingDefinition =
    | (SettingDefinitionBase & { kind: "boolean" })
    | (SettingDefinitionBase & { kind: "select"; options: SelectOption[] })
    | (SettingDefinitionBase & {
          kind: "number";
          min: number | null;
          max: number | null;
          step: number | null;
      })
    | (SettingDefinitionBase & { kind: "string" })
    | (SettingDefinitionBase & { kind: "multilineString" })
    | (SettingDefinitionBase & { kind: "shortcut" })
    | (SettingDefinitionBase & { kind: "stringList" });

export interface SettingsSection {
    id: string;
    title: string;
    settings: SettingDefinition[];
}

export interface SettingsTab {
    id: string;
    label: string;
    sections: SettingsSection[];
}

export interface SettingsSchema {
    tabs: SettingsTab[];
}

export interface ValuesSnapshot {
    /**
     * Merged stored-or-default values for every schema key. Shape matches
     * the generated `SettingsValues` interface exactly.
     */
    values: Record<string, SettingValue>;
    /** Keys explicitly present in the persisted file. */
    savedKeys: string[];
}

export interface SettingsSnapshot extends ValuesSnapshot {
    schema: SettingsSchema;
}

/**
 * A tab as persisted in the session document. `title` and `lastResolvedHref`
 * rebuild the tab's route; `titleBadge` is the registry key, since a
 * component reference cannot survive a restart.
 */
export interface PersistedTab {
    tabId: string;
    title: string;
    lastResolvedHref?: string;
    titleBadge?: string;
}

/**
 * The whole UI state, persisted by the backend to disk. The Rust side
 * round-trips the document as opaque JSON, so additive optional fields are
 * tolerated by older builds.
 */
export interface SessionDocument {
    version: number;
    tabs: PersistedTab[];
    activeTabId: string | null;
}
