//! Pure Narrative IR V2 structural validation and Chronicle adapter parity.
//!
//! This module is deliberately a contract boundary only.  It has no writer,
//! persistence, runtime publication, Freshness, or activation integration.
//! Canonical scope bytes and digests always go through [`crate::canonical_json`]
//! so that Rust and TypeScript share one canonicalization primitive.

use serde_json::{json, Map, Value};
use thiserror::Error;

use crate::canonical_json::{canonical_json_digest, canonical_json_string};
use crate::narrative_dependency::{
    canonicalize_dependency_selector, evaluate_dependency_effect, load_dependency_role_registry,
    validate_dependency_selector_value, DependencyContractError, DependencyEffectInput,
    DependencyRole,
};

pub const NARRATIVE_SCOPE_V2_SCHEMA_VERSION: u64 = 2;
pub const NARRATIVE_SCOPE_V2_REGISTRY_VERSION: &str = "narrative-scope/2";
pub const NARRATIVE_IR_CONTRACT_VERSION: &str = "narrative-ir/2";
pub const NARRATIVE_IR_ENVELOPE_V2_SCHEMA_VERSION: u64 = 2;
pub const CHRONICLE_SCENE_EVENT_ASSERTION_KIND: &str = "scene-event@1";
pub const CHRONICLE_SCENE_EVENT_ADAPTER_ID: &str = "chronicle.scene-event";
pub const CHRONICLE_SCENE_EVENT_ADAPTER_VERSION: &str = "1";
pub const CHRONICLE_EVENT_PROPOSAL_KIND: &str = "chronicle.create-event@1";
pub const CHRONICLE_EVENT_PROPOSAL_SCHEMA_ID: &str = "narrative.chronicle-event.create";
pub const CHRONICLE_EVENT_PROPOSAL_SCHEMA_VERSION: &str = "1";
pub const CHRONICLE_SCENE_EVENT_ASSERTION_SCHEMA_ID: &str = "narrative.chronicle.scene-event";
pub const CHRONICLE_SCENE_EVENT_ASSERTION_SCHEMA_VERSION: &str = "1";

const SCOPE_AXES: [&str; 9] = [
    "timeline",
    "worldline",
    "scene",
    "viewpoint",
    "knowledgeHolder",
    "audience",
    "narrativeLayer",
    "storyTime",
    "readingOrder",
];
const REFERENCE_AXES: [&str; 7] = [
    "timeline",
    "worldline",
    "scene",
    "viewpoint",
    "knowledgeHolder",
    "audience",
    "narrativeLayer",
];
const TEMPORAL_AXES: [&str; 2] = ["storyTime", "readingOrder"];

#[derive(Debug, Error)]
pub enum NarrativeIrValidationError {
    #[error("{reason} at {path}")]
    Validation { reason: &'static str, path: String },
    #[error("canonical JSON failed: {0}")]
    Canonical(String),
}

fn validation_error(reason: &'static str, path: impl Into<String>) -> NarrativeIrValidationError {
    NarrativeIrValidationError::Validation {
        reason,
        path: path.into(),
    }
}

fn canonical_error(error: impl std::fmt::Display) -> NarrativeIrValidationError {
    NarrativeIrValidationError::Canonical(error.to_string())
}

fn object<'a>(
    value: &'a Value,
    path: &str,
) -> Result<&'a Map<String, Value>, NarrativeIrValidationError> {
    value
        .as_object()
        .ok_or_else(|| validation_error("object-required", path))
}

fn non_empty_string(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.trim().is_empty())
}

fn require<'a>(
    value: &'a Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<&'a Value, NarrativeIrValidationError> {
    value
        .get(key)
        .ok_or_else(|| validation_error("missing-field", format!("{path}.{key}")))
}

fn reject_unknown(
    value: &Map<String, Value>,
    allowed: &[&str],
    path: &str,
) -> Result<(), NarrativeIrValidationError> {
    if let Some(key) = value.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(validation_error("unknown-field", format!("{path}.{key}")));
    }
    Ok(())
}

fn is_known_unresolved_reason(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some(
            "not-provided"
                | "ambiguous"
                | "missing-reference"
                | "unsupported-axis"
                | "legacy-axis-unknown"
        )
    )
}

fn validate_constraint_id(
    value: &Map<String, Value>,
    path: &str,
) -> Result<(), NarrativeIrValidationError> {
    if let Some(constraint_id) = value.get("constraintId") {
        if !non_empty_string(constraint_id) {
            return Err(validation_error(
                "invalid-constraint-id",
                format!("{path}.constraintId"),
            ));
        }
    }
    Ok(())
}

fn validate_unresolved(
    value: &Map<String, Value>,
    path: &str,
) -> Result<(), NarrativeIrValidationError> {
    reject_unknown(value, &["kind", "reason", "constraintId"], path)?;
    let reason = require(value, "reason", path)?;
    if !is_known_unresolved_reason(reason) {
        return Err(validation_error(
            "unsupported-unresolved-reason",
            format!("{path}.reason"),
        ));
    }
    validate_constraint_id(value, path)
}

fn validate_reference_constraint(
    value: &Value,
    path: &str,
) -> Result<(), NarrativeIrValidationError> {
    let value = object(value, path)?;
    let kind = require(value, "kind", path)?;
    match kind.as_str() {
        Some("any") => reject_unknown(value, &["kind"], path),
        Some("exact") => {
            reject_unknown(value, &["kind", "ref"], path)?;
            let reference = require(value, "ref", path)?;
            if !non_empty_string(reference) {
                return Err(validation_error("empty-reference", format!("{path}.ref")));
            }
            Ok(())
        }
        Some("unresolved") => validate_unresolved(value, path),
        _ => Err(validation_error(
            "unsupported-constraint-kind",
            format!("{path}.kind"),
        )),
    }
}

fn validate_boundary(value: &Value, path: &str) -> Result<(), NarrativeIrValidationError> {
    let value = object(value, path)?;
    reject_unknown(value, &["ref", "inclusive"], path)?;
    if !non_empty_string(require(value, "ref", path)?)
        || !require(value, "inclusive", path)?.is_boolean()
    {
        return Err(validation_error("invalid-interval-boundary", path));
    }
    Ok(())
}

