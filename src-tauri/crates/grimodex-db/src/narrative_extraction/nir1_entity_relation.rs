//! Native-owned persistence boundary for reviewed NIR-1 Entity/Relation input.
//!
//! This lane deliberately reuses the existing ProposalSet/Proposal/Revision/
//! Decision ledger.  The bundle is stored as a typed payload with a Native
//! generated revision identity; it is not a promotion of the mutable Codex
//! catalog and it does not create a Graph index or a product-facing reader.

use chrono::{DateTime, SecondsFormat, Utc};
use grimodex_core::narrative_scope_authority_basis::NarrativeScopeAuthorityStoryTimeOrderV2;
use grimodex_core::{
    canonical_json_digest, canonical_json_string,
    narrative_dependency::{canonicalize_dependency_selector, DependencyRole, DependencySelector},
    narrative_nir1,
};
use narrative_nir1::{
    validate_entity_relation_bundle, validate_entity_relation_revision_envelope_v2, EntityInput,
    EntityRelationBundle, EvidenceInput, GraphEdgeInput, ScopeBinding, ScopeValue,
    ENTITY_RELATION_ADAPTER_ID, ENTITY_RELATION_ADAPTER_VERSION, ENTITY_RELATION_ASSERTION_KIND,
    ENTITY_RELATION_INDEX_KEY, ENTITY_RELATION_MATERIAL_CONTRACT_ID, ENTITY_RELATION_PRODUCER,
    ENTITY_RELATION_SOURCE_KIND,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use uuid::Uuid;

use super::c2zc_canonical_cutover::{
    current_c2zc_run_epoch_in_tx, is_generic_freshness_canonical,
    validate_current_evaluation_run_reference,
};
use super::declaration_storage::{
    read_active_dependency_declaration_set_in_tx, write_dependency_declaration_set_in_tx,
    ActiveDependencyDeclarationSetRead, DependencyDeclaration, DependencyDeclarationSetRequest,
};
use super::dependency_edges::{
    consumer_dependency_set_digest, find_edges_by_consumer, record_dependency_edge_in_tx,
    DependencyEdge,
};
use super::evaluator::{evaluate_edge, BuildAction, EdgeComparisonInput, EvidenceFreshness};
use super::execution_state::next_run_lifecycle_timestamp_in_tx;
use super::human_material_basis::{
    D1DeclarationProjection, MaterialBasis, MaterialDependencyEntry, MaterialEvidenceEntry,
    MaterialSourceBasisEntry,
};
use super::project_scope_authority::load_live_project_scope_authority;
use super::publish_runtime::{
    publish_complete_runless_freshness_in_tx, worst_edge_state_for_consumer,
};
use super::reconciliation_envelope::{
    load_source_basis_rows, validate_v2_nested_digest_fields, SourceBasisRow,
};
use super::repository::{
    current_chronicle_run_spec_for_run, ensure_run_project, insert_source_basis_rows,
    REVIEW_RESUMABLE_RUN_PREDICATE_SQL,
};
use super::revision_eligibility::pending;
use super::semantic_epoch::get_current_epoch;
use super::task_leases::with_immediate_transaction;
use crate::narrative_runtime_policy::require_narrative_extraction_allowed;
use crate::Database;

/// Reserved ProposalSet kind. Generic proposal persistence cannot use this
/// value; the typed adapter below is the only writer for this contract.
pub const NIR1_ENTITY_RELATION_SET_KIND: &str = "nir1.entity-relation.revision@1";
pub const NIR1_ENTITY_RELATION_PROPOSAL_KIND: &str = "nir1.entity-relation@1";
pub const NIR1_ENTITY_RELATION_REVISION_ORIGIN: &str = "nir1-typed";
pub const NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH: &str = "nir1/entity-relation-review";
pub const NIR1_ENTITY_RELATION_DECISION_LOCKED: &str = "NEX_NIR1_ENTITY_RELATION_DECISION_LOCKED";

type TypedCanonicalFreshnessRow = (
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
);
type TypedRevisionCoreRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
    String,
);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Nir1EntityRelationRevisionRequest {
    pub run_id: String,
    pub project_id: String,
    pub proposal_key: String,
    /// `revisionId` is replaced by the Native-generated immutable Revision
    /// identity at persistence time. The field remains part of the shared
    /// bundle shape so the same type can be consumed by the graph primitive.
    pub bundle: EntityRelationBundle,
}

