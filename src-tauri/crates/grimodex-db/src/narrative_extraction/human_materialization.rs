//! C2B Human-derived projection materialization seam.
//!
//! This domain entry point composes the dormant C2A revision writer with the
//! C2B material authorities in one Native-owned transaction. ScopeOverride
//! resolves the live project authority and publishes the child authorities
//! before the final proposal pointer CAS.

use std::collections::HashSet;

use anyhow::{anyhow, Context};
use grimodex_core::canonical_json_string;
use grimodex_core::narrative_dependency::{DependencyRole, DependencySelector};
use grimodex_core::narrative_ir::{
    classify_chronicle_scene_event_changes, digest_narrative_scope_v2, validate_narrative_scope_v2,
    ChronicleChangeDisposition,
};
use grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityMappingV1;
use grimodex_core::narrative_scope_authority_basis::{
    NarrativeScopeAuthorityStoryTimeOrderV2, NarrativeScopeAuthorityUnresolvedReasonV2,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use super::declaration_storage::{
    read_active_dependency_declaration_set_in_tx, write_dependency_declaration_set_in_tx,
    ActiveDependencyDeclarationSetRead, DependencyDeclarationSetRequest,
};
use super::dependency_edges::find_edges_by_consumer;
use super::human_derivation;
use super::human_material_basis::{
    project_d1_declaration_set, resolve_human_material_basis, D1ParentAuthority,
    HumanMaterialDerivationKind, HumanMaterialParentBundle, HumanMaterialResolutionContext,
    MaterialBasis, TrustedDependencyEntry, TrustedEvidenceEntry, TrustedHumanMaterialResolution,
    TrustedSourceBasisEntry, V1PersistedEdge, D1_PRODUCER_ID,
};
use super::models::{CreateHumanDerivedRevisionRequest, TrustedScopeV2Projection};
use super::project_scope_authority::load_live_project_scope_authority;
use super::reconciliation_envelope::load_source_basis_rows;
use super::repository::{
    record_revision_dependency_edges_in_tx, PROPOSAL_REVISION_D1_PRODUCER_GENERATION,
};
use super::restore_rebuild::evaluate_edge_from_db;
use super::task_leases::with_immediate_transaction;
use crate::narrative_runtime_policy::require_narrative_extraction_allowed;
use crate::Database;

const PROPOSAL_REVISION_CONSUMER_KIND: &str = "proposal-revision";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvelopeMaterialProjection {
    effective_material_basis: MaterialBasis,
    assertion: EnvelopeAssertionProjection,
}

#[derive(Debug, Deserialize)]
struct EnvelopeAssertionProjection {
    scope: EnvelopeScopeProjection,
}

#[derive(Debug, Deserialize)]
struct EnvelopeScopeProjection {
    scene: EnvelopeExactReference,
}

#[derive(Debug, Deserialize)]
struct EnvelopeExactReference {
    kind: String,
    #[serde(rename = "ref")]
    reference: String,
}

#[derive(Debug, Deserialize)]
struct EditedPayloadProjection {
    disclosure: EditedDisclosureProjection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditedDisclosureProjection {
    secret: bool,
    reveal_document_ref: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HumanRevisionReceiptProjection {
    revision_id: String,
}

struct ProjectionAdmission {
    proposal_id: String,
    run_id: String,
    parent_revision_id: String,
    material_basis: MaterialBasis,
    semantic_epoch_id: String,
    scope_projection: Option<TrustedScopeV2Projection>,
    actual_kind: HumanMaterialDerivationKind,
}

fn admit_projection_parent(
    conn: &Connection,
    trusted_project_id: &str,
    request: &CreateHumanDerivedRevisionRequest,
    requested_kind: Option<HumanMaterialDerivationKind>,
) -> anyhow::Result<ProjectionAdmission> {
    #[allow(clippy::type_complexity)]
    let row: Option<(
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )> = conn
        .query_row(
            "SELECT s.project_id, s.run_id, p.current_revision_id,
                    r.reconciliation_envelope_json,
                    r.reconciliation_envelope_digest, r.payload_json
               FROM narrative_proposals p
               JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
               LEFT JOIN narrative_proposal_revisions r
                 ON r.id = p.current_revision_id
                AND r.proposal_id = p.id
              WHERE p.id = ?1",
            params![request.proposal_id],
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
        project_id,
        run_id,
        current_revision_id,
        parent_envelope_json,
        parent_envelope_digest,
        parent_payload_json,
    )) = row
    else {
        return Err(anyhow!(
            "NEX_C2B_PARENT_UNAVAILABLE: proposal '{}' has no persisted parent authority",
            request.proposal_id
        ));
    };
    anyhow::ensure!(
        project_id == trusted_project_id,
        "NEX_C2B_PARENT_PROJECT_MISMATCH: proposal is not owned by the trusted project"
    );
    let current_revision_id = current_revision_id.ok_or_else(|| {
        anyhow!("NEX_PROPOSAL_REVISION_CONFLICT: proposal has no current revision")
    })?;
    anyhow::ensure!(
        current_revision_id == request.expected_current_revision_id
            && current_revision_id == request.parent_revision_id,
        "NEX_PROPOSAL_REVISION_CONFLICT: expected current and parent revision must identify the persisted current revision"
    );
    let parent_envelope_digest = parent_envelope_digest.ok_or_else(|| {
        anyhow!("NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT: parent digest is missing")
    })?;
    anyhow::ensure!(
        parent_envelope_digest == request.expected_parent_envelope_digest,
        "NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT: expected parent Envelope digest does not match persisted parent"
    );
    let parent_envelope_json = parent_envelope_json.ok_or_else(|| {
        anyhow!("NEX_REVISION_PARENT_ENVELOPE_DIGEST_CONFLICT: parent envelope is missing")
    })?;
    let envelope: EnvelopeMaterialProjection = serde_json::from_str(&parent_envelope_json)
        .context("NEX_C2B_MATERIAL_PARENT_ENVELOPE_INVALID: typed material projection failed")?;
    anyhow::ensure!(
        envelope.assertion.scope.scene.kind == "exact"
            && !envelope.assertion.scope.scene.reference.trim().is_empty(),
        "NEX_C2B_MATERIAL_PARENT_SCOPE_INVALID: parent Scope must name one exact Scene"
    );

    let parent_payload: Value = serde_json::from_str(
        parent_payload_json
            .as_deref()
            .ok_or_else(|| anyhow!("NEX_C2B_PARENT_PAYLOAD_INVALID: parent payload is missing"))?,
    )
    .context("NEX_C2B_PARENT_PAYLOAD_INVALID: parent payload is invalid")?;
    let edited: EditedPayloadProjection = serde_json::from_value(request.proposal_payload.clone())
        .context("NEX_C2B_PARENT_PAYLOAD_INVALID: edited payload projection is invalid")?;
    let classification =
        classify_chronicle_scene_event_changes(&parent_payload, &request.proposal_payload)
            .map_err(|error| anyhow!("NEX_C2B_DERIVATION_CLASSIFICATION_INVALID: {error}"))?;
    anyhow::ensure!(
        classification.disposition == ChronicleChangeDisposition::Accept,
        "NEX_C2B_DERIVATION_CLASSIFICATION_INVALID: edited payload is not accepted"
    );
    let actual_kind = match classification.derivation_kind.as_deref() {
        None | Some("projection-only") => HumanMaterialDerivationKind::ProjectionOnly,
        Some("scope-override") => HumanMaterialDerivationKind::ScopeOverride,
        Some(other) => {
            return Err(anyhow!(
                "NEX_C2B_DERIVATION_CLASSIFICATION_INVALID: unsupported derivation kind '{other}'"
            ));
        }
    };
    if let Some(requested_kind) = requested_kind {
        if actual_kind != requested_kind {
            if requested_kind == HumanMaterialDerivationKind::ScopeOverride
                && actual_kind == HumanMaterialDerivationKind::ProjectionOnly
            {
                return Err(anyhow!(
                    "NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE: Native scope authority is not available for C2B materialization"
                ));
            }
            return Err(anyhow!(
                "NEX_C2B_DERIVATION_KIND_MISMATCH: caller derivation kind does not match Native classification"
            ));
        }
    }
    let source_basis = load_source_basis_rows(conn, &current_revision_id)?;
    let active_dependency_declaration_set = match read_active_dependency_declaration_set_in_tx(
        conn,
        trusted_project_id,
        PROPOSAL_REVISION_CONSUMER_KIND,
        &current_revision_id,
    )? {
        ActiveDependencyDeclarationSetRead::Active(active) => active,
        ActiveDependencyDeclarationSetRead::Missing => {
            return Err(anyhow!(
                "NEX_C2B_PARENT_D1_HEAD_UNAVAILABLE: parent has no active D1 declaration head"
            ));
        }
        ActiveDependencyDeclarationSetRead::Corrupt => {
            return Err(anyhow!(
                "NEX_C2B_PARENT_D1_AUTHORITY_MISMATCH: parent D1 declaration head is corrupt"
            ));
        }
    };
    let persisted_v1_edges = find_edges_by_consumer(
        conn,
        trusted_project_id,
        PROPOSAL_REVISION_CONSUMER_KIND,
        &current_revision_id,
    )?
    .into_iter()
    .map(|edge| V1PersistedEdge {
        project_id: edge.project_id,
        consumer_kind: edge.consumer_kind,
        consumer_key: edge.consumer_key,
        source_object_identity: edge.source_object_identity,
        read_set_json: edge.read_set_json,
        owning_run_id: edge.owning_run_id,
        generated_by_transaction_id: edge.generated_by_transaction_id,
    })
    .collect();
    let parent = HumanMaterialParentBundle {
        project_id: trusted_project_id.to_owned(),
        consumer_kind: PROPOSAL_REVISION_CONSUMER_KIND.to_owned(),
        consumer_key: current_revision_id.clone(),
        owning_run_id: run_id.clone(),
        expected_parent_envelope_digest: parent_envelope_digest.clone(),
        material_basis: envelope.effective_material_basis,
        source_basis,
        active_dependency_declaration_set,
        persisted_v1_edges,
    };
    let context = HumanMaterialResolutionContext {
        project_id: trusted_project_id.to_owned(),
        parent_revision_id: current_revision_id.clone(),
        expected_parent_owning_run_id: run_id.clone(),
        expected_parent_envelope_digest: parent_envelope_digest,
        scene_ref: envelope.assertion.scope.scene.reference,
        edited_document_ref: edited.disclosure.reveal_document_ref,
        secret_scope: edited.disclosure.secret,
    };
    let (resolution, scope_projection) = match actual_kind {
        HumanMaterialDerivationKind::ProjectionOnly => (
            resolve_human_material_basis(
                HumanMaterialDerivationKind::ProjectionOnly,
                &parent,
                &context,
                None,
            )?,
            None,
        ),
        HumanMaterialDerivationKind::ScopeOverride => {
            let (trusted_material, scope_projection) =
                resolve_live_scope_override_authority(conn, trusted_project_id, &parent, &context)?;
            (
                resolve_human_material_basis(
                    HumanMaterialDerivationKind::ScopeOverride,
                    &parent,
                    &context,
                    Some(&trusted_material),
                )?,
                scope_projection,
            )
        }
    };
    let semantic_epoch_id = super::semantic_epoch::get_current_epoch(conn, trusted_project_id)?
        .map(|epoch| epoch.id)
        .ok_or_else(|| {
            anyhow!(
                "NEX_C2B_CURRENT_SEMANTIC_EPOCH_UNAVAILABLE: project has no current Semantic Epoch"
            )
        })?;

    Ok(ProjectionAdmission {
        proposal_id: request.proposal_id.clone(),
        run_id,
        parent_revision_id: current_revision_id,
        material_basis: resolution.material_basis,
        semantic_epoch_id,
        scope_projection,
        actual_kind,
    })
}

const SCOPE_AUTHORITY_SOURCE_KIND: &str = "project-scope-authority";
const SCOPE_AUTHORITY_CONTEXT_ID: &str = "context:chronicle-scope-resolver";
const SCOPE_AUTHORITY_DEPENDENCY_ID: &str = "dependency:scope-resolution";

fn resolve_live_scope_override_authority(
    conn: &Connection,
    trusted_project_id: &str,
    parent: &HumanMaterialParentBundle,
    context: &HumanMaterialResolutionContext,
) -> anyhow::Result<(
    TrustedHumanMaterialResolution,
    Option<TrustedScopeV2Projection>,
)> {
    let authority_source_key = format!("project:scope-authority:{trusted_project_id}");
    let authority =
        load_live_project_scope_authority(conn, trusted_project_id, &authority_source_key)
            .map_err(|error| anyhow!("NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE: {error}"))?;
    anyhow::ensure!(
        authority.source.source_kind == SCOPE_AUTHORITY_SOURCE_KIND
            && authority.source.source_key == authority_source_key
            && !authority.source.revision_token.trim().is_empty(),
        "NEX_C2B_SCOPE_AUTHORITY_INVALID: live authority Source identity is invalid"
    );

    let matching_mappings = authority
        .mappings
        .iter()
        .filter(|mapping| mapping.scene_ref == context.scene_ref)
        .collect::<Vec<_>>();
    let mapping = match matching_mappings.as_slice() {
        [] => {
            return Err(anyhow!(
                "NEX_C2B_SCOPE_AUTHORITY_SCENE_MISSING: live authority has no mapping for '{}'",
                context.scene_ref
            ));
        }
        [mapping] => *mapping,
        _ => {
            return Err(anyhow!(
                "NEX_C2B_SCOPE_AUTHORITY_SCENE_AMBIGUOUS: live authority has multiple mappings for '{}'",
                context.scene_ref
            ));
        }
    };

    let trusted_material = build_scope_override_material_sidecar(
        parent,
        context,
        &authority_source_key,
        &authority.source.revision_token,
    )?;
    let scope_projection = if context.secret_scope {
        Some(build_live_scope_v2_projection(
            &authority,
            mapping,
            &authority_source_key,
        )?)
    } else {
        None
    };
    Ok((trusted_material, scope_projection))
}

fn build_live_scope_v2_projection(
    authority: &grimodex_core::narrative_project_scope_authority::NarrativeProjectScopeAuthorityV1,
    mapping: &NarrativeProjectScopeAuthorityMappingV1,
    authority_source_key: &str,
) -> anyhow::Result<TrustedScopeV2Projection> {
    let reader_count = authority
        .scope_registry
        .reserved_audience_refs
        .iter()
        .filter(|audience| audience.as_str() == "reader")
        .count();
    anyhow::ensure!(
        reader_count == 1,
        "NEX_C2B_SCOPE_AUTHORITY_AUDIENCE_INVALID: live authority must reserve exactly one reader audience"
    );

    let story_time = match &mapping.story_time_order {
        NarrativeScopeAuthorityStoryTimeOrderV2::Resolved { .. } => {
            exact_scope_interval(&mapping.story_time_ref)
        }
        NarrativeScopeAuthorityStoryTimeOrderV2::Unresolved { reason, .. } => json!({
            "kind": "unresolved",
            "reason": unresolved_scope_reason(reason),
        }),
    };
    let scope = json!({
        "schemaVersion": 2,
        "registryVersion": "narrative-scope/2",
        "timeline": {"kind": "any"},
        "worldline": {"kind": "any"},
        "scene": {"kind": "exact", "ref": mapping.scene_ref},
        "viewpoint": {"kind": "any"},
        "knowledgeHolder": {"kind": "any"},
        "audience": {"kind": "exact", "ref": "reader"},
        "narrativeLayer": {"kind": "any"},
        "storyTime": story_time,
        "readingOrder": exact_scope_interval(&mapping.reading_order_ref),
    });
    validate_narrative_scope_v2(&scope).map_err(|error| {
        anyhow!("NEX_C2B_SCOPE_AUTHORITY_INVALID: live Scope V2 is invalid: {error}")
    })?;
    let digest = digest_narrative_scope_v2(&scope).map_err(|error| {
        anyhow!("NEX_C2B_SCOPE_AUTHORITY_INVALID: live Scope V2 digest failed: {error}")
    })?;
    Ok(TrustedScopeV2Projection {
        scope,
        digest,
        source_key: authority_source_key.to_owned(),
    })
}

fn exact_scope_interval(reference: &str) -> Value {
    json!({
        "kind": "interval",
        "from": {"ref": reference, "inclusive": true},
        "until": {"ref": reference, "inclusive": true}
    })
}

fn unresolved_scope_reason(reason: &NarrativeScopeAuthorityUnresolvedReasonV2) -> &'static str {
    match reason {
        NarrativeScopeAuthorityUnresolvedReasonV2::NotProvided => "not-provided",
        NarrativeScopeAuthorityUnresolvedReasonV2::Ambiguous => "ambiguous",
    }
}

fn build_scope_override_material_sidecar(
    parent: &HumanMaterialParentBundle,
    context: &HumanMaterialResolutionContext,
    authority_source_key: &str,
    authority_revision_token: &str,
) -> anyhow::Result<TrustedHumanMaterialResolution> {
    anyhow::ensure!(
        !authority_revision_token.trim().is_empty(),
        "NEX_C2B_SCOPE_AUTHORITY_INVALID: live authority revision token is empty"
    );

    let mut required_source_keys = parent
        .material_basis
        .evidence_set
        .iter()
        .map(|evidence| evidence.source_key.clone())
        .collect::<HashSet<_>>();
    required_source_keys.extend(
        parent
            .material_basis
            .dependency_set
            .iter()
            .filter(|dependency| dependency.role != DependencyRole::ScopeResolution)
            .filter(|&dependency| {
                parent
                    .material_basis
                    .source_basis
                    .iter()
                    .any(|source| source.source_key == dependency.input_ref)
            })
            .map(|dependency| dependency.input_ref.clone()),
    );

    let mut source_basis = Vec::with_capacity(required_source_keys.len() + 1);
    for source in &parent.material_basis.source_basis {
        if !required_source_keys.contains(&source.source_key) {
            continue;
        }
        anyhow::ensure!(
            source.source_key != authority_source_key,
            "NEX_C2B_SCOPE_AUTHORITY_SOURCE_COLLISION: current authority Source is also required as an immutable parent observation"
        );
        source_basis.push(TrustedSourceBasisEntry {
            source_kind: source.source_kind.clone(),
            source_key: source.source_key.clone(),
            revision_token: source.revision_token.clone(),
            revision_observed_at: source.revision_observed_at.clone(),
        });
    }
    source_basis.push(TrustedSourceBasisEntry {
        source_kind: SCOPE_AUTHORITY_SOURCE_KIND.to_owned(),
        source_key: authority_source_key.to_owned(),
        revision_token: authority_revision_token.to_owned(),
        revision_observed_at: None,
    });

    let evidence_set = parent
        .material_basis
        .evidence_set
        .iter()
        .map(|evidence| TrustedEvidenceEntry {
            evidence_ref: evidence.evidence_ref.clone(),
            document_ref: evidence.document_ref.clone(),
            quote: evidence.quote.clone(),
            quote_digest: evidence.quote_digest.clone(),
            source_key: evidence.source_key.clone(),
            revision_token: evidence.revision_token.clone(),
        })
        .collect();

    let mut dependency_ids = HashSet::new();
    let mut dependency_set = Vec::new();
    for dependency in parent
        .material_basis
        .dependency_set
        .iter()
        .filter(|dependency| dependency.role != DependencyRole::ScopeResolution)
    {
        anyhow::ensure!(
            dependency_ids.insert(dependency.dependency_id.clone()),
            "NEX_C2B_SCOPE_AUTHORITY_DEPENDENCY_COLLISION: parent dependency ids are not unique"
        );
        dependency_set.push(TrustedDependencyEntry {
            dependency_id: dependency.dependency_id.clone(),
            input_ref: dependency.input_ref.clone(),
            context_ids: dependency.context_ids.clone(),
            role: dependency.role,
            selector: dependency.selector.clone(),
        });
    }
    anyhow::ensure!(
        dependency_ids.insert(SCOPE_AUTHORITY_DEPENDENCY_ID.to_owned()),
        "NEX_C2B_SCOPE_AUTHORITY_DEPENDENCY_COLLISION: parent already uses the reserved Scope dependency id"
    );
    dependency_set.push(TrustedDependencyEntry {
        dependency_id: SCOPE_AUTHORITY_DEPENDENCY_ID.to_owned(),
        input_ref: authority_source_key.to_owned(),
        context_ids: vec![SCOPE_AUTHORITY_CONTEXT_ID.to_owned()],
        role: DependencyRole::ScopeResolution,
        selector: DependencySelector::WholeSource,
    });

    Ok(TrustedHumanMaterialResolution {
        project_id: context.project_id.clone(),
        parent_revision_id: context.parent_revision_id.clone(),
        expected_parent_envelope_digest: context.expected_parent_envelope_digest.clone(),
        scene_ref: context.scene_ref.clone(),
        edited_document_ref: context.edited_document_ref.clone(),
        source_basis,
        evidence_set,
        dependency_set,
    })
}

pub(crate) fn create_human_derived_revision_with_c2b_projection_materialization(
    db: &Database,
    trusted_project_id: &str,
    request: CreateHumanDerivedRevisionRequest,
    derivation_kind: HumanMaterialDerivationKind,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            create_human_derived_revision_with_c2b_projection_materialization_in_tx(
                conn,
                trusted_project_id,
                &request,
                Some(derivation_kind),
            )
        })
    })
}

