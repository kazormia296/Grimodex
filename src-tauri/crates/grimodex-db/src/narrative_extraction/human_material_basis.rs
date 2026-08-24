//! Pure Native material-basis derivation for NIR-0 C2B.
//!
//! This module deliberately owns no database connection and performs no
//! revision promotion, declaration persistence, or Freshness publication.
//! The public types crossing this boundary are typed; the trusted resolver
//! sidecar is Native-owned and is intentionally not deserializable.

use std::collections::HashSet;

use anyhow::{anyhow, Context};
use grimodex_core::canonical_json_digest;
use grimodex_core::narrative_dependency::{
    validate_dependency_selector, DependencyRole, DependencySelector,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::dependency_edges::canonical_source_object_identity;

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
    pub selector: DependencySelector,
}

/// Native authority used to bind a material resolution to its parent CAS and
/// the edited Chronicle document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HumanMaterialResolutionContext {
    pub project_id: String,
    pub parent_revision_id: String,
    pub expected_parent_envelope_digest: String,
    pub scene_ref: String,
    pub edited_document_ref: String,
    pub secret_scope: bool,
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
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !evidence_set.is_empty(),
        "NEX_C2B_MATERIAL_EVIDENCE_EMPTY: evidenceSet must not be empty"
    );
    let mut evidence_ids = HashSet::new();
    for evidence in evidence_set {
        ensure_non_empty(&evidence.evidence_ref, "evidenceRef")?;
        ensure_non_empty(&evidence.document_ref, "documentRef")?;
        ensure_non_empty(&evidence.quote, "quote")?;
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
        anyhow::ensure!(
            evidence_ids.insert(evidence.evidence_ref.clone()),
            "NEX_C2B_MATERIAL_EVIDENCE_DUPLICATE: evidenceRef '{}' is duplicated",
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
        for context_id in &dependency.context_ids {
            ensure_non_empty(context_id, "contextId")?;
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
    validate_evidence_set(&material.evidence_set, &source_keys)?;
    validate_dependency_set(&material.dependency_set, &source_keys)?;

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
            .filter_map(|dependency| {
                parent
                    .source_basis
                    .iter()
                    .any(|source| source.source_key == dependency.input_ref)
                    .then(|| dependency.input_ref.clone())
            }),
    );
    required
}

/// Resolve a projection-only or scope-override material basis without any
/// persistence side effect.
pub fn resolve_human_material_basis(
    kind: HumanMaterialDerivationKind,
    parent: &MaterialBasis,
    context: &HumanMaterialResolutionContext,
    trusted: Option<&TrustedHumanMaterialResolution>,
) -> anyhow::Result<HumanMaterialResolution> {
    validate_context(context)?;
    validate_material_basis(parent)?;

    if kind == HumanMaterialDerivationKind::ProjectionOnly {
        anyhow::ensure!(
            trusted.is_none(),
            "NEX_C2B_MATERIAL_PROJECTION_SIDECAR_FORBIDDEN: projection-only resolution does not accept a trusted sidecar"
        );
        return Ok(HumanMaterialResolution {
            material_basis: parent.clone(),
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
        child.evidence_set == parent.evidence_set,
        "NEX_C2B_MATERIAL_SCOPE_EVIDENCE_CHANGED: scope override must preserve Evidence exactly"
    );
    let parent_non_scope = parent
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
    for required_source in required_parent_sources(parent) {
        anyhow::ensure!(
            child_sources.contains(&required_source),
            "NEX_C2B_MATERIAL_SCOPE_SOURCE_DROPPED: required parent source '{}' is absent",
            required_source
        );
        let parent_entry = parent
            .source_basis
            .iter()
            .find(|source| source.source_key == required_source)
            .expect("required source comes from parent material");
        let child_entry = child
            .source_basis
            .iter()
            .find(|source| source.source_key == required_source)
            .expect("validated child source exists");
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