fn validate_temporal_constraint(
    value: &Value,
    path: &str,
) -> Result<(), NarrativeIrValidationError> {
    let value = object(value, path)?;
    let kind = require(value, "kind", path)?;
    match kind.as_str() {
        Some("any") => reject_unknown(value, &["kind"], path),
        Some("interval") => {
            reject_unknown(value, &["kind", "from", "until"], path)?;
            if !value.contains_key("from") && !value.contains_key("until") {
                return Err(validation_error("interval-boundary-required", path));
            }
            if let Some(from) = value.get("from") {
                validate_boundary(from, &format!("{path}.from"))?;
            }
            if let Some(until) = value.get("until") {
                validate_boundary(until, &format!("{path}.until"))?;
            }
            Ok(())
        }
        Some("unresolved") => validate_unresolved(value, path),
        _ => Err(validation_error(
            "unsupported-constraint-kind",
            format!("{path}.kind"),
        )),
    }
}

/// Validate the complete, structural Narrative Scope V2 object.
pub fn validate_narrative_scope_v2(value: &Value) -> Result<(), NarrativeIrValidationError> {
    let value = value
        .as_object()
        .ok_or_else(|| validation_error("scope-must-be-object", "scope"))?;
    reject_unknown(
        value,
        &[
            "schemaVersion",
            "registryVersion",
            "timeline",
            "worldline",
            "scene",
            "viewpoint",
            "knowledgeHolder",
            "audience",
            "narrativeLayer",
            "storyTime",
            "readingOrder",
        ],
        "scope",
    )?;
    if require(value, "schemaVersion", "scope")?.as_u64() != Some(NARRATIVE_SCOPE_V2_SCHEMA_VERSION)
    {
        return Err(validation_error(
            "unsupported-schema-version",
            "scope.schemaVersion",
        ));
    }
    if require(value, "registryVersion", "scope")?.as_str()
        != Some(NARRATIVE_SCOPE_V2_REGISTRY_VERSION)
    {
        return Err(validation_error(
            "unsupported-registry-version",
            "scope.registryVersion",
        ));
    }
    for axis in SCOPE_AXES {
        let axis_value = value
            .get(axis)
            .ok_or_else(|| validation_error("missing-axis", format!("scope.{axis}")))?;
        if REFERENCE_AXES.contains(&axis) {
            validate_reference_constraint(axis_value, &format!("scope.{axis}"))?;
        } else if TEMPORAL_AXES.contains(&axis) {
            validate_temporal_constraint(axis_value, &format!("scope.{axis}"))?;
        }
    }
    Ok(())
}

/// Canonicalize a validated Scope V2 through the shared K0 primitive.
pub fn canonical_narrative_scope_v2(value: &Value) -> Result<String, NarrativeIrValidationError> {
    validate_narrative_scope_v2(value)?;
    canonical_json_string(value).map_err(canonical_error)
}

/// Digest canonical bytes of a validated Scope V2 through the shared K0 primitive.
pub fn digest_narrative_scope_v2(value: &Value) -> Result<String, NarrativeIrValidationError> {
    validate_narrative_scope_v2(value)?;
    canonical_json_digest(value).map_err(canonical_error)
}

fn is_digest(value: &Value) -> bool {
    value.as_str().is_some_and(|digest| {
        digest.len() == "sha256:".len() + 64
            && digest.starts_with("sha256:")
            && digest["sha256:".len()..]
                .chars()
                .all(|character| character.is_ascii_hexdigit() && !character.is_ascii_uppercase())
    })
}

fn known_producer_kind(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some(
            "ai-inference"
                | "reconciler-proposal"
                | "author-declaration"
                | "import-metadata"
                | "legacy-migration"
        )
    )
}

fn known_support_class(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some(
            "author-declared"
                | "direct-source"
                | "reported-source"
                | "single-source-inference"
                | "multi-source-inference"
                | "imported-assertion"
                | "unresolved"
        )
    )
}

fn known_modality(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some(
            "modality-explicit-text"
                | "modality-narrator-claim"
                | "modality-hearsay"
                | "modality-character-belief"
                | "modality-inference"
                | "modality-hypothesis"
                | "modality-author-declaration"
                | "modality-imported-assertion"
        )
    )
}

fn known_polarity(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("affirmative" | "negative" | "uncertain")
    )
}

fn known_change_kind(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("add" | "revise" | "retract" | "merge" | "split")
    )
}

fn known_context_exposure(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("deterministic-stage" | "author-supplied" | "model-visible")
    )
}

fn validate_schema_ref(value: &Value, path: &str) -> Result<(), NarrativeIrValidationError> {
    let value = object(value, path)?;
    reject_unknown(value, &["id", "version"], path)?;
    if !non_empty_string(require(value, "id", path)?)
        || !non_empty_string(require(value, "version", path)?)
    {
        return Err(validation_error("invalid-payload-schema-ref", path));
    }
    Ok(())
}

fn validate_producer(value: &Value, path: &str) -> Result<(), NarrativeIrValidationError> {
    let value = object(value, path)?;
    reject_unknown(value, &["kind", "id", "version"], path)?;
    if !known_producer_kind(require(value, "kind", path)?) {
        return Err(validation_error(
            "unsupported-producer-kind",
            format!("{path}.kind"),
        ));
    }
    if !non_empty_string(require(value, "id", path)?)
        || !non_empty_string(require(value, "version", path)?)
    {
        return Err(validation_error("invalid-identifier", path));
    }
    Ok(())
}

fn validate_context_entry(value: &Value, path: &str) -> Result<(), NarrativeIrValidationError> {
    let value = object(value, path)?;
    reject_unknown(
        value,
        &["contextId", "inputRef", "stageId", "exposure", "selector"],
        path,
    )?;
    for field in ["contextId", "inputRef", "stageId"] {
        if !non_empty_string(require(value, field, path)?) {
            return Err(validation_error(
                "invalid-revision-basis",
                format!("{path}.{field}"),
            ));
        }
    }
    if !known_context_exposure(require(value, "exposure", path)?) {
        return Err(validation_error("invalid-revision-basis", path));
    }
    validate_dependency_selector_value(require(value, "selector", path)?, None)
        .map_err(|_| validation_error("invalid-revision-basis", format!("{path}.selector")))?;
    Ok(())
}

fn validate_context_set(
    value: &Value,
    path: &str,
    forbid_model_visible: bool,
) -> Result<(), NarrativeIrValidationError> {
    let values = value
        .as_array()
        .ok_or_else(|| validation_error("invalid-revision-basis", path))?;
    for (index, entry) in values.iter().enumerate() {
        let entry_path = format!("{path}[{index}]");
        validate_context_entry(entry, &entry_path)?;
        if forbid_model_visible
            && entry.get("exposure").and_then(Value::as_str) == Some("model-visible")
        {
            return Err(validation_error(
                "model-visible-context-forbidden",
                format!("{entry_path}.exposure"),
            ));
        }
    }
    Ok(())
}