fn create_human_derived_revision_with_c2b_projection_materialization_in_tx(
    conn: &Connection,
    trusted_project_id: &str,
    request: &CreateHumanDerivedRevisionRequest,
    requested_kind: Option<HumanMaterialDerivationKind>,
) -> anyhow::Result<Value> {
    let admission = admit_projection_parent(conn, trusted_project_id, request, requested_kind)?;
    let trusted_material_basis = (admission.actual_kind
        == HumanMaterialDerivationKind::ScopeOverride)
        .then_some(&admission.material_basis);
    let mut saved = human_derivation::create_human_derived_revision_in_tx_with_authorities(
        conn,
        trusted_project_id,
        None,
        admission.scope_projection.as_ref(),
        trusted_material_basis,
        request,
    )?;
    let child_receipt: HumanRevisionReceiptProjection = serde_json::from_value(saved.clone())
        .context("NEX_C2B_CHILD_RECEIPT_INVALID: C2A did not return a typed child revision")?;
    anyhow::ensure!(
        !child_receipt.revision_id.trim().is_empty(),
        "NEX_C2B_CHILD_RECEIPT_INVALID: child revision id is empty"
    );

    let (child_envelope_json, child_created_at): (Option<String>, String) = conn
        .query_row(
            "SELECT reconciliation_envelope_json, created_at
                       FROM narrative_proposal_revisions
                      WHERE id = ?1 AND proposal_id = ?2",
            params![child_receipt.revision_id, admission.proposal_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .context("NEX_C2B_CHILD_REVISION_INVALID: persisted child revision is missing")?;
    let child_envelope: EnvelopeMaterialProjection = serde_json::from_str(
        child_envelope_json
            .as_deref()
            .ok_or_else(|| anyhow!("NEX_C2B_CHILD_ENVELOPE_INVALID: child Envelope is missing"))?,
    )
    .context("NEX_C2B_CHILD_ENVELOPE_INVALID: typed material projection failed")?;
    anyhow::ensure!(
                child_envelope.effective_material_basis == admission.material_basis,
                "NEX_C2B_CHILD_MATERIAL_MISMATCH: child Envelope material differs from the admitted projection"
            );

    let child_source_basis = load_source_basis_rows(conn, &child_receipt.revision_id)?;
    record_revision_dependency_edges_in_tx(
        conn,
        trusted_project_id,
        &admission.run_id,
        &child_receipt.revision_id,
        &child_source_basis,
        &child_created_at,
    )?;

    let d1_projection = project_d1_declaration_set(
        &admission.material_basis,
        &D1ParentAuthority {
            project_id: trusted_project_id.to_owned(),
            consumer_kind: PROPOSAL_REVISION_CONSUMER_KIND.to_owned(),
            consumer_key: child_receipt.revision_id.clone(),
            producer_id: D1_PRODUCER_ID.to_owned(),
            producer_generation: PROPOSAL_REVISION_D1_PRODUCER_GENERATION,
        },
    )?;
    write_dependency_declaration_set_in_tx(
        conn,
        DependencyDeclarationSetRequest {
            project_id: d1_projection.project_id,
            consumer_kind: d1_projection.consumer_kind,
            consumer_key: d1_projection.consumer_key,
            producer_id: d1_projection.producer_id,
            producer_generation: d1_projection.producer_generation,
            expected_head_version: 0,
            declarations: d1_projection.declarations,
            created_at: child_created_at.clone(),
        },
    )?;

    let child_edges = find_edges_by_consumer(
        conn,
        trusted_project_id,
        PROPOSAL_REVISION_CONSUMER_KIND,
        &child_receipt.revision_id,
    )?;
    let edges_and_observations = child_edges
        .iter()
        .map(|edge| {
            Ok((
                edge.id.clone(),
                evaluate_edge_from_db(conn, trusted_project_id, &admission.run_id, edge)?,
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    super::publish_runtime::publish_complete_runless_freshness_in_tx(
        conn,
        trusted_project_id,
        PROPOSAL_REVISION_CONSUMER_KIND,
        &child_receipt.revision_id,
        &edges_and_observations,
        &admission.semantic_epoch_id,
        &child_created_at,
    )?;

    let payload_json = canonical_json_string(&request.proposal_payload)?;
    let updated = conn.execute(
        "UPDATE narrative_proposals
                    SET payload_json = ?1,
                        current_revision_id = ?2,
                        status = 'unreviewed',
                        updated_at = ?3
                  WHERE id = ?4
                    AND current_revision_id = ?5",
        params![
            payload_json,
            child_receipt.revision_id,
            child_created_at,
            admission.proposal_id,
            admission.parent_revision_id,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_PROPOSAL_REVISION_CONFLICT: current revision changed concurrently"
    );
    let saved_object = saved
        .as_object_mut()
        .ok_or_else(|| anyhow!("NEX_C2B_CHILD_RECEIPT_INVALID: C2A receipt is not an object"))?;
    saved_object.insert(
        "currentRevisionId".to_owned(),
        Value::String(child_receipt.revision_id),
    );
    Ok(saved)
}

/// C3 production entry point. Native classifies the edited payload against the
/// persisted parent before selecting projection-only versus ScopeOverride;
/// renderer input never supplies a derivation kind.
pub(crate) fn create_human_derived_revision_with_c2b_projection_materialization_auto(
    db: &Database,
    trusted_project_id: &str,
    request: CreateHumanDerivedRevisionRequest,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            create_human_derived_revision_with_c2b_projection_materialization_in_tx(
                conn,
                trusted_project_id,
                &request,
                None,
            )
        })
    })
}
