//! The fixed-size history slots of `AttemptBinding` v2 (K4/3 section 2).
//!
//! `historyTurnContext` and `durableWorkspaceIdentity` are the two slots DT-3
//! reserved. A turn's context is one value built from digests, integers and
//! closed enums only, so its size depends on the set of fields and never on an
//! identifier's length or on the number of inputs. The context never carries
//! authority: it is compared by a later history reader, not trusted.
//!
//! The slot has three stored forms plus one read-only form:
//! - JSON `null` (`None` in `AttemptBinding`): written before HS-1 or by
//!   test-support; not usable as history.
//! - [`HistoryContextSlot::Unavailable`]: a closed reason only; not usable.
//! - [`HistoryContextSlot::Context`]: a [`HistoryTurnContextV1`].
//! - [`HistoryContextSlot::UnknownContract`]: a slot whose `contract` names a
//!   version this build does not know. It is read so that claim and recovery
//!   keep working and a history reader can exclude the candidate; it is never
//!   written and its content is not kept.
//!
//! Every shape that is not one of these (an unknown field, a wrong type, an
//! unknown enum value or reason, a malformed digest, an integer outside the
//! canonical-JSON safe range) is a parse failure of the whole binding.

use anyhow::{Context, Result};
use grimodex_core::{canonical_json_digest, canonical_json_string};
use serde::{de, ser, Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Map, Value};
use std::fmt;
use std::path::Path;

/// The only context contract this build writes.
pub const HISTORY_TURN_CONTEXT_CONTRACT: &str = "nir1-history-turn-context/1";

/// How long an attempt stays eligible as history (K4/3 section 7): 30 days.
/// Shortening it is a technical decision of the integrator; lengthening it
/// needs a new confirmed draftRef.
pub const HISTORY_ELIGIBILITY_WINDOW_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// The largest integer canonical JSON (an ECMAScript number domain) writes and
/// reads back unchanged: 2^53 - 1. A larger value would be rounded by the
/// canonicalizer and the stored binding would no longer equal the written one.
pub const HISTORY_MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

const SLOT_INVALID_ERROR: &str = "NIR1_GENERATION_HISTORY_SLOT_INVALID";
const DIGEST_INVALID_ERROR: &str = "NIR1_GENERATION_INVALID_DIGEST";
const INTEGER_RANGE_ERROR: &str = "NIR1_GENERATION_HISTORY_INTEGER_RANGE";
/// Returned when a slot that cannot be written (an unknown contract) is
/// serialized or validated for a write.
pub(super) const SLOT_UNWRITABLE_ERROR: &str = "NIR1_GENERATION_HISTORY_SLOT_UNWRITABLE";

/// A non-negative integer in the canonical-JSON safe range.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct HistoryInt(u64);

impl HistoryInt {
    pub const MAX: Self = Self(HISTORY_MAX_SAFE_INTEGER);

    pub fn new(value: u64) -> Result<Self> {
        anyhow::ensure!(value <= HISTORY_MAX_SAFE_INTEGER, "{INTEGER_RANGE_ERROR}");
        Ok(Self(value))
    }

    pub fn from_i64(value: i64) -> Result<Self> {
        Self::new(u64::try_from(value).context(INTEGER_RANGE_ERROR)?)
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

impl Serialize for HistoryInt {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_u64(self.0)
    }
}

impl<'de> Deserialize<'de> for HistoryInt {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        Self::new(u64::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

/// The domain a variable-length value is hashed under. Every value is hashed
/// as canonical JSON `{"domain": <domain>, "value": <string>}`, so equal
/// strings under different domains never produce the same digest.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoryDigestDomain {
    RestoreEpochId,
    WorkspaceId,
    CanonicalLocator,
    ScopeBindingToken,
    ReadingRef,
    StoryRef,
    StoryRawKey,
    PovCharacter,
    PrincipalCharacter,
    TimelineRef,
    WorldlineRef,
    NarrativeLayerRef,
}

impl HistoryDigestDomain {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RestoreEpochId => "nir1-history-turn-context@1/restore-epoch-id",
            Self::WorkspaceId => "nir1-history-turn-context@1/workspace-id",
            Self::CanonicalLocator => "nir1-history-turn-context@1/canonical-locator",
            Self::ScopeBindingToken => "nir1-history-turn-context@1/scope-binding-token",
            Self::ReadingRef => "nir1-history-turn-context@1/reading-ref",
            Self::StoryRef => "nir1-history-turn-context@1/story-ref",
            Self::StoryRawKey => "nir1-history-turn-context@1/story-raw-key",
            Self::PovCharacter => "nir1-history-turn-context@1/pov-character",
            Self::PrincipalCharacter => "nir1-history-turn-context@1/principal-character",
            Self::TimelineRef => "nir1-history-turn-context@1/timeline-ref",
            Self::WorldlineRef => "nir1-history-turn-context@1/worldline-ref",
            Self::NarrativeLayerRef => "nir1-history-turn-context@1/narrative-layer-ref",
        }
    }
}

/// `sha256:` and 64 lower-case hex digits (71 bytes).
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct HistoryDigest(String);

impl HistoryDigest {
    /// Hash `value` under `domain`.
    pub fn of(domain: HistoryDigestDomain, value: &str) -> Result<Self> {
        Ok(Self(canonical_json_digest(&json!({
            "domain": domain.as_str(),
            "value": value,
        }))?))
    }

    /// Accept an already computed digest (for example the D1 selection
    /// digest) after checking its shape.
    pub fn parse(value: &str) -> Result<Self> {
        anyhow::ensure!(is_digest_shape(value), "{DIGEST_INVALID_ERROR}");
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn is_digest_shape(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}

impl Serialize for HistoryDigest {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for HistoryDigest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(de::Error::custom)
    }
}

/// `contract` of a known slot. It serializes as the contract string and every
/// other string fails to deserialize (an unknown version is routed to
/// [`HistoryContextSlot::UnknownContract`] before this type is reached).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HistoryContextContract;

impl Serialize for HistoryContextContract {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(HISTORY_TURN_CONTEXT_CONTRACT)
    }
}