fn validate_source_basis(value: &Value, path: &str) -> Result<(), NarrativeIrValidationError> {
    let values = value
        .as_array()
        .ok_or_else(|| validation_error("invalid-material-basis", path))?;
    for (index, entry) in values.iter().enumerate() {
        let entry_path = format!("{path}[{index}]");
        let entry = object(entry, &entry_path)?;
        reject_unknown(
            entry,
            &[
                "sourceKind",
                "sourceKey",
                "revisionToken",
                "revisionObservedAt",
            ],
            &entry_path,
        )?;
        for field in ["sourceKind", "sourceKey", "revisionToken"] {
            if !non_empty_string(require(entry, field, &entry_path)?) {
                return Err(validation_error(
                    "invalid-material-basis",
                    format!("{entry_path}.{field}"),
                ));
            }
        }
        if let Some(observed_at) = entry.get("revisionObservedAt") {
            if !non_empty_string(observed_at) {
                return Err(validation_error(
                    "invalid-material-basis",
                    format!("{entry_path}.revisionObservedAt"),
                ));
            }
        }
    }
    Ok(())
}

fn validate_evidence_set(value: &Value, path: &str) -> Result<(), NarrativeIrValidationError> {
    let values = value
        .as_array()
        .ok_or_else(|| validation_error("invalid-material-basis", path))?;
    for (index, entry) in values.iter().enumerate() {
        let entry_path = format!("{path}[{index}]");
        let entry = object(entry, &entry_path)?;
        reject_unknown(
            entry,
            &[
                "evidenceRef",
                "documentRef",
                "quote",
                "quoteDigest",
                "sourceKey",
                "revisionToken",
            ],
            &entry_path,
        )?;
        if !non_empty_string(require(entry, "evidenceRef", &entry_path)?) {
            return Err(validation_error("invalid-material-basis", &entry_path));
        }
        if let Some(quote_digest) = entry.get("quoteDigest") {
            if !is_digest(quote_digest) {
                return Err(validation_error(
                    "invalid-digest",
                    format!("{entry_path}.quoteDigest"),
                ));
            }
        }
        for field in ["documentRef", "quote", "sourceKey", "revisionToken"] {
            if let Some(value) = entry.get(field) {
                if !non_empty_string(value) {
                    return Err(validation_error(
                        "invalid-material-basis",
                        format!("{entry_path}.{field}"),
                    ));
                }
            }
        }
    }
    Ok(())
}

fn validate_dependency_set(value: &Value, path: &str) -> Result<(), NarrativeIrValidationError> {
    let values = value
        .as_array()
        .ok_or_else(|| validation_error("invalid-material-basis", path))?;
    let registry = load_dependency_role_registry()
        .map_err(|_| validation_error("invalid-material-basis", path))?;
    for (index, entry) in values.iter().enumerate() {
        let entry_path = format!("{path}[{index}]");
        let entry = object(entry, &entry_path)?;
        reject_unknown(
            entry,
            &["dependencyId", "inputRef", "contextIds", "role", "selector"],
            &entry_path,
        )?;
        for field in ["dependencyId", "inputRef", "role"] {
            if !non_empty_string(require(entry, field, &entry_path)?) {
                return Err(validation_error(
                    "invalid-material-basis",
                    format!("{entry_path}.{field}"),
                ));
            }
        }
        let context_ids = require(entry, "contextIds", &entry_path)?
            .as_array()
            .ok_or_else(|| validation_error("invalid-material-basis", &entry_path))?;
        if context_ids.iter().any(|id| !non_empty_string(id)) {
            return Err(validation_error("invalid-material-basis", &entry_path));
        }
        let role = DependencyRole::try_from(
            require(entry, "role", &entry_path)?
                .as_str()
                .ok_or_else(|| validation_error("invalid-material-basis", &entry_path))?,
        )
        .map_err(|_| validation_error("invalid-material-basis", format!("{entry_path}.role")))?;
        let role_name = role.as_str();
        let mut effect_found = false;
        for change_class in &registry.source_change_classes {
            match evaluate_dependency_effect(
                &registry,
                DependencyEffectInput {
                    role: role_name,
                    consumer_kind: "proposal-revision",
                    change_class: change_class.as_str(),
                },
            ) {
                Ok(_) => effect_found = true,
                Err(DependencyContractError::MissingEffectRule { .. }) => {}
                Err(_) => {
                    return Err(validation_error(
                        "invalid-material-basis",
                        format!("{entry_path}.role"),
                    ));
                }
            }
        }
        if !effect_found {
            return Err(validation_error(
                "invalid-material-basis",
                format!("{entry_path}.role"),
            ));
        }
        validate_dependency_selector_value(require(entry, "selector", &entry_path)?, None)
            .map_err(|_| {
                validation_error("invalid-material-basis", format!("{entry_path}.selector"))
            })?;
    }
    Ok(())
}

fn validate_material_basis(value: &Value) -> Result<(), NarrativeIrValidationError> {
    let path = "effectiveMaterialBasis";
    let value = object(value, path)?;
    reject_unknown(
        value,
        &[
            "sourceBasis",
            "evidenceSet",
            "dependencySet",
            "dependencySetDigest",
            "materialBasisDigest",
        ],
        path,
    )?;
    validate_source_basis(
        require(value, "sourceBasis", path)?,
        "effectiveMaterialBasis.sourceBasis",
    )?;
    validate_evidence_set(
        require(value, "evidenceSet", path)?,
        "effectiveMaterialBasis.evidenceSet",
    )?;
    validate_dependency_set(
        require(value, "dependencySet", path)?,
        "effectiveMaterialBasis.dependencySet",
    )?;
    if !is_digest(require(value, "dependencySetDigest", path)?)
        || !is_digest(require(value, "materialBasisDigest", path)?)
    {
        return Err(validation_error("invalid-digest", path));
    }
    Ok(())
}

fn evidence_input_ref(entry: &Map<String, Value>) -> Option<&str> {
    entry
        .get("sourceKey")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            entry
                .get("evidenceRef")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
}

fn canonical_selector(value: &Value) -> Option<String> {
    let selector = validate_dependency_selector_value(value, None).ok()?;
    canonicalize_dependency_selector(&selector).ok()
}

