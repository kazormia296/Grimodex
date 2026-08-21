//! Pure NIR-0 Dependency Role / Selector contract primitives.
//!
//! This module deliberately has no database, writer, runtime publication, or
//! Freshness storage dependency.  It validates the policy-owned Role ×
//! Consumer × Source Change mapping, canonicalizes selectors and digest
//! inputs, and keeps required Build Actions separate from advisory actions.

use std::{cmp::Ordering, collections::HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::canonical_json::canonical_json_string;

pub const DEPENDENCY_ROLE_CONTRACT_VERSION: &str = "narrative-dependency-role/1";

macro_rules! string_enum {
    ($name:ident { $( $variant:ident => $value:literal ),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
        #[serde(rename_all = "kebab-case")]
        pub enum $name {
            $( $variant ),+
        }

        impl $name {
            pub const fn as_str(self) -> &'static str {
                match self {
                    $( Self::$variant => $value ),+
                }
            }
        }
    };
}

string_enum!(DependencyRole {
    DirectEvidence => "direct-evidence",
    OpaqueModelContext => "opaque-model-context",
    EntityResolution => "entity-resolution",
    TemporalResolution => "temporal-resolution",
    ScopeResolution => "scope-resolution",
    ProjectionMatch => "projection-match",
    AuthorCorrection => "author-correction",
    ComponentContract => "component-contract",
    QualityContext => "quality-context",
    RankingOnly => "ranking-only",
});

string_enum!(NarrativeConsumerKind {
    NarrativeExtractionRun => "narrative-extraction-run",
    ProposalRevision => "proposal-revision",
    ExtractionArtifact => "extraction-artifact",
    Application => "application",
    ApplicationContribution => "application-contribution",
    DerivedProjection => "derived-projection",
    SemanticIndex => "semantic-index",
    NarrativeIrRevision => "narrative-ir-revision",
    RelatedScenesMaterialization => "related-scenes-materialization",
    ChatContextMaterialization => "chat-context-materialization",
    StructureHealthDiagnostic => "structure-health-diagnostic",
});

string_enum!(SourceChangeClass {
    SourceContentChanged => "source-content-changed",
    SourceMissing => "source-missing",
    AnchorMissing => "anchor-missing",
    ExactContentRelocated => "exact-content-relocated",
    SelectedSetCollapsed => "selected-set-collapsed",
    ComponentUnavailable => "component-unavailable",
    QualityInputChanged => "quality-input-changed",
    RankingInputChanged => "ranking-input-changed",
});

string_enum!(EvidenceFreshness {
    Fresh => "fresh",
    Stale => "stale",
    SourceMissing => "source-missing",
    AnchorMismatch => "anchor-mismatch",
    ReadSetDrift => "read-set-drift",
    Unknown => "unknown",
});

string_enum!(BuildAction {
    None => "none",
    RevalidateExact => "revalidate-exact",
    ReanchorCandidate => "reanchor-candidate",
    ResolveOnly => "resolve-only",
    RecompileOnly => "recompile-only",
    RebuildRequired => "rebuild-required",
    RefreshAvailable => "refresh-available",
    Manual => "manual",
});

string_enum!(ActionRequirement {
    Required => "required",
    Advisory => "advisory",
    None => "none",
});

string_enum!(FindingReasonCode {
    SourceRevisionChanged => "source-revision-changed",
    SourceMissing => "source-missing",
    EvidenceOverlap => "evidence-overlap",
    ContextOverlap => "context-overlap",
    ExactContentRelocated => "exact-content-relocated",
    QuoteNotFound => "quote-not-found",
    QuoteAmbiguous => "quote-ambiguous",
    ReadSetDrift => "read-set-drift",
    NormalizerIncompatible => "normalizer-incompatible",
    ComponentIncompatible => "component-incompatible",
    TargetModified => "target-modified",
});

// These conversions are intentionally exhaustive and are the fail-closed
// boundary for untrusted JSON/input strings.
impl TryFrom<&str> for DependencyRole {
    type Error = DependencyContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "direct-evidence" => Ok(Self::DirectEvidence),
            "opaque-model-context" => Ok(Self::OpaqueModelContext),
            "entity-resolution" => Ok(Self::EntityResolution),
            "temporal-resolution" => Ok(Self::TemporalResolution),
            "scope-resolution" => Ok(Self::ScopeResolution),
            "projection-match" => Ok(Self::ProjectionMatch),
            "author-correction" => Ok(Self::AuthorCorrection),
            "component-contract" => Ok(Self::ComponentContract),
            "quality-context" => Ok(Self::QualityContext),
            "ranking-only" => Ok(Self::RankingOnly),
            _ => Err(DependencyContractError::UnknownRole(value.to_string())),
        }
    }
}

