//! Pure Native material-basis derivation for NIR-0 C2B.
//!
//! This module deliberately owns no database connection and performs no
//! revision promotion, declaration persistence, or Freshness publication.
//! The public types crossing this boundary are typed; the trusted resolver
//! sidecar is Native-owned and is intentionally not deserializable.

use std::collections::HashSet;

use anyhow::{anyhow, Context};
use grimodex_core::canonical_json_digest;
use grimodex_core::contract_string::is_contract_non_empty;
use grimodex_core::narrative_dependency::{
    canonicalize_dependency_selector, compute_dependency_key, compute_dependency_set_digest,
    validate_dependency_selector, validate_dependency_selector_value, DependencyRole,
    DependencySelector, DependencySetDigestEntry, DEPENDENCY_ROLE_CONTRACT_VERSION,
};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};

use super::declaration_storage::{
    ActiveDependencyDeclarationSet, DependencyDeclaration, DependencyDeclarationSetState,
    StoredDependencyDeclaration,
};
use super::dependency_edges::canonical_source_object_identity;
use super::reconciliation_envelope::SourceBasisRow;
use super::repository::PROPOSAL_REVISION_D1_PRODUCER_GENERATION;

pub(crate) const D1_PRODUCER_ID: &str = "proposal-revision-source-basis";
const PROPOSAL_REVISION_CONSUMER_KIND: &str = "proposal-revision";

/// The exact material carried by a validated parent or derived child.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialBasis {
    pub source_basis: Vec<MaterialSourceBasisEntry>,
    pub evidence_set: Vec<MaterialEvidenceEntry>,
    pub dependency_set: Vec<MaterialDependencyEntry>,
    pub dependency_set_digest: String,
    pub material_basis_digest: String,
}

/// A Source observation in the effective material basis.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialSourceBasisEntry {
    pub source_kind: String,
    pub source_key: String,
    pub revision_token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_observed_at: Option<String>,
}

/// A quoted Evidence observation bound to a Source revision.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialEvidenceEntry {
    pub evidence_ref: String,
    pub document_ref: String,
    pub quote: String,
    pub quote_digest: String,
    pub source_key: String,
    pub revision_token: String,
}

/// A typed Dependency declaration used by both C2B projections.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaterialDependencyEntry {
    pub dependency_id: String,
    pub input_ref: String,
    pub context_ids: Vec<String>,
    pub role: DependencyRole,
    #[serde(deserialize_with = "deserialize_dependency_selector")]
    pub selector: DependencySelector,
}

fn deserialize_dependency_selector<'de, D>(deserializer: D) -> Result<DependencySelector, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    validate_dependency_selector_value(&value, None).map_err(D::Error::custom)
}