fn validate_material_consistency(
    material: &Map<String, Value>,
    context_set: &Value,
    context_path: &str,
) -> Result<(), NarrativeIrValidationError> {
    let evidence_values = require(material, "evidenceSet", "effectiveMaterialBasis")?
        .as_array()
        .ok_or_else(|| {
            validation_error(
                "invalid-material-basis",
                "effectiveMaterialBasis.evidenceSet",
            )
        })?;
    let dependency_values = require(material, "dependencySet", "effectiveMaterialBasis")?
        .as_array()
        .ok_or_else(|| {
            validation_error(
                "invalid-material-basis",
                "effectiveMaterialBasis.dependencySet",
            )
        })?;

    for (index, evidence) in evidence_values.iter().enumerate() {
        let evidence = object(
            evidence,
            &format!("effectiveMaterialBasis.evidenceSet[{index}]"),
        )?;
        let expected_input_ref = evidence_input_ref(evidence).ok_or_else(|| {
            validation_error(
                "invalid-material-basis",
                format!("effectiveMaterialBasis.evidenceSet[{index}]"),
            )
        })?;
        let covered = dependency_values.iter().any(|dependency| {
            let Some(dependency) = dependency.as_object() else {
                return false;
            };
            dependency.get("role").and_then(Value::as_str) == Some("direct-evidence")
                && dependency.get("inputRef").and_then(Value::as_str) == Some(expected_input_ref)
        });
        if !covered {
            return Err(validation_error(
                "invalid-material-basis",
                format!("effectiveMaterialBasis.evidenceSet[{index}]"),
            ));
        }
    }

    let context_values = context_set
        .as_array()
        .ok_or_else(|| validation_error("invalid-revision-basis", context_path))?;
    let available_context_ids = context_values
        .iter()
        .filter_map(|context| context.get("contextId").and_then(Value::as_str))
        .collect::<std::collections::HashSet<_>>();
    for (index, dependency) in dependency_values.iter().enumerate() {
        let dependency = object(
            dependency,
            &format!("effectiveMaterialBasis.dependencySet[{index}]"),
        )?;
        let context_ids = dependency
            .get("contextIds")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                validation_error(
                    "invalid-material-basis",
                    format!("effectiveMaterialBasis.dependencySet[{index}].contextIds"),
                )
            })?;
        if context_ids.iter().any(|context_id| {
            context_id
                .as_str()
                .is_none_or(|context_id| !available_context_ids.contains(context_id))
        }) {
            return Err(validation_error(
                "invalid-material-basis",
                format!("effectiveMaterialBasis.dependencySet[{index}].contextIds"),
            ));
        }
    }
    for (index, context) in context_values.iter().enumerate() {
        let Some(context) = context.as_object() else {
            continue;
        };
        if context.get("exposure").and_then(Value::as_str) != Some("model-visible") {
            continue;
        }
        let context_id = context.get("contextId").and_then(Value::as_str);
        let input_ref = context.get("inputRef").and_then(Value::as_str);
        let selector_digest = context.get("selector").and_then(canonical_selector);
        let covered = dependency_values.iter().any(|dependency| {
            let Some(dependency) = dependency.as_object() else {
                return false;
            };
            let context_ids = dependency
                .get("contextIds")
                .and_then(Value::as_array)
                .map(|ids| {
                    context_id.is_some_and(|id| {
                        ids.iter().any(|candidate| candidate.as_str() == Some(id))
                    })
                })
                .unwrap_or(false);
            context_ids
                && input_ref.is_some_and(|input| {
                    dependency.get("inputRef").and_then(Value::as_str) == Some(input)
                })
                && selector_digest.is_some()
                && dependency.get("selector").and_then(canonical_selector) == selector_digest
        });
        if !covered {
            return Err(validation_error(
                "invalid-material-basis",
                format!("{context_path}[{index}]"),
            ));
        }
    }
    Ok(())
}

fn validate_interpretation_basis(
    value: &Map<String, Value>,
) -> Result<(), NarrativeIrValidationError> {
    let path = "revisionBasis";
    reject_unknown(
        value,
        &[
            "kind",
            "runId",
            "taskId",
            "producer",
            "contextSet",
            "contextSetDigest",
            "componentContractDigest",
            "finalRequestDigest",
        ],
        path,
    )?;
    if require(value, "kind", path)?.as_str() != Some("interpretation") {
        return Err(validation_error(
            "invalid-revision-basis",
            "revisionBasis.kind",
        ));
    }
    if !non_empty_string(require(value, "runId", path)?)
        || !non_empty_string(require(value, "taskId", path)?)
    {
        return Err(validation_error("invalid-revision-basis", path));
    }
    validate_producer(require(value, "producer", path)?, "revisionBasis.producer")?;
    validate_context_set(
        require(value, "contextSet", path)?,
        "revisionBasis.contextSet",
        false,
    )?;
    for field in [
        "contextSetDigest",
        "componentContractDigest",
        "finalRequestDigest",
    ] {
        if !is_digest(require(value, field, path)?) {
            return Err(validation_error(
                "invalid-digest",
                format!("revisionBasis.{field}"),
            ));
        }
    }
    Ok(())
}