impl<'de> Deserialize<'de> for HistoryContextContract {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value == HISTORY_TURN_CONTEXT_CONTRACT {
            Ok(Self)
        } else {
            Err(de::Error::custom(SLOT_INVALID_ERROR))
        }
    }
}

/// K4/3 section 2: `local-only` is the only classification a context records.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistorySendClassification {
    LocalOnly,
}

/// The project's current semantic epoch: the digest of its id and its number.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryRestoreEpoch {
    pub id_digest: HistoryDigest,
    pub number: HistoryInt,
}

/// The target Scene's Scope binding: the digest of its token and its version.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryTargetScope {
    pub binding_token_digest: HistoryDigest,
    pub version: HistoryInt,
}

/// One axis: a value or a closed reason it is unavailable. Externally tagged,
/// so a stored value has exactly one of the two keys.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryAxis<T, R> {
    Present(T),
    Unavailable(R),
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryReadingOrder {
    pub reading_ref_digest: HistoryDigest,
    /// The live project Scope authority's reading rank of the target Scene.
    pub rank: HistoryInt,
}

/// The target Scene's own story key, as the live project Scope authority
/// resolved it (unique in the project). Neither the story rank nor the
/// authority revision is recorded.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryStoryTime {
    pub story_ref_digest: HistoryDigest,
    pub raw_key_digest: HistoryDigest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryViewpoint {
    pub pov_digest: HistoryDigest,
}

/// A knowledge holder or an audience of an explicit Scope binding.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryPrincipal {
    Reader,
    Character(HistoryDigest),
}

/// An Exact timeline, worldline or narrative-layer reference.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryScopeRef {
    pub ref_digest: HistoryDigest,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryPhaseSetting {
    Reading,
    Story,
    Auto,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryEffectiveAxis {
    Reading,
    Story,
}

/// Why the resolver fell back to the reading axis (ADR-002).
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryAutoFallback {
    AutoIncompleteStoryCoverage,
    StoryCurrentUnresolved,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryAuto {
    pub setting: HistoryPhaseSetting,
    pub axis: HistoryEffectiveAxis,
    pub fallback: Option<HistoryAutoFallback>,
}

/// The target Scene is not in the live project Scope authority's mapping
/// (including a Scene under an archived ancestor folder).
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryReadingOrderUnavailable {
    SceneNotInAuthorityMapping,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryStoryTimeUnavailable {
    SceneNotInAuthorityMapping,
    /// The Scene has no story key (NULL).
    KeyNotProvided,
    /// The key repeats in the project (a Chronicle stamp included).
    KeyAmbiguous,
    /// Only an inherited (forward-filled) position exists.
    InheritedOnly,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryViewpointUnavailable {
    /// The Scene has no POV (NULL).
    NotProvided,
    /// `read_scene_viewpoint` refused the POV: another project, not a
    /// character, or hidden/suppressed. The reader reports these as one error.
    NotVisibleCharacter,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryPrincipalUnavailable {
    BindingNotExplicit,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryScopeRefUnavailable {
    Unresolved,
    Any,
    BindingNotExplicit,
}

/// `current-scene-missing` of the resolver.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryAutoUnavailable {
    SceneNotInAuthorityMapping,
}

/// The nine axes of K4/3 section 4 (the eight explicit axes and `auto`).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryAxes {
    pub reading_order: HistoryAxis<HistoryReadingOrder, HistoryReadingOrderUnavailable>,
    pub story_time: HistoryAxis<HistoryStoryTime, HistoryStoryTimeUnavailable>,
    pub viewpoint: HistoryAxis<HistoryViewpoint, HistoryViewpointUnavailable>,
    pub knowledge_holder: HistoryAxis<HistoryPrincipal, HistoryPrincipalUnavailable>,
    pub audience: HistoryAxis<HistoryPrincipal, HistoryPrincipalUnavailable>,
    pub timeline: HistoryAxis<HistoryScopeRef, HistoryScopeRefUnavailable>,
    pub worldline: HistoryAxis<HistoryScopeRef, HistoryScopeRefUnavailable>,
    pub narrative_layer: HistoryAxis<HistoryScopeRef, HistoryScopeRefUnavailable>,
    pub auto: HistoryAxis<HistoryAuto, HistoryAutoUnavailable>,
}

/// The token estimator a D1 selection was made with. A closed enum rather
/// than a string, so the slot stays fixed-size; a new estimator is a new
/// variant (and a new contract version if old readers must refuse it).
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum HistoryEstimatorVersion {
    #[serde(rename = "nir1-context-estimator-v1")]
    Nir1ContextEstimatorV1,
}

impl HistoryEstimatorVersion {
    /// The enum value of an estimator version string, or `None` if this
    /// build does not know it.
    pub fn from_wire(value: &str) -> Option<Self> {
        match value {
            "nir1-context-estimator-v1" => Some(Self::Nir1ContextEstimatorV1),
            _ => None,
        }
    }

    pub fn as_wire(self) -> &'static str {
        match self {
            Self::Nir1ContextEstimatorV1 => "nir1-context-estimator-v1",
        }
    }
}

/// The D1 selection fields of K4/3 section 2: with the stored input rows they
/// recompute the selection digest.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryD1Selection {
    pub selection_digest: HistoryDigest,
    pub estimator_version: HistoryEstimatorVersion,
    pub selector_budget_tokens: HistoryInt,
    pub used_tokens: HistoryInt,
    pub remaining_tokens: HistoryInt,
}

/// The per-turn context. It deliberately has no caller, profile, workspace
/// binding digest, route, provider, model, endpoint, material digest or scope
/// digest: those are process-local or request-local values that K4/3 section
/// 4 says are not compared as the turn's context.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryTurnContextV1 {
    pub contract: HistoryContextContract,
    pub send_classification: HistorySendClassification,
    /// `created_at_ms` + 30 days. The builder leaves it `0`; the storage
    /// writer sets it from the stored row's `created_at_ms`.
    pub eligible_until_ms: HistoryInt,
    pub restore_epoch: HistoryRestoreEpoch,
    pub target: HistoryTargetScope,
    pub axes: HistoryAxes,
    pub d1: HistoryD1Selection,
}

/// Why a slot is unavailable. The closed set of K4/3 section 2.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HistoryUnavailableReason {
    /// The D-final output violates the completeness rule.
    DFinalIncomplete,
    /// The two slots would put `binding_json` over 64 KiB.
    BindingLimit,
    /// The workspace id or the canonical locator could not be determined.
    WorkspaceIdentityUnavailable,
    /// The project has no semantic epoch.
    RestoreEpochUnavailable,
    /// The target Scene's Scope binding is unreadable or not explicit.
    SceneScopeUnavailable,
    /// `created_at_ms` plus the eligibility window is out of range.
    EligibilityOverflow,
}