impl TryFrom<&str> for NarrativeConsumerKind {
    type Error = DependencyContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "narrative-extraction-run" => Ok(Self::NarrativeExtractionRun),
            "proposal-revision" => Ok(Self::ProposalRevision),
            "extraction-artifact" => Ok(Self::ExtractionArtifact),
            "application" => Ok(Self::Application),
            "application-contribution" => Ok(Self::ApplicationContribution),
            "derived-projection" => Ok(Self::DerivedProjection),
            "semantic-index" => Ok(Self::SemanticIndex),
            "narrative-ir-revision" => Ok(Self::NarrativeIrRevision),
            "related-scenes-materialization" => Ok(Self::RelatedScenesMaterialization),
            "chat-context-materialization" => Ok(Self::ChatContextMaterialization),
            "structure-health-diagnostic" => Ok(Self::StructureHealthDiagnostic),
            _ => Err(DependencyContractError::UnknownConsumerKind(
                value.to_string(),
            )),
        }
    }
}

impl TryFrom<&str> for SourceChangeClass {
    type Error = DependencyContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "source-content-changed" => Ok(Self::SourceContentChanged),
            "source-missing" => Ok(Self::SourceMissing),
            "anchor-missing" => Ok(Self::AnchorMissing),
            "exact-content-relocated" => Ok(Self::ExactContentRelocated),
            "selected-set-collapsed" => Ok(Self::SelectedSetCollapsed),
            "component-unavailable" => Ok(Self::ComponentUnavailable),
            "quality-input-changed" => Ok(Self::QualityInputChanged),
            "ranking-input-changed" => Ok(Self::RankingInputChanged),
            _ => Err(DependencyContractError::UnknownChangeClass(
                value.to_string(),
            )),
        }
    }
}

impl TryFrom<&str> for EvidenceFreshness {
    type Error = DependencyContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "fresh" => Ok(Self::Fresh),
            "stale" => Ok(Self::Stale),
            "source-missing" => Ok(Self::SourceMissing),
            "anchor-mismatch" => Ok(Self::AnchorMismatch),
            "read-set-drift" => Ok(Self::ReadSetDrift),
            "unknown" => Ok(Self::Unknown),
            _ => Err(DependencyContractError::UnknownFreshness(value.to_string())),
        }
    }
}

impl TryFrom<&str> for BuildAction {
    type Error = DependencyContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "none" => Ok(Self::None),
            "revalidate-exact" => Ok(Self::RevalidateExact),
            "reanchor-candidate" => Ok(Self::ReanchorCandidate),
            "resolve-only" => Ok(Self::ResolveOnly),
            "recompile-only" => Ok(Self::RecompileOnly),
            "rebuild-required" => Ok(Self::RebuildRequired),
            "refresh-available" => Ok(Self::RefreshAvailable),
            "manual" => Ok(Self::Manual),
            _ => Err(DependencyContractError::UnknownBuildAction(
                value.to_string(),
            )),
        }
    }
}

impl TryFrom<&str> for ActionRequirement {
    type Error = DependencyContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "required" => Ok(Self::Required),
            "advisory" => Ok(Self::Advisory),
            "none" => Ok(Self::None),
            _ => Err(DependencyContractError::InvalidEnumValue {
                axis: "ActionRequirement",
                value: value.to_string(),
            }),
        }
    }
}