fn validate_human_basis(value: &Map<String, Value>) -> Result<(), NarrativeIrValidationError> {
    let path = "revisionBasis";
    reject_unknown(
        value,
        &[
            "kind",
            "parentRevisionId",
            "expectedParentEnvelopeDigest",
            "parentAssertionDigest",
            "rootInterpretationRevisionId",
            "derivation",
            "revisionActor",
            "derivationContextSet",
            "derivationContextSetDigest",
        ],
        path,
    )?;
    if require(value, "kind", path)?.as_str() != Some("human-derived") {
        return Err(validation_error(
            "invalid-revision-basis",
            "revisionBasis.kind",
        ));
    }
    for field in ["parentRevisionId", "rootInterpretationRevisionId"] {
        if !non_empty_string(require(value, field, path)?) {
            return Err(validation_error(
                "invalid-revision-basis",
                format!("revisionBasis.{field}"),
            ));
        }
    }
    for field in [
        "expectedParentEnvelopeDigest",
        "parentAssertionDigest",
        "derivationContextSetDigest",
    ] {
        if !is_digest(require(value, field, path)?) {
            return Err(validation_error(
                "invalid-digest",
                format!("revisionBasis.{field}"),
            ));
        }
    }

    let derivation = object(
        require(value, "derivation", path)?,
        "revisionBasis.derivation",
    )?;
    reject_unknown(
        derivation,
        &[
            "adapterId",
            "adapterVersion",
            "kind",
            "proposalPayloadChangedPaths",
        ],
        "revisionBasis.derivation",
    )?;
    if !non_empty_string(require(
        derivation,
        "adapterId",
        "revisionBasis.derivation",
    )?) || !non_empty_string(require(
        derivation,
        "adapterVersion",
        "revisionBasis.derivation",
    )?) || !matches!(
        require(derivation, "kind", "revisionBasis.derivation")?.as_str(),
        Some("projection-only" | "scope-override")
    ) {
        return Err(validation_error(
            "invalid-revision-basis",
            "revisionBasis.derivation",
        ));
    }
    let changed_paths = require(
        derivation,
        "proposalPayloadChangedPaths",
        "revisionBasis.derivation",
    )?
    .as_array()
    .ok_or_else(|| {
        validation_error(
            "invalid-revision-basis",
            "revisionBasis.derivation.proposalPayloadChangedPaths",
        )
    })?;
    if changed_paths.iter().any(|path| !non_empty_string(path)) {
        return Err(validation_error(
            "invalid-revision-basis",
            "revisionBasis.derivation.proposalPayloadChangedPaths",
        ));
    }

    let actor = object(
        require(value, "revisionActor", path)?,
        "revisionBasis.revisionActor",
    )?;
    reject_unknown(actor, &["kind", "surfaceId"], "revisionBasis.revisionActor")?;
    if actor.get("kind").and_then(Value::as_str) != Some("human")
        || !non_empty_string(require(actor, "surfaceId", "revisionBasis.revisionActor")?)
    {
        return Err(validation_error(
            "invalid-revision-basis",
            "revisionBasis.revisionActor",
        ));
    }
    validate_context_set(
        require(value, "derivationContextSet", path)?,
        "revisionBasis.derivationContextSet",
        true,
    )
}

fn validate_revision_basis(value: &Value) -> Result<(), NarrativeIrValidationError> {
    let value = object(value, "revisionBasis")?;
    match value.get("kind").and_then(Value::as_str) {
        Some("interpretation") => validate_interpretation_basis(value),
        Some("human-derived") => validate_human_basis(value),
        _ => Err(validation_error(
            "invalid-revision-basis",
            "revisionBasis.kind",
        )),
    }
}

fn validate_projection_binding(value: &Value) -> Result<(), NarrativeIrValidationError> {
    let path = "projectionBinding";
    let value = object(value, path)?;
    reject_unknown(
        value,
        &[
            "proposalKind",
            "proposalSchemaRef",
            "proposalPayloadDigest",
            "adapterContractId",
            "adapterContractVersion",
        ],
        path,
    )?;
    validate_schema_ref(
        require(value, "proposalSchemaRef", path)?,
        "projectionBinding.proposalSchemaRef",
    )?;
    if !non_empty_string(require(value, "proposalKind", path)?)
        || !is_digest(require(value, "proposalPayloadDigest", path)?)
    {
        return Err(validation_error("invalid-projection-binding", path));
    }
    if require(value, "adapterContractId", path)?.as_str() != Some(CHRONICLE_SCENE_EVENT_ADAPTER_ID)
        || require(value, "adapterContractVersion", path)?.as_str()
            != Some(CHRONICLE_SCENE_EVENT_ADAPTER_VERSION)
    {
        return Err(validation_error(
            "unsupported-adapter",
            "projectionBinding.adapterContractId",
        ));
    }
    Ok(())
}

/// Fail-closed structural validation equivalent to K1's Envelope V2 validator.
/// Assertion payload semantics remain owned by the assertion-kind adapter.
pub fn validate_narrative_revision_envelope_v2(
    value: &Value,
) -> Result<(), NarrativeIrValidationError> {
    let value = value
        .as_object()
        .ok_or_else(|| validation_error("envelope-must-be-object", "envelope"))?;
    reject_unknown(
        value,
        &[
            "schemaVersion",
            "assertion",
            "assertionDigests",
            "changeIntent",
            "effectiveMaterialBasis",
            "revisionBasis",
            "projectionBinding",
        ],
        "envelope",
    )?;
    if require(value, "schemaVersion", "envelope")?.as_u64()
        != Some(NARRATIVE_IR_ENVELOPE_V2_SCHEMA_VERSION)
    {
        return Err(validation_error(
            "unsupported-schema-version",
            "schemaVersion",
        ));
    }

    let assertion = object(require(value, "assertion", "envelope")?, "assertion")?;
    reject_unknown(
        assertion,
        &[
            "assertionId",
            "assertionKind",
            "payloadSchemaRef",
            "payload",
            "scope",
            "modality",
            "polarity",
            "supportClass",
            "producer",
            "producerConfidence",
        ],
        "assertion",
    )?;
    let assertion_id = require(assertion, "assertionId", "assertion")?;
    if !assertion_id.is_null() && !non_empty_string(assertion_id) {
        return Err(validation_error(
            "invalid-identifier",
            "assertion.assertionId",
        ));
    }
    if require(assertion, "assertionKind", "assertion")?.as_str()
        != Some(CHRONICLE_SCENE_EVENT_ASSERTION_KIND)
    {
        return Err(validation_error(
            "unsupported-assertion-kind",
            "assertion.assertionKind",
        ));
    }
    if !assertion.contains_key("payload") {
        return Err(validation_error("missing-field", "assertion.payload"));
    }
    validate_schema_ref(
        require(assertion, "payloadSchemaRef", "assertion")?,
        "assertion.payloadSchemaRef",
    )?;
    validate_narrative_scope_v2(require(assertion, "scope", "assertion")?)
        .map_err(|_| validation_error("invalid-scope", "assertion.scope"))?;
    if !known_modality(require(assertion, "modality", "assertion")?) {
        return Err(validation_error(
            "unsupported-modality",
            "assertion.modality",
        ));
    }
    if !known_polarity(require(assertion, "polarity", "assertion")?) {
        return Err(validation_error(
            "unsupported-polarity",
            "assertion.polarity",
        ));
    }
    if !known_support_class(require(assertion, "supportClass", "assertion")?) {
        return Err(validation_error(
            "unsupported-support-class",
            "assertion.supportClass",
        ));
    }
    validate_producer(
        require(assertion, "producer", "assertion")?,
        "assertion.producer",
    )?;
    if let Some(confidence) = assertion.get("producerConfidence") {
        let valid = confidence
            .as_f64()
            .is_some_and(|number| number.is_finite() && (0.0..=1.0).contains(&number));
        if !valid {
            return Err(validation_error(
                "invalid-producer-confidence",
                "assertion.producerConfidence",
            ));
        }
    }

    let digests = object(
        require(value, "assertionDigests", "envelope")?,
        "assertionDigests",
    )?;
    reject_unknown(
        digests,
        &["assertionCoreDigest", "scopeDigest", "assertionDigest"],
        "assertionDigests",
    )?;
    for field in ["assertionCoreDigest", "scopeDigest", "assertionDigest"] {
        if !is_digest(require(digests, field, "assertionDigests")?) {
            return Err(validation_error(
                "invalid-digest",
                format!("assertionDigests.{field}"),
            ));
        }
    }

    let change = object(require(value, "changeIntent", "envelope")?, "changeIntent")?;
    reject_unknown(
        change,
        &["changeKind", "targetProjectionRef"],
        "changeIntent",
    )?;
    let change_kind = require(change, "changeKind", "changeIntent")?;
    if !known_change_kind(change_kind) {
        return Err(validation_error(
            "unsupported-change-kind",
            "changeIntent.changeKind",
        ));
    }
    if let Some(target) = change.get("targetProjectionRef") {
        if !non_empty_string(target) {
            return Err(validation_error(
                "invalid-identifier",
                "changeIntent.targetProjectionRef",
            ));
        }
    }
    if change_kind.as_str() == Some("add") && change.contains_key("targetProjectionRef") {
        return Err(validation_error(
            "target-projection-forbidden",
            "changeIntent.targetProjectionRef",
        ));
    }
    if change_kind.as_str() == Some("retract") && !change.contains_key("targetProjectionRef") {
        return Err(validation_error(
            "target-projection-required",
            "changeIntent.targetProjectionRef",
        ));
    }

    let material_value = require(value, "effectiveMaterialBasis", "envelope")?;
    validate_material_basis(material_value)?;
    let basis_value = require(value, "revisionBasis", "envelope")?;
    validate_revision_basis(basis_value)?;
    let material = object(material_value, "effectiveMaterialBasis")?;
    let basis = object(basis_value, "revisionBasis")?;
    let (context_set, context_path) = match basis.get("kind").and_then(Value::as_str) {
        Some("interpretation") => (
            require(basis, "contextSet", "revisionBasis")?,
            "revisionBasis.contextSet",
        ),
        Some("human-derived") => (
            require(basis, "derivationContextSet", "revisionBasis")?,
            "revisionBasis.derivationContextSet",
        ),
        _ => {
            return Err(validation_error(
                "invalid-revision-basis",
                "revisionBasis.kind",
            ));
        }
    };
    validate_material_consistency(material, context_set, context_path)?;
    validate_projection_binding(require(value, "projectionBinding", "envelope")?)
}