/// `historyTurnContext` when it is not JSON `null`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HistoryContextSlot {
    Unavailable(HistoryUnavailableReason),
    Context(Box<HistoryTurnContextV1>),
    /// A slot of a contract version this build does not know. Read-only.
    UnknownContract,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UnavailableSlotWire {
    contract: HistoryContextContract,
    unavailable: HistoryUnavailableReason,
}

impl HistoryContextSlot {
    pub fn is_context(&self) -> bool {
        matches!(self, Self::Context(_))
    }
}

/// Why a history reader does not use an attempt, decided from the
/// `historyTurnContext` slot alone and before any reference row is read
/// (K4/3 section 2: legacy and context-less attempts are read for
/// terminalization and recovery, never as history). A closed set with no
/// plaintext.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HistoryContextGateReason {
    /// The slot is JSON null: written before HS-1 or by test-support.
    Missing,
    /// The slot's contract is a version this build does not know.
    UnknownContract,
    /// The writer or builder recorded a closed unavailable reason.
    Unavailable(HistoryUnavailableReason),
}

impl HistoryContextGateReason {
    /// `None` when the slot is a context of the known version.
    pub fn of(slot: Option<&HistoryContextSlot>) -> Option<Self> {
        match slot {
            None => Some(Self::Missing),
            Some(HistoryContextSlot::UnknownContract) => Some(Self::UnknownContract),
            Some(HistoryContextSlot::Unavailable(reason)) => Some(Self::Unavailable(*reason)),
            Some(HistoryContextSlot::Context(_)) => None,
        }
    }
}

impl Serialize for HistoryContextSlot {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Unavailable(reason) => UnavailableSlotWire {
                contract: HistoryContextContract,
                unavailable: *reason,
            }
            .serialize(serializer),
            Self::Context(context) => context.serialize(serializer),
            Self::UnknownContract => Err(ser::Error::custom(SLOT_UNWRITABLE_ERROR)),
        }
    }
}

/// A JSON object whose keys are checked for duplicates at its top level.
struct StrictObject(Map<String, Value>);

impl<'de> Deserialize<'de> for StrictObject {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct ObjectVisitor;
        impl<'de> de::Visitor<'de> for ObjectVisitor {
            type Value = StrictObject;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a history slot object")
            }

            fn visit_map<A: de::MapAccess<'de>>(
                self,
                mut access: A,
            ) -> std::result::Result<StrictObject, A::Error> {
                let mut object = Map::new();
                while let Some((key, value)) = access.next_entry::<String, Value>()? {
                    if object.insert(key, value).is_some() {
                        return Err(de::Error::custom(SLOT_INVALID_ERROR));
                    }
                }
                Ok(StrictObject(object))
            }
        }
        deserializer.deserialize_map(ObjectVisitor)
    }
}

impl<'de> Deserialize<'de> for HistoryContextSlot {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let object = StrictObject::deserialize(deserializer)?.0;
        // The contract decides how the rest is read. An object without a
        // string contract is not a slot of any version.
        match object.get("contract") {
            Some(Value::String(contract)) if contract != HISTORY_TURN_CONTEXT_CONTRACT => {
                return Ok(Self::UnknownContract);
            }
            Some(Value::String(_)) => {}
            _ => return Err(de::Error::custom(SLOT_INVALID_ERROR)),
        }
        let unavailable = object.contains_key("unavailable");
        let value = Value::Object(object);
        if unavailable {
            let wire = UnavailableSlotWire::deserialize(value).map_err(de::Error::custom)?;
            Ok(Self::Unavailable(wire.unavailable))
        } else {
            let context = HistoryTurnContextV1::deserialize(value).map_err(de::Error::custom)?;
            Ok(Self::Context(Box::new(context)))
        }
    }
}

/// `durableWorkspaceIdentity` (K4/3 section 7): the digest of the workspace id
/// and the digest of the canonical locator. `authority_instance` and
/// `recovery_generation` are process-local and are not part of it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurableWorkspaceIdentity {
    pub workspace_id_digest: HistoryDigest,
    pub canonical_locator_digest: HistoryDigest,
}

impl DurableWorkspaceIdentity {
    /// `canonical_locator` is the OS-canonicalized root path as a Unicode
    /// string. The path itself is hashed and dropped; it is never stored.
    pub fn from_parts(workspace_id: &str, canonical_locator: &str) -> Result<Self> {
        Ok(Self {
            workspace_id_digest: HistoryDigest::of(HistoryDigestDomain::WorkspaceId, workspace_id)?,
            canonical_locator_digest: HistoryDigest::of(
                HistoryDigestDomain::CanonicalLocator,
                canonical_locator,
            )?,
        })
    }
}

