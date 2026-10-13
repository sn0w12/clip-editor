//! Settings model shared by the schema definition, the persistence store,
//! and the TypeScript contract exporter. The schema is the single source of
//! truth: values travel as a generic validated map keyed by setting key.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// On-disk envelope version. Bump when the layout changes and add a
/// migration in [`super::store`].
pub const SETTINGS_VERSION: u32 = 1;

/// Merged setting values (stored-or-default) keyed by camelCase key.
pub type SettingsValues = BTreeMap<String, SettingValue>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingKind {
    Boolean,
    Select,
    Number,
    String,
    MultilineString,
    Shortcut,
    StringList,
}

/// The concrete type of a setting. Serialized as a flat discriminated
/// union (`{"kind": "select", "options": [...]}`) so the frontend can
/// render controls directly from it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SettingType {
    Boolean,
    Select {
        options: Vec<SelectOption>,
    },
    Number {
        min: Option<f64>,
        max: Option<f64>,
        step: Option<f64>,
    },
    String,
    MultilineString,
    Shortcut,
    StringList,
}

impl SettingType {
    pub fn kind(&self) -> SettingKind {
        match self {
            SettingType::Boolean => SettingKind::Boolean,
            SettingType::Select { .. } => SettingKind::Select,
            SettingType::Number { .. } => SettingKind::Number,
            SettingType::String => SettingKind::String,
            SettingType::MultilineString => SettingKind::MultilineString,
            SettingType::Shortcut => SettingKind::Shortcut,
            SettingType::StringList => SettingKind::StringList,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectOption {
    pub value: String,
    pub label: String,
}

impl SelectOption {
    pub fn new(value: &'static str, label: &'static str) -> Self {
        Self {
            value: value.to_owned(),
            label: label.to_owned(),
        }
    }
}

/// A stored setting value. Deserialized untagged from whatever JSON shape
/// matches; validated against the setting's [`SettingType`] before use.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SettingValue {
    Bool(bool),
    Number(f64),
    Str(String),
    StringList(Vec<String>),
}

impl SettingValue {
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            SettingValue::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            SettingValue::Number(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            SettingValue::Str(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_string_list(&self) -> Option<&[String]> {
        match self {
            SettingValue::StringList(values) => Some(values),
            _ => None,
        }
    }
}

/// One renderable/validated setting entry. `setting_type` is flattened so
/// the wire shape is `{ key, label, ..., kind, options?/min?/max?/step? }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingDefinition {
    /// Stable camelCase identifier; also the key inside the values file.
    pub key: &'static str,
    pub label: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<&'static str>,
    #[serde(flatten)]
    pub setting_type: SettingType,
    pub default_value: SettingValue,
    /// Hidden settings are persisted and hook-accessible but never rendered
    /// by the settings UI.
    pub hidden: bool,
}

impl SettingDefinition {
    pub fn new(key: &'static str, label: &'static str, setting_type: SettingType) -> Self {
        let default_value = match &setting_type {
            SettingType::Boolean => SettingValue::Bool(false),
            SettingType::Number { .. } => SettingValue::Number(0.0),
            SettingType::String | SettingType::MultilineString | SettingType::Shortcut => {
                SettingValue::Str(String::new())
            }
            SettingType::StringList => SettingValue::StringList(Vec::new()),
            SettingType::Select { options } => SettingValue::Str(
                options
                    .first()
                    .map_or_else(String::new, |o| o.value.clone()),
            ),
        };
        Self {
            key,
            label,
            description: None,
            setting_type,
            default_value,
            hidden: false,
        }
    }

    pub fn default_value(mut self, value: SettingValue) -> Self {
        self.default_value = value;
        self
    }

    pub fn description(mut self, description: &'static str) -> Self {
        self.description = Some(description);
        self
    }

    pub fn hidden(mut self) -> Self {
        self.hidden = true;
        self
    }

    /// Validates `value` against this definition, returning a normalized
    /// value (numbers are clamped into range).
    pub fn validate(&self, value: SettingValue) -> Result<SettingValue, String> {
        match &self.setting_type {
            SettingType::Boolean => match value {
                SettingValue::Bool(_) => Ok(value),
                other => Err(format!("expected boolean, got {}", other.kind_name())),
            },
            SettingType::Select { options } => {
                let raw = value
                    .as_str()
                    .ok_or_else(|| format!("expected string, got {}", value.kind_name()))?;
                if options.iter().any(|option| option.value == raw) {
                    Ok(SettingValue::Str(raw.to_owned()))
                } else {
                    Err(format!("`{raw}` is not a valid option"))
                }
            }
            SettingType::Number { min, max, .. } => {
                let mut number = value
                    .as_f64()
                    .ok_or_else(|| format!("expected number, got {}", value.kind_name()))?;
                if !number.is_finite() {
                    return Err("number must be finite".to_owned());
                }
                if let Some(min) = min {
                    number = number.max(*min);
                }
                if let Some(max) = max {
                    number = number.min(*max);
                }
                Ok(SettingValue::Number(number))
            }
            SettingType::String | SettingType::MultilineString => match value {
                SettingValue::Str(_) => Ok(value),
                other => Err(format!("expected string, got {}", other.kind_name())),
            },
            SettingType::Shortcut => {
                let raw = value
                    .as_str()
                    .ok_or_else(|| format!("expected string, got {}", value.kind_name()))?
                    .trim();
                validate_shortcut(raw)?;
                Ok(SettingValue::Str(raw.to_owned()))
            }
            SettingType::StringList => match value {
                SettingValue::StringList(items) if items.iter().all(|item| !item.is_empty()) => {
                    Ok(SettingValue::StringList(items))
                }
                SettingValue::StringList(_) => {
                    Err("list items must be non-empty strings".to_owned())
                }
                other => Err(format!("expected string[], got {}", other.kind_name())),
            },
        }
    }
}

const SHORTCUT_MODIFIERS: [&str; 5] = ["mod", "ctrl", "alt", "shift", "meta"];

fn validate_shortcut(raw: &str) -> Result<(), String> {
    // An empty shortcut means "unbound" and is always valid.
    if raw.is_empty() {
        return Ok(());
    }

    let parts: Vec<&str> = raw.split('+').map(str::trim).collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err("empty chord segment".to_owned());
    }
    let (modifiers, key) = parts.split_at(parts.len() - 1);
    for modifier in modifiers {
        if !SHORTCUT_MODIFIERS.contains(&modifier.to_lowercase().as_str()) {
            return Err(format!("unknown modifier `{modifier}`"));
        }
    }
    let key = key[0];
    if SHORTCUT_MODIFIERS.contains(&key.to_lowercase().as_str()) {
        return Err("shortcut must end with a key, not a modifier".to_owned());
    }
    Ok(())
}

impl SettingValue {
    fn kind_name(&self) -> &'static str {
        match self {
            SettingValue::Bool(_) => "boolean",
            SettingValue::Number(_) => "number",
            SettingValue::Str(_) => "string",
            SettingValue::StringList(_) => "string[]",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSection {
    pub id: &'static str,
    pub title: &'static str,
    pub settings: Vec<SettingDefinition>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsTab {
    pub id: &'static str,
    pub label: &'static str,
    pub sections: Vec<SettingsSection>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSchema {
    pub tabs: Vec<SettingsTab>,
}

impl SettingsSchema {
    /// Iterator over every definition in schema order.
    pub fn definitions(&self) -> impl Iterator<Item = &SettingDefinition> {
        self.tabs
            .iter()
            .flat_map(|tab| tab.sections.iter())
            .flat_map(|section| section.settings.iter())
    }

    pub fn find(&self, key: &str) -> Option<&SettingDefinition> {
        self.definitions().find(|definition| definition.key == key)
    }

    /// Asserts schema invariants; called on construction and in tests.
    pub fn validate_invariants(&self) -> Result<(), String> {
        let mut seen = std::collections::HashSet::new();
        for definition in self.definitions() {
            if !seen.insert(definition.key) {
                return Err(format!("duplicate setting key `{}`", definition.key));
            }
            definition
                .validate(definition.default_value.clone())
                .map_err(|reason| format!("default for `{}` invalid: {reason}", definition.key))?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub schema: SettingsSchema,
    /// Merged values (stored-or-default) for every schema key. Serialized
    /// as a plain camelCase object matching the generated TS interface.
    pub values: SettingsValues,
    /// Keys explicitly present in the persisted file (used by one-time
    /// frontend migrations to distinguish "user picked" from "default").
    pub saved_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValuesSnapshot {
    pub values: SettingsValues,
    pub saved_keys: Vec<String>,
}