/// Validate the Chronicle `scene-event@1` add-only binding layered on K1's
/// structural Envelope V2 validator.  Payload interpretation is intentionally
/// limited to the disclosure exclusion at this boundary.
pub fn validate_chronicle_scene_event_v2(value: &Value) -> Result<(), NarrativeIrValidationError> {
    validate_narrative_revision_envelope_v2(value)?;
    let envelope = object(value, "envelope")?;
    let assertion = object(require(envelope, "assertion", "envelope")?, "assertion")?;
    if require(assertion, "payloadSchemaRef", "assertion")?
        .get("id")
        .and_then(Value::as_str)
        != Some(CHRONICLE_SCENE_EVENT_ASSERTION_SCHEMA_ID)
        || require(assertion, "payloadSchemaRef", "assertion")?
            .get("version")
            .and_then(Value::as_str)
            != Some(CHRONICLE_SCENE_EVENT_ASSERTION_SCHEMA_VERSION)
    {
        return Err(validation_error(
            "invalid-payload-schema-ref",
            "assertion.payloadSchemaRef",
        ));
    }
    let payload = require(assertion, "payload", "assertion")?;
    let payload = payload
        .as_object()
        .ok_or_else(|| validation_error("invalid-payload-schema-ref", "assertion.payload"))?;
    if ["secret", "disclosure", "revealDocumentRef"]
        .iter()
        .any(|key| payload.contains_key(*key))
    {
        return Err(validation_error(
            "invalid-payload-schema-ref",
            "assertion.payload",
        ));
    }
    let change = object(
        require(envelope, "changeIntent", "envelope")?,
        "changeIntent",
    )?;
    if change.get("changeKind").and_then(Value::as_str) != Some("add")
        || change.contains_key("targetProjectionRef")
    {
        return Err(validation_error(
            "unsupported-change-kind",
            "changeIntent.changeKind",
        ));
    }
    let binding = object(
        require(envelope, "projectionBinding", "envelope")?,
        "projectionBinding",
    )?;
    if binding.get("proposalKind").and_then(Value::as_str) != Some(CHRONICLE_EVENT_PROPOSAL_KIND)
        || binding
            .get("proposalSchemaRef")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            != Some(CHRONICLE_EVENT_PROPOSAL_SCHEMA_ID)
        || binding
            .get("proposalSchemaRef")
            .and_then(|value| value.get("version"))
            .and_then(Value::as_str)
            != Some(CHRONICLE_EVENT_PROPOSAL_SCHEMA_VERSION)
    {
        return Err(validation_error(
            "invalid-projection-binding",
            "projectionBinding",
        ));
    }
    Ok(())
}

fn validate_non_empty_string_array(
    value: &Value,
    path: &str,
    require_one: bool,
) -> Result<(), NarrativeIrValidationError> {
    let values = value
        .as_array()
        .ok_or_else(|| validation_error("invalid-proposal-payload", path))?;
    if require_one && values.is_empty() {
        return Err(validation_error("invalid-proposal-payload", path));
    }
    if values.iter().any(|item| !non_empty_string(item)) {
        return Err(validation_error("invalid-proposal-payload", path));
    }
    Ok(())
}