impl DurableWorkspaceIdentity {
    /// The identity of the workspace rooted at `root`. This is the single
    /// computation for the durable workspace identity (K4/3 section 7); CB-4
    /// (declaration invalidation) shares it through `canonical_locator_digest`.
    ///
    /// `None` is "unavailable": an empty workspace id, a root the OS cannot
    /// canonicalize, or a canonical path that is not valid Unicode. Nothing
    /// is lossily converted, and the path text is hashed and dropped.
    pub fn from_workspace_root(workspace_id: &str, root: &Path) -> Option<Self> {
        if workspace_id.trim().is_empty() {
            return None;
        }
        Some(Self {
            workspace_id_digest: HistoryDigest::of(HistoryDigestDomain::WorkspaceId, workspace_id)
                .ok()?,
            canonical_locator_digest: canonical_locator_digest(root)?,
        })
    }
}

/// The digest of `root` after the OS `canonicalize` (symlinks resolved; the
/// OS form is used as is, e.g. a Windows verbatim path or a macOS `/private`
/// path, with no prefix added or removed). `None` when canonicalize fails or
/// the result is not valid Unicode. The path text is neither stored nor
/// logged.
pub fn canonical_locator_digest(root: &Path) -> Option<HistoryDigest> {
    let canonical = std::fs::canonicalize(root).ok()?;
    let text = canonical.to_str()?;
    HistoryDigest::of(HistoryDigestDomain::CanonicalLocator, text).ok()
}

/// `eligibleUntilMs` of an attempt stored at `created_at_ms`: the row's time
/// plus the 30-day window. `None` if it overflows or leaves the safe range.
pub fn eligible_until_ms(created_at_ms: i64) -> Option<HistoryInt> {
    if created_at_ms < 0 {
        return None;
    }
    let until = created_at_ms.checked_add(HISTORY_ELIGIBILITY_WINDOW_MS)?;
    HistoryInt::from_i64(until).ok()
}

/// The canonical JSON bytes of a slot value, as `binding_json` stores it.
pub fn canonical_slot_json<T: Serialize>(slot: &T) -> Result<String> {
    Ok(canonical_json_string(&serde_json::to_value(slot)?)?)
}