/// Native authority used to bind a material resolution to its parent CAS and
/// the edited Chronicle document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HumanMaterialResolutionContext {
    pub project_id: String,
    pub parent_revision_id: String,
    pub expected_parent_owning_run_id: String,
    pub expected_parent_envelope_digest: String,
    pub scene_ref: String,
    pub edited_document_ref: String,
    pub secret_scope: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HumanMaterialParentBundle {
    pub project_id: String,
    pub consumer_kind: String,
    pub consumer_key: String,
    pub owning_run_id: String,
    pub expected_parent_envelope_digest: String,
    pub material_basis: MaterialBasis,
    pub source_basis: Vec<SourceBasisRow>,
    pub active_dependency_declaration_set: ActiveDependencyDeclarationSet,
    pub persisted_v1_edges: Vec<V1PersistedEdge>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HumanMaterialDerivationKind {
    ProjectionOnly,
    ScopeOverride,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HumanMaterialResolution {
    pub material_basis: MaterialBasis,
}

/// A Native-only complete final set for a scope override. This type has no
/// Serialize/Deserialize implementation so renderer-shaped input cannot
/// smuggle a trusted result across the boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedHumanMaterialResolution {
    pub project_id: String,
    pub parent_revision_id: String,
    pub expected_parent_envelope_digest: String,
    pub scene_ref: String,
    pub edited_document_ref: String,
    pub source_basis: Vec<TrustedSourceBasisEntry>,
    pub evidence_set: Vec<TrustedEvidenceEntry>,
    pub dependency_set: Vec<TrustedDependencyEntry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedSourceBasisEntry {
    pub source_kind: String,
    pub source_key: String,
    pub revision_token: String,
    pub revision_observed_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedEvidenceEntry {
    pub evidence_ref: String,
    pub document_ref: String,
    pub quote: String,
    pub quote_digest: String,
    pub source_key: String,
    pub revision_token: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedDependencyEntry {
    pub dependency_id: String,
    pub input_ref: String,
    pub context_ids: Vec<String>,
    pub role: DependencyRole,
    pub selector: DependencySelector,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct D1ParentAuthority {
    pub project_id: String,
    pub consumer_kind: String,
    pub consumer_key: String,
    pub producer_id: String,
    pub producer_generation: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct D1DeclarationProjection {
    pub project_id: String,
    pub consumer_kind: String,
    pub consumer_key: String,
    pub producer_id: String,
    pub producer_generation: i64,
    pub declarations: Vec<DependencyDeclaration>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct V1ParentAuthority {
    pub project_id: String,
    pub consumer_kind: String,
    pub consumer_key: String,
    pub owning_run_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct V1EdgeExpectation {
    pub source_object_identity: String,
    pub revision_token: String,
    pub owning_run_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct V1PersistedEdge {
    pub project_id: String,
    pub consumer_kind: String,
    pub consumer_key: String,
    pub source_object_identity: String,
    pub read_set_json: String,
    pub owning_run_id: Option<String>,
    pub generated_by_transaction_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MaterialBasisDigestInput<'a> {
    source_basis: &'a [MaterialSourceBasisEntry],
    evidence_set: &'a [MaterialEvidenceEntry],
    dependency_set: &'a [MaterialDependencyEntry],
}

fn canonical_digest<T: Serialize>(value: &T, label: &str) -> anyhow::Result<String> {
    let json = serde_json::to_value(value)
        .with_context(|| format!("NEX_C2B_MATERIAL_CANONICALIZE: {label}"))?;
    canonical_json_digest(&json)
        .map_err(|error| anyhow!("NEX_C2B_MATERIAL_CANONICALIZE: {label}: {error}"))
}

fn digest_bytes(value: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(value)))
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

fn ensure_non_empty(value: &str, field: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !value.trim().is_empty() && value.trim() == value,
        "NEX_C2B_MATERIAL_FIELD_INVALID: {field} must be non-empty and trimmed"
    );
    Ok(())
}

fn validate_context(context: &HumanMaterialResolutionContext) -> anyhow::Result<()> {
    ensure_non_empty(&context.project_id, "projectId")?;
    ensure_non_empty(&context.parent_revision_id, "parentRevisionId")?;
    ensure_non_empty(
        &context.expected_parent_owning_run_id,
        "expectedParentOwningRunId",
    )?;
    ensure_non_empty(&context.scene_ref, "sceneRef")?;
    ensure_non_empty(&context.edited_document_ref, "editedDocumentRef")?;
    anyhow::ensure!(
        is_digest(&context.expected_parent_envelope_digest),
        "NEX_C2B_MATERIAL_PARENT_DIGEST_INVALID: expectedParentEnvelopeDigest is not sha256"
    );
    Ok(())
}

fn validate_source_basis(
    source_basis: &[MaterialSourceBasisEntry],
) -> anyhow::Result<HashSet<String>> {
    anyhow::ensure!(
        !source_basis.is_empty(),
        "NEX_C2B_MATERIAL_SOURCE_EMPTY: sourceBasis must not be empty"
    );
    let mut identities = HashSet::new();
    for source in source_basis {
        ensure_non_empty(&source.source_kind, "sourceKind")?;
        ensure_non_empty(&source.source_key, "sourceKey")?;
        ensure_non_empty(&source.revision_token, "revisionToken")?;
        if let Some(observed_at) = &source.revision_observed_at {
            ensure_non_empty(observed_at, "revisionObservedAt")?;
        }
        let identity = canonical_source_object_identity(&source.source_kind, &source.source_key)
            .map_err(|error| {
                anyhow!(
                    "NEX_C2B_MATERIAL_SOURCE_KIND_INVALID: {}: {error}",
                    source.source_kind
                )
            })?;
        anyhow::ensure!(
            identity == source.source_key,
            "NEX_C2B_MATERIAL_SOURCE_KEY_INVALID: sourceKey '{}' is not canonical",
            source.source_key
        );
        anyhow::ensure!(
            identities.insert(identity),
            "NEX_C2B_MATERIAL_SOURCE_DUPLICATE: sourceKey '{}' is duplicated",
            source.source_key
        );
    }
    Ok(identities)
}

fn validate_evidence_set(
    evidence_set: &[MaterialEvidenceEntry],
    source_keys: &HashSet<String>,
    source_basis: &[MaterialSourceBasisEntry],
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !evidence_set.is_empty(),
        "NEX_C2B_MATERIAL_EVIDENCE_EMPTY: evidenceSet must not be empty"
    );
    let mut evidence_ids = HashSet::new();
    for evidence in evidence_set {
        ensure_non_empty(&evidence.evidence_ref, "evidenceRef")?;
        ensure_non_empty(&evidence.document_ref, "documentRef")?;
        anyhow::ensure!(
            is_contract_non_empty(&evidence.quote),
            "NEX_C2B_MATERIAL_QUOTE_EMPTY: evidenceRef '{}' quote must contain non-whitespace content",
            evidence.evidence_ref
        );
        ensure_non_empty(&evidence.source_key, "sourceKey")?;
        ensure_non_empty(&evidence.revision_token, "revisionToken")?;
        anyhow::ensure!(
            is_digest(&evidence.quote_digest),
            "NEX_C2B_MATERIAL_QUOTE_DIGEST_INVALID: evidenceRef '{}' has an invalid quoteDigest",
            evidence.evidence_ref
        );
        anyhow::ensure!(
            digest_bytes(evidence.quote.as_bytes()) == evidence.quote_digest,
            "NEX_C2B_MATERIAL_QUOTE_DIGEST_MISMATCH: evidenceRef '{}' quoteDigest does not match quote bytes",
            evidence.evidence_ref
        );
        anyhow::ensure!(
            source_keys.contains(&evidence.source_key),
            "NEX_C2B_MATERIAL_EVIDENCE_SOURCE_MISSING: evidenceRef '{}' names '{}', which is absent from sourceBasis",
            evidence.evidence_ref,
            evidence.source_key
        );
        let source_revision_token = source_basis
            .iter()
            .find(|source| source.source_key == evidence.source_key)
            .map(|source| source.revision_token.as_str());
        anyhow::ensure!(
            source_revision_token == Some(evidence.revision_token.as_str()),
            "NEX_C2B_MATERIAL_EVIDENCE_TOKEN_MISMATCH: evidenceRef '{}' revisionToken differs from its source basis",
            evidence.evidence_ref
        );
        anyhow::ensure!(
            evidence_ids.insert(evidence.evidence_ref.clone()),
            "NEX_C2B_MATERIAL_EVIDENCE_DUPLICATE: evidenceRef '{}' is duplicated",
            evidence.evidence_ref
        );
    }
    Ok(())
}

fn validate_material_coverage(
    material: &MaterialBasis,
    source_keys: &HashSet<String>,
) -> anyhow::Result<()> {
    let mut covered_sources = material
        .evidence_set
        .iter()
        .map(|evidence| evidence.source_key.as_str())
        .collect::<HashSet<_>>();
    covered_sources.extend(material.dependency_set.iter().filter_map(|dependency| {
        source_keys
            .contains(&dependency.input_ref)
            .then_some(dependency.input_ref.as_str())
    }));
    for source_key in source_keys {
        anyhow::ensure!(
            covered_sources.contains(source_key.as_str()),
            "NEX_C2B_MATERIAL_SOURCE_ORPHAN: sourceBasis entry '{}' is not referenced by evidence or dependencySet",
            source_key
        );
    }
    for evidence in &material.evidence_set {
        anyhow::ensure!(
            material.dependency_set.iter().any(|dependency| {
                dependency.role == DependencyRole::DirectEvidence
                    && dependency.input_ref == evidence.source_key
            }),
            "NEX_C2B_MATERIAL_EVIDENCE_NOT_DECLARED: evidenceRef '{}' has no matching DirectEvidence dependency",
            evidence.evidence_ref
        );
    }
    Ok(())
}

fn validate_dependency_set(
    dependency_set: &[MaterialDependencyEntry],
    source_keys: &HashSet<String>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !dependency_set.is_empty(),
        "NEX_C2B_MATERIAL_DEPENDENCY_EMPTY: dependencySet must not be empty"
    );
    let mut dependency_ids = HashSet::new();
    for dependency in dependency_set {
        ensure_non_empty(&dependency.dependency_id, "dependencyId")?;
        ensure_non_empty(&dependency.input_ref, "inputRef")?;
        let mut context_ids = HashSet::new();
        for context_id in &dependency.context_ids {
            ensure_non_empty(context_id, "contextId")?;
            anyhow::ensure!(
                context_ids.insert(context_id),
                "NEX_C2B_MATERIAL_CONTEXT_DUPLICATE: dependencyId '{}' contextId '{}' is duplicated",
                dependency.dependency_id,
                context_id
            );
        }
        anyhow::ensure!(
            dependency_ids.insert(dependency.dependency_id.clone()),
            "NEX_C2B_MATERIAL_DEPENDENCY_DUPLICATE: dependencyId '{}' is duplicated",
            dependency.dependency_id
        );
        validate_dependency_selector(&dependency.selector, None).map_err(|error| {
            anyhow!(
                "NEX_C2B_MATERIAL_SELECTOR_INVALID: dependencyId '{}': {error}",
                dependency.dependency_id
            )
        })?;
        if dependency.role == DependencyRole::ScopeResolution {
            anyhow::ensure!(
                source_keys.contains(&dependency.input_ref),
                "NEX_C2B_MATERIAL_SCOPE_SOURCE_MISSING: dependencyId '{}' scope inputRef '{}' is absent from sourceBasis",
                dependency.dependency_id,
                dependency.input_ref
            );
        }
    }
    Ok(())
}

fn validate_material_basis(material: &MaterialBasis) -> anyhow::Result<()> {
    let source_keys = validate_source_basis(&material.source_basis)?;
    validate_evidence_set(&material.evidence_set, &source_keys, &material.source_basis)?;
    validate_dependency_set(&material.dependency_set, &source_keys)?;
    validate_material_coverage(material, &source_keys)?;

    let expected_dependency_digest = canonical_digest(&material.dependency_set, "dependencySet")?;
    anyhow::ensure!(
        is_digest(&material.dependency_set_digest),
        "NEX_C2B_MATERIAL_DEPENDENCY_DIGEST_INVALID: dependencySetDigest is not sha256"
    );
    anyhow::ensure!(
        expected_dependency_digest == material.dependency_set_digest,
        "NEX_C2B_MATERIAL_DEPENDENCY_DIGEST_MISMATCH: dependencySetDigest does not match dependencySet"
    );

    let digest_input = MaterialBasisDigestInput {
        source_basis: &material.source_basis,
        evidence_set: &material.evidence_set,
        dependency_set: &material.dependency_set,
    };
    let expected_material_digest = canonical_digest(&digest_input, "materialBasis")?;
    anyhow::ensure!(
        is_digest(&material.material_basis_digest),
        "NEX_C2B_MATERIAL_BASIS_DIGEST_INVALID: materialBasisDigest is not sha256"
    );
    anyhow::ensure!(
        expected_material_digest == material.material_basis_digest,
        "NEX_C2B_MATERIAL_BASIS_DIGEST_MISMATCH: materialBasisDigest does not match material basis"
    );
    Ok(())
}

fn material_from_trusted(trusted: &TrustedHumanMaterialResolution) -> MaterialBasis {
    MaterialBasis {
        source_basis: trusted
            .source_basis
            .iter()
            .map(|source| MaterialSourceBasisEntry {
                source_kind: source.source_kind.clone(),
                source_key: source.source_key.clone(),
                revision_token: source.revision_token.clone(),
                revision_observed_at: source.revision_observed_at.clone(),
            })
            .collect(),
        evidence_set: trusted
            .evidence_set
            .iter()
            .map(|evidence| MaterialEvidenceEntry {
                evidence_ref: evidence.evidence_ref.clone(),
                document_ref: evidence.document_ref.clone(),
                quote: evidence.quote.clone(),
                quote_digest: evidence.quote_digest.clone(),
                source_key: evidence.source_key.clone(),
                revision_token: evidence.revision_token.clone(),
            })
            .collect(),
        dependency_set: trusted
            .dependency_set
            .iter()
            .map(|dependency| MaterialDependencyEntry {
                dependency_id: dependency.dependency_id.clone(),
                input_ref: dependency.input_ref.clone(),
                context_ids: dependency.context_ids.clone(),
                role: dependency.role,
                selector: dependency.selector.clone(),
            })
            .collect(),
        dependency_set_digest: String::new(),
        material_basis_digest: String::new(),
    }
}

fn bind_trusted_context(
    trusted: &TrustedHumanMaterialResolution,
    context: &HumanMaterialResolutionContext,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        trusted.project_id == context.project_id,
        "NEX_C2B_MATERIAL_CONTEXT_MISMATCH: trusted projectId does not match context"
    );
    anyhow::ensure!(
        trusted.parent_revision_id == context.parent_revision_id,
        "NEX_C2B_MATERIAL_CONTEXT_MISMATCH: trusted parentRevisionId does not match context"
    );
    anyhow::ensure!(
        trusted.expected_parent_envelope_digest == context.expected_parent_envelope_digest,
        "NEX_C2B_MATERIAL_CONTEXT_MISMATCH: trusted parent envelope digest does not match context"
    );
    anyhow::ensure!(
        trusted.scene_ref == context.scene_ref,
        "NEX_C2B_MATERIAL_CONTEXT_MISMATCH: trusted sceneRef does not match context"
    );
    anyhow::ensure!(
        trusted.edited_document_ref == context.edited_document_ref,
        "NEX_C2B_MATERIAL_CONTEXT_MISMATCH: trusted editedDocumentRef does not match context"
    );
    Ok(())
}

fn refresh_material_digests(material: &mut MaterialBasis) -> anyhow::Result<()> {
    material.dependency_set_digest = canonical_digest(&material.dependency_set, "dependencySet")?;
    let digest_input = MaterialBasisDigestInput {
        source_basis: &material.source_basis,
        evidence_set: &material.evidence_set,
        dependency_set: &material.dependency_set,
    };
    material.material_basis_digest = canonical_digest(&digest_input, "materialBasis")?;
    Ok(())
}

fn required_parent_sources(parent: &MaterialBasis) -> HashSet<String> {
    let mut required = parent
        .evidence_set
        .iter()
        .map(|evidence| evidence.source_key.clone())
        .collect::<HashSet<_>>();
    required.extend(
        parent
            .dependency_set
            .iter()
            .filter(|dependency| dependency.role != DependencyRole::ScopeResolution)
            .filter(|&dependency| {
                parent
                    .source_basis
                    .iter()
                    .any(|source| source.source_key == dependency.input_ref)
            })
            .map(|dependency| dependency.input_ref.clone()),
    );
    required
}

fn validate_parent_source_basis(
    material: &MaterialBasis,
    persisted: &[SourceBasisRow],
) -> anyhow::Result<()> {
    anyhow::ensure!(
        material.source_basis.len() == persisted.len(),
        "NEX_C2B_MATERIAL_PARENT_SOURCE_COUNT_MISMATCH: material has {} sources, persisted parent has {}",
        material.source_basis.len(),
        persisted.len()
    );
    for (ordinal, (material_source, persisted_source)) in
        material.source_basis.iter().zip(persisted).enumerate()
    {
        anyhow::ensure!(
            persisted_source.ordinal == ordinal as i64,
            "NEX_C2B_MATERIAL_PARENT_SOURCE_ORDINAL_MISMATCH: persisted SourceBasis ordinal {} is not {}",
            persisted_source.ordinal,
            ordinal
        );
        anyhow::ensure!(
            persisted_source.source_kind == material_source.source_kind
                && persisted_source.source_key == material_source.source_key
                && persisted_source.revision_token == material_source.revision_token
                && persisted_source.observed_at == material_source.revision_observed_at,
            "NEX_C2B_MATERIAL_PARENT_SOURCE_MISMATCH: persisted SourceBasis row {} differs from material",
            ordinal
        );
    }
    Ok(())
}

fn typed_stored_d1_declaration(
    entry: &StoredDependencyDeclaration,
) -> anyhow::Result<DependencyDeclaration> {
    ensure_non_empty(&entry.id, "declarationId")?;
    ensure_non_empty(&entry.declaration_set_id, "declarationSetId")?;
    ensure_non_empty(&entry.source_object_identity, "sourceObjectIdentity")?;
    anyhow::ensure!(
        entry.role_contract_version == DEPENDENCY_ROLE_CONTRACT_VERSION,
        "NEX_C2B_MATERIAL_D1_ROLE_CONTRACT_INVALID: declaration '{}' has an unsupported role contract",
        entry.id
    );
    let selector_value: serde_json::Value =
        serde_json::from_str(&entry.selector_json).map_err(|error| {
            anyhow!(
                "NEX_C2B_MATERIAL_D1_SELECTOR_INVALID: {}: {error}",
                entry.id
            )
        })?;
    let selector = validate_dependency_selector_value(&selector_value, None).map_err(|error| {
        anyhow!(
            "NEX_C2B_MATERIAL_D1_SELECTOR_INVALID: {}: {error}",
            entry.id
        )
    })?;
    let canonical_selector = canonicalize_dependency_selector(&selector).map_err(|error| {
        anyhow!(
            "NEX_C2B_MATERIAL_D1_SELECTOR_INVALID: {}: {error}",
            entry.id
        )
    })?;
    anyhow::ensure!(
        canonical_selector == entry.selector_json,
        "NEX_C2B_MATERIAL_D1_SELECTOR_NONCANONICAL: declaration '{}' selector is not canonical",
        entry.id
    );
    anyhow::ensure!(
        digest_bytes(canonical_selector.as_bytes()) == entry.selector_digest,
        "NEX_C2B_MATERIAL_D1_SELECTOR_DIGEST_MISMATCH: declaration '{}' selector digest is invalid",
        entry.id
    );
    anyhow::ensure!(
        compute_dependency_key(entry.dependency_role.as_str(), &selector)
            .map_err(|error| anyhow!("NEX_C2B_MATERIAL_D1_KEY_INVALID: {}: {error}", entry.id))?
            == entry.dependency_key,
        "NEX_C2B_MATERIAL_D1_KEY_MISMATCH: declaration '{}' dependency key is invalid",
        entry.id
    );
    Ok(DependencyDeclaration {
        source_object_identity: entry.source_object_identity.clone(),
        role: entry.dependency_role,
        selector,
    })
}

fn validate_active_parent_d1(parent: &HumanMaterialParentBundle) -> anyhow::Result<()> {
    let active = &parent.active_dependency_declaration_set;
    ensure_non_empty(&active.declaration_set_id, "declarationSetId")?;
    anyhow::ensure!(
        active.state == DependencyDeclarationSetState::Sealed,
        "NEX_C2B_MATERIAL_D1_HEAD_STATE_INVALID: active declaration set is not sealed"
    );
    anyhow::ensure!(
        active.project_id == parent.project_id
            && active.consumer_kind == parent.consumer_kind
            && active.consumer_key == parent.consumer_key,
        "NEX_C2B_MATERIAL_D1_AUTHORITY_MISMATCH: active declaration set Consumer differs from parent bundle"
    );
    anyhow::ensure!(
        active.consumer_kind == PROPOSAL_REVISION_CONSUMER_KIND,
        "NEX_C2B_MATERIAL_D1_CONSUMER_KIND_INVALID: active declaration set Consumer kind is unsupported"
    );
    anyhow::ensure!(
        active.producer_id == D1_PRODUCER_ID,
        "NEX_C2B_MATERIAL_D1_PRODUCER_INVALID: active declaration set producer is not Native-pinned"
    );
    anyhow::ensure!(
        active.producer_generation == PROPOSAL_REVISION_D1_PRODUCER_GENERATION,
        "NEX_C2B_MATERIAL_D1_GENERATION_INVALID: active declaration set generation is not Native-pinned"
    );

    let mut entry_ids = HashSet::new();
    let mut digest_entries = Vec::with_capacity(active.entries.len());
    let mut actual = Vec::with_capacity(active.entries.len());
    for entry in &active.entries {
        anyhow::ensure!(
            entry_ids.insert(entry.id.clone()),
            "NEX_C2B_MATERIAL_D1_ENTRY_DUPLICATE: declaration id '{}' is duplicated",
            entry.id
        );
        anyhow::ensure!(
            entry.declaration_set_id == active.declaration_set_id,
            "NEX_C2B_MATERIAL_D1_SET_MISMATCH: declaration '{}' belongs to another declaration set",
            entry.id
        );
        actual.push(typed_stored_d1_declaration(entry)?);
        digest_entries.push(DependencySetDigestEntry {
            source_object_identity: entry.source_object_identity.clone(),
            dependency_key: entry.dependency_key.clone(),
            selector_digest: entry.selector_digest.clone(),
        });
    }
    let expected = parent
        .material_basis
        .dependency_set
        .iter()
        .map(|dependency| {
            Ok(DependencyDeclaration {
                source_object_identity: dependency.input_ref.clone(),
                role: dependency.role,
                selector: canonicalize_typed_selector(&dependency.selector)?,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(
        sorted_declarations(&expected)? == sorted_declarations(&actual)?,
        "NEX_C2B_MATERIAL_D1_DECLARATION_MISMATCH: active declaration set differs from material dependencies"
    );
    let expected_digest = compute_dependency_set_digest(&digest_entries)
        .map_err(|error| anyhow!("NEX_C2B_MATERIAL_D1_SET_DIGEST_INVALID: {error}"))?;
    anyhow::ensure!(
        expected_digest == active.dependency_set_digest,
        "NEX_C2B_MATERIAL_D1_SET_DIGEST_MISMATCH: active declaration set digest is invalid"
    );
    Ok(())
}

fn parent_v1_authority(parent: &HumanMaterialParentBundle) -> V1ParentAuthority {
    V1ParentAuthority {
        project_id: parent.project_id.clone(),
        consumer_kind: parent.consumer_kind.clone(),
        consumer_key: parent.consumer_key.clone(),
        owning_run_id: parent.owning_run_id.clone(),
    }
}

/// Verify the complete parent material, SourceBasis, V1 edges, and sealed D1
/// head against one CAS-bound Native bundle.
pub fn validate_human_material_parent_bundle(
    parent: &HumanMaterialParentBundle,
    context: &HumanMaterialResolutionContext,
) -> anyhow::Result<()> {
    validate_context(context)?;
    ensure_non_empty(&parent.project_id, "projectId")?;
    anyhow::ensure!(
        parent.project_id == context.project_id,
        "NEX_C2B_MATERIAL_PARENT_PROJECT_MISMATCH: parent bundle project differs from context"
    );
    anyhow::ensure!(
        parent.consumer_kind == PROPOSAL_REVISION_CONSUMER_KIND,
        "NEX_C2B_MATERIAL_PARENT_CONSUMER_KIND_INVALID: parent bundle Consumer kind is unsupported"
    );
    anyhow::ensure!(
        parent.consumer_key == context.parent_revision_id,
        "NEX_C2B_MATERIAL_PARENT_CONSUMER_MISMATCH: parent bundle Consumer key differs from CAS parent"
    );
    ensure_non_empty(&parent.owning_run_id, "owningRunId")?;
    anyhow::ensure!(
        parent.owning_run_id == context.expected_parent_owning_run_id,
        "NEX_C2B_MATERIAL_PARENT_RUN_MISMATCH: parent bundle owning Run differs from CAS authority"
    );
    anyhow::ensure!(
        parent.expected_parent_envelope_digest == context.expected_parent_envelope_digest,
        "NEX_C2B_MATERIAL_PARENT_DIGEST_MISMATCH: parent bundle envelope digest differs from context"
    );
    validate_material_basis(&parent.material_basis)?;
    validate_parent_source_basis(&parent.material_basis, &parent.source_basis)?;
    validate_active_parent_d1(parent)?;

    let authority = parent_v1_authority(parent);
    let expected = project_v1_expectations(&parent.material_basis, &authority)?;
    validate_v1_parent_edges(&expected, &parent.persisted_v1_edges, &authority)
}

/// Resolve a projection-only or scope-override material basis without any
/// persistence side effect.
pub fn resolve_human_material_basis(
    kind: HumanMaterialDerivationKind,
    parent: &HumanMaterialParentBundle,
    context: &HumanMaterialResolutionContext,
    trusted: Option<&TrustedHumanMaterialResolution>,
) -> anyhow::Result<HumanMaterialResolution> {
    validate_human_material_parent_bundle(parent, context)?;
    let parent_material = &parent.material_basis;

    if kind == HumanMaterialDerivationKind::ProjectionOnly {
        anyhow::ensure!(
            trusted.is_none(),
            "NEX_C2B_MATERIAL_PROJECTION_SIDECAR_FORBIDDEN: projection-only resolution does not accept a trusted sidecar"
        );
        return Ok(HumanMaterialResolution {
            material_basis: parent_material.clone(),
        });
    }

    let trusted = trusted.ok_or_else(|| {
        anyhow!(
            "NEX_C2B_MATERIAL_SCOPE_SIDECAR_REQUIRED: scope-override resolution requires a complete trusted sidecar"
        )
    })?;
    bind_trusted_context(trusted, context)?;
    let mut child = material_from_trusted(trusted);
    refresh_material_digests(&mut child)?;
    validate_material_basis(&child)?;

    anyhow::ensure!(
        child.evidence_set == parent_material.evidence_set,
        "NEX_C2B_MATERIAL_SCOPE_EVIDENCE_CHANGED: scope override must preserve Evidence exactly"
    );
    let parent_non_scope = parent_material
        .dependency_set
        .iter()
        .filter(|dependency| dependency.role != DependencyRole::ScopeResolution)
        .cloned()
        .collect::<Vec<_>>();
    let child_non_scope = child
        .dependency_set
        .iter()
        .filter(|dependency| dependency.role != DependencyRole::ScopeResolution)
        .cloned()
        .collect::<Vec<_>>();
    anyhow::ensure!(
        child_non_scope == parent_non_scope,
        "NEX_C2B_MATERIAL_SCOPE_DEPENDENCY_CHANGED: scope override changed a non-scope dependency"
    );
    let child_sources = validate_source_basis(&child.source_basis)?;
    for required_source in required_parent_sources(parent_material) {
        anyhow::ensure!(
            child_sources.contains(&required_source),
            "NEX_C2B_MATERIAL_SCOPE_SOURCE_DROPPED: required parent source '{}' is absent",
            required_source
        );
        let parent_entry = parent_material
            .source_basis
            .iter()
            .find(|source| source.source_key == required_source)
            .ok_or_else(|| {
                anyhow!(
                    "NEX_C2B_MATERIAL_SCOPE_SOURCE_DROPPED: required parent source '{}' is absent",
                    required_source
                )
            })?;
        let child_entry = child
            .source_basis
            .iter()
            .find(|source| source.source_key == required_source)
            .ok_or_else(|| {
                anyhow!(
                    "NEX_C2B_MATERIAL_SCOPE_SOURCE_DROPPED: required child source '{}' is absent",
                    required_source
                )
            })?;
        anyhow::ensure!(
            child_entry == parent_entry,
            "NEX_C2B_MATERIAL_SCOPE_SOURCE_CHANGED: required parent source '{}' changed",
            required_source
        );
    }
    if context.secret_scope {
        anyhow::ensure!(
            child
                .dependency_set
                .iter()
                .any(|dependency| dependency.role == DependencyRole::ScopeResolution),
            "NEX_C2B_MATERIAL_SCOPE_DEPENDENCY_MISSING: secret scope requires a ScopeResolution dependency"
        );
    }
    Ok(HumanMaterialResolution {
        material_basis: child,
    })
}

/// Project every typed Material dependency into the D1 declaration shape.
/// The producer identity and generation are Native-pinned; callers can only
/// supply the Consumer authority used for the projection metadata.
pub fn project_d1_declaration_set(
    material: &MaterialBasis,
    authority: &D1ParentAuthority,
) -> anyhow::Result<D1DeclarationProjection> {
    validate_material_basis(material)?;
    ensure_non_empty(&authority.project_id, "projectId")?;
    anyhow::ensure!(
        authority.consumer_kind == PROPOSAL_REVISION_CONSUMER_KIND,
        "NEX_C2B_MATERIAL_D1_CONSUMER_KIND_INVALID: consumerKind must be '{}'",
        PROPOSAL_REVISION_CONSUMER_KIND
    );
    ensure_non_empty(&authority.consumer_key, "consumerKey")?;
    anyhow::ensure!(
        authority.producer_id == D1_PRODUCER_ID,
        "NEX_C2B_MATERIAL_D1_PRODUCER_INVALID: producerId must be '{}'",
        D1_PRODUCER_ID
    );
    anyhow::ensure!(
        authority.producer_generation == PROPOSAL_REVISION_D1_PRODUCER_GENERATION,
        "NEX_C2B_MATERIAL_D1_GENERATION_INVALID: producerGeneration must be {}",
        PROPOSAL_REVISION_D1_PRODUCER_GENERATION
    );

    let declarations = material
        .dependency_set
        .iter()
        .map(|dependency| {
            let selector = canonicalize_typed_selector(&dependency.selector).map_err(|error| {
                anyhow!(
                    "NEX_C2B_MATERIAL_D1_SELECTOR_INVALID: dependencyId '{}': {error}",
                    dependency.dependency_id
                )
            })?;
            Ok(DependencyDeclaration {
                source_object_identity: dependency.input_ref.clone(),
                role: dependency.role,
                selector,
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    Ok(D1DeclarationProjection {
        project_id: authority.project_id.clone(),
        consumer_kind: authority.consumer_kind.clone(),
        consumer_key: authority.consumer_key.clone(),
        producer_id: D1_PRODUCER_ID.to_owned(),
        producer_generation: PROPOSAL_REVISION_D1_PRODUCER_GENERATION,
        declarations,
    })
}

fn canonicalize_typed_selector(
    selector: &DependencySelector,
) -> anyhow::Result<DependencySelector> {
    let canonical = canonicalize_dependency_selector(selector)
        .map_err(|error| anyhow!("NEX_C2B_MATERIAL_SELECTOR_CANONICALIZE: {error}"))?;
    serde_json::from_str(&canonical)
        .map_err(|error| anyhow!("NEX_C2B_MATERIAL_SELECTOR_CANONICALIZE: {error}"))
}

fn canonical_declaration_sort_key(
    declaration: &DependencyDeclaration,
) -> anyhow::Result<(String, String, String)> {
    Ok((
        declaration.source_object_identity.clone(),
        declaration.role.as_str().to_owned(),
        canonicalize_dependency_selector(&declaration.selector)
            .map_err(|error| anyhow!("NEX_C2B_MATERIAL_D1_SELECTOR_INVALID: {error}"))?,
    ))
}

fn sorted_declarations(
    declarations: &[DependencyDeclaration],
) -> anyhow::Result<Vec<DependencyDeclaration>> {
    let mut keyed = declarations
        .iter()
        .map(|declaration| {
            let mut canonical_declaration = declaration.clone();
            canonical_declaration.selector = canonicalize_typed_selector(&declaration.selector)?;
            let key = canonical_declaration_sort_key(&canonical_declaration)?;
            Ok((key, canonical_declaration))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    keyed.sort_by(|left, right| left.0.cmp(&right.0));
    for pair in keyed.windows(2) {
        anyhow::ensure!(
            pair[0].0 != pair[1].0,
            "NEX_C2B_MATERIAL_D1_DECLARATION_DUPLICATE: declaration set contains a duplicate"
        );
    }
    Ok(keyed
        .into_iter()
        .map(|(_, declaration)| declaration)
        .collect())
}

/// Project V1 compatibility expectations from SourceBasis only. Each source
/// contributes exactly one whole-source revision token and one owning Run.
pub fn project_v1_expectations(
    material: &MaterialBasis,
    authority: &V1ParentAuthority,
) -> anyhow::Result<Vec<V1EdgeExpectation>> {
    validate_material_basis(material)?;
    ensure_non_empty(&authority.project_id, "projectId")?;
    anyhow::ensure!(
        authority.consumer_kind == PROPOSAL_REVISION_CONSUMER_KIND,
        "NEX_C2B_MATERIAL_V1_CONSUMER_KIND_INVALID: consumerKind must be '{}'",
        PROPOSAL_REVISION_CONSUMER_KIND
    );
    ensure_non_empty(&authority.consumer_key, "consumerKey")?;
    ensure_non_empty(&authority.owning_run_id, "owningRunId")?;

    let mut source_identities = HashSet::new();
    material
        .source_basis
        .iter()
        .map(|source| {
            let source_object_identity =
                canonical_source_object_identity(&source.source_kind, &source.source_key).map_err(
                    |error| {
                        anyhow!(
                            "NEX_C2B_MATERIAL_V1_SOURCE_INVALID: sourceKey '{}': {error}",
                            source.source_key
                        )
                    },
                )?;
            anyhow::ensure!(
                source_identities.insert(source_object_identity.clone()),
                "NEX_C2B_MATERIAL_V1_SOURCE_DUPLICATE: sourceKey '{}' is duplicated",
                source.source_key
            );
            Ok(V1EdgeExpectation {
                source_object_identity,
                revision_token: source.revision_token.clone(),
                owning_run_id: authority.owning_run_id.clone(),
            })
        })
        .collect()
}

/// Verify the exact V1 edge set. The legacy read-set payload remains typed at
/// the boundary and is parsed directly as a one-token string array.
fn validate_v1_parent_edges(
    expected: &[V1EdgeExpectation],
    persisted: &[V1PersistedEdge],
    authority: &V1ParentAuthority,
) -> anyhow::Result<()> {
    ensure_non_empty(&authority.project_id, "projectId")?;
    anyhow::ensure!(
        authority.consumer_kind == PROPOSAL_REVISION_CONSUMER_KIND,
        "NEX_C2B_MATERIAL_V1_CONSUMER_KIND_INVALID: consumerKind must be '{}'",
        PROPOSAL_REVISION_CONSUMER_KIND
    );
    ensure_non_empty(&authority.consumer_key, "consumerKey")?;
    ensure_non_empty(&authority.owning_run_id, "owningRunId")?;
    anyhow::ensure!(
        expected.len() == persisted.len(),
        "NEX_C2B_MATERIAL_V1_EDGE_COUNT_MISMATCH: expected {} edges, found {}",
        expected.len(),
        persisted.len()
    );

    let mut expected_sources = HashSet::<String>::new();
    for edge in expected {
        ensure_non_empty(&edge.source_object_identity, "sourceObjectIdentity")?;
        ensure_non_empty(&edge.revision_token, "revisionToken")?;
        ensure_non_empty(&edge.owning_run_id, "owningRunId")?;
        anyhow::ensure!(
            edge.owning_run_id == authority.owning_run_id,
            "NEX_C2B_MATERIAL_V1_OWNER_MISMATCH: expected edge owner differs from authority"
        );
        anyhow::ensure!(
            expected_sources.insert(edge.source_object_identity.clone()),
            "NEX_C2B_MATERIAL_V1_EDGE_DUPLICATE: expected source identity '{}' is duplicated",
            edge.source_object_identity
        );
    }

    let mut persisted_sources = HashSet::<String>::new();
    for edge in persisted {
        anyhow::ensure!(
            edge.project_id == authority.project_id,
            "NEX_C2B_MATERIAL_V1_PROJECT_MISMATCH: persisted edge '{}' belongs to another project",
            edge.source_object_identity
        );
        anyhow::ensure!(
            edge.consumer_kind == authority.consumer_kind
                && edge.consumer_key == authority.consumer_key,
            "NEX_C2B_MATERIAL_V1_CONSUMER_MISMATCH: persisted edge '{}' belongs to another Consumer",
            edge.source_object_identity
        );
        anyhow::ensure!(
            edge.generated_by_transaction_id.is_none(),
            "NEX_C2B_MATERIAL_V1_TRANSACTION_UNEXPECTED: current revision edge '{}' must not carry a generated transaction id",
            edge.source_object_identity
        );
        ensure_non_empty(&edge.source_object_identity, "sourceObjectIdentity")?;
        anyhow::ensure!(
            persisted_sources.insert(edge.source_object_identity.clone()),
            "NEX_C2B_MATERIAL_V1_EDGE_DUPLICATE: persisted source identity '{}' is duplicated",
            edge.source_object_identity
        );
        let expected_edge = expected
            .iter()
            .find(|expected_edge| {
                expected_edge.source_object_identity == edge.source_object_identity
            })
            .ok_or_else(|| {
                anyhow!(
                    "NEX_C2B_MATERIAL_V1_EDGE_EXTRA: persisted source identity '{}' is not expected",
                    edge.source_object_identity
                )
            })?;
        anyhow::ensure!(
            edge.owning_run_id.as_deref() == Some(expected_edge.owning_run_id.as_str()),
            "NEX_C2B_MATERIAL_V1_OWNER_MISMATCH: persisted edge '{}' has the wrong owner",
            edge.source_object_identity
        );
        let read_set: Vec<String> = serde_json::from_str(&edge.read_set_json).map_err(|error| {
            anyhow!(
                "NEX_C2B_MATERIAL_V1_READ_SET_INVALID: persisted edge '{}': {error}",
                edge.source_object_identity
            )
        })?;
        anyhow::ensure!(
            read_set.len() == 1,
            "NEX_C2B_MATERIAL_V1_READ_SET_CARDINALITY: persisted edge '{}' must contain exactly one revision token",
            edge.source_object_identity
        );
        anyhow::ensure!(
            read_set[0] == expected_edge.revision_token,
            "NEX_C2B_MATERIAL_V1_REVISION_MISMATCH: persisted edge '{}' has the wrong revision token",
            edge.source_object_identity
        );
    }
    anyhow::ensure!(
        expected_sources == persisted_sources,
        "NEX_C2B_MATERIAL_V1_EDGE_SET_MISMATCH: persisted V1 edge set differs from expectation"
    );
    Ok(())
}
