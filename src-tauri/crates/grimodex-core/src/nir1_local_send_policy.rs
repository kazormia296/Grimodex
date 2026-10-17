//! AI usage policy check of the NIR-1 local generation routes (K5/3, B-2).
//!
//! A pure function that decides whether the stored `projects.ai_policy` of the
//! conversation's project allows one purpose of the local send route:
//!
//! - Writing needs `chat` and `bodyWrite`;
//! - Review needs `chat` and `analysis`.
//!
//! `structureWrite` and `knowledgeWrite` are never looked at: this route writes
//! neither structure nor knowledge.
//!
//! This function is independent of [`crate::policy`] on purpose. The existing
//! parsers fall back to the documented default (full) for malformed input; the
//! local send route must not inherit that. Only an absent input (`None`, which
//! the database column cannot produce because it is `NOT NULL`) is the default
//! and is allowed. Every other value that cannot be read, a missing required
//! toggle and a toggle that is not a boolean all deny, so the caller sends
//! nothing (fail-closed). The existing parsers and their fixture are unchanged.
//!
//! The decision carries its basis (the purpose and the names and values of the
//! items that were looked at) so the audit can record it. The basis explains a
//! decision; it never authorizes one.

use serde::Serialize;

/// Largest `ai_policy` text this check reads. A real policy is about 150 bytes.
/// The database reader tests the stored length with this constant before it
/// loads the value, so a hostile row cannot make the check allocate; the
/// function denies anything larger as well. Exceeding it only ever denies.
pub const NIR1_LOCAL_SEND_POLICY_MAX_BYTES: usize = 64 * 1024;

/// Names of the toggles that every readable policy must declare as booleans.
const REQUIRED_TOGGLES: [&str; 3] = ["chat", "bodyWrite", "analysis"];
const VALID_PRESETS: [&str; 5] = ["full", "assist-off", "review-only", "off", "custom"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Nir1LocalSendPurpose {
    Writing,
    Review,
}

impl Nir1LocalSendPurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Writing => "writing",
            Self::Review => "review",
        }
    }

    /// The two items this purpose looks at, in the order they are checked.
    pub fn required_items(self) -> [&'static str; 2] {
        match self {
            Self::Writing => ["chat", "bodyWrite"],
            Self::Review => ["chat", "analysis"],
        }
    }
}

/// Where the decision's input came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Nir1LocalSendPolicySource {
    /// The input was absent (`None`): the documented default (full).
    DefaultUnset,
    /// The input was a stored value that was read.
    Stored,
}

impl Nir1LocalSendPolicySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DefaultUnset => "default-unset",
            Self::Stored => "stored",
        }
    }
}

/// One item the decision looked at and the boolean it found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Nir1LocalSendPolicyItem {
    pub name: &'static str,
    pub value: bool,
}

/// Why a decision allowed. Recorded in the audit; never used to authorize.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1LocalSendPolicyBasis {
    pub purpose: Nir1LocalSendPurpose,
    pub source: Nir1LocalSendPolicySource,
    pub items: [Nir1LocalSendPolicyItem; 2],
}

/// Why a decision denied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Nir1LocalSendPolicyDenial {
    /// The stored text is longer than [`NIR1_LOCAL_SEND_POLICY_MAX_BYTES`].
    TooLarge,
    /// The stored value is not valid text (NULL, a number or a blob).
    NotText,
    /// Empty or whitespace only.
    Blank,
    NotJson,
    /// Valid JSON whose root is not an object.
    NotObject,
    /// `preset` is missing, not a string, or not one of the five presets.
    PresetInvalid,
    /// `toggles` is missing or not an object.
    TogglesNotObject,
    /// A required toggle is missing.
    ToggleMissing(&'static str),
    /// A required toggle is not a boolean.
    ToggleNotBoolean(&'static str),
    /// The policy is readable and this purpose's item is false.
    ItemDisabled(&'static str),
}

impl Nir1LocalSendPolicyDenial {
    /// Stable code. Pinned by the decision vectors.
    pub fn code(self) -> &'static str {
        match self {
            Self::TooLarge => "too-large",
            Self::NotText => "not-text",
            Self::Blank => "blank",
            Self::NotJson => "not-json",
            Self::NotObject => "not-object",
            Self::PresetInvalid => "preset-invalid",
            Self::TogglesNotObject => "toggles-not-object",
            Self::ToggleMissing(_) => "toggle-missing",
            Self::ToggleNotBoolean(_) => "toggle-not-boolean",
            Self::ItemDisabled(_) => "item-disabled",
        }
    }

    /// The toggle the denial is about, when there is one.
    pub fn item(self) -> Option<&'static str> {
        match self {
            Self::ToggleMissing(name) | Self::ToggleNotBoolean(name) | Self::ItemDisabled(name) => {
                Some(name)
            }
            _ => None,
        }
    }

    /// Whether the stored value could not be read as a policy (as opposed to a
    /// readable policy that turned this purpose off).
    pub fn is_unreadable(self) -> bool {
        !matches!(self, Self::ItemDisabled(_))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use]
pub enum Nir1LocalSendPolicyDecision {
    Allowed(Nir1LocalSendPolicyBasis),
    Denied(Nir1LocalSendPolicyDenial),
}

impl Nir1LocalSendPolicyDecision {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allowed(_))
    }
}

