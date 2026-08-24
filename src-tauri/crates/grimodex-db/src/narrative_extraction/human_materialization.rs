//! C2B Human-derived projection materialization seam.
//!
//! This domain entry point composes the dormant C2A revision writer with the
//! C2B material authorities in one Native-owned transaction. Scope override
//! remains unavailable until its Registry/Oracle sources are ratified.

use anyhow::{anyhow, Context};
use grimodex_core::canonical_json_string;
use grimodex_core::narrative_ir::{
    classify_chronicle_scene_event_changes, ChronicleChangeDisposition,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use super::declaration_storage::{
    read_active_dependency_declaration_set_in_tx, write_dependency_declaration_set_in_tx,
    ActiveDependencyDeclarationSetRead, DependencyDeclarationSetRequest,
};
use super::dependency_edges::find_edges_by_consumer;
use super::human_derivation;
use super::human_material_basis::{
    project_d1_declaration_set, resolve_human_material_basis, D1ParentAuthority,
    HumanMaterialDerivationKind, HumanMaterialParentBundle, HumanMaterialResolutionContext,
    MaterialBasis, V1PersistedEdge, D1_PRODUCER_ID,
};
use super::models::CreateHumanDerivedRevisionRequest;
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
}

fn admit_projection_parent(
    conn: &Connection,
    trusted_project_id: &str,
    request: &CreateHumanDerivedRevisionRequest,
    requested_kind: HumanMaterialDerivationKind,
) -> anyhow::Result<ProjectionAdmission> {
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
    anyhow::ensure!(
        actual_kind == requested_kind,
        "NEX_C2B_DERIVATION_KIND_MISMATCH: caller derivation kind does not match Native classification"
    );
    if actual_kind == HumanMaterialDerivationKind::ScopeOverride {
        return Err(anyhow!(
            "NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE: Native scope authority is not available for C2B materialization"
        ));
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
    let resolution = resolve_human_material_basis(
        HumanMaterialDerivationKind::ProjectionOnly,
        &parent,
        &context,
        None,
    )?;
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
    })
}

pub(crate) fn create_human_derived_revision_with_c2b_projection_materialization(
    db: &Database,
    trusted_project_id: &str,
    request: CreateHumanDerivedRevisionRequest,
    derivation_kind: HumanMaterialDerivationKind,
) -> anyhow::Result<Value> {
    if derivation_kind == HumanMaterialDerivationKind::ScopeOverride {
        return Err(anyhow!(
            "NEX_C2B_SCOPE_AUTHORITY_UNAVAILABLE: Native scope authority is not available for C2B materialization"
        ));
    }

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            let admission =
                admit_projection_parent(conn, trusted_project_id, &request, derivation_kind)?;
            let mut saved = human_derivation::create_human_derived_revision_in_tx(
                conn,
                trusted_project_id,
                None,
                &request,
            )?;
            let child_receipt: HumanRevisionReceiptProjection =
                serde_json::from_value(saved.clone()).context(
                    "NEX_C2B_CHILD_RECEIPT_INVALID: C2A did not return a typed child revision",
                )?;
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
                child_envelope_json.as_deref().ok_or_else(|| {
                    anyhow!("NEX_C2B_CHILD_ENVELOPE_INVALID: child Envelope is missing")
                })?,
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
                        evaluate_edge_from_db(
                            conn,
                            trusted_project_id,
                            &admission.run_id,
                            edge,
                        )?,
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
            let saved_object = saved.as_object_mut().ok_or_else(|| {
                anyhow!("NEX_C2B_CHILD_RECEIPT_INVALID: C2A receipt is not an object")
            })?;
            saved_object.insert(
                "currentRevisionId".to_owned(),
                Value::String(child_receipt.revision_id),
            );
            Ok(saved)
        })
    })
}