/// Renderer supplies only the live object identities selected for review. The
/// Native adapter resolves labels, type, Relation endpoints/version, summary
/// or name Evidence, and the current Scope authority in the same transaction.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Nir1EntityRelationRevisionPrepareRequest {
    pub project_id: String,
    pub scene_id: String,
    pub proposal_key: Option<String>,
    pub entity_ids: Vec<String>,
    pub relation_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1EntityRelationRevision {
    pub project_id: String,
    pub run_id: String,
    pub proposal_set_id: String,
    pub proposal_id: String,
    pub revision_id: String,
    pub bundle_digest: String,
    pub eligibility_source: &'static str,
    pub index_key: &'static str,
    /// The sealed source/dependency references that A3/B/D1 may consume. It
    /// contains no transitive closure bodies beyond the typed Evidence quote
    /// already present in the bundle.
    pub material_basis: MaterialBasis,
    pub canonical_freshness: Nir1EntityRelationFreshness,
    pub bundle: EntityRelationBundle,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1EntityRelationFreshness {
    pub semantic_epoch_id: String,
    pub dependency_set_digest: String,
    pub declaration_set_id: String,
    pub declaration_set_digest: String,
    pub last_evaluated_run_id: Option<String>,
    pub edge_count: usize,
    pub feed_acknowledged_through_sequence: i64,
    pub feed_head_sequence: i64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", content = "result", rename_all = "camelCase")]
pub enum Nir1EntityRelationRevisionRead {
    Available(Box<Nir1EntityRelationRevision>),
    Unavailable { reason: String },
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", content = "result", rename_all = "camelCase")]
pub enum Nir1EntityRelationRevisionCurrentRead {
    Draft(Box<Nir1EntityRelationRevision>),
    Available(Box<Nir1EntityRelationRevision>),
    Unavailable { reason: String },
}

/// Renderer-safe projection of a qualified typed revision.  The Native
/// reader above remains the full A3/B/D1 authority; this DTO deliberately
/// omits material basis, canonical Freshness, source tokens, and Scope.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1EntityRelationRevisionReviewEvidence {
    pub evidence_id: String,
    pub source_ref: String,
    pub quote: String,
    pub start_utf16: usize,
    pub end_utf16: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1EntityRelationRevisionReviewEntity {
    pub entity_id: String,
    pub entity_type: String,
    pub label: String,
    pub evidence: Vec<Nir1EntityRelationRevisionReviewEvidence>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1EntityRelationRevisionReviewRelation {
    pub edge_id: String,
    pub from_entity_id: String,
    pub to_entity_id: String,
    pub relation_type: String,
    pub directionality: String,
    pub evidence_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Nir1EntityRelationRevisionReviewResult {
    pub project_id: String,
    pub run_id: String,
    pub proposal_set_id: String,
    pub proposal_id: String,
    pub revision_id: String,
    pub scene_id: String,
    pub entities: Vec<Nir1EntityRelationRevisionReviewEntity>,
    pub relations: Vec<Nir1EntityRelationRevisionReviewRelation>,
}

fn typed_review_scene_id(bundle: &EntityRelationBundle) -> String {
    let scene_ids = bundle
        .entities
        .iter()
        .filter_map(|entity| match &entity.scope.reading {
            ScopeValue::Exact { value } => value.strip_prefix("scene:"),
            _ => None,
        })
        .filter(|scene_id| !scene_id.is_empty())
        .collect::<HashSet<_>>();
    if scene_ids.len() == 1 {
        scene_ids.into_iter().next().unwrap_or_default().to_owned()
    } else {
        String::new()
    }
}

fn typed_review_result(
    revision: &Nir1EntityRelationRevision,
) -> Nir1EntityRelationRevisionReviewResult {
    Nir1EntityRelationRevisionReviewResult {
        project_id: revision.project_id.clone(),
        run_id: revision.run_id.clone(),
        proposal_set_id: revision.proposal_set_id.clone(),
        proposal_id: revision.proposal_id.clone(),
        revision_id: revision.revision_id.clone(),
        scene_id: typed_review_scene_id(&revision.bundle),
        entities: revision
            .bundle
            .entities
            .iter()
            .map(|entity| Nir1EntityRelationRevisionReviewEntity {
                entity_id: entity.entity_id.clone(),
                entity_type: entity.entity_type.clone(),
                label: entity.label.clone(),
                evidence: entity
                    .evidence
                    .iter()
                    .map(|evidence| Nir1EntityRelationRevisionReviewEvidence {
                        evidence_id: evidence.evidence_id.clone(),
                        source_ref: evidence.source_ref.clone(),
                        quote: evidence.quote.clone(),
                        start_utf16: evidence.start_utf16,
                        end_utf16: evidence.end_utf16,
                    })
                    .collect(),
            })
            .collect(),
        relations: revision
            .bundle
            .relations
            .iter()
            .map(|relation| Nir1EntityRelationRevisionReviewRelation {
                edge_id: relation.edge_id.clone(),
                from_entity_id: relation.from_entity_id.clone(),
                to_entity_id: relation.to_entity_id.clone(),
                relation_type: relation.relation_type.clone(),
                directionality: relation.directionality.clone(),
                evidence_ids: relation.evidence_ids.clone(),
            })
            .collect(),
    }
}

pub fn nir1_entity_relation_revision_read_for_renderer(
    response: Nir1EntityRelationRevisionRead,
) -> anyhow::Result<Value> {
    Ok(match response {
        Nir1EntityRelationRevisionRead::Available(revision) => json!({
            "status": "available",
            "result": typed_review_result(&revision),
        }),
        Nir1EntityRelationRevisionRead::Unavailable { reason } => json!({
            "status": "unavailable",
            "result": { "reason": reason },
        }),
    })
}

pub fn nir1_entity_relation_revision_current_read_for_renderer(
    response: Nir1EntityRelationRevisionCurrentRead,
) -> anyhow::Result<Value> {
    Ok(match response {
        Nir1EntityRelationRevisionCurrentRead::Draft(revision) => json!({
            "status": "draft",
            "result": typed_review_result(&revision),
        }),
        Nir1EntityRelationRevisionCurrentRead::Available(revision) => json!({
            "status": "available",
            "result": typed_review_result(&revision),
        }),
        Nir1EntityRelationRevisionCurrentRead::Unavailable { reason } => json!({
            "status": "unavailable",
            "result": { "reason": reason },
        }),
    })
}

/// Reduce the Native prepare response to an opaque durable receipt.  The
/// nested full Revision is intentionally never serialized across this
/// mutation boundary; callers must use a separately gated current reader.
pub fn nir1_entity_relation_revision_prepare_receipt(value: Value) -> anyhow::Result<Value> {
    let run_id = value
        .get("runId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("NIR1_ENTITY_RELATION_PREPARE_RECEIPT_INVALID"))?;
    let result = value
        .get("result")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("NIR1_ENTITY_RELATION_PREPARE_RECEIPT_INVALID"))?;
    let proposal_set_id = result
        .get("proposalSetId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("NIR1_ENTITY_RELATION_PREPARE_RECEIPT_INVALID"))?;
    let proposal_id = result
        .get("proposalId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("NIR1_ENTITY_RELATION_PREPARE_RECEIPT_INVALID"))?;
    let revision_id = result
        .get("revisionId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("NIR1_ENTITY_RELATION_PREPARE_RECEIPT_INVALID"))?;
    Ok(json!({
        "runId": run_id,
        "status": "draft",
        "receipt": {
            "proposalSetId": proposal_set_id,
            "proposalId": proposal_id,
            "revisionId": revision_id,
            "status": "unreviewed",
        },
    }))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredNir1EntityRelationPayload {
    schema_version: u64,
    kind: String,
    producer: String,
    project_id: String,
    revision_id: String,
    bundle: EntityRelationBundle,
}

const NIR1_ENTITY_RELATION_CONTEXT_STAGE: &str = "nir1-entity-relation-native";
const NIR1_ENTITY_RELATION_CONTEXT_VERSION: &str = "chronicle.context-set/1";

fn digest_bytes(value: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(value)))
}

fn build_typed_material_basis(
    conn: &Connection,
    project_id: &str,
    bundle: &EntityRelationBundle,
    observed_at: &str,
) -> anyhow::Result<MaterialBasis> {
    let authority = load_live_project_scope_authority(
        conn,
        project_id,
        &format!("project:scope-authority:{project_id}"),
    )?;
    let scope_source_key = authority.source.source_key.clone();
    let mut source_basis = bundle
        .entities
        .iter()
        .map(|entity| MaterialSourceBasisEntry {
            source_kind: "codex-entry".into(),
            source_key: format!("codex:{}", entity.entity_id),
            revision_token: entity.source_token.clone(),
            revision_observed_at: Some(observed_at.into()),
        })
        .chain(
            bundle
                .relations
                .iter()
                .map(|relation| MaterialSourceBasisEntry {
                    source_kind: "codex-relation".into(),
                    source_key: format!("codex-relation:{}", relation.edge_id),
                    revision_token: relation.source_token.clone(),
                    revision_observed_at: Some(observed_at.into()),
                }),
        )
        .chain(std::iter::once(MaterialSourceBasisEntry {
            source_kind: "project-scope-authority".into(),
            source_key: scope_source_key.clone(),
            revision_token: authority.source.revision_token,
            revision_observed_at: Some(observed_at.into()),
        }))
        .collect::<Vec<_>>();
    source_basis.sort_by(|left, right| left.source_key.cmp(&right.source_key));

    let mut evidence_set = bundle
        .entities
        .iter()
        .flat_map(|entity| {
            entity
                .evidence
                .iter()
                .map(|evidence| MaterialEvidenceEntry {
                    evidence_ref: evidence.evidence_id.clone(),
                    document_ref: evidence.source_ref.clone(),
                    quote: evidence.quote.clone(),
                    quote_digest: digest_bytes(evidence.quote.as_bytes()),
                    source_key: format!("codex:{}", entity.entity_id),
                    revision_token: entity.source_token.clone(),
                })
        })
        .collect::<Vec<_>>();
    evidence_set.sort_by(|left, right| left.evidence_ref.cmp(&right.evidence_ref));

    let context_id = "context:nir1.entity-relation".to_string();
    let mut dependency_set = Vec::new();
    for entity in &bundle.entities {
        let source_key = format!("codex:{}", entity.entity_id);
        for evidence in &entity.evidence {
            dependency_set.push(MaterialDependencyEntry {
                dependency_id: format!("nir1:evidence:{}", evidence.evidence_id),
                input_ref: source_key.clone(),
                context_ids: vec![context_id.clone()],
                role: DependencyRole::DirectEvidence,
                selector: DependencySelector::WholeSource,
            });
        }
        dependency_set.push(MaterialDependencyEntry {
            dependency_id: format!("nir1:entity:{}", entity.entity_id),
            input_ref: source_key,
            context_ids: vec![context_id.clone()],
            role: DependencyRole::EntityResolution,
            selector: DependencySelector::WholeSource,
        });
    }
    for relation in &bundle.relations {
        dependency_set.push(MaterialDependencyEntry {
            dependency_id: format!("nir1:relation:{}", relation.edge_id),
            input_ref: format!("codex-relation:{}", relation.edge_id),
            context_ids: vec![context_id.clone()],
            role: DependencyRole::EntityResolution,
            selector: DependencySelector::WholeSource,
        });
    }
    dependency_set.push(MaterialDependencyEntry {
        dependency_id: format!("nir1:scope:{project_id}"),
        input_ref: scope_source_key,
        context_ids: vec![context_id.clone()],
        role: DependencyRole::ScopeResolution,
        selector: DependencySelector::WholeSource,
    });
    let component_contract_digest = canonical_json_digest(&json!({
        "contractId": ENTITY_RELATION_MATERIAL_CONTRACT_ID,
        "version": "1",
    }))?;
    let component_input_ref = source_basis
        .first()
        .map(|source| source.source_key.clone())
        .ok_or_else(|| anyhow::anyhow!("NIR1_ENTITY_RELATION_MATERIAL_SOURCE_EMPTY"))?;
    dependency_set.push(MaterialDependencyEntry {
        dependency_id: "nir1:component-contract:1".into(),
        input_ref: component_input_ref,
        context_ids: vec![context_id],
        role: DependencyRole::ComponentContract,
        selector: DependencySelector::ComponentContract {
            contract_id: ENTITY_RELATION_MATERIAL_CONTRACT_ID.into(),
            contract_digest: component_contract_digest,
        },
    });
    dependency_set.sort_by(|left, right| left.dependency_id.cmp(&right.dependency_id));

    let dependency_set_digest = canonical_json_digest(&serde_json::to_value(&dependency_set)?)?;
    let material_basis_digest = canonical_json_digest(&json!({
        "sourceBasis": source_basis,
        "evidenceSet": evidence_set,
        "dependencySet": dependency_set,
    }))?;
    let material = MaterialBasis {
        source_basis,
        evidence_set,
        dependency_set,
        dependency_set_digest,
        material_basis_digest,
    };
    Ok(material)
}

fn typed_assertion_scope() -> Value {
    let any = || json!({"kind": "any"});
    json!({
        "schemaVersion": 2,
        "registryVersion": "narrative-scope/2",
        "timeline": any(),
        "worldline": any(),
        "scene": any(),
        "viewpoint": any(),
        "knowledgeHolder": any(),
        "audience": any(),
        "narrativeLayer": any(),
        "storyTime": any(),
        "readingOrder": any(),
    })
}

fn build_typed_envelope(
    run_id: &str,
    revision_id: &str,
    payload: &Value,
    bundle_digest: &str,
    material: &MaterialBasis,
) -> anyhow::Result<Value> {
    let producer = json!({
        "kind": "reconciler-proposal",
        "id": ENTITY_RELATION_PRODUCER,
        "version": "1",
    });
    let assertion_scope = typed_assertion_scope();
    let assertion_payload = json!({
        "bundleDigest": bundle_digest,
        "revisionId": revision_id,
    });
    let assertion_core = canonical_json_digest(&json!({
        "assertionKind": ENTITY_RELATION_ASSERTION_KIND,
        "payloadSchemaRef": {
            "id": narrative_nir1::ENTITY_RELATION_ASSERTION_SCHEMA_ID,
            "version": narrative_nir1::ENTITY_RELATION_ASSERTION_SCHEMA_VERSION,
        },
        "typedSemanticPayload": assertion_payload,
        "modality": "modality-inference",
        "polarity": "affirmative",
        "supportClass": "direct-source",
        "producer": producer,
    }))?;
    let scope_digest = canonical_json_digest(&assertion_scope)?;
    let assertion_digest = canonical_json_digest(&json!({
        "assertionCoreDigest": assertion_core,
        "scopeDigest": scope_digest,
    }))?;
    let context_set = json!([{
        "contextId": "context:nir1.entity-relation",
        "inputRef": material.source_basis[0].source_key,
        "stageId": NIR1_ENTITY_RELATION_CONTEXT_STAGE,
        "exposure": "deterministic-stage",
        "selector": {"kind": "whole-source"},
    }]);
    let context_set_digest = canonical_json_digest(&json!({
        "version": NIR1_ENTITY_RELATION_CONTEXT_VERSION,
        "entries": context_set,
    }))?;
    let component_contract_digest = canonical_json_digest(&json!({
        "contractId": ENTITY_RELATION_MATERIAL_CONTRACT_ID,
        "version": "1",
    }))?;
    let value = json!({
        "schemaVersion": 2,
        "assertion": {
            "assertionId": Value::Null,
            "assertionKind": ENTITY_RELATION_ASSERTION_KIND,
            "payloadSchemaRef": {
                "id": narrative_nir1::ENTITY_RELATION_ASSERTION_SCHEMA_ID,
                "version": narrative_nir1::ENTITY_RELATION_ASSERTION_SCHEMA_VERSION,
            },
            "payload": assertion_payload,
            "scope": assertion_scope,
            "modality": "modality-inference",
            "polarity": "affirmative",
            "supportClass": "direct-source",
            "producer": producer,
        },
        "assertionDigests": {
            "assertionCoreDigest": assertion_core,
            "scopeDigest": scope_digest,
            "assertionDigest": assertion_digest,
        },
        "changeIntent": {"changeKind": "add"},
        "effectiveMaterialBasis": material,
        "revisionBasis": {
            "kind": "interpretation",
            "runId": run_id,
            "taskId": format!("nir1.entity-relation:{revision_id}"),
            "producer": producer,
            "contextSet": context_set,
            "contextSetDigest": context_set_digest,
            "componentContractDigest": component_contract_digest,
            "finalRequestDigest": canonical_json_digest(payload)?,
        },
        "projectionBinding": {
            "proposalKind": ENTITY_RELATION_ASSERTION_KIND,
            "proposalSchemaRef": {
                "id": narrative_nir1::ENTITY_RELATION_ASSERTION_SCHEMA_ID,
                "version": narrative_nir1::ENTITY_RELATION_ASSERTION_SCHEMA_VERSION,
            },
            "proposalPayloadDigest": canonical_json_digest(payload)?,
            "adapterContractId": ENTITY_RELATION_ADAPTER_ID,
            "adapterContractVersion": ENTITY_RELATION_ADAPTER_VERSION,
        },
    });
    validate_entity_relation_revision_envelope_v2(&value)
        .map_err(|error| anyhow::anyhow!("NIR1_ENTITY_RELATION_ENVELOPE_INVALID: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("NIR1_ENTITY_RELATION_ENVELOPE_INVALID"))?;
    validate_v2_nested_digest_fields(object).map_err(|error| {
        anyhow::anyhow!("NIR1_ENTITY_RELATION_ENVELOPE_DIGEST_INVALID: {error}")
    })?;
    Ok(value)
}

fn source_basis_rows(material: &MaterialBasis) -> Vec<SourceBasisRow> {
    material
        .source_basis
        .iter()
        .enumerate()
        .map(|(ordinal, source)| SourceBasisRow {
            ordinal: ordinal as i64,
            source_kind: source.source_kind.clone(),
            source_key: source.source_key.clone(),
            revision_token: source.revision_token.clone(),
            observed_at: source.revision_observed_at.clone(),
        })
        .collect()
}

/// The generic Source identity registry intentionally does not know about
/// this typed family. Entity/Relation source identities therefore stay inside
/// this adapter and are written verbatim to the existing V1/D1 authorities.
fn typed_source_identity(
    source: &MaterialSourceBasisEntry,
    project_id: &str,
) -> anyhow::Result<String> {
    let expected = match source.source_kind.as_str() {
        "codex-entry" => {
            anyhow::ensure!(
                source.source_key.starts_with("codex:")
                    && source.source_key.len() > "codex:".len(),
                "NIR1_ENTITY_RELATION_SOURCE_IDENTITY_INVALID"
            );
            source.source_key.clone()
        }
        "codex-relation" => {
            anyhow::ensure!(
                source.source_key.starts_with("codex-relation:")
                    && source.source_key.len() > "codex-relation:".len(),
                "NIR1_ENTITY_RELATION_SOURCE_IDENTITY_INVALID"
            );
            source.source_key.clone()
        }
        "project-scope-authority" => {
            let expected = format!("project:scope-authority:{project_id}");
            anyhow::ensure!(
                source.source_key == expected,
                "NIR1_ENTITY_RELATION_SCOPE_SOURCE_IDENTITY_INVALID"
            );
            expected
        }
        other => anyhow::bail!(
            "NIR1_ENTITY_RELATION_SOURCE_KIND_UNSUPPORTED: typed source kind '{other}' is not allowed"
        ),
    };
    Ok(expected)
}

/// Project the typed dependency set into the existing D1 declaration
/// authority. Multiple Evidence entries can name one Entity Source; D1 is a
/// set of `(source, role, selector)` rows, so those declarations are emitted
/// once while every Evidence and dependency id remains in the sealed basis.
fn typed_d1_declaration_set(
    material: &MaterialBasis,
    project_id: &str,
    revision_id: &str,
) -> anyhow::Result<D1DeclarationProjection> {
    let source_keys = material
        .source_basis
        .iter()
        .map(|source| typed_source_identity(source, project_id))
        .collect::<anyhow::Result<HashSet<_>>>()?;
    let mut seen = HashSet::new();
    let mut declarations = Vec::new();
    for dependency in &material.dependency_set {
        anyhow::ensure!(
            source_keys.contains(&dependency.input_ref),
            "NIR1_ENTITY_RELATION_DEPENDENCY_SOURCE_MISSING"
        );
        let selector_json = canonicalize_dependency_selector(&dependency.selector)?;
        let key = (
            dependency.input_ref.clone(),
            dependency.role.as_str().to_owned(),
            selector_json,
        );
        if seen.insert(key) {
            declarations.push(DependencyDeclaration {
                source_object_identity: dependency.input_ref.clone(),
                role: dependency.role,
                selector: dependency.selector.clone(),
            });
        }
    }
    anyhow::ensure!(
        !declarations.is_empty(),
        "NIR1_ENTITY_RELATION_DECLARATION_SET_EMPTY"
    );
    Ok(D1DeclarationProjection {
        project_id: project_id.to_owned(),
        consumer_kind: "proposal-revision".to_owned(),
        consumer_key: revision_id.to_owned(),
        producer_id: "proposal-revision-source-basis".to_owned(),
        producer_generation: 1,
        declarations,
    })
}

fn record_typed_dependency_edges_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    revision_id: &str,
    rows: &[SourceBasisRow],
    created_at: &str,
) -> anyhow::Result<()> {
    for row in rows {
        let source = MaterialSourceBasisEntry {
            source_kind: row.source_kind.clone(),
            source_key: row.source_key.clone(),
            revision_token: row.revision_token.clone(),
            revision_observed_at: row.observed_at.clone(),
        };
        let source_object_identity = typed_source_identity(&source, project_id)?;
        let read_set_json = serde_json::to_string(&[row.revision_token.as_str()])?;
        record_dependency_edge_in_tx(
            conn,
            project_id,
            "proposal-revision",
            revision_id,
            &source_object_identity,
            &read_set_json,
            None,
            Some(run_id),
            created_at,
        )?;
    }
    Ok(())
}

fn materialize_typed_authorities_in_tx(
    conn: &Connection,
    project_id: &str,
    _run_id: &str,
    revision_id: &str,
    material: &MaterialBasis,
    created_at: &str,
) -> anyhow::Result<()> {
    let epoch_id = get_current_epoch(conn, project_id)?
        .map(|epoch| epoch.id)
        .ok_or_else(|| anyhow::anyhow!("NIR1_ENTITY_RELATION_CURRENT_EPOCH_UNAVAILABLE"))?;
    let projection = typed_d1_declaration_set(material, project_id, revision_id)?;
    write_dependency_declaration_set_in_tx(
        conn,
        DependencyDeclarationSetRequest {
            project_id: projection.project_id,
            consumer_kind: projection.consumer_kind,
            consumer_key: projection.consumer_key,
            producer_id: projection.producer_id,
            producer_generation: projection.producer_generation,
            expected_head_version: 0,
            declarations: projection.declarations,
            created_at: created_at.into(),
        },
    )?;
    let edges = find_edges_by_consumer(conn, project_id, "proposal-revision", revision_id)?;
    let observations = edges
        .iter()
        .map(|edge| {
            Ok((
                edge.id.clone(),
                evaluate_typed_edge(conn, project_id, edge)?,
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    publish_complete_runless_freshness_in_tx(
        conn,
        project_id,
        "proposal-revision",
        revision_id,
        &observations,
        &epoch_id,
        created_at,
    )?;
    Ok(())
}

/// Re-derive and compare every persisted authority for one typed Revision in
/// the caller's read snapshot. This is deliberately a typed-local check:
/// generic material membership remains unable to classify this family.
fn validate_typed_persisted_material(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    revision_id: &str,
    material: &MaterialBasis,
) -> anyhow::Result<()> {
    let expected_sources = source_basis_rows(material);
    let persisted_sources = load_source_basis_rows(conn, revision_id)?;
    anyhow::ensure!(
        persisted_sources == expected_sources,
        "NIR1_ENTITY_RELATION_SOURCE_BASIS_MISMATCH"
    );

    let edges = find_edges_by_consumer(conn, project_id, "proposal-revision", revision_id)?;
    anyhow::ensure!(
        edges.len() == expected_sources.len(),
        "NIR1_ENTITY_RELATION_V1_EDGE_SET_MISMATCH"
    );
    for source in &expected_sources {
        let matching = edges
            .iter()
            .filter(|edge| edge.source_object_identity == source.source_key)
            .collect::<Vec<_>>();
        anyhow::ensure!(
            matching.len() == 1,
            "NIR1_ENTITY_RELATION_V1_EDGE_SOURCE_MISMATCH"
        );
        let edge = matching[0];
        let read_set: Vec<String> = serde_json::from_str(&edge.read_set_json)
            .map_err(|_| anyhow::anyhow!("NIR1_ENTITY_RELATION_V1_READ_SET_INVALID"))?;
        anyhow::ensure!(
            edge.project_id == project_id
                && edge.consumer_kind == "proposal-revision"
                && edge.consumer_key == revision_id
                && edge.owning_run_id.as_deref() == Some(run_id)
                && read_set == vec![source.revision_token.clone()],
            "NIR1_ENTITY_RELATION_V1_EDGE_BINDING_MISMATCH"
        );
    }

    let expected_d1 = typed_d1_declaration_set(material, project_id, revision_id)?;
    let ActiveDependencyDeclarationSetRead::Active(actual_d1) =
        read_active_dependency_declaration_set_in_tx(
            conn,
            project_id,
            "proposal-revision",
            revision_id,
        )?
    else {
        anyhow::bail!("NIR1_ENTITY_RELATION_D1_UNAVAILABLE");
    };
    anyhow::ensure!(
        actual_d1.project_id == expected_d1.project_id
            && actual_d1.consumer_kind == expected_d1.consumer_kind
            && actual_d1.consumer_key == expected_d1.consumer_key
            && actual_d1.producer_id == expected_d1.producer_id
            && actual_d1.producer_generation == expected_d1.producer_generation
            && actual_d1.entries.len() == expected_d1.declarations.len(),
        "NIR1_ENTITY_RELATION_D1_BINDING_MISMATCH"
    );
    let mut expected_declarations = expected_d1
        .declarations
        .iter()
        .map(|declaration| {
            Ok((
                declaration.source_object_identity.clone(),
                declaration.role.as_str().to_owned(),
                canonicalize_dependency_selector(&declaration.selector)?,
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let mut actual_declarations = actual_d1
        .entries
        .iter()
        .map(|entry| {
            Ok((
                entry.source_object_identity.clone(),
                entry.dependency_role.as_str().to_owned(),
                canonicalize_dependency_selector(&serde_json::from_str(&entry.selector_json)?)?,
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    expected_declarations.sort();
    actual_declarations.sort();
    anyhow::ensure!(
        actual_declarations == expected_declarations,
        "NIR1_ENTITY_RELATION_D1_DECLARATION_SET_MISMATCH"
    );
    Ok(())
}

fn canonical_instant(value: &str) -> bool {
    DateTime::parse_from_rfc3339(value).is_ok_and(|instant| {
        instant
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
            == value
    })
}

/// Resolve only the three source shapes admitted by `nir1.entity-relation@1`.
/// This intentionally does not register them with the generic Source
/// resolver; the typed reader is the sole consumer of these identities.
fn resolve_typed_source_token(
    conn: &Connection,
    project_id: &str,
    source_object_identity: &str,
) -> anyhow::Result<Option<String>> {
    if let Some(entity_id) = source_object_identity.strip_prefix("codex:") {
        if entity_id.trim().is_empty() {
            return Ok(None);
        }
        return conn
            .query_row(
                "SELECT updated_at
                   FROM codex_entries
                  WHERE id = ?1 AND project_id = ?2
                    AND context_mode NOT IN ('hidden', 'suppress')",
                params![entity_id, project_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map(|updated_at| updated_at.map(|value| format!("codex:{entity_id}@{value}")))
            .map_err(Into::into);
    }
    if let Some(relation_id) = source_object_identity.strip_prefix("codex-relation:") {
        if relation_id.trim().is_empty() {
            return Ok(None);
        }
        return conn
            .query_row(
                "SELECT version, updated_at
                   FROM codex_relations
                  WHERE id = ?1 AND project_id = ?2",
                params![relation_id, project_id],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map(|value| {
                value.map(|(version, updated_at)| {
                    format!("v{version}@{updated_at}:relation:{relation_id}")
                })
            })
            .map_err(Into::into);
    }
    let expected_scope = format!("project:scope-authority:{project_id}");
    if source_object_identity == expected_scope {
        return load_live_project_scope_authority(conn, project_id, source_object_identity)
            .map(|authority| Some(authority.source.revision_token));
    }
    Ok(None)
}

fn evaluate_typed_edge(
    conn: &Connection,
    project_id: &str,
    edge: &DependencyEdge,
) -> anyhow::Result<super::evaluator::EdgeObservation> {
    let read_set: Vec<String> = serde_json::from_str(&edge.read_set_json)
        .map_err(|_| anyhow::anyhow!("NIR1_ENTITY_RELATION_V1_READ_SET_INVALID"))?;
    anyhow::ensure!(
        read_set.len() == 1,
        "NIR1_ENTITY_RELATION_V1_READ_SET_INVALID"
    );
    let current_revision_token =
        resolve_typed_source_token(conn, project_id, &edge.source_object_identity)?;
    Ok(evaluate_edge(&EdgeComparisonInput {
        stored_revision_token: read_set.into_iter().next(),
        current_revision_token: current_revision_token.clone(),
        current_source_exists: current_revision_token.is_some(),
        comparison_available: current_revision_token.is_some(),
        ..EdgeComparisonInput::default()
    }))
}

pub(crate) fn is_typed_revision_edge(
    conn: &Connection,
    project_id: &str,
    edge: &DependencyEdge,
) -> anyhow::Result<bool> {
    if edge.consumer_kind != "proposal-revision" {
        return Ok(false);
    }
    Ok(conn.query_row(
        "SELECT EXISTS(
             SELECT 1
               FROM narrative_proposal_revisions revision
               JOIN narrative_proposals proposal
                 ON proposal.id = revision.proposal_id
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
              WHERE revision.id = ?1
                AND proposal_set.project_id = ?2
                AND proposal_set.set_kind = ?3
         )",
        params![edge.consumer_key, project_id, NIR1_ENTITY_RELATION_SET_KIND],
        |row| row.get(0),
    )?)
}

pub(crate) fn evaluate_typed_edge_for_incremental(
    conn: &Connection,
    project_id: &str,
    edge: &DependencyEdge,
) -> anyhow::Result<super::evaluator::EdgeObservation> {
    evaluate_typed_edge(conn, project_id, edge)
}

pub(crate) fn typed_source_token_for_incremental(
    conn: &Connection,
    project_id: &str,
    source_object_identity: &str,
) -> anyhow::Result<Option<String>> {
    resolve_typed_source_token(conn, project_id, source_object_identity)
}

fn typed_run_matches_current_epoch(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<bool> {
    let Some(epoch) = get_current_epoch(conn, project_id)? else {
        return Ok(false);
    };
    let run_epoch: Option<String> = conn
        .query_row(
            "SELECT semantic_epoch_id FROM narrative_extraction_runs
              WHERE id = ?1 AND project_id = ?2",
            params![run_id, project_id],
            |row| row.get(0),
        )
        .optional()?
        .flatten();
    Ok(run_epoch.as_deref() == Some(epoch.id.as_str()))
}

/// Read the existing canonical V1/D1 Freshness authority for the typed
/// consumer. The generic reader is intentionally not called because its
/// membership and Source resolvers must remain family-scoped deny paths.
fn read_typed_canonical_freshness(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    revision_id: &str,
    material: &MaterialBasis,
) -> anyhow::Result<Option<Nir1EntityRelationFreshness>> {
    if !is_generic_freshness_canonical(conn)? {
        return Ok(None);
    }
    let Some(epoch) = get_current_epoch(conn, project_id)? else {
        return Ok(None);
    };
    // A restore/migration creates a new Epoch and invalidates every old Run.
    // This check is deliberately tied to the existing Run/Epoch authority,
    // so rebuilding the old rows cannot make this Revision eligible again.
    if !typed_run_matches_current_epoch(conn, project_id, run_id)? {
        return Ok(None);
    }

    let row: Option<TypedCanonicalFreshnessRow> = conn
        .query_row(
            "SELECT evidence_freshness, build_action, semantic_epoch_id,
                    last_evaluated_run_id, dependency_set_digest, updated_at
               FROM narrative_consumer_freshness
              WHERE project_id = ?1
                AND consumer_kind = 'proposal-revision'
                AND consumer_key = ?2",
            params![project_id, revision_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()?;
    let Some((freshness, action, evaluated_epoch, publisher, digest, updated_at)) = row else {
        return Ok(None);
    };
    if evaluated_epoch != epoch.id
        || !canonical_instant(&updated_at)
        || EvidenceFreshness::try_from(freshness.as_str()).ok() != Some(EvidenceFreshness::Fresh)
        || BuildAction::try_from(action.as_str()).ok() != Some(BuildAction::None)
    {
        return Ok(None);
    }

    let edges = find_edges_by_consumer(conn, project_id, "proposal-revision", revision_id)?;
    if edges.is_empty() || edges.len() != material.source_basis.len() {
        return Ok(None);
    }
    let expected_digest =
        consumer_dependency_set_digest(conn, project_id, "proposal-revision", revision_id)?;
    if digest.as_deref() != Some(expected_digest.as_str()) {
        return Ok(None);
    }

    let ActiveDependencyDeclarationSetRead::Active(declaration) =
        read_active_dependency_declaration_set_in_tx(
            conn,
            project_id,
            "proposal-revision",
            revision_id,
        )?
    else {
        return Ok(None);
    };
    let mut edge_state_statement = conn.prepare(
        "SELECT s.evidence_freshness, s.reason_code, s.build_action,
                s.evaluated_at_epoch_id, s.evaluated_at
           FROM narrative_dependency_edges e
           LEFT JOIN narrative_dependency_edge_states s ON s.edge_id = e.id
          WHERE e.project_id = ?1
            AND e.consumer_kind = 'proposal-revision'
            AND e.consumer_key = ?2
          ORDER BY e.id",
    )?;
    let states = edge_state_statement
        .query_map(params![project_id, revision_id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if states.len() != edges.len()
        || states
            .iter()
            .any(|(freshness, reason, action, state_epoch, evaluated_at)| {
                freshness.as_deref() != Some("fresh")
                    || reason.is_some()
                    || action.as_deref() != Some("none")
                    || state_epoch.as_deref() != Some(epoch.id.as_str())
                    || evaluated_at
                        .as_deref()
                        .is_none_or(|value| !canonical_instant(value))
            })
    {
        return Ok(None);
    }

    let aggregate = worst_edge_state_for_consumer(
        conn,
        project_id,
        "proposal-revision",
        revision_id,
        &epoch.id,
    )?;
    if aggregate.as_ref().is_none_or(|observation| {
        observation.freshness != EvidenceFreshness::Fresh
            || observation.build_action != BuildAction::None
            || observation.reason_code.is_some()
    }) {
        return Ok(None);
    }
    if let Some(publisher) = publisher.as_deref() {
        if validate_current_evaluation_run_reference(
            conn,
            project_id,
            &epoch.id,
            revision_id,
            publisher,
        )
        .is_err()
        {
            return Ok(None);
        }
    }
    let feed = match pending::read(conn, project_id, &edges)? {
        Ok(feed) => feed,
        Err(_) => return Ok(None),
    };
    for edge in &edges {
        if edge.owning_run_id.as_deref() != Some(run_id) {
            return Ok(None);
        }
        let observation = evaluate_typed_edge(conn, project_id, edge)?;
        if observation.freshness != EvidenceFreshness::Fresh
            || observation.build_action != BuildAction::None
            || observation.reason_code.is_some()
        {
            return Ok(None);
        }
    }
    Ok(Some(Nir1EntityRelationFreshness {
        semantic_epoch_id: epoch.id,
        dependency_set_digest: expected_digest,
        declaration_set_id: declaration.declaration_set_id,
        declaration_set_digest: declaration.dependency_set_digest,
        last_evaluated_run_id: publisher,
        edge_count: edges.len(),
        feed_acknowledged_through_sequence: feed.acknowledged,
        feed_head_sequence: feed.head,
    }))
}

pub fn create_nir1_entity_relation_revision(
    db: &Database,
    request: Nir1EntityRelationRevisionRequest,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            create_in_tx(conn, request)
        })
    })
}

fn create_in_tx(
    conn: &Connection,
    request: Nir1EntityRelationRevisionRequest,
) -> anyhow::Result<Value> {
    if request.project_id.trim().is_empty()
        || request.run_id.trim().is_empty()
        || request.proposal_key.trim().is_empty()
        || request.proposal_key.len() > 256
    {
        anyhow::bail!("NIR1_ENTITY_RELATION_INVALID_REQUEST");
    }
    anyhow::ensure!(
        request.bundle.project_id == request.project_id,
        "NIR1_ENTITY_PROJECT_MISMATCH: bundle project differs from trusted project"
    );
    ensure_run_project(conn, &request.run_id, &request.project_id)?;
    let surface_path_id: String = conn.query_row(
        "SELECT surface_path_id
           FROM narrative_extraction_runs
          WHERE id = ?1 AND project_id = ?2",
        params![request.run_id, request.project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        surface_path_id == NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
        "NIR1_ENTITY_RELATION_REVIEW_SURFACE_REQUIRED: typed revisions require the dedicated review surface"
    );
    anyhow::ensure!(
        !current_chronicle_run_spec_for_run(conn, &request.project_id, &request.run_id)?,
        "NIR1_ENTITY_RELATION_CHRONICLE_FINISH_REQUIRED: current Chronicle Runs must persist typed output through their terminal Task"
    );

    let revision_id = Uuid::new_v4().to_string();
    let mut bundle = request.bundle;
    // The renderer/request supplies material, never the identity of the
    // immutable Revision. This assignment is the actual identity binding.
    bundle.revision_id = revision_id.clone();
    validate_entity_relation_bundle(&bundle)
        .map_err(|error| anyhow::anyhow!("NIR1_ENTITY_RELATION_INPUT_INVALID: {error}"))?;
    validate_live_sources(conn, &request.project_id, &bundle)?;

    let payload = StoredNir1EntityRelationPayload {
        schema_version: 1,
        kind: NIR1_ENTITY_RELATION_PROPOSAL_KIND.into(),
        producer: ENTITY_RELATION_PRODUCER.into(),
        project_id: request.project_id.clone(),
        revision_id: revision_id.clone(),
        bundle: bundle.clone(),
    };
    let payload_value = serde_json::to_value(&payload)?;
    let payload_json = serde_json::to_string(&payload_value)?;
    let payload_digest = canonical_json_digest(&payload_value)?;
    let bundle_digest = canonical_json_digest(&serde_json::to_value(&bundle)?)?;
    let proposal_set_id = Uuid::new_v4().to_string();
    let proposal_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let material = build_typed_material_basis(conn, &request.project_id, &bundle, &created_at)?;
    let envelope = build_typed_envelope(
        &request.run_id,
        &revision_id,
        &payload_value,
        &bundle_digest,
        &material,
    )?;
    let envelope_json = canonical_json_string(&envelope)?;
    let envelope_digest = canonical_json_digest(&envelope)?;
    let summary_json = serde_json::to_string(&json!({
        "kind": "nir1.entity-relation.revision-summary@1",
        "producer": ENTITY_RELATION_PRODUCER,
        "bundleDigest": bundle_digest,
        "entityCount": bundle.entities.len(),
        "relationCount": bundle.relations.len(),
    }))?;

    conn.execute(
        "INSERT INTO narrative_proposal_sets
            (id, run_id, project_id, set_kind, status, summary_json,
             created_at, updated_at, version)
         VALUES (?1, ?2, ?3, ?4, 'draft', ?5, ?6, ?6, 0)",
        params![
            proposal_set_id,
            request.run_id,
            request.project_id,
            NIR1_ENTITY_RELATION_SET_KIND,
            summary_json,
            created_at,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposals
            (id, proposal_set_id, proposal_key, kind, status, payload_json,
             current_revision_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'unreviewed', ?5, ?6, ?7, ?7)",
        params![
            proposal_id,
            proposal_set_id,
            request.proposal_key,
            NIR1_ENTITY_RELATION_PROPOSAL_KIND,
            payload_json,
            revision_id,
            created_at,
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_proposal_revisions
            (id, proposal_id, revision_number, payload_json, origin_kind,
             reconciliation_envelope_json, reconciliation_envelope_digest,
             created_at, created_by)
         VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            revision_id,
            proposal_id,
            serde_json::to_string(&payload_value)?,
            NIR1_ENTITY_RELATION_REVISION_ORIGIN,
            envelope_json,
            envelope_digest,
            created_at,
            "nir1-native-adapter",
        ],
    )?;

    let source_rows = source_basis_rows(&material);
    insert_source_basis_rows(conn, &revision_id, &source_rows)?;
    record_typed_dependency_edges_in_tx(
        conn,
        &request.project_id,
        &request.run_id,
        &revision_id,
        &source_rows,
        &created_at,
    )?;
    materialize_typed_authorities_in_tx(
        conn,
        &request.project_id,
        &request.run_id,
        &revision_id,
        &material,
        &created_at,
    )?;

    super::nir1_chronicle_index::invalidate::suspend_project_in_tx(conn, &request.project_id)?;
    Ok(json!({
        "proposalSetId": proposal_set_id,
        "proposalId": proposal_id,
        "revisionId": revision_id,
        "originKind": NIR1_ENTITY_RELATION_REVISION_ORIGIN,
        "producer": ENTITY_RELATION_PRODUCER,
        "indexKey": ENTITY_RELATION_INDEX_KEY,
        "eligibilitySource": ENTITY_RELATION_SOURCE_KIND,
        "payloadDigest": payload_digest,
        "status": "unreviewed",
    }))
}

/// Prepare a dedicated typed review Run and its unreviewed Revision in one
/// Native transaction.  If live source resolution or any authority write
/// fails, both rows roll back together so cold discovery cannot surface an
/// orphan resumable Run.
pub fn prepare_nir1_entity_relation_revision(
    db: &Database,
    request: Nir1EntityRelationRevisionPrepareRequest,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            let bundle = build_live_typed_bundle(conn, &request)?;
            let run_id = create_typed_run_in_tx(
                conn,
                &request.project_id,
                &request.scene_id,
                &request.entity_ids,
                &request.relation_ids,
            )?;
            let proposal_key = request
                .proposal_key
                .clone()
                .unwrap_or_else(|| format!("nir1:review:{run_id}"));
            let created = create_in_tx(
                conn,
                Nir1EntityRelationRevisionRequest {
                    run_id: run_id.clone(),
                    project_id: request.project_id.clone(),
                    proposal_key,
                    bundle,
                },
            )?;
            let revision_id = created
                .get("revisionId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("NIR1_ENTITY_RELATION_PREPARE_REVISION_MISSING"))?;
            let result =
                match read_typed_revision_core(conn, &request.project_id, revision_id, true)? {
                    Nir1EntityRelationRevisionCurrentRead::Draft(revision) => *revision,
                    Nir1EntityRelationRevisionCurrentRead::Available(_) => {
                        anyhow::bail!("NIR1_ENTITY_RELATION_PREPARE_UNEXPECTED_APPROVAL")
                    }
                    Nir1EntityRelationRevisionCurrentRead::Unavailable { reason } => {
                        anyhow::bail!("NIR1_ENTITY_RELATION_PREPARE_READER_REJECTED: {reason}")
                    }
                };
            Ok(json!({
                "runId": run_id,
                "status": "draft",
                "result": result,
            }))
        })
    })
}

/// Re-open one approved typed Revision from a caller-owned read snapshot.
/// Approval is intentionally checked here, not inferred from Proposal status
/// alone: the exact current Decision must be the Native human-review actor.
pub fn read_nir1_entity_relation_revision(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
) -> anyhow::Result<Nir1EntityRelationRevisionRead> {
    match read_typed_revision_core(conn, project_id, revision_id, false)? {
        Nir1EntityRelationRevisionCurrentRead::Available(revision) => {
            Ok(Nir1EntityRelationRevisionRead::Available(revision))
        }
        Nir1EntityRelationRevisionCurrentRead::Draft(_) => {
            Ok(Nir1EntityRelationRevisionRead::Unavailable {
                reason: "revision-not-human-approved".into(),
            })
        }
        Nir1EntityRelationRevisionCurrentRead::Unavailable { reason } => {
            Ok(Nir1EntityRelationRevisionRead::Unavailable { reason })
        }
    }
}

/// Read the current typed Revision for a dedicated Entity/Relation review
/// Run.  This is the only cold-reopen lookup for the typed surface; generic
/// review bundles never participate in this projection.
pub fn read_nir1_entity_relation_revision_current(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<Nir1EntityRelationRevisionCurrentRead> {
    if conn.is_autocommit() {
        anyhow::bail!("NIR1_ENTITY_RELATION_REQUIRES_READ_TRANSACTION");
    }
    if project_id.trim().is_empty() || run_id.trim().is_empty() {
        anyhow::bail!("NIR1_ENTITY_RELATION_INVALID_READ_REQUEST");
    }
    let revision_id: Option<String> = conn
        .query_row(
            "SELECT proposal.current_revision_id
               FROM narrative_proposal_sets proposal_set
               JOIN narrative_extraction_runs extraction_run
                 ON extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
               JOIN narrative_proposals proposal
                 ON proposal.proposal_set_id = proposal_set.id
              WHERE proposal_set.run_id = ?1
                AND proposal_set.project_id = ?2
                AND proposal_set.set_kind = ?3
                AND extraction_run.surface_path_id = ?4
              ORDER BY proposal_set.created_at DESC, proposal_set.id DESC
              LIMIT 1",
            params![
                run_id,
                project_id,
                NIR1_ENTITY_RELATION_SET_KIND,
                NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            ],
            |row| row.get(0),
        )
        .optional()?;
    let Some(revision_id) = revision_id else {
        return Ok(Nir1EntityRelationRevisionCurrentRead::Unavailable {
            reason: "revision-not-found".into(),
        });
    };
    read_typed_revision_core(conn, project_id, &revision_id, true)
}

/// Read one exact Revision selected by a target-aware restore lookup. The
/// current-by-Run reader above intentionally keeps its historical newest-set
/// behavior for generic callers; restore must instead send this immutable
/// Revision identity through the existing current/decision/source/Freshness
/// validation core.
pub fn read_nir1_entity_relation_revision_current_for_revision(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
) -> anyhow::Result<Nir1EntityRelationRevisionCurrentRead> {
    read_typed_revision_core(conn, project_id, revision_id, true)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Nir1EntityRelationRevisionRestoreMatch {
    pub run_id: String,
    pub revision_id: String,
}

/// Find the current typed review Run for one launcher target inside Native.
///
/// The generic resumable-run list is intentionally not target-aware: applying
/// its page limit before a renderer-side filter can hide an older launcher
/// revision. This query filters the sealed current typed payload first, then
/// applies the same canonical resumability predicate and ordering. A matching
/// stale Run is still returned so the current reader can report its exact
/// unavailable reason instead of falling back to an unrelated Run.
pub fn find_nir1_entity_relation_revision_run(
    conn: &Connection,
    project_id: &str,
    entity_id: &str,
    relation_id: Option<&str>,
) -> anyhow::Result<Option<Nir1EntityRelationRevisionRestoreMatch>> {
    if conn.is_autocommit() {
        anyhow::bail!("NIR1_ENTITY_RELATION_REQUIRES_READ_TRANSACTION");
    }
    for (field, value) in [("projectId", project_id), ("entityId", entity_id)] {
        anyhow::ensure!(
            !value.trim().is_empty() && value.trim() == value,
            "NIR1_ENTITY_RELATION_RESTORE_INVALID: {field} must be non-empty and unpadded"
        );
    }
    if let Some(relation_id) = relation_id {
        anyhow::ensure!(
            !relation_id.trim().is_empty() && relation_id.trim() == relation_id,
            "NIR1_ENTITY_RELATION_RESTORE_INVALID: relationId must be non-empty and unpadded"
        );
    }

    let sql = format!(
        r#"
        SELECT r.id, revision.id
          FROM narrative_extraction_runs r
          JOIN narrative_proposal_sets ps
            ON ps.run_id = r.id
           AND ps.project_id = r.project_id
          JOIN narrative_proposals p
            ON p.proposal_set_id = ps.id
          JOIN narrative_proposal_revisions revision
            ON revision.id = p.current_revision_id
           AND revision.proposal_id = p.id
         WHERE r.project_id = ?1
           AND r.surface_path_id = ?2
           AND ps.set_kind = ?3
           AND p.kind = ?4
           AND revision.origin_kind = ?5
           AND json_valid(revision.payload_json)
           AND json_extract(
                 CASE WHEN json_valid(revision.payload_json)
                      THEN revision.payload_json ELSE '{{}}' END,
                 '$.schemaVersion'
               ) = 1
           AND json_extract(
                 CASE WHEN json_valid(revision.payload_json)
                      THEN revision.payload_json ELSE '{{}}' END,
                 '$.kind'
               ) = ?4
           AND json_extract(
                 CASE WHEN json_valid(revision.payload_json)
                      THEN revision.payload_json ELSE '{{}}' END,
                 '$.producer'
               ) = ?6
           AND json_extract(
                 CASE WHEN json_valid(revision.payload_json)
                      THEN revision.payload_json ELSE '{{}}' END,
                 '$.projectId'
               ) = ?1
           AND json_extract(
                 CASE WHEN json_valid(revision.payload_json)
                      THEN revision.payload_json ELSE '{{}}' END,
                 '$.revisionId'
               ) = revision.id
           AND EXISTS (
                 SELECT 1
                   FROM json_each(
                     CASE
                       WHEN json_type(
                              CASE WHEN json_valid(revision.payload_json)
                                   THEN revision.payload_json ELSE '{{}}' END,
                              '$.bundle.entities'
                            ) = 'array'
                       THEN json_extract(
                              CASE WHEN json_valid(revision.payload_json)
                                   THEN revision.payload_json ELSE '{{}}' END,
                              '$.bundle.entities'
                            )
                       ELSE '[]'
                     END
                   ) AS entity
                  WHERE json_extract(
                          CASE WHEN json_valid(entity.value)
                               THEN entity.value ELSE '{{}}' END,
                          '$.entityId'
                        ) = ?7
               )
           AND (
                 ?8 IS NULL
                 OR EXISTS (
                      SELECT 1
                        FROM json_each(
                          CASE
                            WHEN json_type(
                                   CASE WHEN json_valid(revision.payload_json)
                                        THEN revision.payload_json ELSE '{{}}' END,
                                   '$.bundle.relations'
                                 ) = 'array'
                            THEN json_extract(
                                   CASE WHEN json_valid(revision.payload_json)
                                        THEN revision.payload_json ELSE '{{}}' END,
                                   '$.bundle.relations'
                                 )
                            ELSE '[]'
                          END
                        ) AS relation
                       WHERE json_extract(
                               CASE WHEN json_valid(relation.value)
                                    THEN relation.value ELSE '{{}}' END,
                               '$.edgeId'
                             ) = ?8
                         AND (
                           json_extract(
                             CASE WHEN json_valid(relation.value)
                                  THEN relation.value ELSE '{{}}' END,
                             '$.fromEntityId'
                           ) = ?7
                           OR json_extract(
                             CASE WHEN json_valid(relation.value)
                                  THEN relation.value ELSE '{{}}' END,
                             '$.toEntityId'
                           ) = ?7
                         )
                    )
               )
           AND {REVIEW_RESUMABLE_RUN_PREDICATE_SQL}
         ORDER BY julianday(COALESCE(r.completed_at, r.started_at, r.created_at)) DESC,
                  COALESCE(r.completed_at, r.started_at, r.created_at) DESC,
                  r.id DESC,
                  ps.created_at DESC,
                  ps.id DESC
         LIMIT 1
        "#,
    );
    conn.query_row(
        &sql,
        params![
            project_id,
            NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            NIR1_ENTITY_RELATION_SET_KIND,
            NIR1_ENTITY_RELATION_PROPOSAL_KIND,
            NIR1_ENTITY_RELATION_REVISION_ORIGIN,
            ENTITY_RELATION_PRODUCER,
            entity_id,
            relation_id,
        ],
        |row| {
            Ok(Nir1EntityRelationRevisionRestoreMatch {
                run_id: row.get(0)?,
                revision_id: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn read_typed_revision_core(
    conn: &Connection,
    project_id: &str,
    revision_id: &str,
    allow_draft: bool,
) -> anyhow::Result<Nir1EntityRelationRevisionCurrentRead> {
    if conn.is_autocommit() {
        anyhow::bail!("NIR1_ENTITY_RELATION_REQUIRES_READ_TRANSACTION");
    }
    if project_id.trim().is_empty() || revision_id.trim().is_empty() {
        anyhow::bail!("NIR1_ENTITY_RELATION_INVALID_READ_REQUEST");
    }
    let row: Option<TypedRevisionCoreRow> = conn
        .query_row(
            "SELECT proposal_set.id, proposal_set.run_id, proposal.id,
                    proposal.current_revision_id, proposal.status,
                    revision.origin_kind, revision.payload_json,
                    revision.reconciliation_envelope_json,
                    revision.reconciliation_envelope_digest,
                    revision.created_at
               FROM narrative_proposal_revisions revision
               JOIN narrative_proposals proposal
                 ON proposal.id = revision.proposal_id
               JOIN narrative_proposal_sets proposal_set
                 ON proposal_set.id = proposal.proposal_set_id
               JOIN narrative_extraction_runs extraction_run
                 ON extraction_run.id = proposal_set.run_id
                AND extraction_run.project_id = proposal_set.project_id
              WHERE revision.id = ?1
                AND proposal_set.project_id = ?2
                AND proposal_set.set_kind = ?3
                AND extraction_run.surface_path_id = ?4",
            params![
                revision_id,
                project_id,
                NIR1_ENTITY_RELATION_SET_KIND,
                NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            ],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                ))
            },
        )
        .optional()?;
    let Some((
        proposal_set_id,
        run_id,
        proposal_id,
        current_revision_id,
        status,
        origin,
        payload_json,
        envelope_json,
        envelope_digest,
        revision_created_at,
    )) = row
    else {
        return Ok(unavailable("revision-not-found"));
    };
    if current_revision_id != revision_id {
        return Ok(unavailable("revision-not-current"));
    }
    if origin != NIR1_ENTITY_RELATION_REVISION_ORIGIN {
        return Ok(unavailable("revision-kind-mismatch"));
    }
    if status != "approved" && !(allow_draft && status == "unreviewed") {
        return Ok(unavailable("revision-not-human-approved"));
    }
    // `created_at` is the only logical ordering field in the existing
    // Decision authority. Never break a same-millisecond tie with UUID or
    // SQLite rowid order: if the latest timestamp is ambiguous, fail closed
    // until a new explicit Decision is recorded at a distinct instant.
    let latest_decision_at: Option<String> = conn
        .query_row(
            "SELECT MAX(created_at)
               FROM narrative_proposal_decisions
              WHERE proposal_id = ?1 AND revision_id = ?2",
            params![proposal_id, revision_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let decision: Option<(String, String, String)> = if let Some(created_at) = latest_decision_at {
        let latest_count: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM narrative_proposal_decisions
              WHERE proposal_id = ?1 AND revision_id = ?2 AND created_at = ?3",
            params![proposal_id, revision_id, created_at],
            |row| row.get(0),
        )?;
        if latest_count != 1 {
            return Ok(unavailable("revision-decision-ambiguous"));
        }
        conn.query_row(
            "SELECT decision, actor_kind, actor_id
               FROM narrative_proposal_decisions
              WHERE proposal_id = ?1 AND revision_id = ?2 AND created_at = ?3",
            params![proposal_id, revision_id, created_at],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
    } else {
        None
    };
    let human_approved = status == "approved"
        && decision.as_ref()
            == Some(&(
                "approved".to_owned(),
                "human".to_owned(),
                "electron:human-review".to_owned(),
            ));
    if !human_approved && (!allow_draft || status != "unreviewed" || decision.is_some()) {
        return Ok(unavailable("revision-not-human-approved"));
    }
    // Epoch rotation is an irreversible invalidation boundary. Even if an
    // old Freshness row is rebuilt in place and the old decision remains in
    // the ledger, the old Run cannot qualify this Revision after restore.
    if !typed_run_matches_current_epoch(conn, project_id, &run_id)? {
        return Ok(unavailable("revision-restore-invalidated"));
    }

    let payload: StoredNir1EntityRelationPayload = match serde_json::from_str(&payload_json) {
        Ok(payload) => payload,
        Err(_) => return Ok(unavailable("revision-payload-invalid")),
    };
    if payload.schema_version != 1
        || payload.kind != NIR1_ENTITY_RELATION_PROPOSAL_KIND
        || payload.producer != ENTITY_RELATION_PRODUCER
        || payload.project_id != project_id
        || payload.revision_id != revision_id
        || payload.bundle.project_id != project_id
        || payload.bundle.revision_id != revision_id
    {
        return Ok(unavailable("revision-payload-binding-invalid"));
    }
    let envelope_json = match envelope_json {
        Some(envelope_json) => envelope_json,
        None => return Ok(unavailable("canonical-freshness-unavailable")),
    };
    let envelope: Value = match serde_json::from_str(&envelope_json) {
        Ok(envelope) => envelope,
        Err(_) => return Ok(unavailable("revision-envelope-invalid")),
    };
    if validate_entity_relation_revision_envelope_v2(&envelope).is_err()
        || envelope
            .as_object()
            .is_none_or(|object| validate_v2_nested_digest_fields(object).is_err())
    {
        return Ok(unavailable("revision-envelope-invalid"));
    }
    let expected_envelope_digest = canonical_json_digest(&envelope)?;
    if envelope_digest.as_deref() != Some(expected_envelope_digest.as_str()) {
        return Ok(unavailable("revision-envelope-invalid"));
    }
    let payload_value = serde_json::to_value(&payload)?;
    let bundle_digest = canonical_json_digest(&serde_json::to_value(&payload.bundle)?)?;
    let payload_digest = canonical_json_digest(&payload_value)?;
    if envelope.pointer("/assertion/payload/bundleDigest")
        != Some(&Value::String(bundle_digest.clone()))
        || envelope.pointer("/assertion/payload/revisionId")
            != Some(&Value::String(revision_id.to_owned()))
        || envelope.pointer("/projectionBinding/proposalPayloadDigest")
            != Some(&Value::String(payload_digest))
    {
        return Ok(unavailable("revision-payload-binding-invalid"));
    }
    let material_basis: MaterialBasis = match envelope
        .get("effectiveMaterialBasis")
        .cloned()
        .map(serde_json::from_value)
    {
        Some(Ok(material)) => material,
        _ => return Ok(unavailable("revision-envelope-invalid")),
    };
    if validate_entity_relation_bundle(&payload.bundle).is_err()
        || validate_live_sources(conn, project_id, &payload.bundle).is_err()
    {
        return Ok(unavailable("source-revision-changed"));
    }
    let expected_material =
        match build_typed_material_basis(conn, project_id, &payload.bundle, &revision_created_at) {
            Ok(material) => material,
            Err(_) => return Ok(unavailable("revision-material-mismatch")),
        };
    if expected_material != material_basis {
        return Ok(unavailable("revision-material-mismatch"));
    }
    if validate_typed_persisted_material(conn, project_id, &run_id, revision_id, &expected_material)
        .is_err()
    {
        return Ok(unavailable("revision-material-authority-mismatch"));
    }
    let freshness = match read_typed_canonical_freshness(
        conn,
        project_id,
        &run_id,
        revision_id,
        &expected_material,
    )? {
        Some(snapshot) => snapshot,
        None => return Ok(unavailable("canonical-freshness-unavailable")),
    };
    let revision = Box::new(Nir1EntityRelationRevision {
        project_id: project_id.into(),
        run_id,
        proposal_set_id,
        proposal_id,
        revision_id: revision_id.into(),
        bundle_digest,
        eligibility_source: ENTITY_RELATION_SOURCE_KIND,
        index_key: ENTITY_RELATION_INDEX_KEY,
        material_basis,
        canonical_freshness: freshness,
        bundle: payload.bundle,
    });
    if human_approved {
        Ok(Nir1EntityRelationRevisionCurrentRead::Available(revision))
    } else {
        Ok(Nir1EntityRelationRevisionCurrentRead::Draft(revision))
    }
}

fn unavailable(reason: &str) -> Nir1EntityRelationRevisionCurrentRead {
    Nir1EntityRelationRevisionCurrentRead::Unavailable {
        reason: reason.into(),
    }
}

/// Bind the typed input to the real current Codex/Relation rows. This is a
/// source observation, not a new authority: a later edit makes cold reopen
/// unavailable until a new immutable typed Revision is reviewed.
fn validate_live_sources(
    conn: &Connection,
    project_id: &str,
    bundle: &EntityRelationBundle,
) -> anyhow::Result<()> {
    let authority = load_live_project_scope_authority(
        conn,
        project_id,
        &format!("project:scope-authority:{project_id}"),
    )?;
    for entity in &bundle.entities {
        let current: Option<(String, String, Option<String>, String)> = conn
            .query_row(
                "SELECT type, name, summary, updated_at
                   FROM codex_entries
                  WHERE id = ?1 AND project_id = ?2
                    AND context_mode NOT IN ('hidden', 'suppress')",
                params![entity.entity_id, project_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((entity_type, name, summary, updated_at)) = current else {
            anyhow::bail!(
                "NIR1_ENTITY_SOURCE_MISSING: entity '{}' is not a visible project Codex entry",
                entity.entity_id
            );
        };
        anyhow::ensure!(
            entity.entity_type == entity_type,
            "NIR1_ENTITY_TYPE_STALE: entity '{}' type does not match current Codex entry",
            entity.entity_id
        );
        anyhow::ensure!(
            entity.label == name,
            "NIR1_ENTITY_LABEL_STALE: entity '{}' label does not match current Codex entry",
            entity.entity_id
        );
        let expected = format!("codex:{}@{}", entity.entity_id, updated_at);
        anyhow::ensure!(
            entity.source_token == expected,
            "NIR1_ENTITY_SOURCE_STALE: entity '{}' source token does not match current Codex revision",
            entity.entity_id
        );
        validate_scope_binding(conn, project_id, &entity.scope, &authority)?;
        let canonical_text = summary
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| name.clone());
        for evidence in &entity.evidence {
            anyhow::ensure!(
                evidence.source_ref == format!("codex:{}", entity.entity_id),
                "NIR1_ENTITY_EVIDENCE_SOURCE_MISMATCH: Evidence '{}' is not bound to its Entity",
                evidence.evidence_id
            );
            anyhow::ensure!(
                exact_utf16_quote(
                    &canonical_text,
                    &evidence.quote,
                    evidence.start_utf16,
                    evidence.end_utf16,
                ),
                "NIR1_ENTITY_EVIDENCE_ANCHOR_MISMATCH: Evidence '{}' does not match the current canonical Codex text",
                evidence.evidence_id
            );
        }
    }
    for relation in &bundle.relations {
        let current: Option<(String, String, String, String, i64, String)> = conn
            .query_row(
                "SELECT from_codex_id, to_codex_id, relation_type, directionality,
                        version, updated_at
                   FROM codex_relations
                  WHERE id = ?1 AND project_id = ?2",
                params![relation.edge_id, project_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((from_id, to_id, relation_type, directionality, version, updated_at)) = current
        else {
            anyhow::bail!(
                "NIR1_RELATION_SOURCE_MISSING: relation '{}' is not a project Relation",
                relation.edge_id
            );
        };
        anyhow::ensure!(
            relation.from_entity_id == from_id
                && relation.to_entity_id == to_id
                && relation.relation_type == relation_type,
            "NIR1_RELATION_ENDPOINT_STALE: relation '{}' no longer matches its endpoints/type",
            relation.edge_id
        );
        anyhow::ensure!(
            relation.directionality == directionality,
            "NIR1_RELATION_SOURCE_STALE: relation '{}' directionality changed",
            relation.edge_id
        );
        let expected = format!("v{}@{}:relation:{}", version, updated_at, relation.edge_id);
        anyhow::ensure!(
            relation.source_token == expected,
            "NIR1_RELATION_SOURCE_STALE: relation '{}' source token does not match current Relation revision",
            relation.edge_id
        );
    }
    Ok(())
}

fn validate_scope_binding(
    conn: &Connection,
    project_id: &str,
    scope: &ScopeBinding,
    authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        authority.project_id == project_id,
        "NIR1_SCOPE_PROJECT_MISMATCH: live Scope authority belongs to another project"
    );
    anyhow::ensure!(
        scope.authority_revision == authority.source.revision_token,
        "NIR1_SCOPE_AUTHORITY_STALE: Scope binding does not match the current project Scope authority revision"
    );

    validate_scope_value(&scope.reading, "reading", authority)?;
    validate_scope_value(&scope.story, "story", authority)?;
    validate_scope_value(&scope.auto, "auto", authority)?;
    anyhow::ensure!(
        authority
            .scope_registry
            .reserved_audience_refs
            .iter()
            .any(|audience| audience == &scope.reveal),
        "NIR1_SCOPE_REVEAL_UNAVAILABLE: reveal audience is not reserved by the current Scope authority"
    );
    if let Some(pov) = scope.pov.as_deref() {
        let visible_pov = conn
            .query_row(
                "SELECT 1
                   FROM codex_entries
                  WHERE id = ?1 AND project_id = ?2
                    AND context_mode NOT IN ('hidden', 'suppress')",
                params![pov, project_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        anyhow::ensure!(
            visible_pov,
            "NIR1_SCOPE_POV_UNAVAILABLE: POV '{}' is not a visible project Codex entry",
            pov
        );
    }
    Ok(())
}

fn validate_scope_value(
    value: &ScopeValue,
    field: &str,
    authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
) -> anyhow::Result<()> {
    let ScopeValue::Exact { value } = value else {
        return Ok(());
    };
    let known = authority.mappings.iter().any(|mapping| {
        if field == "reading" {
            mapping.scene_ref == *value || mapping.reading_order_ref == *value
        } else if field == "story" {
            mapping.story_time_ref == *value
                && matches!(
                    &mapping.story_time_order,
                    NarrativeScopeAuthorityStoryTimeOrderV2::Resolved { .. }
                )
        } else {
            mapping.scene_ref == *value
                || mapping.reading_order_ref == *value
                || (mapping.story_time_ref == *value
                    && matches!(
                        &mapping.story_time_order,
                        NarrativeScopeAuthorityStoryTimeOrderV2::Resolved { .. }
                    ))
        }
    });
    anyhow::ensure!(
        known,
        "NIR1_SCOPE_REFERENCE_UNAVAILABLE: {field} Scope reference '{}' is not resolved by the current project Scope authority",
        value
    );
    Ok(())
}

fn exact_utf16_quote(text: &str, quote: &str, start: usize, end: usize) -> bool {
    if quote.is_empty() || start >= end || end - start != quote.encode_utf16().count() {
        return false;
    }
    let units = text.encode_utf16().collect::<Vec<_>>();
    units
        .get(start..end)
        .is_some_and(|range| String::from_utf16(range).is_ok_and(|value| value == quote))
}

fn validate_prepare_ids(ids: &[String], field: &str) -> anyhow::Result<()> {
    let mut seen = HashSet::with_capacity(ids.len());
    for value in ids {
        anyhow::ensure!(
            !value.trim().is_empty() && value.trim() == value,
            "NIR1_ENTITY_RELATION_PREPARE_INVALID: {field} contains an empty or padded identity"
        );
        anyhow::ensure!(
            seen.insert(value),
            "NIR1_ENTITY_RELATION_PREPARE_INVALID: {field} contains a duplicate identity"
        );
    }
    Ok(())
}

/// Resolve a review bundle from live Native rows. Renderer callers provide
/// only identities; labels, source tokens, summary/name Evidence, Relation
/// endpoints and the Scope binding are all derived under the same DB snapshot
/// that persists the typed Revision.
fn build_live_typed_bundle(
    conn: &Connection,
    request: &Nir1EntityRelationRevisionPrepareRequest,
) -> anyhow::Result<EntityRelationBundle> {
    if request.project_id.trim().is_empty()
        || request.project_id.trim() != request.project_id
        || request.scene_id.trim().is_empty()
        || request.scene_id.trim() != request.scene_id
    {
        anyhow::bail!("NIR1_ENTITY_RELATION_PREPARE_INVALID: project or scene identity");
    }
    validate_prepare_ids(&request.entity_ids, "entityIds")?;
    validate_prepare_ids(&request.relation_ids, "relationIds")?;
    if let Some(proposal_key) = request.proposal_key.as_deref() {
        anyhow::ensure!(
            !proposal_key.trim().is_empty()
                && proposal_key.trim() == proposal_key
                && proposal_key.len() <= 256,
            "NIR1_ENTITY_RELATION_PREPARE_INVALID: proposalKey"
        );
    }
    anyhow::ensure!(
        !request.entity_ids.is_empty() || !request.relation_ids.is_empty(),
        "NIR1_ENTITY_RELATION_PREPARE_EMPTY: at least one Entity or Relation is required"
    );
    anyhow::ensure!(
        request.entity_ids.len() + request.relation_ids.len() <= narrative_nir1::MAX_GRAPH_RECORDS,
        "NIR1_ENTITY_RELATION_PREPARE_TOO_LARGE"
    );

    let authority = load_live_project_scope_authority(
        conn,
        &request.project_id,
        &format!("project:scope-authority:{}", request.project_id),
    )?;
    let scene_ref = format!("scene:{}", request.scene_id);
    anyhow::ensure!(
        authority
            .mappings
            .iter()
            .any(|mapping| mapping.scene_ref == scene_ref),
        "NIR1_ENTITY_RELATION_PREPARE_SCENE_UNAVAILABLE: scene is not present in the current Scope authority"
    );
    let reveal = authority
        .scope_registry
        .reserved_audience_refs
        .first()
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("NIR1_ENTITY_RELATION_PREPARE_SCOPE_UNAVAILABLE"))?;
    let scope = ScopeBinding {
        reading: ScopeValue::Exact { value: scene_ref },
        story: ScopeValue::Any {
            purpose: Some("nir1-entity-relation-review".into()),
        },
        auto: ScopeValue::NotApplicable {
            reason: "typed-review-input".into(),
        },
        phase: "draft".into(),
        reveal,
        pov: None,
        authority_revision: authority.source.revision_token.clone(),
    };

    let mut relation_rows = Vec::with_capacity(request.relation_ids.len());
    let mut entity_ids = request.entity_ids.iter().cloned().collect::<HashSet<_>>();
    for relation_id in &request.relation_ids {
        let row: Option<(String, String, String, String, i64, String)> = conn
            .query_row(
                "SELECT from_codex_id, to_codex_id, relation_type, directionality,
                        version, updated_at
                   FROM codex_relations
                  WHERE id = ?1 AND project_id = ?2",
                params![relation_id, request.project_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            from_entity_id,
            to_entity_id,
            relation_type,
            directionality,
            version,
            updated_at,
        )) = row
        else {
            anyhow::bail!(
                "NIR1_ENTITY_RELATION_PREPARE_RELATION_MISSING: relation '{relation_id}'"
            );
        };
        anyhow::ensure!(
            directionality == "directed" || directionality == "symmetric",
            "NIR1_ENTITY_RELATION_PREPARE_RELATION_INVALID: relation '{relation_id}' directionality"
        );
        entity_ids.insert(from_entity_id.clone());
        entity_ids.insert(to_entity_id.clone());
        relation_rows.push((
            relation_id.clone(),
            from_entity_id,
            to_entity_id,
            relation_type,
            directionality,
            version,
            updated_at,
        ));
    }
    anyhow::ensure!(
        entity_ids.len() + relation_rows.len() <= narrative_nir1::MAX_GRAPH_RECORDS,
        "NIR1_ENTITY_RELATION_PREPARE_TOO_LARGE"
    );

    let mut sorted_entity_ids = entity_ids.into_iter().collect::<Vec<_>>();
    sorted_entity_ids.sort();
    let mut entities = Vec::with_capacity(sorted_entity_ids.len());
    for entity_id in sorted_entity_ids {
        let row: Option<(String, String, Option<String>, String)> = conn
            .query_row(
                "SELECT type, name, summary, updated_at
                   FROM codex_entries
                  WHERE id = ?1 AND project_id = ?2
                    AND context_mode NOT IN ('hidden', 'suppress')",
                params![entity_id, request.project_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((entity_type, name, summary, updated_at)) = row else {
            anyhow::bail!("NIR1_ENTITY_RELATION_PREPARE_ENTITY_MISSING: entity '{entity_id}'");
        };
        let quote = summary
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| name.clone());
        let evidence_id = format!("nir1:evidence:codex:{entity_id}");
        entities.push(EntityInput {
            entity_id: entity_id.clone(),
            entity_type,
            label: name,
            source_token: format!("codex:{entity_id}@{updated_at}"),
            scope: scope.clone(),
            evidence: vec![EvidenceInput {
                evidence_id,
                source_ref: format!("codex:{entity_id}"),
                start_utf16: 0,
                end_utf16: quote.encode_utf16().count(),
                quote,
            }],
        });
    }
    let evidence_by_entity = entities
        .iter()
        .map(|entity| {
            (
                entity.entity_id.clone(),
                entity.evidence[0].evidence_id.clone(),
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    relation_rows.sort_by(|left, right| left.0.cmp(&right.0));
    let relations = relation_rows
        .into_iter()
        .map(
            |(
                edge_id,
                from_entity_id,
                to_entity_id,
                relation_type,
                directionality,
                version,
                updated_at,
            )| {
                let from_evidence = evidence_by_entity
                    .get(&from_entity_id)
                    .cloned()
                    .ok_or_else(|| {
                        anyhow::anyhow!("NIR1_ENTITY_RELATION_PREPARE_EVIDENCE_MISSING")
                    })?;
                let to_evidence =
                    evidence_by_entity
                        .get(&to_entity_id)
                        .cloned()
                        .ok_or_else(|| {
                            anyhow::anyhow!("NIR1_ENTITY_RELATION_PREPARE_EVIDENCE_MISSING")
                        })?;
                Ok(GraphEdgeInput {
                    edge_id: edge_id.clone(),
                    from_entity_id,
                    to_entity_id,
                    relation_type,
                    directionality,
                    source_token: format!("v{version}@{updated_at}:relation:{edge_id}"),
                    evidence_ids: vec![from_evidence, to_evidence],
                })
            },
        )
        .collect::<anyhow::Result<Vec<_>>>()?;

    let bundle = EntityRelationBundle {
        project_id: request.project_id.clone(),
        revision_id: "native-preparation-placeholder".into(),
        producer: ENTITY_RELATION_PRODUCER.into(),
        entities,
        relations,
    };
    validate_entity_relation_bundle(&bundle)
        .map_err(|error| anyhow::anyhow!("NIR1_ENTITY_RELATION_PREPARE_BUNDLE_INVALID: {error}"))?;
    Ok(bundle)
}

fn create_typed_run_in_tx(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    entity_ids: &[String],
    relation_ids: &[String],
) -> anyhow::Result<String> {
    let semantic_epoch_id = current_c2zc_run_epoch_in_tx(conn, project_id)?
        .ok_or_else(|| anyhow::anyhow!("NIR1_ENTITY_RELATION_CURRENT_EPOCH_UNAVAILABLE"))?;
    let run_id = Uuid::new_v4().to_string();
    let lifecycle_at = next_run_lifecycle_timestamp_in_tx(conn, project_id)?;
    let scope_json = serde_json::to_string(&json!({
        "sceneId": scene_id,
        "entityIds": entity_ids,
        "relationIds": relation_ids,
    }))?;
    let spec_json = serde_json::to_string(&json!({
        "kind": "nir1.entity-relation.review@1",
        "version": 1,
    }))?;
    let spec_digest = canonical_json_digest(&json!({
        "kind": "nir1.entity-relation.review@1",
        "version": 1,
    }))?;
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             snapshot_digest, catalog_digest, registry_digest, semantic_epoch_id,
             status, coverage_json, created_at, started_at, version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, ?7,
                 'pending', '{}', ?8, NULL, 0)",
        params![
            run_id,
            project_id,
            NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
            scope_json,
            spec_json,
            spec_digest,
            semantic_epoch_id,
            lifecycle_at,
        ],
    )?;
    Ok(run_id)
}

#[cfg(test)]
mod tests {
    use super::{
        create_nir1_entity_relation_revision, find_nir1_entity_relation_revision_run,
        prepare_nir1_entity_relation_revision, read_nir1_entity_relation_revision,
        read_nir1_entity_relation_revision_current,
        read_nir1_entity_relation_revision_current_for_revision,
        Nir1EntityRelationRevisionCurrentRead, Nir1EntityRelationRevisionPrepareRequest,
        Nir1EntityRelationRevisionRead, Nir1EntityRelationRevisionRequest,
        NIR1_ENTITY_RELATION_DECISION_LOCKED, NIR1_ENTITY_RELATION_PROPOSAL_KIND,
        NIR1_ENTITY_RELATION_REVISION_ORIGIN, NIR1_ENTITY_RELATION_SET_KIND,
    };
    use crate::narrative_extraction::change_feed::get_changes_since;
    use crate::narrative_extraction::incremental_freshness::{
        run_incremental_freshness_cycle, IncrementalFreshnessCycleOutcome,
    };
    use crate::narrative_extraction::material_membership::{
        read_revision_material_membership, MaterialMembershipRead,
    };
    use crate::narrative_extraction::revision_eligibility::RevisionFreshnessReason;
    use crate::narrative_extraction::{
        narrative_extraction_append_human_decision, narrative_extraction_append_revision,
        narrative_extraction_create_run, narrative_extraction_save_proposal_set,
        AppendDecisionPayload, AppendRevisionPayload, CreateRunPayload, SaveProposalSetPayload,
    };
    use crate::test_support::fresh_migrated_memory;
    use crate::Database;
    use grimodex_core::narrative_nir1::{
        EntityInput, EntityRelationBundle, EvidenceInput, GraphEdgeInput, ScopeBinding, ScopeValue,
    };
    use rusqlite::params;
    use serde_json::json;

    fn valid_bundle(project_id: &str, authority_revision: String) -> EntityRelationBundle {
        EntityRelationBundle {
            project_id: project_id.to_owned(),
            revision_id: "renderer-must-not-own-this".into(),
            producer: "nir1-reviewed-entity-relation-v1".into(),
            entities: vec![
                EntityInput {
                    entity_id: "nir1-alice".into(),
                    entity_type: "character".into(),
                    label: "Alice".into(),
                    source_token: "codex:nir1-alice@2026-09-12T00:00:00Z".into(),
                    scope: scope(authority_revision.clone()),
                    evidence: vec![EvidenceInput {
                        evidence_id: "nir1-evidence-alice".into(),
                        source_ref: "codex:nir1-alice".into(),
                        start_utf16: 0,
                        end_utf16: 5,
                        quote: "Alice".into(),
                    }],
                },
                EntityInput {
                    entity_id: "nir1-bob".into(),
                    entity_type: "character".into(),
                    label: "Bob".into(),
                    source_token: "codex:nir1-bob@2026-09-12T00:00:00Z".into(),
                    scope: scope(authority_revision),
                    evidence: vec![EvidenceInput {
                        evidence_id: "nir1-evidence-bob".into(),
                        source_ref: "codex:nir1-bob".into(),
                        start_utf16: 0,
                        end_utf16: 3,
                        quote: "Bob".into(),
                    }],
                },
            ],
            relations: vec![GraphEdgeInput {
                edge_id: "nir1-edge".into(),
                from_entity_id: "nir1-alice".into(),
                to_entity_id: "nir1-bob".into(),
                relation_type: "knows".into(),
                directionality: "directed".into(),
                source_token: "v1@2026-09-12T00:00:00Z:relation:nir1-edge".into(),
                evidence_ids: vec!["nir1-evidence-alice".into(), "nir1-evidence-bob".into()],
            }],
        }
    }

    fn scope(authority_revision: String) -> ScopeBinding {
        ScopeBinding {
            reading: ScopeValue::Exact {
                value: "scene:nir1".into(),
            },
            story: ScopeValue::Any {
                purpose: Some("nir1-review".into()),
            },
            auto: ScopeValue::NotApplicable {
                reason: "review-input".into(),
            },
            phase: "draft".into(),
            reveal: "reader".into(),
            pov: None,
            authority_revision,
        }
    }

    fn seed_run_and_catalog(db: &crate::Database) -> anyhow::Result<()> {
        db.with_conn(|conn| {
            super::super::create_epoch_in_tx(conn, "default-project", "initial", None)
        })?;
        db.with_conn(|conn| {
            crate::Database::record_c2zc_cutover_marker(conn, "2026-09-15T00:00:00.000Z")
        })?;
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_change_cursors
                    (project_id, consumer_id, acknowledged_through_sequence,
                     last_error, updated_at)
                 VALUES (?1, ?2, 0, NULL, '2026-09-15T00:00:00.000Z')",
                params![
                    "default-project",
                    super::super::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID
                ],
            )?;
            Ok(())
        })?;
        crate::narrative_extraction::narrative_extraction_create_run(
            db,
            CreateRunPayload {
                run_id: Some("nir1-run".into()),
                project_id: "default-project".into(),
                surface_path_id: super::NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH.into(),
                scope_json: json!({}),
                spec_json: json!({}),
                spec_digest: "spec-nir1".into(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![],
            },
        )?;
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, content, sort_order)
                 VALUES ('nir1', 'default-project', 'scene', 'NIR1', '{}', 'a0')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                 VALUES ('nir1-alice', 'default-project', 'character', 'Alice', 'Alice', '2026-09-12T00:00:00Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name, summary, updated_at)
                 VALUES ('nir1-bob', 'default-project', 'character', 'Bob', 'Bob', '2026-09-12T00:00:00Z')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_relations
                    (id, project_id, from_codex_id, to_codex_id, relation_type,
                     directionality, version, updated_at)
                 VALUES ('nir1-edge', 'default-project', 'nir1-alice', 'nir1-bob',
                         'knows', 'directed', 1, '2026-09-12T00:00:00Z')",
                [],
            )?;
            Ok(())
        })
    }

    fn request(db: &crate::Database) -> Nir1EntityRelationRevisionRequest {
        let authority_revision = db
            .with_read_transaction(|conn| {
                super::load_live_project_scope_authority(
                    conn,
                    "default-project",
                    "project:scope-authority:default-project",
                )
            })
            .expect("live fixture Scope authority");
        Nir1EntityRelationRevisionRequest {
            run_id: "nir1-run".into(),
            project_id: "default-project".into(),
            proposal_key: "nir1:review:1".into(),
            bundle: valid_bundle("default-project", authority_revision.source.revision_token),
        }
    }

    fn request_for_run(
        db: &crate::Database,
        run_id: &str,
        proposal_key: &str,
    ) -> Nir1EntityRelationRevisionRequest {
        let mut request = request(db);
        request.run_id = run_id.to_owned();
        request.proposal_key = proposal_key.to_owned();
        request
    }

    fn create_typed_run(db: &crate::Database, run_id: &str) -> anyhow::Result<()> {
        narrative_extraction_create_run(
            db,
            CreateRunPayload {
                run_id: Some(run_id.to_owned()),
                project_id: "default-project".into(),
                surface_path_id: super::NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH.into(),
                scope_json: json!({}),
                spec_json: json!({}),
                spec_digest: "spec-nir1-recovery".into(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![],
            },
        )?;
        Ok(())
    }

    fn approve_typed_revision(
        db: &crate::Database,
        run_id: &str,
        created: &serde_json::Value,
    ) -> anyhow::Result<()> {
        narrative_extraction_append_human_decision(
            db,
            AppendDecisionPayload {
                run_id: run_id.into(),
                project_id: "default-project".into(),
                proposal_id: created["proposalId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("created typed proposal id missing"))?
                    .into(),
                revision_id: created["revisionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("created typed revision id missing"))?
                    .into(),
                decision: "approved".into(),
                decision_json: None,
                created_by: Some("renderer-reviewer".into()),
            },
        )?;
        Ok(())
    }

    fn append_typed_decision(
        db: &crate::Database,
        run_id: &str,
        created: &serde_json::Value,
        decision: &str,
    ) -> anyhow::Result<serde_json::Value> {
        narrative_extraction_append_human_decision(
            db,
            AppendDecisionPayload {
                run_id: run_id.into(),
                project_id: "default-project".into(),
                proposal_id: created["proposalId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("typed proposal id missing"))?
                    .into(),
                revision_id: created["revisionId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("typed revision id missing"))?
                    .into(),
                decision: decision.into(),
                decision_json: None,
                created_by: Some("renderer-reviewer".into()),
            },
        )
    }

    #[test]
    fn typed_entity_relation_product_journey_cold_reopens_only_after_human_approval(
    ) -> anyhow::Result<()> {
        let path =
            std::env::temp_dir().join(format!("grimodex-nir1-a2-{}.sqlite", uuid::Uuid::new_v4()));
        let result = (|| -> anyhow::Result<()> {
            let db = Database::new(&path)?;
            db.migrate()?;
            seed_run_and_catalog(&db)?;
            let created = create_nir1_entity_relation_revision(&db, request(&db))?;
            let revision_id = created["revisionId"].as_str().unwrap().to_owned();
            let proposal_id = created["proposalId"].as_str().unwrap().to_owned();

            let prepared = db.with_read_transaction(|conn| {
                read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
            })?;
            assert!(matches!(
                prepared,
                Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                    if reason == "revision-not-human-approved"
            ));

            narrative_extraction_append_human_decision(
                &db,
                AppendDecisionPayload {
                    run_id: "nir1-run".into(),
                    project_id: "default-project".into(),
                    proposal_id,
                    revision_id: revision_id.clone(),
                    decision: "approved".into(),
                    decision_json: None,
                    created_by: Some("renderer-reviewer".into()),
                },
            )?;
            let approved = db.with_read_transaction(|conn| {
                read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
            })?;
            let approved_digest = match approved {
                Nir1EntityRelationRevisionRead::Available(result) => {
                    assert_eq!(result.bundle.entities[0].evidence[0].quote, "Alice");
                    assert_eq!(result.material_basis.source_basis.len(), 4);
                    result.bundle_digest
                }
                Nir1EntityRelationRevisionRead::Unavailable { reason } => {
                    anyhow::bail!("approved typed journey row unavailable: {reason}")
                }
            };
            drop(db);

            let reopened_db = Database::new(&path)?;
            reopened_db.migrate()?;
            let cold = reopened_db.with_read_transaction(|conn| {
                read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
            })?;
            match cold {
                Nir1EntityRelationRevisionRead::Available(result) => {
                    assert_eq!(result.bundle_digest, approved_digest);
                    assert_eq!(result.revision_id, revision_id);
                    assert_eq!(result.bundle.entities.len(), 2);
                    assert_eq!(result.bundle.relations.len(), 1);
                    assert_eq!(result.canonical_freshness.edge_count, 4);
                }
                Nir1EntityRelationRevisionRead::Unavailable { reason } => {
                    anyhow::bail!("cold typed journey row unavailable: {reason}")
                }
            }
            Ok(())
        })();
        for suffix in ["", "-wal", "-shm"] {
            let mut candidate = path.as_os_str().to_owned();
            candidate.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(candidate));
        }
        result
    }

    #[test]
    fn native_prepare_creates_a_dedicated_draft_and_current_reader_reopens_it() -> anyhow::Result<()>
    {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let prepared = prepare_nir1_entity_relation_revision(
            &db,
            Nir1EntityRelationRevisionPrepareRequest {
                project_id: "default-project".into(),
                scene_id: "nir1".into(),
                proposal_key: Some("nir1:review:prepared".into()),
                entity_ids: vec!["nir1-alice".into()],
                relation_ids: vec!["nir1-edge".into()],
            },
        )?;
        let prepared = super::nir1_entity_relation_revision_prepare_receipt(prepared)?;
        assert_eq!(prepared["status"], "draft");
        assert!(prepared.get("result").is_none());
        let run_id = prepared["runId"]
            .as_str()
            .expect("Native prepare run id")
            .to_owned();

        let current = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision_current(conn, "default-project", &run_id)
        })?;
        let draft_revision = match current {
            Nir1EntityRelationRevisionCurrentRead::Draft(revision) => {
                assert_eq!(revision.run_id, run_id);
                assert_eq!(revision.bundle.entities.len(), 2);
                revision
            }
            Nir1EntityRelationRevisionCurrentRead::Available(_) => {
                anyhow::bail!("prepare must not approve its own Revision")
            }
            Nir1EntityRelationRevisionCurrentRead::Unavailable { reason } => {
                anyhow::bail!("prepared typed draft unavailable: {reason}")
            }
        };
        approve_typed_revision(
            &db,
            &run_id,
            &json!({
                "proposalId": draft_revision.proposal_id,
                "revisionId": draft_revision.revision_id,
            }),
        )?;
        let approved = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision_current(conn, "default-project", &run_id)
        })?;
        assert!(matches!(
            approved,
            Nir1EntityRelationRevisionCurrentRead::Available(_)
        ));
        Ok(())
    }

    #[test]
    fn target_lookup_filters_before_newer_unrelated_runs_and_keeps_stale_target_bound(
    ) -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let target = prepare_nir1_entity_relation_revision(
            &db,
            Nir1EntityRelationRevisionPrepareRequest {
                project_id: "default-project".into(),
                scene_id: "nir1".into(),
                proposal_key: Some("nir1:lookup:target".into()),
                entity_ids: vec!["nir1-alice".into()],
                relation_ids: vec!["nir1-edge".into()],
            },
        )?;
        let target_run = target["runId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("target typed run id missing"))?
            .to_owned();
        let target_draft = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision_current(conn, "default-project", &target_run)
        })?;
        let (target_proposal_id, target_revision_id) = match target_draft {
            Nir1EntityRelationRevisionCurrentRead::Draft(revision) => {
                (revision.proposal_id.clone(), revision.revision_id.clone())
            }
            other => anyhow::bail!("target typed preparation was not a draft: {other:?}"),
        };
        approve_typed_revision(
            &db,
            &target_run,
            &json!({
                "proposalId": target_proposal_id,
                "revisionId": target_revision_id,
            }),
        )?;

        for index in 0..8 {
            prepare_nir1_entity_relation_revision(
                &db,
                Nir1EntityRelationRevisionPrepareRequest {
                    project_id: "default-project".into(),
                    scene_id: "nir1".into(),
                    proposal_key: Some(format!("nir1:lookup:unrelated-{index}")),
                    entity_ids: vec!["nir1-bob".into()],
                    relation_ids: vec![],
                },
            )?;
        }
        let corrupt = prepare_nir1_entity_relation_revision(
            &db,
            Nir1EntityRelationRevisionPrepareRequest {
                project_id: "default-project".into(),
                scene_id: "nir1".into(),
                proposal_key: Some("nir1:lookup:corrupt-unrelated".into()),
                entity_ids: vec!["nir1-bob".into()],
                relation_ids: vec![],
            },
        )?;
        let corrupt_revision = corrupt["result"]["revisionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("corrupt typed revision id missing"))?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_proposal_revisions
                    SET payload_json = '{not-json'
                  WHERE id = ?1",
                [corrupt_revision],
            )?;
            Ok(())
        })?;
        let malformed_shape = prepare_nir1_entity_relation_revision(
            &db,
            Nir1EntityRelationRevisionPrepareRequest {
                project_id: "default-project".into(),
                scene_id: "nir1".into(),
                proposal_key: Some("nir1:lookup:malformed-shape-unrelated".into()),
                entity_ids: vec!["nir1-bob".into()],
                relation_ids: vec![],
            },
        )?;
        let malformed_shape_revision = malformed_shape["result"]["revisionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("malformed shape revision id missing"))?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_proposal_revisions
                    SET payload_json = ?1
                  WHERE id = ?2",
                params![
                    json!({
                        "schemaVersion": 1,
                        "kind": NIR1_ENTITY_RELATION_PROPOSAL_KIND,
                        "producer": "nir1-reviewed-entity-relation-v1",
                        "projectId": "default-project",
                        "revisionId": malformed_shape_revision,
                        "bundle": {
                            "entities": ["not-json"],
                            "relations": "not-json",
                        },
                    })
                    .to_string(),
                    malformed_shape_revision,
                ],
            )?;
            Ok(())
        })?;

        let found = db.with_read_transaction(|conn| {
            find_nir1_entity_relation_revision_run(
                conn,
                "default-project",
                "nir1-alice",
                Some("nir1-edge"),
            )
        })?;
        let found = found.ok_or_else(|| anyhow::anyhow!("target typed revision not found"))?;
        assert_eq!(found.run_id, target_run);
        let current = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision_current_for_revision(
                conn,
                "default-project",
                &found.revision_id,
            )
        })?;
        assert!(matches!(
            current,
            Nir1EntityRelationRevisionCurrentRead::Available(_)
        ));

        let base_version: i64 = db.with_read_transaction(|conn| {
            conn.query_row(
                "SELECT version FROM codex_entries
                  WHERE id = 'nir1-alice' AND project_id = 'default-project'",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })?;
        super::super::codex_operations::test_agent_codex_update_for_change_feed(
            &db,
            "default-project",
            "nir1-lookup-stale",
            "nir1-alice",
            base_version,
            "Alice changed after target lookup",
        )?;
        let stale_found = db.with_read_transaction(|conn| {
            find_nir1_entity_relation_revision_run(
                conn,
                "default-project",
                "nir1-alice",
                Some("nir1-edge"),
            )
        })?;
        let stale_found =
            stale_found.ok_or_else(|| anyhow::anyhow!("stale target typed revision not found"))?;
        assert_eq!(stale_found.run_id, target_run);
        let stale_current = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision_current_for_revision(
                conn,
                "default-project",
                &stale_found.revision_id,
            )
        })?;
        assert!(matches!(
            stale_current,
            Nir1EntityRelationRevisionCurrentRead::Unavailable { ref reason }
                if reason == "source-revision-changed"
        ));
        Ok(())
    }

    #[test]
    fn target_lookup_keeps_exact_revision_when_newer_typed_set_shares_run() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let a = create_nir1_entity_relation_revision(
            &db,
            request_for_run(&db, "nir1-run", "nir1:lookup:same-run-a"),
        )?;
        let a_revision_id = a["revisionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("A typed revision id missing"))?
            .to_owned();
        approve_typed_revision(&db, "nir1-run", &a)?;

        let mut b_request = request_for_run(&db, "nir1-run", "nir1:lookup:same-run-b");
        b_request
            .bundle
            .entities
            .retain(|entity| entity.entity_id == "nir1-bob");
        b_request.bundle.relations.clear();
        let b = create_nir1_entity_relation_revision(&db, b_request)?;
        let b_revision_id = b["revisionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("B typed revision id missing"))?
            .to_owned();
        approve_typed_revision(&db, "nir1-run", &b)?;

        let a_set_id = a["proposalSetId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("A typed proposal set id missing"))?;
        let b_set_id = b["proposalSetId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("B typed proposal set id missing"))?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_proposal_sets
                    SET created_at = '2026-09-15T00:00:00.001Z'
                  WHERE id = ?1",
                [a_set_id],
            )?;
            conn.execute(
                "UPDATE narrative_proposal_sets
                    SET created_at = '2026-09-15T00:00:00.002Z'
                  WHERE id = ?1",
                [b_set_id],
            )?;
            Ok(())
        })?;

        let generic = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision_current(conn, "default-project", "nir1-run")
        })?;
        match generic {
            Nir1EntityRelationRevisionCurrentRead::Available(revision) => {
                assert_eq!(revision.revision_id, b_revision_id);
            }
            other => anyhow::bail!("newer same-Run typed set was not current: {other:?}"),
        }

        let found = db.with_read_transaction(|conn| {
            find_nir1_entity_relation_revision_run(conn, "default-project", "nir1-alice", None)
        })?;
        let found = found.ok_or_else(|| anyhow::anyhow!("A target typed revision not found"))?;
        assert_eq!(found.run_id, "nir1-run");
        assert_eq!(found.revision_id, a_revision_id);

        let exact = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision_current_for_revision(
                conn,
                "default-project",
                &found.revision_id,
            )
        })?;
        match exact {
            Nir1EntityRelationRevisionCurrentRead::Available(revision) => {
                assert_eq!(revision.revision_id, a_revision_id);
                assert!(revision
                    .bundle
                    .entities
                    .iter()
                    .any(|entity| entity.entity_id == "nir1-alice"));
            }
            other => anyhow::bail!("A target typed revision was not available: {other:?}"),
        }
        Ok(())
    }

    #[test]
    fn target_lookup_prefers_newest_matching_set_within_one_run() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let old = create_nir1_entity_relation_revision(
            &db,
            request_for_run(&db, "nir1-run", "nir1:lookup:same-target-old"),
        )?;
        let old_revision_id = old["revisionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("old target typed revision id missing"))?
            .to_owned();
        append_typed_decision(&db, "nir1-run", &old, "rejected")?;

        let new = create_nir1_entity_relation_revision(
            &db,
            request_for_run(&db, "nir1-run", "nir1:lookup:same-target-new"),
        )?;
        let new_revision_id = new["revisionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("new target typed revision id missing"))?
            .to_owned();
        approve_typed_revision(&db, "nir1-run", &new)?;

        let old_set_id = old["proposalSetId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("old target proposal set id missing"))?;
        let new_set_id = new["proposalSetId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("new target proposal set id missing"))?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_proposal_sets
                    SET created_at = '2026-09-15T00:00:00.001Z'
                  WHERE id = ?1",
                [old_set_id],
            )?;
            conn.execute(
                "UPDATE narrative_proposal_sets
                    SET created_at = '2026-09-15T00:00:00.002Z'
                  WHERE id = ?1",
                [new_set_id],
            )?;
            Ok(())
        })?;

        let found = db.with_read_transaction(|conn| {
            find_nir1_entity_relation_revision_run(conn, "default-project", "nir1-alice", None)
        })?;
        let found = found.ok_or_else(|| anyhow::anyhow!("new target typed revision not found"))?;
        assert_eq!(found.run_id, "nir1-run");
        assert_eq!(found.revision_id, new_revision_id);
        assert_ne!(found.revision_id, old_revision_id);

        let exact = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision_current_for_revision(
                conn,
                "default-project",
                &found.revision_id,
            )
        })?;
        assert!(matches!(
            exact,
            Nir1EntityRelationRevisionCurrentRead::Available(ref revision)
                if revision.revision_id == new_revision_id
        ));
        Ok(())
    }

    #[test]
    fn typed_decisions_are_terminal_after_rejection_or_defer() -> anyhow::Result<()> {
        for first_decision in ["rejected", "deferred"] {
            let db = fresh_migrated_memory()?;
            seed_run_and_catalog(&db)?;
            let created = create_nir1_entity_relation_revision(&db, request(&db))?;
            append_typed_decision(&db, "nir1-run", &created, first_decision)?;

            let replay = append_typed_decision(&db, "nir1-run", &created, "approved")
                .expect_err("a rejected/deferred typed Revision must not be approved later");
            assert!(replay
                .to_string()
                .contains(NIR1_ENTITY_RELATION_DECISION_LOCKED));
            let (status, decision_count): (String, i64) = db.with_read_transaction(|conn| {
                Ok((
                    conn.query_row(
                        "SELECT status FROM narrative_proposals WHERE id = ?1",
                        [created["proposalId"].as_str()],
                        |row| row.get(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM narrative_proposal_decisions
                          WHERE proposal_id = ?1 AND revision_id = ?2",
                        params![
                            created["proposalId"].as_str(),
                            created["revisionId"].as_str()
                        ],
                        |row| row.get(0),
                    )?,
                ))
            })?;
            assert_eq!(status, first_decision);
            assert_eq!(decision_count, 1);
        }

        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let revoked = create_nir1_entity_relation_revision(&db, request(&db))?;
        append_typed_decision(&db, "nir1-run", &revoked, "approved")?;
        append_typed_decision(&db, "nir1-run", &revoked, "rejected")
            .expect("the existing explicit approval cancellation remains supported");
        let replay = append_typed_decision(&db, "nir1-run", &revoked, "approved")
            .expect_err("a revoked typed Revision must not be approved again");
        assert!(replay
            .to_string()
            .contains(NIR1_ENTITY_RELATION_DECISION_LOCKED));

        let new_revision = create_nir1_entity_relation_revision(
            &db,
            request_for_run(&db, "nir1-run", "nir1:review:new-after-revocation"),
        )?;
        append_typed_decision(&db, "nir1-run", &new_revision, "approved")
            .expect("a new immutable Revision remains decidable");
        let reopened = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision_current(conn, "default-project", "nir1-run")
        })?;
        assert!(matches!(
            reopened,
            Nir1EntityRelationRevisionCurrentRead::Available(_)
        ));
        Ok(())
    }

    #[test]
    fn real_codex_update_feed_invalidates_approved_typed_revision_until_incremental_cycle(
    ) -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let revision_id = created["revisionId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("typed revision id missing"))?
            .to_owned();
        let run_id = created["runId"].as_str().unwrap_or("nir1-run").to_owned();
        approve_typed_revision(&db, "nir1-run", &created)?;

        let initial = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision_current(conn, "default-project", &run_id)
        })?;
        assert!(matches!(
            initial,
            Nir1EntityRelationRevisionCurrentRead::Available(_)
        ));
        let initial_freshness: String = db.with_read_transaction(|conn| {
            conn.query_row(
                "SELECT evidence_freshness
                   FROM narrative_consumer_freshness
                  WHERE project_id = 'default-project'
                    AND consumer_kind = 'proposal-revision'
                    AND consumer_key = ?1",
                [&revision_id],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })?;
        assert_eq!(initial_freshness, "fresh");

        let base_version: i64 = db.with_read_transaction(|conn| {
            conn.query_row(
                "SELECT version FROM codex_entries
                  WHERE id = 'nir1-alice' AND project_id = 'default-project'",
                [],
                |row| row.get(0),
            )
            .map_err(Into::into)
        })?;
        super::super::codex_operations::test_agent_codex_update_for_change_feed(
            &db,
            "default-project",
            "nir1-feed-e2e",
            "nir1-alice",
            base_version,
            "Alice after a real Codex mutation",
        )?;

        let feed_events =
            db.with_read_transaction(|conn| get_changes_since(conn, "default-project", 0, 500))?;
        assert!(feed_events.iter().any(|event| {
            event.object_key == json!({"kind": "codex-entry", "entryId": "nir1-alice"})
        }));
        let selected_sources = super::super::incremental_freshness::affected_source_identities(
            "default-project",
            &feed_events,
        )?;
        assert!(selected_sources.contains(&"codex:nir1-alice".to_owned()));
        assert!(selected_sources.contains(&"project:codex-catalog:default-project".to_owned()));

        let immediately_unavailable = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision_current(conn, "default-project", &run_id)
        })?;
        assert!(
            matches!(
                immediately_unavailable,
                Nir1EntityRelationRevisionCurrentRead::Unavailable { .. }
            ),
            "unexpected immediate current read: {immediately_unavailable:?}"
        );
        let pending_feed = db.with_read_transaction(|conn| {
            let edges = super::find_edges_by_consumer(
                conn,
                "default-project",
                "proposal-revision",
                &revision_id,
            )?;
            super::super::revision_eligibility::pending::read(conn, "default-project", &edges)
        })?;
        assert!(matches!(
            pending_feed,
            Err(RevisionFreshnessReason::PendingRelevantChange)
        ));
        let immediately_unavailable_approved = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        assert!(matches!(
            immediately_unavailable_approved,
            Nir1EntityRelationRevisionRead::Unavailable { .. }
        ));

        let outcome = run_incremental_freshness_cycle(&db)?;
        let IncrementalFreshnessCycleOutcome::Processed(summary) = outcome else {
            anyhow::bail!("real Codex Change Feed must produce a processed cycle");
        };
        assert!(summary.affected_edge_count >= 1);
        assert!(summary.affected_consumer_count >= 1);

        let final_freshness: (String, String) = db.with_read_transaction(|conn| {
            conn.query_row(
                "SELECT evidence_freshness, build_action
                   FROM narrative_consumer_freshness
                  WHERE project_id = 'default-project'
                    AND consumer_kind = 'proposal-revision'
                    AND consumer_key = ?1",
                [&revision_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(Into::into)
        })?;
        assert_eq!(final_freshness, ("stale".into(), "rebuild-required".into()));
        let final_current = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision_current(conn, "default-project", &run_id)
        })?;
        assert!(matches!(
            final_current,
            Nir1EntityRelationRevisionCurrentRead::Unavailable { ref reason }
                if reason == "source-revision-changed"
        ));
        let final_approved = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        assert!(matches!(
            final_approved,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "source-revision-changed"
        ));
        Ok(())
    }

    #[test]
    fn native_prepare_rejects_missing_live_input_without_creating_a_review_run(
    ) -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let before = db.with_read_transaction(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*)
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND surface_path_id = ?2",
                params![
                    "default-project",
                    super::NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH
                ],
                |row| row.get::<_, i64>(0),
            )?)
        })?;
        let error = prepare_nir1_entity_relation_revision(
            &db,
            Nir1EntityRelationRevisionPrepareRequest {
                project_id: "default-project".into(),
                scene_id: "nir1".into(),
                proposal_key: None,
                entity_ids: vec!["nir1-missing".into()],
                relation_ids: vec![],
            },
        )
        .expect_err("missing live Entity must fail before a Run is discoverable");
        assert!(error
            .to_string()
            .contains("NIR1_ENTITY_RELATION_PREPARE_ENTITY_MISSING"));
        let after = db.with_read_transaction(|conn| {
            Ok(conn.query_row(
                "SELECT COUNT(*)
                   FROM narrative_extraction_runs
                  WHERE project_id = ?1 AND surface_path_id = ?2",
                params![
                    "default-project",
                    super::NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH
                ],
                |row| row.get::<_, i64>(0),
            )?)
        })?;
        assert_eq!(after, before);
        Ok(())
    }

    #[test]
    fn typed_revision_is_native_bound_and_requires_explicit_human_approval() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let revision_id = created["revisionId"]
            .as_str()
            .expect("Native revision id")
            .to_owned();

        let before_approval = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        assert!(matches!(
            before_approval,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "revision-not-human-approved"
        ));

        narrative_extraction_append_human_decision(
            &db,
            AppendDecisionPayload {
                run_id: "nir1-run".into(),
                project_id: "default-project".into(),
                proposal_id: created["proposalId"].as_str().unwrap().into(),
                revision_id: revision_id.clone(),
                decision: "approved".into(),
                decision_json: None,
                created_by: Some("renderer-reviewer".into()),
            },
        )?;

        let reopened = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        match reopened {
            Nir1EntityRelationRevisionRead::Available(result) => {
                assert_eq!(result.revision_id, revision_id);
                assert_eq!(result.bundle.project_id, "default-project");
                assert_eq!(result.bundle.revision_id, result.revision_id);
                assert_eq!(result.bundle.entities.len(), 2);
                assert_eq!(result.bundle.relations.len(), 1);
                assert_eq!(
                    result.eligibility_source,
                    "nir1-entity-relation-eligibility-set"
                );
            }
            Nir1EntityRelationRevisionRead::Unavailable { reason } => {
                anyhow::bail!("approved typed revision unavailable: {reason}")
            }
        }

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE codex_entries
                    SET updated_at = '2026-09-12T00:01:00Z'
                  WHERE id = 'nir1-alice'",
                [],
            )?;
            Ok(())
        })?;
        let stale = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        assert!(matches!(
            stale,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "source-revision-changed"
        ));
        Ok(())
    }

    #[test]
    fn typed_revision_rejects_fake_or_cross_project_source_rows() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let mut payload = request(&db);
        payload.bundle.entities[0].source_token = "codex:nir1-alice@stale".into();
        let error = create_nir1_entity_relation_revision(&db, payload)
            .expect_err("source token must be tied to current Codex row");
        assert!(error.to_string().contains("NIR1_ENTITY_SOURCE_STALE"));

        let mut cross_project = request(&db);
        cross_project.bundle.project_id = "other-project".into();
        let error = create_nir1_entity_relation_revision(&db, cross_project)
            .expect_err("bundle project must match trusted project");
        assert!(error.to_string().contains("NIR1_ENTITY_PROJECT_MISMATCH"));
        Ok(())
    }

    #[test]
    fn generic_revision_append_cannot_mutate_a_typed_revision() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let error = narrative_extraction_append_revision(
            &db,
            AppendRevisionPayload {
                run_id: "nir1-run".into(),
                project_id: "default-project".into(),
                proposal_id: created["proposalId"].as_str().unwrap().into(),
                payload_json: json!({"kind":"mutation"}),
                reconciliation_envelope: None,
                inherit_reconciliation_envelope: None,
                expected_current_revision_id: created["revisionId"].as_str().unwrap().into(),
                created_by: None,
            },
        )
        .expect_err("typed revision is immutable");
        assert!(error
            .to_string()
            .contains("NIR1_ENTITY_RELATION_REVISION_IMMUTABLE"));
        Ok(())
    }

    #[test]
    fn generic_proposal_writer_cannot_create_the_reserved_typed_set() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        let error = narrative_extraction_save_proposal_set(
            &db,
            SaveProposalSetPayload {
                run_id: "nir1-run".into(),
                project_id: "default-project".into(),
                proposal_set_id: None,
                set_kind: NIR1_ENTITY_RELATION_SET_KIND.into(),
                summary_json: None,
                proposals: vec![],
            },
        )
        .expect_err("reserved typed set must use the Native adapter");
        assert!(error
            .to_string()
            .contains("NIR1_ENTITY_RELATION_TYPED_ADAPTER_REQUIRED"));
        Ok(())
    }

    #[test]
    fn typed_revision_binds_entity_type_to_the_live_codex_object() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let mut payload = request(&db);
        payload.bundle.entities[0].entity_type = "location".into();
        let error = create_nir1_entity_relation_revision(&db, payload)
            .expect_err("typed Entity type must match the live Codex object");
        assert!(error.to_string().contains("NIR1_ENTITY_TYPE_STALE"));
        Ok(())
    }

    #[test]
    fn typed_revision_rejects_a_quote_that_is_not_in_the_live_codex_text() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let mut payload = request(&db);
        payload.bundle.entities[0].evidence[0].quote = "Zebra".into();
        let error = create_nir1_entity_relation_revision(&db, payload)
            .expect_err("current source identity must not authorize a fabricated quote");
        assert!(error
            .to_string()
            .contains("NIR1_ENTITY_EVIDENCE_ANCHOR_MISMATCH"));
        Ok(())
    }

    #[test]
    fn typed_revision_accepts_nonzero_utf16_evidence_after_a_surrogate_prefix() -> anyhow::Result<()>
    {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE codex_entries SET summary = ?1 WHERE id = 'nir1-alice'",
                ["😀Alice waits"],
            )?;
            Ok(())
        })?;

        let mut payload = request(&db);
        payload.bundle.entities[0].evidence[0].start_utf16 = 2;
        payload.bundle.entities[0].evidence[0].end_utf16 = 7;
        payload.bundle.entities[0].evidence[0].quote = "Alice".into();
        create_nir1_entity_relation_revision(&db, payload)
            .expect("an exact non-zero UTF-16 source range must be accepted");
        Ok(())
    }

    #[test]
    fn typed_revision_rejects_unknown_and_stale_scope_bindings() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;

        let mut unknown_scope = request(&db);
        unknown_scope.bundle.entities[0].scope.reading = ScopeValue::Exact {
            value: "scene:not-live".into(),
        };
        let error = create_nir1_entity_relation_revision(&db, unknown_scope)
            .expect_err("unknown Scope references must not be persisted");
        assert!(error
            .to_string()
            .contains("NIR1_SCOPE_REFERENCE_UNAVAILABLE"));

        let mut stale_scope = request(&db);
        stale_scope.bundle.entities[0].scope.authority_revision =
            format!("sha256:{}", "a".repeat(64));
        let error = create_nir1_entity_relation_revision(&db, stale_scope)
            .expect_err("Scope revision must be bound to the live authority");
        assert!(error.to_string().contains("NIR1_SCOPE_AUTHORITY_STALE"));
        Ok(())
    }

    #[test]
    fn typed_revision_reopen_is_invalidated_by_scope_authority_change() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let revision_id = created["revisionId"].as_str().unwrap().to_owned();
        narrative_extraction_append_human_decision(
            &db,
            AppendDecisionPayload {
                run_id: "nir1-run".into(),
                project_id: "default-project".into(),
                proposal_id: created["proposalId"].as_str().unwrap().into(),
                revision_id: revision_id.clone(),
                decision: "approved".into(),
                decision_json: None,
                created_by: Some("renderer-reviewer".into()),
            },
        )?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes
                    SET story_time_order = 'story-nir1'
                  WHERE id = 'nir1' AND project_id = 'default-project'",
                [],
            )?;
            Ok(())
        })?;
        let reopened = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        assert!(matches!(
            reopened,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "source-revision-changed"
        ));
        Ok(())
    }

    #[test]
    fn typed_reader_rederives_exact_source_edge_d1_and_evidence_sets() -> anyhow::Result<()> {
        for mutation in 0..5 {
            let db = fresh_migrated_memory()?;
            seed_run_and_catalog(&db)?;
            let created = create_nir1_entity_relation_revision(&db, request(&db))?;
            let revision_id = created["revisionId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("typed revision id missing"))?
                .to_owned();
            approve_typed_revision(&db, "nir1-run", &created)?;

            db.with_conn(|conn| {
                match mutation {
                    // Missing source basis must not be repaired by the reader.
                    0 => {
                        conn.execute(
                            "DELETE FROM narrative_revision_source_basis
                              WHERE revision_id = ?1 AND source_key = 'codex:nir1-alice'",
                            [&revision_id],
                        )?;
                    }
                    // An extra source is also a different closure, even when
                    // the original source rows remain intact.
                    1 => {
                        conn.execute(
                            "INSERT OR REPLACE INTO narrative_revision_source_basis
                                (revision_id, ordinal, source_kind, source_key,
                                 revision_token, observed_at)
                             VALUES (?1, 99, 'codex-entry', 'codex:unexpected',
                                     'codex:unexpected@2026-09-12T00:00:00Z',
                                     '2026-09-15T00:00:00.000Z')",
                            [&revision_id],
                        )?;
                    }
                    // A different Source at the same ordinal cannot stand in
                    // for the declared Entity, even if its token looks valid.
                    2 => {
                        conn.execute(
                            "DELETE FROM narrative_revision_source_basis
                              WHERE revision_id = ?1 AND source_key = 'codex:nir1-alice'",
                            [&revision_id],
                        )?;
                        conn.execute(
                            "INSERT OR REPLACE INTO narrative_revision_source_basis
                                (revision_id, ordinal, source_kind, source_key,
                                 revision_token, observed_at)
                             VALUES (?1, 0, 'codex-entry', 'codex:unexpected',
                                     'codex:unexpected@2026-09-12T00:00:00Z',
                                     '2026-09-15T00:00:00.000Z')",
                            [&revision_id],
                        )?;
                    }
                    // The V1 closure is independently checked; dropping an
                    // Edge cannot be hidden by a still-fresh aggregate row.
                    3 => {
                        conn.execute(
                            "DELETE FROM narrative_dependency_edges
                              WHERE project_id = 'default-project'
                                AND consumer_kind = 'proposal-revision'
                                AND consumer_key = ?1
                                AND source_object_identity = 'codex:nir1-alice'",
                            [&revision_id],
                        )?;
                    }
                    // D1 is an independent sealed set. Removing one entry
                    // leaves the head present but makes the exact set fail.
                    4 => {
                        conn.execute(
                            "DELETE FROM narrative_dependency_declaration_entries
                              WHERE declaration_set_id = (
                                  SELECT active_declaration_set_id
                                    FROM narrative_dependency_declaration_heads
                                   WHERE project_id = 'default-project'
                                     AND consumer_kind = 'proposal-revision'
                                     AND consumer_key = ?1
                              )
                              AND source_object_identity = 'codex:nir1-alice'",
                            [&revision_id],
                        )?;
                    }
                    _ => unreachable!(),
                }
                Ok(())
            })?;

            let reopened = db.with_read_transaction(|conn| {
                read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
            })?;
            assert!(
                matches!(
                    reopened,
                    Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                        if reason == "revision-material-authority-mismatch"
                ),
                "mutation {mutation} unexpectedly reopened as {reopened:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn typed_reader_rejects_evidence_substitution_without_new_revision() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let revision_id = created["revisionId"].as_str().unwrap().to_owned();
        approve_typed_revision(&db, "nir1-run", &created)?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_proposal_revisions
                    SET payload_json = json_set(
                        payload_json,
                        '$.bundle.entities[0].evidence[0].quote',
                        'Bob'
                    )
                  WHERE id = ?1",
                [&revision_id],
            )?;
            Ok(())
        })?;
        let reopened = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        assert!(matches!(
            reopened,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "revision-payload-binding-invalid"
        ));
        Ok(())
    }

    #[test]
    fn typed_reader_invalidation_matrix_never_reuses_stale_approval() -> anyhow::Result<()> {
        for mutation in 0..4 {
            let db = fresh_migrated_memory()?;
            seed_run_and_catalog(&db)?;
            let created = create_nir1_entity_relation_revision(&db, request(&db))?;
            let revision_id = created["revisionId"].as_str().unwrap().to_owned();
            approve_typed_revision(&db, "nir1-run", &created)?;

            let expected_reason = match mutation {
                // Evidence drift after save, without changing the source's
                // identity token, must still invalidate the cold reader.
                0 => {
                    db.with_conn(|conn| {
                        conn.execute(
                            "UPDATE codex_entries
                                SET summary = 'Alicia'
                              WHERE id = 'nir1-alice' AND project_id = 'default-project'",
                            [],
                        )?;
                        Ok::<_, anyhow::Error>(())
                    })?;
                    "source-revision-changed"
                }
                // Endpoint changes are Source changes for the Relation, not
                // merely a display/catalog update.
                1 => {
                    db.with_conn(|conn| {
                        conn.execute(
                            "UPDATE codex_relations
                                SET from_codex_id = 'nir1-bob'
                              WHERE id = 'nir1-edge' AND project_id = 'default-project'",
                            [],
                        )?;
                        Ok::<_, anyhow::Error>(())
                    })?;
                    "source-revision-changed"
                }
                // The old immutable Revision ceases to be current as soon as
                // its Proposal pointer is replaced.
                2 => {
                    db.with_conn(|conn| {
                        conn.execute(
                            "UPDATE narrative_proposals
                                SET current_revision_id = 'replacement-revision'
                              WHERE id = ?1",
                            params![created["proposalId"].as_str().unwrap()],
                        )?;
                        Ok::<_, anyhow::Error>(())
                    })?;
                    "revision-not-current"
                }
                // A human cancellation is a new explicit Decision and must
                // not leave the old approval usable.
                3 => {
                    narrative_extraction_append_human_decision(
                        &db,
                        AppendDecisionPayload {
                            run_id: "nir1-run".into(),
                            project_id: "default-project".into(),
                            proposal_id: created["proposalId"].as_str().unwrap().into(),
                            revision_id: revision_id.clone(),
                            decision: "rejected".into(),
                            decision_json: None,
                            created_by: Some("renderer-reviewer".into()),
                        },
                    )?;
                    "revision-not-human-approved"
                }
                _ => unreachable!(),
            };
            let reopened = db.with_read_transaction(|conn| {
                read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
            })?;
            assert!(
                matches!(
                    reopened,
                    Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                        if reason == expected_reason
                ),
                "mutation {mutation} expected {expected_reason}, got {reopened:?}"
            );
        }
        Ok(())
    }

    #[test]
    fn typed_revision_keeps_all_evidence_but_deduplicates_d1_whole_source_declarations(
    ) -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let mut request = request(&db);
        request.bundle.entities[0].evidence.push(EvidenceInput {
            evidence_id: "nir1-evidence-alice-second".into(),
            source_ref: "codex:nir1-alice".into(),
            start_utf16: 0,
            end_utf16: 5,
            quote: "Alice".into(),
        });
        let created = create_nir1_entity_relation_revision(&db, request)?;
        let revision_id = created["revisionId"].as_str().unwrap().to_owned();
        approve_typed_revision(&db, "nir1-run", &created)?;

        let (source_count, d1_count, evidence_count) = db.with_conn(|conn| {
            Ok::<_, anyhow::Error>((
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_revision_source_basis
                      WHERE revision_id = ?1",
                    [&revision_id],
                    |row| row.get::<_, i64>(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_dependency_declaration_entries
                      WHERE declaration_set_id = (
                          SELECT active_declaration_set_id
                            FROM narrative_dependency_declaration_heads
                           WHERE project_id = 'default-project'
                             AND consumer_kind = 'proposal-revision'
                             AND consumer_key = ?1
                      )",
                    [&revision_id],
                    |row| row.get::<_, i64>(0),
                )?,
                conn.query_row(
                    "SELECT json_array_length(json_extract(payload_json,
                             '$.bundle.entities[0].evidence'))
                       FROM narrative_proposal_revisions
                      WHERE id = ?1",
                    [&revision_id],
                    |row| row.get::<_, i64>(0),
                )?,
            ))
        })?;
        assert_eq!(
            source_count, 4,
            "source identity closure stays deduplicated"
        );
        assert_eq!(d1_count, 7, "one D1 declaration per Source/role/selector");
        assert_eq!(
            evidence_count, 2,
            "all Evidence remains in the typed payload"
        );

        let reopened = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        match reopened {
            Nir1EntityRelationRevisionRead::Available(result) => {
                assert_eq!(result.bundle.entities[0].evidence.len(), 2);
                assert_eq!(result.material_basis.evidence_set.len(), 3);
            }
            Nir1EntityRelationRevisionRead::Unavailable { reason } => {
                anyhow::bail!("deduplicated D1 typed revision unavailable: {reason}")
            }
        }
        Ok(())
    }

    #[test]
    fn restore_epoch_invalidates_old_typed_revision_until_new_revision_and_decision(
    ) -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let old = create_nir1_entity_relation_revision(&db, request(&db))?;
        let old_revision_id = old["revisionId"].as_str().unwrap().to_owned();
        approve_typed_revision(&db, "nir1-run", &old)?;

        let restore_epoch = db.with_conn(|conn| {
            super::super::semantic_epoch::create_epoch_in_tx(
                conn,
                "default-project",
                "restore",
                Some("restore-event-nir1"),
            )
        })?;
        // Rebuild the old V1 Freshness row in the new Epoch to model the
        // tempting but forbidden recovery shortcut. The old Run remains
        // stamped with the pre-restore Epoch, so the typed reader must still
        // reject it.
        db.with_conn(|conn| {
            let edges = super::find_edges_by_consumer(
                conn,
                "default-project",
                "proposal-revision",
                &old_revision_id,
            )?;
            let observations = edges
                .iter()
                .map(|edge| {
                    Ok((
                        edge.id.clone(),
                        super::evaluate_typed_edge(conn, "default-project", edge)?,
                    ))
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            super::super::task_leases::with_immediate_transaction(conn, |conn| {
                super::publish_complete_runless_freshness_in_tx(
                    conn,
                    "default-project",
                    "proposal-revision",
                    &old_revision_id,
                    &observations,
                    &restore_epoch,
                    "2026-09-15T00:00:01.000Z",
                )?;
                Ok(())
            })
        })?;
        let old_after_restore = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &old_revision_id)
        })?;
        assert!(matches!(
            old_after_restore,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "revision-restore-invalidated"
        ));

        let new_run_id = "nir1-run-after-restore";
        create_typed_run(&db, new_run_id)?;
        let new = create_nir1_entity_relation_revision(
            &db,
            request_for_run(&db, new_run_id, "nir1:review:after-restore"),
        )?;
        let new_revision_id = new["revisionId"].as_str().unwrap().to_owned();
        let before_new_decision = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &new_revision_id)
        })?;
        assert!(matches!(
            before_new_decision,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "revision-not-human-approved"
        ));
        approve_typed_revision(&db, new_run_id, &new)?;
        let new_after_approval = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &new_revision_id)
        })?;
        assert!(matches!(
            new_after_approval,
            Nir1EntityRelationRevisionRead::Available(_)
        ));
        Ok(())
    }

    #[test]
    fn generic_review_bundle_does_not_publish_typed_evidence() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let error = super::super::repository::get_run_review_bundle(
            &db,
            "nir1-run".into(),
            "default-project".into(),
        )
        .expect_err("generic review bundle must not expose typed Evidence plaintext");
        assert!(error
            .to_string()
            .contains("NIR1_ENTITY_RELATION_REVIEW_BUNDLE_UNAVAILABLE"));
        assert!(created["revisionId"].as_str().is_some());
        Ok(())
    }

    #[test]
    fn renderer_sql_cannot_read_typed_revision_payloads_from_either_table() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let revision_id = created["revisionId"].as_str().unwrap().to_owned();
        let proposal_id = created["proposalId"].as_str().unwrap().to_owned();

        for (table, id) in [
            ("narrative_proposals", proposal_id.as_str()),
            ("narrative_proposal_revisions", revision_id.as_str()),
        ] {
            let error = db
                .execute_renderer(
                    &format!("SELECT payload_json FROM {table} WHERE id = ?1"),
                    &[json!(id)],
                    "get",
                )
                .expect_err("renderer db_execute must not expose typed Evidence");
            assert!(
                error.to_string().contains("RENDERER_SQL_TYPED_PAYLOAD"),
                "unexpected single-statement error for {table}: {error}"
            );

            let error = db
                .execute_batch_tx_renderer(&[crate::BatchStatement {
                    sql: format!("SELECT payload_json FROM {table} WHERE id = ?1"),
                    params: vec![json!(id)],
                    method: "get".into(),
                }])
                .expect_err("renderer db_execute_batch must not expose typed Evidence");
            assert!(
                error.to_string().contains("RENDERER_SQL_TYPED_PAYLOAD"),
                "unexpected batch error for {table}: {error}"
            );
        }
        Ok(())
    }

    #[test]
    fn typed_reader_requires_a_read_transaction() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        let error = db
            .with_conn(|conn| read_nir1_entity_relation_revision(conn, "default-project", "r"))
            .expect_err("autocommit reader must be rejected");
        assert!(error
            .to_string()
            .contains("NIR1_ENTITY_RELATION_REQUIRES_READ_TRANSACTION"));
        Ok(())
    }

    #[test]
    fn typed_revision_persists_v2_material_edges_and_canonical_freshness() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let revision_id = created["revisionId"].as_str().unwrap().to_owned();

        let (schema_version, envelope, source_count, edge_count, freshness_count): (
            Option<i64>,
            Option<String>,
            i64,
            i64,
            i64,
        ) = db.with_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT json_extract(reconciliation_envelope_json, '$.schemaVersion')
                       FROM narrative_proposal_revisions WHERE id = ?1",
                    [&revision_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT reconciliation_envelope_json
                       FROM narrative_proposal_revisions WHERE id = ?1",
                    [&revision_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_revision_source_basis WHERE revision_id = ?1",
                    [&revision_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_dependency_edges
                       WHERE project_id = 'default-project'
                         AND consumer_kind = 'proposal-revision'
                         AND consumer_key = ?1",
                    [&revision_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_consumer_freshness
                       WHERE project_id = 'default-project'
                         AND consumer_kind = 'proposal-revision'
                         AND consumer_key = ?1",
                    [&revision_id],
                    |row| row.get(0),
                )?,
            ))
        })?;
        assert_eq!(schema_version, Some(2));
        assert!(
            envelope.is_some(),
            "typed revisions need a sealed Envelope V2"
        );
        assert_eq!(
            source_count, 4,
            "two Entities, one Relation and Scope are closed"
        );
        assert_eq!(edge_count, source_count);
        assert_eq!(freshness_count, 1);

        let before_approval = db.with_read_transaction(|conn| {
            super::super::read_revision_canonical_freshness(conn, "default-project", &revision_id)
        })?;
        assert!(matches!(
            before_approval,
            super::super::RevisionFreshnessRead::Unavailable {
                reason: super::super::RevisionFreshnessReason::MembershipUnavailable
            }
        ));
        let generic_membership = db.with_read_transaction(|conn| {
            read_revision_material_membership(conn, "default-project", &revision_id)
        })?;
        assert!(
            matches!(
                generic_membership,
                MaterialMembershipRead::Unavailable { .. }
            ),
            "generic material membership must deny the typed family"
        );
        Ok(())
    }

    #[test]
    fn typed_reader_rejects_missing_canonical_freshness_even_when_approved() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let revision_id = created["revisionId"].as_str().unwrap().to_owned();
        narrative_extraction_append_human_decision(
            &db,
            AppendDecisionPayload {
                run_id: "nir1-run".into(),
                project_id: "default-project".into(),
                proposal_id: created["proposalId"].as_str().unwrap().into(),
                revision_id: revision_id.clone(),
                decision: "approved".into(),
                decision_json: None,
                created_by: Some("renderer-reviewer".into()),
            },
        )?;
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_consumer_freshness
                  WHERE project_id = 'default-project'
                    AND consumer_kind = 'proposal-revision'
                    AND consumer_key = ?1",
                [&revision_id],
            )?;
            Ok(())
        })?;
        let reopened = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        assert!(matches!(
            reopened,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "canonical-freshness-unavailable"
        ));
        Ok(())
    }

    #[test]
    fn legacy_null_envelope_rows_remain_unavailable_without_retroactive_qualification(
    ) -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let revision_id = "legacy-null-typed-revision";
        let proposal_id = "legacy-null-typed-proposal";
        let proposal_set_id = "legacy-null-typed-set";
        let mut bundle = request(&db).bundle;
        bundle.revision_id = revision_id.into();
        let payload_json = serde_json::to_string(&json!({
            "schemaVersion": 1,
            "kind": NIR1_ENTITY_RELATION_PROPOSAL_KIND,
            "producer": "nir1-reviewed-entity-relation-v1",
            "projectId": "default-project",
            "revisionId": revision_id,
            "bundle": bundle,
        }))?;
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_proposal_sets
                    (id, run_id, project_id, set_kind, status, summary_json,
                     created_at, updated_at, version)
                 VALUES (?1, 'nir1-run', 'default-project', ?2, 'approved', '{}',
                         '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z', 0)",
                params![proposal_set_id, NIR1_ENTITY_RELATION_SET_KIND],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposals
                    (id, proposal_set_id, proposal_key, kind, status, payload_json,
                     current_revision_id, created_at, updated_at)
                 VALUES (?1, ?2, 'legacy-null', ?3, 'approved', ?4, ?5,
                         '2026-09-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z')",
                params![
                    proposal_id,
                    proposal_set_id,
                    NIR1_ENTITY_RELATION_PROPOSAL_KIND,
                    payload_json,
                    revision_id,
                ],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json, origin_kind,
                     reconciliation_envelope_json, reconciliation_envelope_digest,
                     created_at, created_by)
                 VALUES (?1, ?2, 1, ?3, ?4, NULL, NULL,
                         '2026-09-15T00:00:00.000Z', 'legacy-import')",
                params![
                    revision_id,
                    proposal_id,
                    payload_json,
                    NIR1_ENTITY_RELATION_REVISION_ORIGIN,
                ],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposal_decisions
                    (id, proposal_id, revision_id, decision, decision_json,
                     created_at, created_by, actor_kind, actor_id, authority_scope,
                     override_field_paths_json)
                 VALUES ('legacy-null-decision', ?1, ?2, 'approved', '{}',
                         '2026-09-15T00:00:00.000Z', 'legacy-import', 'human',
                         'electron:human-review', 'legacy-null', '[]')",
                params![proposal_id, revision_id],
            )?;
            Ok(())
        })?;

        let reopened = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", revision_id)
        })?;
        assert!(matches!(
            reopened,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "canonical-freshness-unavailable"
        ));
        let (envelope, decision_count): (Option<String>, i64) = db.with_conn(|conn| {
            Ok((
                conn.query_row(
                    "SELECT reconciliation_envelope_json
                       FROM narrative_proposal_revisions WHERE id = ?1",
                    [revision_id],
                    |row| row.get(0),
                )?,
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_proposal_decisions WHERE revision_id = ?1",
                    [revision_id],
                    |row| row.get(0),
                )?,
            ))
        })?;
        assert!(envelope.is_none(), "legacy row must not be retrofitted");
        assert_eq!(decision_count, 1, "legacy decision remains displayable");
        Ok(())
    }

    #[test]
    fn typed_reader_rejects_ambiguous_same_timestamp_current_decision() -> anyhow::Result<()> {
        let db = fresh_migrated_memory()?;
        seed_run_and_catalog(&db)?;
        let created = create_nir1_entity_relation_revision(&db, request(&db))?;
        let revision_id = created["revisionId"].as_str().unwrap().to_owned();
        let proposal_id = created["proposalId"].as_str().unwrap().to_owned();
        narrative_extraction_append_human_decision(
            &db,
            AppendDecisionPayload {
                run_id: "nir1-run".into(),
                project_id: "default-project".into(),
                proposal_id: proposal_id.clone(),
                revision_id: revision_id.clone(),
                decision: "approved".into(),
                decision_json: None,
                created_by: Some("renderer-reviewer".into()),
            },
        )?;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_proposal_decisions
                    SET created_at = '2026-09-15T00:00:00.000Z'
                  WHERE proposal_id = ?1 AND revision_id = ?2",
                params![proposal_id, revision_id],
            )?;
            conn.execute(
                "INSERT INTO narrative_proposal_decisions
                    (id, proposal_id, revision_id, decision, decision_json, created_at,
                     created_by, actor_kind, actor_id, authority_scope, override_field_paths_json)
                 VALUES ('00000000-0000-0000-0000-000000000001', ?1, ?2, 'approved', '{}',
                         '2026-09-15T00:00:00.000Z', 'automation', 'automated',
                         'electron:automated-review', 'automated', '[]')",
                params![proposal_id, revision_id],
            )?;
            Ok(())
        })?;
        let reopened = db.with_read_transaction(|conn| {
            read_nir1_entity_relation_revision(conn, "default-project", &revision_id)
        })?;
        assert!(matches!(
            reopened,
            Nir1EntityRelationRevisionRead::Unavailable { ref reason }
                if reason == "revision-decision-ambiguous"
        ));
        Ok(())
    }
}