/// Fixtures shared with the storage tests of `nir1_generation`.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    pub(crate) fn digest(domain: HistoryDigestDomain, value: &str) -> HistoryDigest {
        HistoryDigest::of(domain, value).expect("test digest")
    }

    /// A complete context whose every axis is present. `id` is hashed under
    /// every ID-like domain, so a long `id` shows that size does not depend
    /// on it; `input_count` feeds the D1 selection digest.
    pub(crate) fn context_for(id: &str, input_count: usize) -> HistoryTurnContextV1 {
        let inputs: Vec<super::super::InputReference> = (0..input_count)
            .map(|ordinal| super::super::InputReference {
                role: super::super::InputRole::Context,
                target: super::super::InputTarget::RawSource {
                    source_key: format!("source-{ordinal}"),
                    revision_token: format!("revision-{ordinal}"),
                },
                input_use: super::super::InputUse::SelectedMaterial,
            })
            .collect();
        let selection = super::super::d1_selection_digest(
            &super::super::D1SelectionParameters {
                estimator_version: HistoryEstimatorVersion::Nir1ContextEstimatorV1
                    .as_wire()
                    .to_owned(),
                selector_budget_tokens: 1_000,
                used_tokens: 400,
                remaining_tokens: 600,
            },
            &inputs,
        )
        .expect("selection digest");
        HistoryTurnContextV1 {
            contract: HistoryContextContract,
            send_classification: HistorySendClassification::LocalOnly,
            eligible_until_ms: HistoryInt::new(0).expect("int"),
            restore_epoch: HistoryRestoreEpoch {
                id_digest: digest(HistoryDigestDomain::RestoreEpochId, id),
                number: HistoryInt::new(7).expect("int"),
            },
            target: HistoryTargetScope {
                binding_token_digest: digest(HistoryDigestDomain::ScopeBindingToken, id),
                version: HistoryInt::new(3).expect("int"),
            },
            axes: HistoryAxes {
                reading_order: HistoryAxis::Present(HistoryReadingOrder {
                    reading_ref_digest: digest(HistoryDigestDomain::ReadingRef, id),
                    rank: HistoryInt::new(12).expect("int"),
                }),
                story_time: HistoryAxis::Present(HistoryStoryTime {
                    story_ref_digest: digest(HistoryDigestDomain::StoryRef, id),
                    raw_key_digest: digest(HistoryDigestDomain::StoryRawKey, id),
                }),
                viewpoint: HistoryAxis::Present(HistoryViewpoint {
                    pov_digest: digest(HistoryDigestDomain::PovCharacter, id),
                }),
                knowledge_holder: HistoryAxis::Present(HistoryPrincipal::Character(digest(
                    HistoryDigestDomain::PrincipalCharacter,
                    id,
                ))),
                audience: HistoryAxis::Present(HistoryPrincipal::Reader),
                timeline: HistoryAxis::Present(HistoryScopeRef {
                    ref_digest: digest(HistoryDigestDomain::TimelineRef, id),
                }),
                worldline: HistoryAxis::Present(HistoryScopeRef {
                    ref_digest: digest(HistoryDigestDomain::WorldlineRef, id),
                }),
                narrative_layer: HistoryAxis::Present(HistoryScopeRef {
                    ref_digest: digest(HistoryDigestDomain::NarrativeLayerRef, id),
                }),
                auto: HistoryAxis::Present(HistoryAuto {
                    setting: HistoryPhaseSetting::Auto,
                    axis: HistoryEffectiveAxis::Story,
                    fallback: None,
                }),
            },
            d1: HistoryD1Selection {
                selection_digest: HistoryDigest::parse(&selection).expect("selection digest"),
                estimator_version: HistoryEstimatorVersion::Nir1ContextEstimatorV1,
                selector_budget_tokens: HistoryInt::new(1_000).expect("int"),
                used_tokens: HistoryInt::new(400).expect("int"),
                remaining_tokens: HistoryInt::new(600).expect("int"),
            },
        }
    }

    pub(crate) fn sample_context() -> HistoryTurnContextV1 {
        context_for("history-context-sample", 3)
    }

    pub(crate) fn sample_identity() -> DurableWorkspaceIdentity {
        DurableWorkspaceIdentity::from_parts("workspace-id", "/canonical/workspace/root")
            .expect("identity")
    }

    /// The largest context: every axis present with its longest spelling,
    /// the longest enum values and the largest integers.
    pub(crate) fn max_context() -> HistoryTurnContextV1 {
        let mut context = context_for(&"x".repeat(4096), 513);
        let max = HistoryInt::MAX;
        context.eligible_until_ms = max;
        context.restore_epoch.number = max;
        context.target.version = max;
        context.d1.selector_budget_tokens = max;
        context.d1.used_tokens = max;
        context.d1.remaining_tokens = max;
        if let HistoryAxis::Present(reading) = &mut context.axes.reading_order {
            reading.rank = max;
        }
        context.axes.audience = context.axes.knowledge_holder.clone();
        context.axes.auto = HistoryAxis::Present(HistoryAuto {
            setting: HistoryPhaseSetting::Reading,
            axis: HistoryEffectiveAxis::Reading,
            fallback: Some(HistoryAutoFallback::AutoIncompleteStoryCoverage),
        });
        context
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    fn canonical(value: &impl Serialize) -> String {
        canonical_slot_json(value).expect("canonical json")
    }

    fn slot_json(slot: &HistoryContextSlot) -> Value {
        serde_json::to_value(slot).expect("slot value")
    }

    fn parse_slot(text: &str) -> std::result::Result<HistoryContextSlot, serde_json::Error> {
        serde_json::from_str(text)
    }

    #[test]
    fn history_context_roundtrips_in_canonical_json() {
        let context = sample_context();
        let slot = HistoryContextSlot::Context(Box::new(context.clone()));
        let text = canonical(&slot);
        assert_eq!(
            text,
            canonical(&HistoryContextSlot::Context(Box::new(context.clone()))),
            "the same value always writes the same bytes"
        );
        assert_eq!(parse_slot(&text).expect("parse"), slot);
        let value: Value = serde_json::from_str(&text).expect("value");
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "axes",
                "contract",
                "d1",
                "eligibleUntilMs",
                "restoreEpoch",
                "sendClassification",
                "target"
            ]
        );
        assert_eq!(value["contract"], json!(HISTORY_TURN_CONTEXT_CONTRACT));
        assert_eq!(value["sendClassification"], json!("local-only"));
        let mut axes: Vec<&str> = value["axes"]
            .as_object()
            .expect("axes")
            .keys()
            .map(String::as_str)
            .collect();
        axes.sort_unstable();
        assert_eq!(
            axes,
            [
                "audience",
                "auto",
                "knowledgeHolder",
                "narrativeLayer",
                "readingOrder",
                "storyTime",
                "timeline",
                "viewpoint",
                "worldline"
            ]
        );
        for reason in [
            HistoryUnavailableReason::DFinalIncomplete,
            HistoryUnavailableReason::BindingLimit,
            HistoryUnavailableReason::WorkspaceIdentityUnavailable,
            HistoryUnavailableReason::RestoreEpochUnavailable,
            HistoryUnavailableReason::SceneScopeUnavailable,
            HistoryUnavailableReason::EligibilityOverflow,
        ] {
            let slot = HistoryContextSlot::Unavailable(reason);
            assert_eq!(parse_slot(&canonical(&slot)).expect("reason"), slot);
        }
        let identity = sample_identity();
        let text = canonical(&identity);
        assert_eq!(
            serde_json::from_str::<DurableWorkspaceIdentity>(&text).expect("identity"),
            identity
        );
        assert!(text.len() <= 194, "identity stays within the model");
        // The identity hashes the two strings under separate domains and does
        // not carry either string.
        assert!(!text.contains("workspace-id") && !text.contains("/canonical/workspace/root"));
        assert_ne!(
            identity.workspace_id_digest,
            digest(HistoryDigestDomain::CanonicalLocator, "workspace-id")
        );
        assert_ne!(
            DurableWorkspaceIdentity::from_parts("same", "same")
                .expect("same")
                .workspace_id_digest,
            DurableWorkspaceIdentity::from_parts("same", "same")
                .expect("same")
                .canonical_locator_digest
        );
    }

    #[test]
    fn slot_forms_null_unavailable_context_and_unknown_contract() {
        // Unavailable carries only a closed reason.
        let unavailable = HistoryContextSlot::Unavailable(HistoryUnavailableReason::BindingLimit);
        assert_eq!(
            slot_json(&unavailable),
            json!({"contract": HISTORY_TURN_CONTEXT_CONTRACT, "unavailable": "binding-limit"})
        );
        // A contract this build does not know is read, not parsed, and its
        // content is not kept (so any shape under it is accepted).
        for text in [
            r#"{"contract":"nir1-history-turn-context/2","anything":[1,2,{"x":null}]}"#,
            r#"{"contract":"nir1-history-turn-context/2"}"#,
            r#"{"contract":""}"#,
            r#"{"contract":"nir1-history-turn-context/0","unavailable":"binding-limit"}"#,
        ] {
            assert_eq!(
                parse_slot(text).expect(text),
                HistoryContextSlot::UnknownContract,
                "{text}"
            );
        }
        // It can never be written: neither as a value nor as a stored form.
        let error = serde_json::to_value(HistoryContextSlot::UnknownContract)
            .expect_err("an unknown contract is not writable");
        assert!(error.to_string().contains(SLOT_UNWRITABLE_ERROR), "{error}");
        // The known contract parses by its forms.
        let context = HistoryContextSlot::Context(Box::new(sample_context()));
        assert!(context.is_context());
        assert!(!unavailable.is_context());
    }

    #[test]
    fn slot_rejects_open_shapes_and_unknown_reasons() {
        let known = HISTORY_TURN_CONTEXT_CONTRACT;
        let valid = slot_json(&HistoryContextSlot::Context(Box::new(sample_context())));
        let mutate = |path: &[&str], replacement: Value| -> String {
            let mut value = valid.clone();
            let mut cursor = &mut value;
            for key in &path[..path.len() - 1] {
                cursor = &mut cursor[*key];
            }
            cursor[path[path.len() - 1]] = replacement;
            value.to_string()
        };
        let mut cases: Vec<(String, String)> = vec![
            ("not an object".into(), "\"text\"".into()),
            ("array".into(), "[]".into()),
            ("number".into(), "0".into()),
            ("empty object".into(), "{}".into()),
            (
                "contract is not a string".into(),
                r#"{"contract":2}"#.into(),
            ),
            (
                "contract is null".into(),
                r#"{"contract":null,"unavailable":"binding-limit"}"#.into(),
            ),
            (
                "unknown reason".into(),
                format!(r#"{{"contract":"{known}","unavailable":"some-new-reason"}}"#),
            ),
            (
                "reason is not a string".into(),
                format!(r#"{{"contract":"{known}","unavailable":3}}"#),
            ),
            (
                "unavailable with an extra field".into(),
                format!(r#"{{"contract":"{known}","unavailable":"binding-limit","x":1}}"#),
            ),
            (
                "unavailable with context fields".into(),
                format!(
                    r#"{{"contract":"{known}","unavailable":"binding-limit","sendClassification":"local-only"}}"#
                ),
            ),
            (
                "duplicate key".into(),
                format!(
                    r#"{{"contract":"{known}","unavailable":"binding-limit","unavailable":"d-final-incomplete"}}"#
                ),
            ),
            (
                "unknown top-level field".into(),
                mutate(&["extra"], json!(1)),
            ),
            (
                "unknown classification".into(),
                mutate(&["sendClassification"], json!("remote")),
            ),
            (
                "negative integer".into(),
                mutate(&["restoreEpoch", "number"], json!(-1)),
            ),
            (
                "fractional integer".into(),
                mutate(&["restoreEpoch", "number"], json!(1.5)),
            ),
            (
                "integer beyond the canonical range".into(),
                mutate(&["eligibleUntilMs"], json!(HISTORY_MAX_SAFE_INTEGER + 1)),
            ),
            (
                "digest without the prefix".into(),
                mutate(&["target", "bindingTokenDigest"], json!("abc")),
            ),
            (
                "upper-case digest".into(),
                mutate(
                    &["target", "bindingTokenDigest"],
                    json!(format!("sha256:{}", "A".repeat(64))),
                ),
            ),
            (
                "raw id where a digest belongs".into(),
                mutate(&["restoreEpoch", "idDigest"], json!("epoch-uuid")),
            ),
            (
                "unknown estimator".into(),
                mutate(&["d1", "estimatorVersion"], json!("a-later-estimator")),
            ),
            (
                "estimator as a free string of any length".into(),
                mutate(&["d1", "estimatorVersion"], json!("e".repeat(4096))),
            ),
            (
                "axis with both keys".into(),
                mutate(
                    &["axes", "viewpoint"],
                    json!({"present": {"povDigest": format!("sha256:{}", "0".repeat(64))}, "unavailable": "not-provided"}),
                ),
            ),
            (
                "axis with an unknown reason".into(),
                mutate(&["axes", "storyTime"], json!({"unavailable": "tuesday"})),
            ),
            (
                "axis reason of another axis".into(),
                mutate(
                    &["axes", "viewpoint"],
                    json!({"unavailable": "key-ambiguous"}),
                ),
            ),
            (
                "axis present with an extra field".into(),
                mutate(
                    &["axes", "viewpoint"],
                    json!({"present": {"povDigest": format!("sha256:{}", "0".repeat(64)), "id": "x"}}),
                ),
            ),
            (
                "unknown auto fallback".into(),
                mutate(
                    &["axes", "auto"],
                    json!({"present": {"setting": "auto", "axis": "story", "fallback": "new"}}),
                ),
            ),
            ("missing axis".into(), {
                let mut value = valid.clone();
                value["axes"]
                    .as_object_mut()
                    .expect("axes")
                    .remove("audience");
                value.to_string()
            }),
        ];
        cases.push((
            "context field renamed".into(),
            mutate(&["send_classification"], json!("local-only")),
        ));
        for (name, text) in &cases {
            assert!(parse_slot(text).is_err(), "{name} must not parse: {text}");
        }
        // The identity slot is closed in the same way.
        let identity = serde_json::to_value(sample_identity()).expect("identity");
        for text in [
            "{}".to_owned(),
            "\"x\"".to_owned(),
            json!({"workspaceIdDigest": identity["workspaceIdDigest"]}).to_string(),
            json!({"workspaceIdDigest": "plain", "canonicalLocatorDigest": identity["canonicalLocatorDigest"]})
                .to_string(),
            {
                let mut value = identity.clone();
                value["path"] = json!("/home/x");
                value.to_string()
            },
        ] {
            assert!(
                serde_json::from_str::<DurableWorkspaceIdentity>(&text).is_err(),
                "{text}"
            );
        }
        // The valid value itself still parses.
        assert!(parse_slot(&valid.to_string()).is_ok());
    }

    #[test]
    fn history_context_size_is_independent_of_ids_and_input_counts() {
        let sizes: Vec<usize> = [
            ("a", 1),
            (&"a".repeat(36), 1),
            (&"a".repeat(4096), 1),
            ("a", 513),
            (&"é\u{0}\"\\".repeat(1024), 513),
        ]
        .iter()
        .map(|(id, inputs)| {
            canonical(&HistoryContextSlot::Context(Box::new(context_for(
                id, *inputs,
            ))))
            .len()
        })
        .collect();
        assert!(
            sizes.windows(2).all(|pair| pair[0] == pair[1]),
            "the slot size must not depend on an ID's length or the input count: {sizes:?}"
        );
        // The identity slot is independent of the path and id lengths.
        let identity_sizes: Vec<usize> = [
            ("w", "/a"),
            ("w", &"/é".repeat(4096)),
            (&"w".repeat(4096), "/a"),
        ]
        .iter()
        .map(|(id, path)| {
            canonical(&DurableWorkspaceIdentity::from_parts(id, path).expect("identity")).len()
        })
        .collect();
        assert!(identity_sizes.windows(2).all(|pair| pair[0] == pair[1]));
    }

    /// The largest bytes of the two slots in their actual types (every axis
    /// present with its longest spelling, the longest enum values, the largest
    /// safe integers). Measured against the model of K4/3 S6-3 (1,893 B and
    /// 194 B); the measured values are pinned here.
    const MAX_HISTORY_SLOT_BYTES: usize = 1_767;
    const MAX_DURABLE_IDENTITY_SLOT_BYTES: usize = 194;

    #[test]
    fn history_context_and_identity_slots_max_size_is_pinned() {
        let max = canonical(&HistoryContextSlot::Context(Box::new(max_context())));
        assert_eq!(max.len(), MAX_HISTORY_SLOT_BYTES, "{max}");
        assert!(
            max.len() <= 1_893,
            "the measured slot is no larger than the model"
        );
        // An absent value is never larger than a present one, so the all-
        // present value is the maximum: check it against every axis made
        // unavailable with its longest reason.
        let mut thin = max_context();
        thin.axes = HistoryAxes {
            reading_order: HistoryAxis::Unavailable(
                HistoryReadingOrderUnavailable::SceneNotInAuthorityMapping,
            ),
            story_time: HistoryAxis::Unavailable(
                HistoryStoryTimeUnavailable::SceneNotInAuthorityMapping,
            ),
            viewpoint: HistoryAxis::Unavailable(HistoryViewpointUnavailable::NotVisibleCharacter),
            knowledge_holder: HistoryAxis::Unavailable(
                HistoryPrincipalUnavailable::BindingNotExplicit,
            ),
            audience: HistoryAxis::Unavailable(HistoryPrincipalUnavailable::BindingNotExplicit),
            timeline: HistoryAxis::Unavailable(HistoryScopeRefUnavailable::BindingNotExplicit),
            worldline: HistoryAxis::Unavailable(HistoryScopeRefUnavailable::BindingNotExplicit),
            narrative_layer: HistoryAxis::Unavailable(
                HistoryScopeRefUnavailable::BindingNotExplicit,
            ),
            auto: HistoryAxis::Unavailable(HistoryAutoUnavailable::SceneNotInAuthorityMapping),
        };
        assert!(canonical(&HistoryContextSlot::Context(Box::new(thin))).len() < max.len());
        let identity = canonical(&sample_identity());
        assert_eq!(
            identity.len(),
            MAX_DURABLE_IDENTITY_SLOT_BYTES,
            "{identity}"
        );
        assert!(identity.len() <= 194);
        // Both stay far below a 4 KiB slot ceiling.
        assert!(max.len() < 4 * 1024);
        // Every digest is 71 bytes.
        assert_eq!(sample_identity().workspace_id_digest.as_str().len(), 71);
    }

    #[test]
    fn context_does_not_carry_per_process_or_route_fields() {
        let text = canonical(&HistoryContextSlot::Context(Box::new(max_context())));
        let value: Value = serde_json::from_str(&text).expect("value");
        fn keys(value: &Value, out: &mut Vec<String>) {
            match value {
                Value::Object(map) => {
                    for (key, child) in map {
                        out.push(key.clone());
                        keys(child, out);
                    }
                }
                Value::Array(items) => items.iter().for_each(|item| keys(item, out)),
                _ => {}
            }
        }
        let mut all = Vec::new();
        keys(&value, &mut all);
        for forbidden in [
            "caller",
            "callerId",
            "callerEpoch",
            "callerSessionId",
            "profileId",
            "workspaceBindingDigest",
            "authorityInstance",
            "recoveryGeneration",
            "routeRevision",
            "provider",
            "model",
            "api",
            "endpointIdentity",
            "materialDigest",
            "scopeDigest",
            "d1Digest",
            "projectScopeAuthorityRevision",
            "storyRank",
        ] {
            assert!(
                !all.iter().any(|key| key == forbidden),
                "{forbidden} is not a field of the turn context"
            );
        }
    }

    #[test]
    fn eligibility_window_is_thirty_days_and_stays_in_the_safe_range() {
        assert_eq!(HISTORY_ELIGIBILITY_WINDOW_MS, 2_592_000_000);
        assert_eq!(
            eligible_until_ms(1_000).map(HistoryInt::get),
            Some(1_000 + 2_592_000_000)
        );
        assert_eq!(eligible_until_ms(-1), None);
        assert_eq!(eligible_until_ms(i64::MAX), None);
        let edge =
            i64::try_from(HISTORY_MAX_SAFE_INTEGER).expect("edge") - HISTORY_ELIGIBILITY_WINDOW_MS;
        assert_eq!(
            eligible_until_ms(edge).map(HistoryInt::get),
            Some(HISTORY_MAX_SAFE_INTEGER)
        );
        assert_eq!(eligible_until_ms(edge + 1), None);
    }

    #[test]
    fn safe_integers_survive_canonical_json() {
        // The canonicalizer writes numbers through f64: the largest safe
        // integer is the largest value that comes back unchanged.
        let max = HistoryInt::MAX;
        let text = canonical(&max);
        assert_eq!(serde_json::from_str::<HistoryInt>(&text).expect("max"), max);
        assert!(HistoryInt::new(HISTORY_MAX_SAFE_INTEGER + 1).is_err());
        assert!(HistoryInt::from_i64(-1).is_err());
    }

    #[test]
    fn digests_are_domain_separated() {
        let a = digest(HistoryDigestDomain::StoryRef, "scene:1");
        let b = digest(HistoryDigestDomain::ReadingRef, "scene:1");
        assert_ne!(a, b);
        assert_eq!(a, digest(HistoryDigestDomain::StoryRef, "scene:1"));
        assert!(HistoryDigest::parse(a.as_str()).is_ok());
        assert!(HistoryDigest::parse("sha256:zz").is_err());
    }

    fn identity_fixture(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "grimodex-hs1-identity-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&root).expect("fixture root");
        std::fs::canonicalize(&root).expect("canonical fixture root")
    }

    #[cfg(unix)]
    #[test]
    fn canonical_locator_digest_resolves_symlinks() {
        let real = identity_fixture("symlink-real");
        let link = real.with_file_name(format!(
            "{}-link",
            real.file_name().and_then(|n| n.to_str()).expect("name")
        ));
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        let via_real = DurableWorkspaceIdentity::from_workspace_root("ws-1", &real).expect("real");
        let via_link = DurableWorkspaceIdentity::from_workspace_root("ws-1", &link).expect("link");
        assert_eq!(via_real, via_link);

        // A copied folder keeps the workspace id and changes the locator.
        let copy = identity_fixture("symlink-copy");
        let copied = DurableWorkspaceIdentity::from_workspace_root("ws-1", &copy).expect("copy");
        assert_eq!(copied.workspace_id_digest, via_real.workspace_id_digest);
        assert_ne!(
            copied.canonical_locator_digest,
            via_real.canonical_locator_digest
        );
        for path in [&real, &copy, &link] {
            let _ = std::fs::remove_dir_all(path);
            let _ = std::fs::remove_file(path);
        }
    }

    #[cfg(unix)]
    #[test]
    fn canonical_locator_is_unavailable_for_non_unicode_and_failed_canonicalize() {
        use std::os::unix::ffi::OsStrExt;
        let base = identity_fixture("non-unicode");
        let invalid = base.join(std::ffi::OsStr::from_bytes(b"ws-\xff\xfe"));
        std::fs::create_dir_all(&invalid).expect("non-unicode directory");
        assert!(invalid.to_str().is_none());
        assert_eq!(canonical_locator_digest(&invalid), None);
        assert_eq!(
            DurableWorkspaceIdentity::from_workspace_root("ws-1", &invalid),
            None
        );

        let missing = base.join("does-not-exist");
        assert_eq!(canonical_locator_digest(&missing), None);
        assert_eq!(
            DurableWorkspaceIdentity::from_workspace_root("ws-1", &missing),
            None
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn moved_back_workspace_matches_the_recorded_identity() {
        let root = identity_fixture("moved");
        let recorded = DurableWorkspaceIdentity::from_workspace_root("ws-1", &root).expect("id");
        let parked = root.with_file_name(format!(
            "{}-parked",
            root.file_name().and_then(|n| n.to_str()).expect("name")
        ));
        std::fs::rename(&root, &parked).expect("move away");
        assert_eq!(
            DurableWorkspaceIdentity::from_workspace_root("ws-1", &root),
            None
        );
        let while_moved =
            DurableWorkspaceIdentity::from_workspace_root("ws-1", &parked).expect("moved");
        assert_ne!(
            while_moved.canonical_locator_digest,
            recorded.canonical_locator_digest
        );
        std::fs::rename(&parked, &root).expect("move back");
        assert_eq!(
            DurableWorkspaceIdentity::from_workspace_root("ws-1", &root),
            Some(recorded)
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn identity_digests_are_domain_separated_and_hide_paths() {
        let root = identity_fixture("domains");
        let path_text = root.to_str().expect("unicode root").to_owned();
        // The same string as a workspace id and as a locator never collides.
        let identity =
            DurableWorkspaceIdentity::from_workspace_root(&path_text, &root).expect("identity");
        assert_ne!(
            identity.workspace_id_digest, identity.canonical_locator_digest,
            "domains must separate the two digests"
        );
        // Neither the serialized form nor Debug carries the path text.
        let json = canonical(&identity);
        assert!(!json.contains(&path_text));
        assert!(!format!("{identity:?}").contains(&path_text));
        assert!(json.len() <= 194);
        // An empty or blank workspace id is unavailable.
        assert_eq!(
            DurableWorkspaceIdentity::from_workspace_root("", &root),
            None
        );
        assert_eq!(
            DurableWorkspaceIdentity::from_workspace_root("  ", &root),
            None
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn canonical_locator_windows_verbatim_and_macos_private_forms() {
        // macOS: temp dirs live under /var, a symlink to /private/var. The
        // canonical form must resolve to /private and still hash stably.
        let raw = std::env::temp_dir().join(format!("grimodex-hs1-mac-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&raw).expect("fixture");
        let canonical_path = std::fs::canonicalize(&raw).expect("canonicalize");
        assert!(canonical_path.starts_with("/private"));
        assert_eq!(
            canonical_locator_digest(&raw),
            canonical_locator_digest(&canonical_path)
        );
        let _ = std::fs::remove_dir_all(&raw);
    }

    #[cfg(windows)]
    #[test]
    fn canonical_locator_windows_verbatim_and_macos_private_forms() {
        // Windows: canonicalize returns the verbatim (`\\?\`) form. It is
        // used exactly as the OS returned it, with no prefix added or removed.
        let raw = std::env::temp_dir().join(format!("grimodex-hs1-win-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&raw).expect("fixture");
        let canonical_path = std::fs::canonicalize(&raw).expect("canonicalize");
        let text = canonical_path.to_str().expect("unicode");
        assert!(text.starts_with(r"\\?\"));
        assert_eq!(
            canonical_locator_digest(&raw),
            Some(HistoryDigest::of(HistoryDigestDomain::CanonicalLocator, text).expect("digest"))
        );
        let _ = std::fs::remove_dir_all(&raw);
    }
}