fn validate_proposal_payload(value: &Value) -> Result<(), NarrativeIrValidationError> {
    let path = "proposalPayload";
    let value = object(value, path)?;
    reject_unknown(
        value,
        &[
            "eventId",
            "title",
            "note",
            "actuality",
            "significance",
            "semanticType",
            "evidenceAnchorIds",
            "evidenceDocumentRefs",
            "disclosure",
            "unresolvedMetadata",
        ],
        path,
    )?;
    for field in ["eventId", "title"] {
        if !non_empty_string(require(value, field, path)?) {
            return Err(validation_error(
                "invalid-proposal-payload",
                format!("{path}.{field}"),
            ));
        }
    }
    if let Some(note) = value.get("note") {
        if !note.is_null() && note.as_str().is_none() {
            return Err(validation_error(
                "invalid-proposal-payload",
                "proposalPayload.note",
            ));
        }
    } else {
        return Err(validation_error("missing-field", "proposalPayload.note"));
    }
    if !matches!(
        require(value, "actuality", path)?.as_str(),
        Some("actual" | "attempted" | "prevented")
    ) || !matches!(
        require(value, "significance", path)?.as_str(),
        Some("major" | "scene-level")
    ) {
        return Err(validation_error("invalid-proposal-payload", path));
    }
    if let Some(semantic_type) = value.get("semanticType") {
        if !non_empty_string(semantic_type) {
            return Err(validation_error(
                "invalid-proposal-payload",
                "proposalPayload.semanticType",
            ));
        }
    }
    validate_non_empty_string_array(
        require(value, "evidenceAnchorIds", path)?,
        "proposalPayload.evidenceAnchorIds",
        true,
    )?;
    validate_non_empty_string_array(
        require(value, "evidenceDocumentRefs", path)?,
        "proposalPayload.evidenceDocumentRefs",
        true,
    )?;

    let disclosure = object(
        require(value, "disclosure", path)?,
        "proposalPayload.disclosure",
    )?;
    reject_unknown(
        disclosure,
        &["secret", "revealDocumentRef"],
        "proposalPayload.disclosure",
    )?;
    if !require(disclosure, "secret", "proposalPayload.disclosure")?.is_boolean()
        || !non_empty_string(require(
            disclosure,
            "revealDocumentRef",
            "proposalPayload.disclosure",
        )?)
    {
        return Err(validation_error(
            "invalid-proposal-payload",
            "proposalPayload.disclosure",
        ));
    }
    let metadata = object(
        require(value, "unresolvedMetadata", path)?,
        "proposalPayload.unresolvedMetadata",
    )?;
    reject_unknown(
        metadata,
        &[
            "participantSurfaces",
            "locationSurface",
            "temporalExpressions",
        ],
        "proposalPayload.unresolvedMetadata",
    )?;
    validate_non_empty_string_array(
        require(
            metadata,
            "participantSurfaces",
            "proposalPayload.unresolvedMetadata",
        )?,
        "proposalPayload.unresolvedMetadata.participantSurfaces",
        false,
    )?;
    let location = require(
        metadata,
        "locationSurface",
        "proposalPayload.unresolvedMetadata",
    )?;
    if !location.is_null() && !non_empty_string(location) {
        return Err(validation_error(
            "invalid-proposal-payload",
            "proposalPayload.unresolvedMetadata.locationSurface",
        ));
    }
    validate_non_empty_string_array(
        require(
            metadata,
            "temporalExpressions",
            "proposalPayload.unresolvedMetadata",
        )?,
        "proposalPayload.unresolvedMetadata.temporalExpressions",
        false,
    )
}

fn clone_boundary(value: &Value, path: &str) -> Result<Value, NarrativeIrValidationError> {
    validate_boundary(value, path)?;
    let value = object(value, path)?;
    let mut result = Map::new();
    result.insert("ref".to_owned(), require(value, "ref", path)?.clone());
    result.insert(
        "inclusive".to_owned(),
        require(value, "inclusive", path)?.clone(),
    );
    Ok(Value::Object(result))
}

fn clone_interval(value: &Value, path: &str) -> Result<Value, NarrativeIrValidationError> {
    let value = object(value, path)?;
    reject_unknown(value, &["from", "until"], path)?;
    if !value.contains_key("from") && !value.contains_key("until") {
        return Err(validation_error("interval-boundary-required", path));
    }
    let mut result = Map::new();
    result.insert("kind".to_owned(), Value::String("interval".to_owned()));
    for field in ["from", "until"] {
        if let Some(boundary) = value.get(field) {
            result.insert(
                field.to_owned(),
                clone_boundary(boundary, &format!("{path}.{field}"))?,
            );
        }
    }
    Ok(Value::Object(result))
}

fn derive_reveal_scope(
    proposal: &Map<String, Value>,
    reveal_basis: &Value,
) -> Result<(Value, Value, Value), NarrativeIrValidationError> {
    let disclosure = object(
        require(proposal, "disclosure", "proposalPayload")?,
        "proposalPayload.disclosure",
    )?;
    let secret = require(disclosure, "secret", "proposalPayload.disclosure")?
        .as_bool()
        .ok_or_else(|| {
            validation_error(
                "invalid-proposal-payload",
                "proposalPayload.disclosure.secret",
            )
        })?;
    let basis = object(reveal_basis, "revealBasis")?;
    let status = require(basis, "status", "revealBasis")?
        .as_str()
        .ok_or_else(|| validation_error("invalid-reveal-basis", "revealBasis.status"))?;
    let audience = match (secret, status) {
        (false, "not-secret") => {
            reject_unknown(basis, &["status"], "revealBasis")?;
            (json_any(), json_any(), json_any())
        }
        (true, "resolved") => {
            reject_unknown(
                basis,
                &[
                    "status",
                    "documentRef",
                    "audienceRef",
                    "readingOrder",
                    "storyTime",
                ],
                "revealBasis",
            )?;
            let document_ref = require(basis, "documentRef", "revealBasis")?;
            if !non_empty_string(document_ref)
                || document_ref
                    != require(
                        disclosure,
                        "revealDocumentRef",
                        "proposalPayload.disclosure",
                    )?
            {
                return Err(validation_error(
                    "invalid-reveal-basis",
                    "revealBasis.documentRef",
                ));
            }
            let audience_ref = require(basis, "audienceRef", "revealBasis")?;
            if !non_empty_string(audience_ref) {
                return Err(validation_error(
                    "invalid-reveal-basis",
                    "revealBasis.audienceRef",
                ));
            }
            let reading_order = clone_interval(
                require(basis, "readingOrder", "revealBasis")?,
                "revealBasis.readingOrder",
            )?;
            let story_time = clone_interval(
                require(basis, "storyTime", "revealBasis")?,
                "revealBasis.storyTime",
            )?;
            (
                json!({"kind":"exact", "ref": audience_ref}),
                reading_order,
                story_time,
            )
        }
        (true, "unresolved") => {
            reject_unknown(
                basis,
                &["status", "documentRef", "audience", "readingOrder"],
                "revealBasis",
            )?;
            let document_ref = require(basis, "documentRef", "revealBasis")?;
            if !non_empty_string(document_ref)
                || document_ref
                    != require(
                        disclosure,
                        "revealDocumentRef",
                        "proposalPayload.disclosure",
                    )?
            {
                return Err(validation_error(
                    "invalid-reveal-basis",
                    "revealBasis.documentRef",
                ));
            }
            let audience = object(
                require(basis, "audience", "revealBasis")?,
                "revealBasis.audience",
            )?;
            let reading_order = object(
                require(basis, "readingOrder", "revealBasis")?,
                "revealBasis.readingOrder",
            )?;
            let audience_constraint = {
                validate_unresolved(audience, "revealBasis.audience")?;
                json!({
                    "kind": "unresolved",
                    "reason": require(audience, "reason", "revealBasis.audience")?,
                    "constraintId": require(audience, "constraintId", "revealBasis.audience")?
                })
            };
            let reading_constraint = {
                validate_unresolved(reading_order, "revealBasis.readingOrder")?;
                json!({
                    "kind": "unresolved",
                    "reason": require(reading_order, "reason", "revealBasis.readingOrder")?,
                    "constraintId": require(reading_order, "constraintId", "revealBasis.readingOrder")?
                })
            };
            (audience_constraint, reading_constraint, json_any())
        }
        (false, _) => {
            return Err(validation_error(
                "invalid-reveal-basis",
                "revealBasis.status",
            ));
        }
        (true, _) => {
            return Err(validation_error(
                "invalid-reveal-basis",
                "revealBasis.status",
            ));
        }
    };
    Ok(audience)
}