impl TryFrom<&str> for FindingReasonCode {
    type Error = DependencyContractError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "source-revision-changed" => Ok(Self::SourceRevisionChanged),
            "source-missing" => Ok(Self::SourceMissing),
            "evidence-overlap" => Ok(Self::EvidenceOverlap),
            "context-overlap" => Ok(Self::ContextOverlap),
            "exact-content-relocated" => Ok(Self::ExactContentRelocated),
            "quote-not-found" => Ok(Self::QuoteNotFound),
            "quote-ambiguous" => Ok(Self::QuoteAmbiguous),
            "read-set-drift" => Ok(Self::ReadSetDrift),
            "normalizer-incompatible" => Ok(Self::NormalizerIncompatible),
            "component-incompatible" => Ok(Self::ComponentIncompatible),
            "target-modified" => Ok(Self::TargetModified),
            _ => Err(DependencyContractError::UnknownReasonCode(
                value.to_string(),
            )),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum DependencySelector {
    #[serde(rename = "whole-source")]
    WholeSource,
    #[serde(rename = "text-range")]
    TextRange {
        unit: String,
        from: u64,
        to: u64,
        #[serde(rename = "normalizerVersion")]
        normalizer_version: String,
        #[serde(rename = "anchorDigest", skip_serializing_if = "Option::is_none")]
        anchor_digest: Option<String>,
    },
    #[serde(rename = "field-path")]
    FieldPath {
        #[serde(rename = "objectIdentity")]
        object_identity: String,
        #[serde(rename = "fieldPath")]
        field_path: String,
    },
    #[serde(rename = "exact-object-set")]
    ExactObjectSet {
        #[serde(rename = "objectIdentities")]
        object_identities: Vec<String>,
        #[serde(rename = "setDigest")]
        set_digest: String,
    },
    #[serde(rename = "component-contract")]
    ComponentContract {
        #[serde(rename = "contractId")]
        contract_id: String,
        #[serde(rename = "contractDigest")]
        contract_digest: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEffectRule {
    pub id: String,
    pub role: DependencyRole,
    pub consumer_kind: NarrativeConsumerKind,
    pub change_class: SourceChangeClass,
    pub freshness: EvidenceFreshness,
    pub reason_code: Option<String>,
    pub build_action: BuildAction,
    pub action_requirement: ActionRequirement,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DependencyEffectRegistry {
    pub role_contract_version: String,
    pub roles: Vec<DependencyRole>,
    pub consumer_kinds: Vec<NarrativeConsumerKind>,
    pub source_change_classes: Vec<SourceChangeClass>,
    pub effect_rules: Vec<DependencyEffectRule>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEffect {
    pub freshness: EvidenceFreshness,
    pub reason_code: Option<String>,
    pub build_action: BuildAction,
    pub action_requirement: ActionRequirement,
}

#[derive(Clone, Copy, Debug)]
pub struct DependencyEffectInput<'a> {
    pub role: &'a str,
    pub consumer_kind: &'a str,
    pub change_class: &'a str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencySetDigestEntry {
    pub source_object_identity: String,
    pub dependency_key: String,
    pub selector_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsumerBuildSummary {
    pub required_actions: Vec<BuildAction>,
    pub advisory_actions: Vec<BuildAction>,
    pub compatibility_primary_action: BuildAction,
}

#[derive(Debug, Error, Clone, Eq, PartialEq)]
pub enum DependencyContractError {
    #[error("unknown dependency role '{0}'")]
    UnknownRole(String),
    #[error("unknown Dependency Consumer kind '{0}'")]
    UnknownConsumerKind(String),
    #[error("unknown Dependency Source Change Class '{0}'")]
    UnknownChangeClass(String),
    #[error("unknown Dependency Freshness '{0}'")]
    UnknownFreshness(String),
    #[error("unknown Dependency Build Action '{0}'")]
    UnknownBuildAction(String),
    #[error("unknown Dependency Finding Reason Code '{0}'")]
    UnknownReasonCode(String),
    #[error("invalid {axis} value '{value}'")]
    InvalidEnumValue { axis: &'static str, value: String },
    #[error("no effect rule for {role}|{consumer_kind}|{change_class}")]
    MissingEffectRule {
        role: String,
        consumer_kind: String,
        change_class: String,
    },
    #[error("duplicate effect rule for {0}")]
    DuplicateEffectRule(String),
    #[error("invalid dependency effect registry: {0}")]
    InvalidRegistry(String),
    #[error("invalid Dependency selector: {0}")]
    InvalidSelector(String),
    #[error("Dependency selector digest must be a sha256-prefixed lowercase digest")]
    InvalidDigest,
    #[error("text-range must use UTF-16 half-open coordinates with from < to")]
    InvalidTextRange,
    #[error("text-range crosses the UTF-16 source boundary")]
    RangeOutOfBounds,
    #[error("text-range cannot begin or end inside a UTF-16 surrogate pair")]
    SurrogateBoundary,
    #[error("canonical Dependency JSON failed: {0}")]
    CanonicalJson(String),
    #[error("Dependency Role policy failed to parse: {0}")]
    PolicyParse(String),
    #[error("invalid dependency set digest entry")]
    InvalidDigestEntry,
}

fn is_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub fn validate_dependency_selector(
    selector: &DependencySelector,
    source: Option<&str>,
) -> Result<(), DependencyContractError> {
    match selector {
        DependencySelector::WholeSource => Ok(()),
        DependencySelector::TextRange {
            unit,
            from,
            to,
            normalizer_version,
            anchor_digest,
        } => {
            if unit != "utf16" || from >= to || !is_trimmed_non_empty(normalizer_version) {
                return Err(DependencyContractError::InvalidTextRange);
            }
            if *from > 9_007_199_254_740_991 || *to > 9_007_199_254_740_991 {
                return Err(DependencyContractError::InvalidTextRange);
            }
            if anchor_digest
                .as_deref()
                .is_some_and(|digest| !is_digest(digest))
            {
                return Err(DependencyContractError::InvalidDigest);
            }
            if let Some(source) = source {
                let units: Vec<u16> = source.encode_utf16().collect();
                if *to > units.len() as u64 {
                    return Err(DependencyContractError::RangeOutOfBounds);
                }
                if is_surrogate_boundary(&units, *from) || is_surrogate_boundary(&units, *to) {
                    return Err(DependencyContractError::SurrogateBoundary);
                }
            }
            Ok(())
        }
        DependencySelector::FieldPath {
            object_identity,
            field_path,
        } => {
            if is_trimmed_non_empty(object_identity) && is_trimmed_non_empty(field_path) {
                Ok(())
            } else {
                Err(DependencyContractError::InvalidSelector(
                    "field-path requires objectIdentity and fieldPath".to_string(),
                ))
            }
        }
        DependencySelector::ExactObjectSet {
            object_identities,
            set_digest,
        } => {
            if object_identities.is_empty()
                || object_identities
                    .iter()
                    .any(|identity| !is_trimmed_non_empty(identity))
                || object_identities.iter().collect::<HashSet<_>>().len() != object_identities.len()
            {
                return Err(DependencyContractError::InvalidSelector(
                    "exact-object-set requires unique object identities".to_string(),
                ));
            }
            if !is_digest(set_digest) {
                return Err(DependencyContractError::InvalidDigest);
            }
            Ok(())
        }
        DependencySelector::ComponentContract {
            contract_id,
            contract_digest,
        } => {
            if !is_trimmed_non_empty(contract_id) {
                return Err(DependencyContractError::InvalidSelector(
                    "component-contract requires contractId".to_string(),
                ));
            }
            if !is_digest(contract_digest) {
                return Err(DependencyContractError::InvalidDigest);
            }
            Ok(())
        }
    }
}

/// Parse and validate an untrusted selector object through the same typed D0
/// contract used by canonicalization.  Comparing the parsed representation
/// back to the input also refuses serde's default unknown-field elision.
pub fn validate_dependency_selector_value(
    value: &Value,
    source: Option<&str>,
) -> Result<DependencySelector, DependencyContractError> {
    let selector: DependencySelector = serde_json::from_value(value.clone()).map_err(|error| {
        DependencyContractError::InvalidSelector(format!("selector shape: {error}"))
    })?;
    let parsed_value = serde_json::to_value(&selector)
        .map_err(|error| DependencyContractError::CanonicalJson(error.to_string()))?;
    if parsed_value != *value {
        return Err(DependencyContractError::InvalidSelector(
            "selector contains unknown or non-canonical fields".to_string(),
        ));
    }
    validate_dependency_selector(&selector, source)?;
    Ok(selector)
}

fn is_trimmed_non_empty(value: &str) -> bool {
    !value.is_empty() && value.trim() == value
}

fn is_surrogate_boundary(units: &[u16], offset: u64) -> bool {
    let offset = offset as usize;
    if offset == 0 || offset >= units.len() {
        return false;
    }
    let previous = units[offset - 1];
    let current = units[offset];
    (0xd800..=0xdbff).contains(&previous) && (0xdc00..=0xdfff).contains(&current)
}

fn compare_utf16(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

pub fn canonicalize_dependency_selector(
    selector: &DependencySelector,
) -> Result<String, DependencyContractError> {
    validate_dependency_selector(selector, None)?;
    let mut canonical_selector = selector.clone();
    if let DependencySelector::ExactObjectSet {
        object_identities, ..
    } = &mut canonical_selector
    {
        object_identities.sort_by(|left, right| compare_utf16(left, right));
    }
    let value = serde_json::to_value(canonical_selector)
        .map_err(|error| DependencyContractError::CanonicalJson(error.to_string()))?;
    canonical_json_string(&value)
        .map_err(|error| DependencyContractError::CanonicalJson(error.to_string()))
}

pub fn canonicalize_dependency_key_input(
    role: &str,
    selector: &DependencySelector,
) -> Result<String, DependencyContractError> {
    DependencyRole::try_from(role)?;
    let selector_value: Value = serde_json::from_str(&canonicalize_dependency_selector(selector)?)
        .map_err(|error| DependencyContractError::CanonicalJson(error.to_string()))?;
    let input = serde_json::json!({ "role": role, "selector": selector_value });
    canonical_json_string(&input)
        .map_err(|error| DependencyContractError::CanonicalJson(error.to_string()))
}

pub fn compute_dependency_key(
    role: &str,
    selector: &DependencySelector,
) -> Result<String, DependencyContractError> {
    let input = canonicalize_dependency_key_input(role, selector)?;
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(input.as_bytes()))
    ))
}

pub fn canonicalize_dependency_set(
    entries: &[DependencySetDigestEntry],
) -> Result<String, DependencyContractError> {
    let mut normalized = entries.to_vec();
    for entry in &normalized {
        if !is_trimmed_non_empty(&entry.source_object_identity)
            || !is_digest(&entry.dependency_key)
            || !is_digest(&entry.selector_digest)
        {
            return Err(DependencyContractError::InvalidDigestEntry);
        }
    }
    normalized.sort_by(|left, right| {
        compare_utf16(&left.source_object_identity, &right.source_object_identity)
            .then_with(|| compare_utf16(&left.dependency_key, &right.dependency_key))
            .then_with(|| compare_utf16(&left.selector_digest, &right.selector_digest))
    });
    let value = serde_json::to_value(normalized)
        .map_err(|error| DependencyContractError::CanonicalJson(error.to_string()))?;
    canonical_json_string(&value)
        .map_err(|error| DependencyContractError::CanonicalJson(error.to_string()))
}

pub fn compute_dependency_set_digest(
    entries: &[DependencySetDigestEntry],
) -> Result<String, DependencyContractError> {
    let input = canonicalize_dependency_set(entries)?;
    Ok(format!(
        "sha256:{}",
        hex::encode(Sha256::digest(input.as_bytes()))
    ))
}

const ALL_ROLES: [DependencyRole; 10] = [
    DependencyRole::DirectEvidence,
    DependencyRole::OpaqueModelContext,
    DependencyRole::EntityResolution,
    DependencyRole::TemporalResolution,
    DependencyRole::ScopeResolution,
    DependencyRole::ProjectionMatch,
    DependencyRole::AuthorCorrection,
    DependencyRole::ComponentContract,
    DependencyRole::QualityContext,
    DependencyRole::RankingOnly,
];

const ALL_CONSUMER_KINDS: [NarrativeConsumerKind; 11] = [
    NarrativeConsumerKind::NarrativeExtractionRun,
    NarrativeConsumerKind::ProposalRevision,
    NarrativeConsumerKind::ExtractionArtifact,
    NarrativeConsumerKind::Application,
    NarrativeConsumerKind::ApplicationContribution,
    NarrativeConsumerKind::DerivedProjection,
    NarrativeConsumerKind::SemanticIndex,
    NarrativeConsumerKind::NarrativeIrRevision,
    NarrativeConsumerKind::RelatedScenesMaterialization,
    NarrativeConsumerKind::ChatContextMaterialization,
    NarrativeConsumerKind::StructureHealthDiagnostic,
];

const ALL_SOURCE_CHANGE_CLASSES: [SourceChangeClass; 8] = [
    SourceChangeClass::SourceContentChanged,
    SourceChangeClass::SourceMissing,
    SourceChangeClass::AnchorMissing,
    SourceChangeClass::ExactContentRelocated,
    SourceChangeClass::SelectedSetCollapsed,
    SourceChangeClass::ComponentUnavailable,
    SourceChangeClass::QualityInputChanged,
    SourceChangeClass::RankingInputChanged,
];

pub fn validate_dependency_effect_registry(
    registry: &DependencyEffectRegistry,
) -> Result<(), DependencyContractError> {
    if registry.role_contract_version != DEPENDENCY_ROLE_CONTRACT_VERSION {
        return Err(DependencyContractError::InvalidRegistry(
            "role contract version is not ratified".to_string(),
        ));
    }
    if registry.roles.len() != ALL_ROLES.len()
        || registry.roles.iter().collect::<HashSet<_>>().len() != ALL_ROLES.len()
        || ALL_ROLES.iter().any(|role| !registry.roles.contains(role))
    {
        return Err(DependencyContractError::InvalidRegistry(
            "roles are incomplete or duplicated".to_string(),
        ));
    }
    if registry.consumer_kinds.len() != ALL_CONSUMER_KINDS.len()
        || registry.consumer_kinds.iter().collect::<HashSet<_>>().len() != ALL_CONSUMER_KINDS.len()
        || ALL_CONSUMER_KINDS
            .iter()
            .any(|consumer| !registry.consumer_kinds.contains(consumer))
    {
        return Err(DependencyContractError::InvalidRegistry(
            "consumer kinds are incomplete or duplicated".to_string(),
        ));
    }
    if registry.source_change_classes.len() != ALL_SOURCE_CHANGE_CLASSES.len()
        || registry
            .source_change_classes
            .iter()
            .collect::<HashSet<_>>()
            .len()
            != ALL_SOURCE_CHANGE_CLASSES.len()
        || ALL_SOURCE_CHANGE_CLASSES
            .iter()
            .any(|change| !registry.source_change_classes.contains(change))
    {
        return Err(DependencyContractError::InvalidRegistry(
            "source change classes are incomplete or duplicated".to_string(),
        ));
    }

    let mut rule_ids = HashSet::new();
    let mut effect_keys = HashSet::new();
    let mut covered_roles = HashSet::new();
    for rule in &registry.effect_rules {
        if !rule_ids.insert(rule.id.clone()) {
            return Err(DependencyContractError::DuplicateEffectRule(
                rule.id.clone(),
            ));
        }
        let effect_key = format!(
            "{}|{}|{}",
            rule.role.as_str(),
            rule.consumer_kind.as_str(),
            rule.change_class.as_str()
        );
        if !effect_keys.insert(effect_key.clone()) {
            return Err(DependencyContractError::DuplicateEffectRule(effect_key));
        }
        covered_roles.insert(rule.role);
        if let Some(reason_code) = rule.reason_code.as_deref() {
            FindingReasonCode::try_from(reason_code)?;
        }
        if rule.freshness == EvidenceFreshness::Unknown
            && rule.change_class != SourceChangeClass::ComponentUnavailable
        {
            return Err(DependencyContractError::InvalidRegistry(format!(
                "unknown Freshness is only valid for component-unavailable: {}",
                rule.id
            )));
        }
        let expected_requirement = match rule.build_action {
            BuildAction::None => ActionRequirement::None,
            BuildAction::RefreshAvailable => ActionRequirement::Advisory,
            _ => ActionRequirement::Required,
        };
        if rule.action_requirement != expected_requirement {
            return Err(DependencyContractError::InvalidRegistry(format!(
                "Build Action channel mismatch: {}",
                rule.id
            )));
        }
    }
    if ALL_ROLES.iter().any(|role| !covered_roles.contains(role)) {
        return Err(DependencyContractError::InvalidRegistry(
            "every Dependency Role requires an effect rule".to_string(),
        ));
    }
    Ok(())
}

pub fn evaluate_dependency_effect(
    registry: &DependencyEffectRegistry,
    input: DependencyEffectInput<'_>,
) -> Result<DependencyEffect, DependencyContractError> {
    validate_dependency_effect_registry(registry)?;
    let role = DependencyRole::try_from(input.role)?;
    let consumer_kind = NarrativeConsumerKind::try_from(input.consumer_kind)?;
    let change_class = SourceChangeClass::try_from(input.change_class)?;
    let matching_rules: Vec<&DependencyEffectRule> = registry
        .effect_rules
        .iter()
        .filter(|rule| {
            rule.role == role
                && rule.consumer_kind == consumer_kind
                && rule.change_class == change_class
        })
        .collect();
    if matching_rules.len() != 1 {
        return Err(DependencyContractError::MissingEffectRule {
            role: input.role.to_string(),
            consumer_kind: input.consumer_kind.to_string(),
            change_class: input.change_class.to_string(),
        });
    }
    let rule = matching_rules[0];
    Ok(DependencyEffect {
        freshness: rule.freshness,
        reason_code: rule.reason_code.clone(),
        build_action: rule.build_action,
        action_requirement: rule.action_requirement,
    })
}

pub fn load_dependency_role_registry() -> Result<DependencyEffectRegistry, DependencyContractError>
{
    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct RawRegistry {
        role_contract_version: String,
        roles: Vec<RawRole>,
        source_change_classes: Vec<SourceChangeClass>,
        effect_rules: Vec<DependencyEffectRule>,
    }

    #[derive(Debug, Deserialize)]
    struct RawRole {
        id: DependencyRole,
    }

    let raw: RawRegistry = serde_json::from_str(include_str!(
        "../../../../policies/narrative/narrative-dependency-role-registry.json"
    ))
    .map_err(|error| DependencyContractError::PolicyParse(error.to_string()))?;
    let registry = DependencyEffectRegistry {
        role_contract_version: raw.role_contract_version,
        roles: raw.roles.into_iter().map(|role| role.id).collect(),
        consumer_kinds: ALL_CONSUMER_KINDS.to_vec(),
        source_change_classes: raw.source_change_classes,
        effect_rules: raw.effect_rules,
    };
    validate_dependency_effect_registry(&registry)?;
    Ok(registry)
}

pub fn aggregate_dependency_build_actions(effects: &[DependencyEffect]) -> ConsumerBuildSummary {
    let mut required_actions = Vec::new();
    let mut advisory_actions = Vec::new();
    for effect in effects {
        match (effect.action_requirement, effect.build_action) {
            (ActionRequirement::Required, BuildAction::None)
            | (ActionRequirement::Advisory, BuildAction::None) => {
                // An inconsistent effect cannot be trusted as a lower-impact
                // action.  The compatibility projection fails closed to a
                // required Manual action; the independent lists remain safe.
                if !required_actions.contains(&BuildAction::Manual) {
                    required_actions.push(BuildAction::Manual);
                }
            }
            (ActionRequirement::None, BuildAction::None) => {}
            (ActionRequirement::None, _) => {
                if !required_actions.contains(&BuildAction::Manual) {
                    required_actions.push(BuildAction::Manual);
                }
            }
            (ActionRequirement::Required, BuildAction::RefreshAvailable) => {
                // Refresh-available is advisory-only in the D0 contract. A
                // malformed required declaration must never be downgraded
                // into an advisory action or exposed as a required refresh.
                if !required_actions.contains(&BuildAction::Manual) {
                    required_actions.push(BuildAction::Manual);
                }
            }
            (ActionRequirement::Required, action) => {
                if !required_actions.contains(&action) {
                    required_actions.push(action);
                }
            }
            (ActionRequirement::Advisory, BuildAction::RefreshAvailable) => {
                if !advisory_actions.contains(&BuildAction::RefreshAvailable) {
                    advisory_actions.push(BuildAction::RefreshAvailable);
                }
            }
            (ActionRequirement::Advisory, _) => {
                if !required_actions.contains(&BuildAction::Manual) {
                    required_actions.push(BuildAction::Manual);
                }
            }
        }
    }

    let required_order = [
        BuildAction::RevalidateExact,
        BuildAction::ReanchorCandidate,
        BuildAction::ResolveOnly,
        BuildAction::RecompileOnly,
        BuildAction::RebuildRequired,
        BuildAction::Manual,
    ];
    required_actions.sort_by_key(|action| {
        required_order
            .iter()
            .position(|candidate| candidate == action)
            .unwrap_or(required_order.len())
    });
    let compatibility_primary_action = required_actions
        .last()
        .copied()
        .or_else(|| advisory_actions.last().copied())
        .unwrap_or(BuildAction::None);
    ConsumerBuildSummary {
        required_actions,
        advisory_actions,
        compatibility_primary_action,
    }
}