/// Decide one purpose. `None` is the documented default and allows; the
/// database never supplies it. Everything else follows the rules in the module
/// documentation, and any problem denies.
pub fn decide(raw: Option<&str>, purpose: Nir1LocalSendPurpose) -> Nir1LocalSendPolicyDecision {
    let basis_of = |source, values: [bool; 2]| {
        let names = purpose.required_items();
        Nir1LocalSendPolicyBasis {
            purpose,
            source,
            items: [
                Nir1LocalSendPolicyItem {
                    name: names[0],
                    value: values[0],
                },
                Nir1LocalSendPolicyItem {
                    name: names[1],
                    value: values[1],
                },
            ],
        }
    };
    let Some(raw) = raw else {
        return Nir1LocalSendPolicyDecision::Allowed(basis_of(
            Nir1LocalSendPolicySource::DefaultUnset,
            [true, true],
        ));
    };
    match read_toggles(raw) {
        Err(denial) => Nir1LocalSendPolicyDecision::Denied(denial),
        Ok(toggles) => {
            let value_of = |name: &str| {
                REQUIRED_TOGGLES
                    .iter()
                    .position(|candidate| *candidate == name)
                    .map(|index| toggles[index])
                    .unwrap_or(false)
            };
            let names = purpose.required_items();
            let values = [value_of(names[0]), value_of(names[1])];
            for (name, value) in names.iter().zip(values) {
                if !value {
                    return Nir1LocalSendPolicyDecision::Denied(
                        Nir1LocalSendPolicyDenial::ItemDisabled(name),
                    );
                }
            }
            Nir1LocalSendPolicyDecision::Allowed(basis_of(
                Nir1LocalSendPolicySource::Stored,
                values,
            ))
        }
    }
}

/// The three required toggles, in [`REQUIRED_TOGGLES`] order, or the reason the
/// text is not a readable policy.
fn read_toggles(raw: &str) -> Result<[bool; 3], Nir1LocalSendPolicyDenial> {
    use Nir1LocalSendPolicyDenial as Denial;
    if raw.len() > NIR1_LOCAL_SEND_POLICY_MAX_BYTES {
        return Err(Denial::TooLarge);
    }
    if raw.trim().is_empty() {
        return Err(Denial::Blank);
    }
    let root: serde_json::Value = serde_json::from_str(raw).map_err(|_| Denial::NotJson)?;
    let root = root.as_object().ok_or(Denial::NotObject)?;
    let preset_valid = root
        .get("preset")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|preset| VALID_PRESETS.contains(&preset));
    if !preset_valid {
        return Err(Denial::PresetInvalid);
    }
    let toggles = root
        .get("toggles")
        .and_then(serde_json::Value::as_object)
        .ok_or(Denial::TogglesNotObject)?;
    let mut values = [false; 3];
    for (index, name) in REQUIRED_TOGGLES.iter().enumerate() {
        values[index] = match toggles.get(*name) {
            None => return Err(Denial::ToggleMissing(name)),
            Some(serde_json::Value::Bool(value)) => *value,
            Some(_) => return Err(Denial::ToggleNotBoolean(name)),
        };
    }
    Ok(values)
}

#[cfg(test)]
mod tests;