fn json_any() -> Value {
    json!({"kind":"any"})
}

/// The strongest accepted human-derived classification from the Chronicle
/// path contract.  Assertion-affecting and unknown paths are rejected.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChronicleChangeDisposition {
    Accept,
    Reject,
}

impl ChronicleChangeDisposition {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Accept => "accept",
            Self::Reject => "reject",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChronicleChangeClassification {
    pub disposition: ChronicleChangeDisposition,
    pub reason: Option<String>,
    pub changed_paths: Vec<String>,
    pub derivation_kind: Option<String>,
    pub changed_path_classes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChronicleScopeDerivation {
    pub scope: Value,
    pub canonical_json: String,
    pub digest: String,
}

/// Derive the Chronicle Scope V2 object from the complete proposal and reveal
/// basis seam.  Disclosure is used only for Scope; it is never copied into an
/// assertion payload by this pure contract primitive.
pub fn derive_chronicle_scene_event_scope(
    scene_ref: &str,
    proposal_payload: &Value,
    reveal_basis: &Value,
) -> Result<ChronicleScopeDerivation, NarrativeIrValidationError> {
    if scene_ref.trim().is_empty() {
        return Err(validation_error("empty-reference", "sceneRef"));
    }
    validate_proposal_payload(proposal_payload)?;
    let proposal = object(proposal_payload, "proposalPayload")?;
    let (audience, reading_order, story_time) = derive_reveal_scope(proposal, reveal_basis)?;
    let scope = json!({
        "schemaVersion": NARRATIVE_SCOPE_V2_SCHEMA_VERSION,
        "registryVersion": NARRATIVE_SCOPE_V2_REGISTRY_VERSION,
        "timeline": {"kind": "any"},
        "worldline": {"kind": "any"},
        "scene": {"kind": "exact", "ref": scene_ref},
        "viewpoint": {"kind": "any"},
        "knowledgeHolder": {"kind": "any"},
        "audience": audience,
        "narrativeLayer": {"kind": "any"},
        "storyTime": story_time,
        "readingOrder": reading_order
    });
    let canonical_json = canonical_narrative_scope_v2(&scope)?;
    let digest = digest_narrative_scope_v2(&scope)?;
    Ok(ChronicleScopeDerivation {
        scope,
        canonical_json,
        digest,
    })
}

fn pointer_segment(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn collect_changed_paths(before: &Value, after: &Value, prefix: &str, output: &mut Vec<String>) {
    if before == after {
        return;
    }
    match (before.as_object(), after.as_object()) {
        (Some(before), Some(after)) => {
            let mut keys = Vec::new();
            for key in before.keys().chain(after.keys()) {
                if !keys.iter().any(|existing: &String| existing == key) {
                    keys.push(key.clone());
                }
            }
            for key in keys {
                let path = format!("{prefix}/{}", pointer_segment(&key));
                match (before.get(&key), after.get(&key)) {
                    (Some(before), Some(after)) => {
                        collect_changed_paths(before, after, &path, output)
                    }
                    _ => output.push(path),
                }
            }
        }
        _ => output.push(if prefix.is_empty() {
            "/".to_owned()
        } else {
            prefix.to_owned()
        }),
    }
}

/// Classify the complete human-derived Proposal payload diff according to the
/// policy-owned path classes and precedence.  Unknown paths fail closed.
pub fn classify_chronicle_scene_event_changes(
    before: &Value,
    after: &Value,
) -> Result<ChronicleChangeClassification, NarrativeIrValidationError> {
    let mut changed_paths = Vec::new();
    collect_changed_paths(before, after, "", &mut changed_paths);
    let mut changed_path_classes = Vec::new();
    for path in &changed_paths {
        let path_class = match path.as_str() {
            "/title" | "/note" => "projection-only",
            "/disclosure/secret" | "/disclosure/revealDocumentRef" => "scope-affecting",
            _ => "unsupported",
        };
        if !changed_path_classes.iter().any(|class| class == path_class) {
            changed_path_classes.push(path_class.to_owned());
        }
        if path_class == "unsupported" {
            return Ok(ChronicleChangeClassification {
                disposition: ChronicleChangeDisposition::Reject,
                reason: Some("unsupported-path".to_owned()),
                changed_paths,
                derivation_kind: None,
                changed_path_classes,
            });
        }
    }
    let derivation_kind = if changed_path_classes
        .iter()
        .any(|class| class == "scope-affecting")
    {
        "scope-override"
    } else {
        "projection-only"
    };
    Ok(ChronicleChangeClassification {
        disposition: ChronicleChangeDisposition::Accept,
        reason: None,
        changed_paths,
        derivation_kind: Some(derivation_kind.to_owned()),
        changed_path_classes,
    })
}
