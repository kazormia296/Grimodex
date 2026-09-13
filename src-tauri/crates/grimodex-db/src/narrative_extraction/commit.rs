//! Atomic narrative apply commit engine (prepare / apply / status).

use chrono::Utc;
use grimodex_core::narrative_ir::validate_chronicle_scene_event_proposal_payload;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use uuid::Uuid;

use super::application_contributions::{
    contribution_target_identity_for_application, record_contribution_in_tx, ContributionField,
    ContributionProvenance, ContributionTargetState, FieldAuthorityCoordinate,
};
use super::c2zc_canonical_cutover::{
    is_generic_freshness_canonical, write_application_dependencies_in_tx,
};
use super::change_feed::{
    append_narrative_change_transaction_in_tx, events_from_journal_entities,
    journal_op_kind_wrote_nothing, AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind,
    NarrativeChangeOrigin,
};
use super::chronicle_operations::{
    apply_chronicle_event_create, ensure_event_id_available, ensure_order_neighbor,
    ensure_scene_versions, generate_append_ordinals, parse_event_create_payload,
    ChronicleEventCreateContext,
};
use super::codex_operations::{
    apply_codex_entity_bind_existing, apply_codex_entry_create, apply_codex_entry_patch,
    apply_codex_relation_create_in_tx, ensure_entry_id_available, ensure_entry_version,
    ensure_operation_kind, is_chronicle_op, parse_entity_bind_existing_payload,
    parse_entry_create_payload, parse_entry_patch_payload, parse_relation_create_payload,
    CodexEntityBinding, CommitMap, ForeshadowBinding, PlotThreadBinding,
    OP_KIND_ENTITY_BIND_EXISTING, OP_KIND_ENTRY_CREATE, OP_KIND_ENTRY_PATCH, OP_KIND_EVENT_CREATE,
    OP_KIND_RELATION_CREATE,
};
use super::detail_operations::{
    apply_detail_value_set_in_tx, parse_detail_value_set_payload, OP_KIND_DETAIL_VALUE_SET,
};
use super::field_authority::{
    affected_fields, load_decision_authority, record_operation_field_authority,
    validate_operation_field_authority,
};
use super::foreshadow_operations::{
    apply_create as apply_foreshadow_create, apply_patch as apply_foreshadow_patch,
    ensure_id_available as ensure_foreshadow_id_available,
    ensure_version as ensure_foreshadow_version, parse_create as parse_foreshadow_create,
    parse_patch as parse_foreshadow_patch, OP_KIND_FORESHADOW_AGGREGATE_CREATE,
    OP_KIND_FORESHADOW_AGGREGATE_PATCH,
};
use super::incremental_freshness::initialize_application_freshness_in_tx;
use super::models::{
    ApplyCommitPayload, CommitApplicationRef, CommitOperation, EntityBindingSeed,
    GetCommitStatusPayload, PrepareCommitPayload,
};
use super::phase_operations::{
    apply_phase_create_in_tx, apply_phase_patch_in_tx, parse_phase_create_payload,
    parse_phase_patch_payload, OP_KIND_PHASE_CREATE, OP_KIND_PHASE_PATCH,
};
use super::plot_thread_operations::{
    apply_plot_branch_create_in_tx, apply_plot_marker_create_in_tx, apply_plot_thread_create_in_tx,
    apply_plot_thread_patch_in_tx, ensure_branch_id_available, ensure_marker_id_available,
    ensure_thread_id_available, ensure_thread_version, parse_plot_branch_create_payload,
    parse_plot_marker_create_payload, parse_plot_thread_create_payload,
    parse_plot_thread_patch_payload, OP_KIND_PLOT_BRANCH_CREATE, OP_KIND_PLOT_MARKER_CREATE,
    OP_KIND_PLOT_THREAD_CREATE, OP_KIND_PLOT_THREAD_PATCH,
};
use super::reconciliation_envelope::{
    envelope_schema_version, load_read_set_rows, load_source_basis_rows,
    validate_reconciliation_envelope, SourceBasisRow, ORIGIN_ENVELOPED,
};
use super::repository::{
    current_chronicle_revision_requires_probable_duplicate_review,
    current_chronicle_run_spec_for_run, ensure_proposal_not_applied, ensure_run_project,
    load_current_chronicle_proposal_matches, load_verified_chronicle_revision_review_authority,
    load_verified_chronicle_snapshot_for_apply, validate_current_chronicle_live_catalog,
};
use super::semantic_bindings::{
    apply_semantic_binding_upsert_in_tx, parse_semantic_binding_upsert_payload,
    OP_KIND_SEMANTIC_BINDING_UPSERT,
};
use super::source_revision::resolve_source_revision;
use super::task_leases::with_immediate_transaction;
use super::temporal_constraints::{
    apply_constraint_create_in_tx, parse_constraint_create_payload, OP_KIND_CONSTRAINT_CREATE,
};
use super::temporal_nodes::{
    apply_node_ensure_in_tx, parse_node_ensure_payload, OP_KIND_NODE_ENSURE,
};
use super::temporal_operations::{
    apply_event_metadata_patch_in_tx, apply_scene_metadata_patch_in_tx,
    apply_story_order_materialize_in_tx, ensure_calendar_version,
    parse_event_metadata_patch_payload, parse_scene_metadata_patch_payload,
    parse_story_order_materialize_payload, OP_KIND_EVENT_METADATA_PATCH,
    OP_KIND_SCENE_METADATA_PATCH, OP_KIND_STORY_ORDER_MATERIALIZE,
};
use super::temporal_projections::{
    apply_projection_record_in_tx, parse_projection_record_payload, OP_KIND_PROJECTION_RECORD,
};
use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::narrative_runtime_policy::{
    load_narrative_runtime_policy, require_narrative_apply_allowed,
    validate_narrative_apply_authority_in_tx,
};
use crate::Database;

const STATUS_PREPARED: &str = "prepared";
const STATUS_APPLIED: &str = "applied";
const STATUS_UNDONE: &str = "undone";
const STATUS_REDONE: &str = "redone";
const STATUS_FAILED: &str = "failed";
const STATUS_INVALIDATED: &str = "invalidated";

struct CommitPlanValidationContext<'a> {
    expected_calendar_version: Option<i64>,
    project_id: &'a str,
    run_id: &'a str,
    proposal_set_id: &'a str,
    operations: &'a [CommitOperation],
    applications: &'a [CommitApplicationRef],
    expected_tail_ordinal: Option<&'a str>,
    entity_bindings: &'a [EntityBindingSeed],
}

/// Transaction-local authority for compiling every current Chronicle Event
/// operation in one commit plan. The constructor performs the expensive full
/// Snapshot verification once; proposal-specific compilation only reads this
/// immutable document map.
struct VerifiedChronicleCommitDocumentAuthority {
    project_id: String,
    run_id: String,
    documents: HashMap<String, (String, u64)>,
}

#[derive(Clone, Copy)]
enum ChronicleCommitPlanAuthority<'a> {
    NonCurrent,
    Current(&'a VerifiedChronicleCommitDocumentAuthority),
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SealedSourceContract {
    revision_envelope_digest: String,
    aggregate_source_basis_digest: String,
    aggregate_read_set_digest: String,
}

pub fn narrative_extraction_prepare_commit(
    db: &Database,
    payload: PrepareCommitPayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_apply_allowed(conn)?;
            let mut sealed_plan = sealed_plan_json(&payload)?;
            let plan_digest = digest_plan(&json!({
                "operations": payload.operations,
                "applications": payload.applications,
                "entityBindings": payload.entity_bindings,
                "expectedTailOrdinal": payload.expected_tail_ordinal,
                "expectedCalendarVersion": payload.expected_calendar_version,
            }));
            sealed_plan["planDigest"] = Value::String(plan_digest.clone());
            if let Some(existing) =
                load_commit_by_request(conn, &payload.project_id, &payload.request_id)?
            {
                if existing.plan_digest != plan_digest {
                    anyhow::bail!(
                        "NEX_COMMIT_IDEMPOTENCY_CONFLICT: request id reused with different planDigest"
                    );
                }
                return Ok(json!({
                    "ok": true,
                    "preparedCommitId": existing.commit_id,
                    "requestId": existing.request_id,
                    "planDigest": existing.plan_digest,
                    "authorityDigest": existing.authority_digest,
                    "operationCount": payload.operations.len(),
                    "status": existing.status,
                    "version": existing.version,
                    "idempotentReplay": true,
                }));
            }
            let validation_ctx = CommitPlanValidationContext {
                expected_calendar_version: payload.expected_calendar_version,
                project_id: &payload.project_id,
                run_id: &payload.run_id,
                proposal_set_id: &payload.proposal_set_id,
                operations: &payload.operations,
                applications: &payload.applications,
                expected_tail_ordinal: payload.expected_tail_ordinal.as_deref(),
                entity_bindings: &payload.entity_bindings,
            };
            validate_current_chronicle_apply_coverage(conn, &validation_ctx)?;
            // The Existing Event Catalog is an input to match/safety, but is
            // not part of each Proposal's Source Basis. Recheck its Native
            // authority in this same transaction before a prepared Commit row
            // can make stale `noDuplicate` evidence durable. Only the exact-set
            // review/coverage gate intentionally precedes this check so a
            // legacy partial Apply is reported as an unusable partial set;
            // ordinary plan validation retains catalog-drift precedence.
            validate_current_chronicle_live_catalog(
                conn,
                &payload.project_id,
                &payload.run_id,
            )?;
            validate_commit_plan(conn, validation_ctx)?;
            let applications = application_pairs(&payload.applications);
            validate_narrative_apply_authority_in_tx(
                conn,
                &payload.proposal_set_id,
                &applications,
            )?;
            let validation_commit_map = build_validation_commit_map(
                &payload.entity_bindings,
                &payload.operations,
            )?;
            validate_operation_field_authority(
                conn,
                &payload.project_id,
                &applications,
                &payload.operations,
                &validation_commit_map,
            )?;
            let authority_digest =
                digest_authority_rows(conn, &payload.proposal_set_id, &applications)?;
            let source_contract = build_source_contract(
                conn,
                &payload.project_id,
                &payload.run_id,
                &applications,
            )?;
            validate_retraction_targets(
                conn,
                &payload.project_id,
                &applications,
                &payload.operations,
            )?;
            sealed_plan["sourceContract"] = serde_json::to_value(&source_contract)?;
            let prepared_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
            let policy_version = load_narrative_runtime_policy(conn).version;
            let prepared_commit_id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO narrative_apply_commits
                    (id, project_id, run_id, proposal_set_id, request_id, plan_digest,
                     status, receipt_json, error_message, prepared_plan_json,
                     prepared_policy_version, prepared_at, authority_digest, session_id,
                     created_at, completed_at, version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?9, ?10, ?11, ?12, ?10, NULL, 0)",
                params![
                    prepared_commit_id,
                    payload.project_id,
                    payload.run_id,
                    payload.proposal_set_id,
                    payload.request_id,
                    plan_digest,
                    STATUS_PREPARED,
                    sealed_plan.to_string(),
                    policy_version,
                    prepared_at,
                    authority_digest,
                    payload.session_id,
                ],
            )?;
            Ok(json!({
                "ok": true,
                "preparedCommitId": prepared_commit_id,
                "requestId": payload.request_id,
                "planDigest": plan_digest,
                "authorityDigest": authority_digest,
                "operationCount": payload.operations.len(),
                "status": STATUS_PREPARED,
                "version": 0,
            }))
        })
    })
}

fn sealed_plan_json(payload: &PrepareCommitPayload) -> anyhow::Result<Value> {
    let plan_fragments: Vec<Value> = payload
        .operations
        .iter()
        .map(|operation| {
            let fragment = json!({
                "proposalId": operation.proposal_id,
                "revisionId": operation.revision_id,
                "kind": operation.kind,
                "payload": operation.payload,
            });
            json!({
                "proposalId": operation.proposal_id,
                "revisionId": operation.revision_id,
                "fragment": fragment,
                "fragmentDigest": digest_plan(&fragment),
            })
        })
        .collect();
    Ok(json!({
        "requestId": payload.request_id,
        "sessionId": payload.session_id,
        "operations": payload.operations,
        "applications": payload.applications,
        "entityBindings": payload.entity_bindings,
        "expectedTailOrdinal": payload.expected_tail_ordinal,
        "expectedCalendarVersion": payload.expected_calendar_version,
        "projectId": payload.project_id,
        "runId": payload.run_id,
        "proposalSetId": payload.proposal_set_id,
        "surface": payload.surface,
        "planFragments": plan_fragments,
    }))
}

fn application_pairs(applications: &[CommitApplicationRef]) -> Vec<(String, String)> {
    applications
        .iter()
        .map(|application| {
            (
                application.proposal_id.clone(),
                application.revision_id.clone(),
            )
        })
        .collect()
}

fn build_validation_commit_map(
    seeds: &[EntityBindingSeed],
    operations: &[CommitOperation],
) -> anyhow::Result<CommitMap> {
    let mut commit_map = CommitMap::new();
    for seed in seeds {
        commit_map.insert_binding(CodexEntityBinding {
            narrative_entity_id: seed.narrative_entity_id.clone(),
            codex_entry_id: seed.codex_entry_id.clone(),
            source: if seed.source.is_empty() {
                "existing".to_string()
            } else {
                seed.source.clone()
            },
        })?;
    }
    for operation in operations {
        match operation.kind.as_str() {
            OP_KIND_ENTRY_CREATE => {
                let value = parse_entry_create_payload(&operation.payload)?;
                if let Some(narrative_entity_id) = value.narrative_entity_id {
                    commit_map.insert_binding(CodexEntityBinding {
                        narrative_entity_id,
                        codex_entry_id: value.entry_id,
                        source: "created".to_string(),
                    })?;
                }
            }
            OP_KIND_ENTRY_PATCH => {
                let value = parse_entry_patch_payload(&operation.payload)?;
                if let Some(narrative_entity_id) = value.narrative_entity_id {
                    commit_map.insert_binding(CodexEntityBinding {
                        narrative_entity_id,
                        codex_entry_id: value.entry_id,
                        source: "existing".to_string(),
                    })?;
                }
            }
            OP_KIND_ENTITY_BIND_EXISTING => {
                let value = parse_entity_bind_existing_payload(&operation.payload)?;
                commit_map.insert_binding(CodexEntityBinding {
                    narrative_entity_id: value.narrative_entity_id,
                    codex_entry_id: value.entry_id,
                    source: "existing".to_string(),
                })?;
            }
            _ => {}
        }
    }
    Ok(commit_map)
}

fn digest_authority_rows(
    conn: &Connection,
    _proposal_set_id: &str,
    applications: &[(String, String)],
) -> anyhow::Result<String> {
    let mut rows = Vec::with_capacity(applications.len());
    for (proposal_id, revision_id) in applications {
        let decision: String = conn.query_row(
            "SELECT decision
               FROM narrative_proposal_decisions
              WHERE proposal_id = ?1 AND revision_id = ?2
              ORDER BY created_at DESC, rowid DESC
              LIMIT 1",
            params![proposal_id, revision_id],
            |row| row.get(0),
        )?;
        let authority = load_decision_authority(conn, proposal_id, revision_id)?;
        rows.push(json!({
            "proposalId": proposal_id,
            "revisionId": revision_id,
            "decision": decision,
            "actorKind": authority.actor_kind,
            "actorId": authority.actor_id,
            "authorityScope": authority.authority_scope,
            "overrideFieldPaths": authority.override_field_paths,
        }));
    }
    rows.sort_by(|left, right| {
        (
            left["proposalId"].as_str().unwrap_or_default(),
            left["revisionId"].as_str().unwrap_or_default(),
            left["decision"].as_str().unwrap_or_default(),
        )
            .cmp(&(
                right["proposalId"].as_str().unwrap_or_default(),
                right["revisionId"].as_str().unwrap_or_default(),
                right["decision"].as_str().unwrap_or_default(),
            ))
    });
    Ok(digest_plan(&Value::Array(rows)))
}

fn build_source_contract(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    applications: &[(String, String)],
) -> anyhow::Result<SealedSourceContract> {
    let mut revision_rows = Vec::with_capacity(applications.len());
    let mut source_rows = Vec::new();
    let mut read_rows = Vec::new();

    for (proposal_id, revision_id) in applications {
        let (origin_kind, stored_digest, stored_json): (String, Option<String>, Option<String>) =
            conn.query_row(
                "SELECT origin_kind, reconciliation_envelope_digest,
                        reconciliation_envelope_json
                   FROM narrative_proposal_revisions
                  WHERE id = ?1 AND proposal_id = ?2",
                params![revision_id, proposal_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        anyhow::ensure!(
            origin_kind == ORIGIN_ENVELOPED,
            "NEX_REVISION_LEGACY_UNBOUND: proposal '{proposal_id}' revision '{revision_id}' is not envelope-bound"
        );
        let stored_digest = stored_digest.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_REVISION_ENVELOPE_MISSING: proposal '{proposal_id}' revision '{revision_id}' has no envelope digest"
            )
        })?;
        let stored_json = stored_json.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_REVISION_ENVELOPE_MISSING: proposal '{proposal_id}' revision '{revision_id}' has no envelope JSON"
            )
        })?;
        let envelope: Value = serde_json::from_str(&stored_json)?;
        let validated =
            validate_reconciliation_envelope(conn, project_id, run_id, Some(&envelope))?
                .ok_or_else(|| {
                    anyhow::anyhow!("NEX_REVISION_ENVELOPE_MISSING: envelope was empty")
                })?;
        anyhow::ensure!(
            validated.digest == stored_digest && validated.canonical_json == stored_json,
            "NEX_REVISION_ENVELOPE_CHANGED: persisted envelope canonical bytes do not match its digest"
        );

        let persisted_source_basis = load_source_basis_rows(conn, revision_id)?;
        ensure_source_basis_storage_matches(&validated.source_basis, &persisted_source_basis)?;
        revision_rows.push(json!({
            "proposalId": proposal_id,
            "revisionId": revision_id,
            "envelopeDigest": stored_digest,
        }));

        for source in &persisted_source_basis {
            let current = resolve_source_revision(
                conn,
                project_id,
                run_id,
                &source.source_kind,
                &source.source_key,
            )?;
            anyhow::ensure!(
                current.revision_token == source.revision_token,
                "NEX_SOURCE_BASIS_STALE: source '{}' expected '{}' but found '{}'",
                source.source_key,
                source.revision_token,
                current.revision_token
            );
            source_rows.push(json!({
                "proposalId": proposal_id,
                "revisionId": revision_id,
                "ordinal": source.ordinal,
                "sourceKind": source.source_kind,
                "sourceKey": source.source_key,
                "revisionToken": source.revision_token,
            }));
        }

        if envelope_schema_version(&envelope) == Some(2) {
            for row in super::v2_apply_sources::load_v2_apply_sources(
                conn,
                project_id,
                run_id,
                revision_id,
                &envelope,
            )? {
                read_rows.push(json!({
                    "proposalId": proposal_id, "revisionId": revision_id,
                    "inputRef": row.source_key, "kind": row.source_kind,
                    "revisionToken": row.revision_token,
                }));
            }
            continue;
        }
        let read_set = envelope
            .get("readSet")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("NEX_READ_SET_DRIFT: persisted readSet is missing"))?;
        for entry in read_set {
            let object = entry.as_object().ok_or_else(|| {
                anyhow::anyhow!("NEX_READ_SET_DRIFT: persisted readSet entry is not an object")
            })?;
            let input_ref = object
                .get("inputRef")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("NEX_READ_SET_DRIFT: inputRef is missing"))?;
            let kind = object
                .get("kind")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("NEX_READ_SET_DRIFT: read-set kind is missing"))?;
            let source_kind = object
                .get("sourceKind")
                .and_then(Value::as_str)
                .map(Ok)
                .unwrap_or_else(|| source_kind_for_read_set(kind))?;
            let current =
                resolve_source_revision(conn, project_id, run_id, source_kind, input_ref)?;
            if let Some(expected) = object.get("revisionToken").and_then(Value::as_str) {
                anyhow::ensure!(
                    current.revision_token == expected,
                    "NEX_READ_SET_STALE: input '{}' expected '{}' but found '{}'",
                    input_ref,
                    expected,
                    current.revision_token
                );
            }
            read_rows.push(json!({
                "proposalId": proposal_id,
                "revisionId": revision_id,
                "inputRef": input_ref,
                "kind": kind,
                "revisionToken": current.revision_token,
            }));
        }
    }

    sort_contract_rows(&mut revision_rows, &["proposalId", "revisionId"]);
    sort_contract_rows(&mut source_rows, &["proposalId", "revisionId", "ordinal"]);
    sort_contract_rows(
        &mut read_rows,
        &["proposalId", "revisionId", "inputRef", "kind"],
    );
    Ok(SealedSourceContract {
        revision_envelope_digest: digest_contract_value(&Value::Array(revision_rows)),
        aggregate_source_basis_digest: digest_contract_value(&Value::Array(source_rows)),
        aggregate_read_set_digest: digest_contract_value(&Value::Array(read_rows)),
    })
}

fn ensure_source_basis_storage_matches(
    envelope_rows: &[SourceBasisRow],
    persisted_rows: &[SourceBasisRow],
) -> anyhow::Result<()> {
    anyhow::ensure!(
        envelope_rows.len() == persisted_rows.len(),
        "NEX_SOURCE_BASIS_STORAGE_MISMATCH: normalized source-basis row count differs"
    );
    for (envelope, persisted) in envelope_rows.iter().zip(persisted_rows) {
        anyhow::ensure!(
            envelope.ordinal == persisted.ordinal
                && envelope.source_kind == persisted.source_kind
                && envelope.source_key == persisted.source_key
                && envelope.revision_token == persisted.revision_token
                && envelope.observed_at == persisted.observed_at,
            "NEX_SOURCE_BASIS_STORAGE_MISMATCH: normalized source-basis row differs from envelope"
        );
    }
    Ok(())
}

fn validate_retraction_targets(
    conn: &Connection,
    project_id: &str,
    applications: &[(String, String)],
    operations: &[CommitOperation],
) -> anyhow::Result<()> {
    anyhow::ensure!(
        applications.len() == operations.len(),
        "NEX_RETRACTION_APPLICATIONS_MISMATCH: operation/application counts differ"
    );
    for ((proposal_id, revision_id), operation) in applications.iter().zip(operations) {
        let (change_kind, target) = load_retraction_metadata(conn, proposal_id, revision_id)?;
        if change_kind != "retract" {
            continue;
        }
        let target = target.ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_RETRACTION_TARGET_REQUIRED: retract revision '{revision_id}' has no target application"
            )
        })?;
        let target_row: Option<(String, String, String, String, String)> = conn
            .query_row(
                "SELECT c.project_id, a.revision_id, a.application_kind,
                        a.applied_entity_kind, a.applied_entity_id
                   FROM narrative_proposal_applications a
                   INNER JOIN narrative_apply_commits c ON c.id = a.commit_id
                  WHERE a.id = ?1",
                params![target],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            target_project_id,
            target_revision_id,
            target_kind,
            target_entity_kind,
            target_entity_id,
        )) = target_row
        else {
            anyhow::bail!(
                "NEX_RETRACTION_TARGET_MISSING: target application '{target}' is not applied"
            );
        };
        anyhow::ensure!(
            target_project_id == project_id,
            "NEX_RETRACTION_TARGET_PROJECT_MISMATCH: target application belongs to another project"
        );
        anyhow::ensure!(
            target_kind == "normal",
            "NEX_RETRACTION_TARGET_INVALID: compensation must target a normal application"
        );
        anyhow::ensure!(
            target_revision_id != revision_id.as_str(),
            "NEX_RETRACTION_TARGET_INVALID: a revision cannot compensate itself"
        );
        let already_compensated: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM narrative_proposal_applications
              WHERE application_kind = 'compensation'
                AND compensates_application_id = ?1",
            params![target],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            already_compensated == 0,
            "NEX_RETRACTION_TARGET_ALREADY_COMPENSATED: target application '{target}' already has a compensation"
        );
        anyhow::ensure!(
            !target_entity_id.is_empty(),
            "NEX_RETRACTION_TARGET_INVALID: target application '{target}' has no entity id"
        );
        validate_compensation_operation(operation, &target_entity_kind, &target_entity_id)?;
    }
    Ok(())
}

fn compensation_strategy(operation_kind: &str) -> anyhow::Result<(&'static str, &'static str)> {
    let strategy = match operation_kind {
        OP_KIND_EVENT_CREATE => ("event", "chronicle.event.retract"),
        OP_KIND_ENTRY_CREATE | OP_KIND_ENTRY_PATCH | OP_KIND_ENTITY_BIND_EXISTING => {
            ("codex_entry", "codex.entry.retract")
        }
        OP_KIND_RELATION_CREATE => ("codex_relation", "codex.relation.retract"),
        OP_KIND_DETAIL_VALUE_SET => ("codex_detail_value", "codex.detail-value.retract"),
        OP_KIND_PHASE_CREATE | OP_KIND_PHASE_PATCH => ("codex_phase", "codex.phase.retract"),
        OP_KIND_SEMANTIC_BINDING_UPSERT => {
            ("codex_semantic_binding", "codex.semantic-binding.retract")
        }
        OP_KIND_NODE_ENSURE => ("temporal_node", "temporal.node.retract"),
        OP_KIND_CONSTRAINT_CREATE => ("temporal_constraint", "temporal.constraint.retract"),
        OP_KIND_SCENE_METADATA_PATCH => (
            "temporal_scene_chronicle",
            "temporal.scene-metadata.retract",
        ),
        OP_KIND_EVENT_METADATA_PATCH => (
            "temporal_event_chronicle",
            "temporal.event-metadata.retract",
        ),
        OP_KIND_STORY_ORDER_MATERIALIZE => {
            ("temporal_scene_story_order", "temporal.story-order.retract")
        }
        OP_KIND_PROJECTION_RECORD => ("temporal_projection", "temporal.projection.retract"),
        OP_KIND_PLOT_THREAD_CREATE | OP_KIND_PLOT_THREAD_PATCH => {
            ("plot_thread", "plot.thread.retract")
        }
        OP_KIND_PLOT_MARKER_CREATE => ("plot_thread_marker", "plot.marker.retract"),
        OP_KIND_PLOT_BRANCH_CREATE => ("plot_thread_branch", "plot.branch.retract"),
        OP_KIND_FORESHADOW_AGGREGATE_CREATE | OP_KIND_FORESHADOW_AGGREGATE_PATCH => {
            ("foreshadow", "foreshadow.retract")
        }
        other => anyhow::bail!(
            "NEX_RETRACTION_OPERATION_UNSUPPORTED: operation '{other}' cannot be a compensation"
        ),
    };
    Ok(strategy)
}

fn validate_compensation_operation(
    operation: &CommitOperation,
    target_entity_kind: &str,
    target_entity_id: &str,
) -> anyhow::Result<()> {
    let (expected_entity_kind, expected_strategy) = compensation_strategy(&operation.kind)?;
    anyhow::ensure!(
        target_entity_kind == expected_entity_kind,
        "NEX_RETRACTION_OPERATION_MISMATCH: operation '{}' cannot compensate entity kind '{}' (expected '{}')",
        operation.kind,
        target_entity_kind,
        expected_entity_kind
    );
    let compensation = operation
        .payload
        .as_object()
        .and_then(|payload| payload.get("compensation"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_RETRACTION_COMPENSATION_MISSING: operation '{}' must declare a compensation strategy and targetEntityId",
                operation.kind
            )
        })?;
    let strategy = compensation
        .get("strategy")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_RETRACTION_COMPENSATION_INVALID: operation '{}' compensation strategy is missing",
                operation.kind
            )
        })?;
    let declared_target = compensation
        .get("targetEntityId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_RETRACTION_COMPENSATION_INVALID: operation '{}' compensation targetEntityId is missing",
                operation.kind
            )
        })?;
    anyhow::ensure!(
        strategy == expected_strategy,
        "NEX_RETRACTION_COMPENSATION_STRATEGY_MISMATCH: operation '{}' requires strategy '{}', got '{}'",
        operation.kind,
        expected_strategy,
        strategy
    );
    anyhow::ensure!(
        declared_target == target_entity_id,
        "NEX_RETRACTION_COMPENSATION_TARGET_MISMATCH: operation '{}' targets '{}' but compensates '{}'",
        operation.kind,
        declared_target,
        target_entity_id
    );
    Ok(())
}

fn load_retraction_metadata(
    conn: &Connection,
    proposal_id: &str,
    revision_id: &str,
) -> anyhow::Result<(String, Option<String>)> {
    let envelope_json: String = conn.query_row(
        "SELECT reconciliation_envelope_json
           FROM narrative_proposal_revisions
          WHERE id = ?1 AND proposal_id = ?2",
        params![revision_id, proposal_id],
        |row| row.get(0),
    )?;
    let envelope: Value = serde_json::from_str(&envelope_json)?;
    let object = envelope.as_object().ok_or_else(|| {
        anyhow::anyhow!("NEX_RETRACTION_ENVELOPE_INVALID: envelope is not an object")
    })?;
    if envelope_schema_version(&envelope) == Some(2) {
        super::v2_apply_sources::ensure_supported_intent(&envelope)?;
        return Ok(("add".to_string(), None));
    }
    let change_kind = object
        .get("changeKind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("NEX_RETRACTION_ENVELOPE_INVALID: changeKind is missing"))?
        .to_string();
    let target = object
        .get("targetProjectionRef")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok((change_kind, target))
}

fn source_kind_for_read_set(kind: &str) -> anyhow::Result<&'static str> {
    match kind {
        "snapshot-document" => Ok("snapshot-document"),
        "projection" => Ok("domain-projection"),
        "evidence" => Ok("evidence-anchor"),
        "signal" => anyhow::bail!(
            "NEX_SOURCE_KIND_UNSUPPORTED: signal read-set entries have no registered resolver"
        ),
        other => anyhow::bail!(
            "NEX_SOURCE_KIND_UNSUPPORTED: read-set kind '{other}' has no registered resolver"
        ),
    }
}

fn sort_contract_rows(rows: &mut [Value], fields: &[&str]) {
    rows.sort_by(|left, right| {
        fields
            .iter()
            .map(|field| left.get(*field).map(Value::to_string).unwrap_or_default())
            .cmp(
                fields
                    .iter()
                    .map(|field| right.get(*field).map(Value::to_string).unwrap_or_default()),
            )
    });
}

fn digest_contract_value(value: &Value) -> String {
    format!("sha256:{}", digest_plan(value))
}

pub fn narrative_extraction_apply_commit(
    db: &Database,
    payload: ApplyCommitPayload,
) -> anyhow::Result<Value> {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let timestamp = Utc::now().timestamp_millis();

    let apply_result = db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        with_immediate_transaction(conn, |conn| {
            let existing =
                load_commit_by_id(conn, &payload.project_id, &payload.prepared_commit_id)?
                    .ok_or_else(|| anyhow::anyhow!("prepared commit not found"))?;
            anyhow::ensure!(
                existing.request_id == payload.request_id,
                "NEX_COMMIT_REQUEST_MISMATCH: request id does not match prepared commit"
            );
            if existing.status == STATUS_APPLIED
                || existing.status == STATUS_REDONE
                || existing.status == STATUS_UNDONE
            {
                let plan_digest = existing.plan_digest.clone();
                return replay_or_conflict(existing, &plan_digest);
            }
            anyhow::ensure!(
                existing.status == STATUS_PREPARED,
                "NEX_COMMIT_NOT_PREPARED: prepared commit status is '{}'",
                existing.status
            );
            if let Some(expected_version) = payload.expected_version {
                anyhow::ensure!(
                    existing.version == expected_version,
                    "NEX_COMMIT_VERSION_MISMATCH: expected version {}, found {}",
                    expected_version,
                    existing.version
                );
            }
            if let Some(sealed_session_id) = existing.session_id.as_deref() {
                anyhow::ensure!(
                    sealed_session_id == payload.session_id,
                    "NEX_COMMIT_SESSION_MISMATCH: session does not match prepared commit"
                );
            }
            let sealed_plan_raw = existing
                .prepared_plan_json
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("prepared commit has no sealed plan"))?;
            let sealed_plan_value: Value = serde_json::from_str(sealed_plan_raw)?;
            let sealed_source_contract: SealedSourceContract = sealed_plan_value
                .get("sourceContract")
                .cloned()
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_SOURCE_CONTRACT_MISSING: prepared commit has no sealed source contract"
                    )
                })
                .and_then(|value| serde_json::from_value(value).map_err(Into::into))?;
            let sealed_plan: PrepareCommitPayload = serde_json::from_value(sealed_plan_value)?;
            require_narrative_apply_allowed(conn)?;
            let validation_ctx = CommitPlanValidationContext {
                expected_calendar_version: sealed_plan.expected_calendar_version,
                project_id: &sealed_plan.project_id,
                run_id: &sealed_plan.run_id,
                proposal_set_id: &sealed_plan.proposal_set_id,
                operations: &sealed_plan.operations,
                applications: &sealed_plan.applications,
                expected_tail_ordinal: sealed_plan.expected_tail_ordinal.as_deref(),
                entity_bindings: &sealed_plan.entity_bindings,
            };
            validate_current_chronicle_apply_coverage(conn, &validation_ctx)?;
            // Close the Prepare -> Apply writer race. A prepared plan may
            // still be byte-valid while its match-existing catalog is stale.
            // This guard runs under the Apply BEGIN IMMEDIATE and precedes
            // Event/Application/operation DML.
            validate_current_chronicle_live_catalog(
                conn,
                &sealed_plan.project_id,
                &sealed_plan.run_id,
            )?;
            validate_commit_plan(conn, validation_ctx)?;
            let applications = application_pairs(&sealed_plan.applications);
            validate_narrative_apply_authority_in_tx(
                conn,
                &sealed_plan.proposal_set_id,
                &applications,
            )?;
            let validation_commit_map =
                build_validation_commit_map(&sealed_plan.entity_bindings, &sealed_plan.operations)?;
            validate_operation_field_authority(
                conn,
                &sealed_plan.project_id,
                &applications,
                &sealed_plan.operations,
                &validation_commit_map,
            )?;
            validate_retraction_targets(
                conn,
                &sealed_plan.project_id,
                &applications,
                &sealed_plan.operations,
            )?;
            let current_authority_digest =
                digest_authority_rows(conn, &sealed_plan.proposal_set_id, &applications)?;
            anyhow::ensure!(
                existing.authority_digest.as_deref() == Some(current_authority_digest.as_str()),
                "NEX_COMMIT_AUTHORITY_CHANGED: prepared authority digest no longer matches"
            );
            let current_policy_version = load_narrative_runtime_policy(conn).version;
            anyhow::ensure!(
                existing.prepared_policy_version == Some(current_policy_version),
                "NEX_PREPARED_POLICY_CHANGED: prepared policy version no longer matches"
            );
            let current_source_contract = build_source_contract(
                conn,
                &sealed_plan.project_id,
                &sealed_plan.run_id,
                &applications,
            )?;
            anyhow::ensure!(
                current_source_contract.revision_envelope_digest
                    == sealed_source_contract.revision_envelope_digest,
                "NEX_REVISION_ENVELOPE_CHANGED: prepared revision envelope digest no longer matches"
            );
            anyhow::ensure!(
                current_source_contract.aggregate_source_basis_digest
                    == sealed_source_contract.aggregate_source_basis_digest,
                "NEX_SOURCE_BASIS_CHANGED: prepared source-basis digest no longer matches"
            );
            anyhow::ensure!(
                current_source_contract.aggregate_read_set_digest
                    == sealed_source_contract.aggregate_read_set_digest,
                "NEX_READ_SET_DRIFT: prepared read-set digest no longer matches"
            );
            let commit_id = existing.commit_id.clone();
            // Keep the existing execution loop operating on the sealed plan only.
            let payload = sealed_plan;

            let mut commit_map = CommitMap::new();
            for seed in &payload.entity_bindings {
                commit_map.insert_binding(CodexEntityBinding {
                    narrative_entity_id: seed.narrative_entity_id.clone(),
                    codex_entry_id: seed.codex_entry_id.clone(),
                    source: if seed.source.is_empty() {
                        "existing".to_string()
                    } else {
                        seed.source.clone()
                    },
                })?;
            }

            let chronicle_count = payload
                .operations
                .iter()
                .filter(|op| is_chronicle_op(&op.kind))
                .count();
            let ordinals = if chronicle_count > 0 {
                generate_append_ordinals(payload.expected_tail_ordinal.as_deref(), chronicle_count)?
            } else {
                Vec::new()
            };
            let mut ordinal_index = 0usize;

            let mut created = Vec::new();
            let mut after_snapshots = Vec::new();
            let mut scene_scope_refresh_events = Vec::new();
            let mut application_ids = Vec::with_capacity(payload.applications.len());
            // Kept so each Contribution can name the operation that produced
            // it (SCHEMA 29). 1:1 with `payload.operations` by construction,
            // the same way `application_ids` is.
            let mut operation_ids = Vec::with_capacity(payload.operations.len());
            // Same 1:1 indexing. Carried to the Contribution loop below so it
            // can tell an operation that wrote something from one that did
            // not; see `journal_op_kind_wrote_nothing`.
            let mut operation_op_kinds: Vec<&str> = Vec::with_capacity(payload.operations.len());

            for (index, op) in payload.operations.iter().enumerate() {
                ensure_operation_kind(&op.kind)?;
                let (entity_kind, entity_id, version, snapshot, before_snapshot, op_kind) = match op
                    .kind
                    .as_str()
                {
                    OP_KIND_EVENT_CREATE => {
                        let event_payload = parse_event_create_payload(&op.payload)?;
                        let ordinal = &ordinals[ordinal_index];
                        ordinal_index += 1;
                        let result = apply_chronicle_event_create(ChronicleEventCreateContext {
                            conn,
                            project_id: &payload.project_id,
                            session_id: &payload.session_id,
                            surface: payload.surface.as_deref(),
                            payload: &event_payload,
                            ordinal,
                            now: &now,
                            timestamp,
                        })?;
                        (
                            "event",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            None,
                            "create",
                        )
                    }

                    OP_KIND_ENTRY_CREATE => {
                        let entry_payload = parse_entry_create_payload(&op.payload)?;
                        let result = apply_codex_entry_create(
                            conn,
                            &payload.project_id,
                            &payload.session_id,
                            payload.surface.as_deref(),
                            &entry_payload,
                            &now,
                            timestamp,
                        )?;
                        if let Some(narrative_entity_id) =
                            entry_payload.narrative_entity_id.as_ref()
                        {
                            commit_map.insert_binding(CodexEntityBinding {
                                narrative_entity_id: narrative_entity_id.clone(),
                                codex_entry_id: result.entity_id.clone(),
                                source: "created".to_string(),
                            })?;
                        }
                        (
                            "codex_entry",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            None,
                            "create",
                        )
                    }
                    OP_KIND_ENTRY_PATCH => {
                        let patch_payload = parse_entry_patch_payload(&op.payload)?;
                        let result = apply_codex_entry_patch(
                            conn,
                            &payload.project_id,
                            &payload.session_id,
                            payload.surface.as_deref(),
                            &patch_payload,
                            &now,
                            timestamp,
                        )?;
                        if let Some(narrative_entity_id) =
                            patch_payload.narrative_entity_id.as_ref()
                        {
                            commit_map.insert_binding(CodexEntityBinding {
                                narrative_entity_id: narrative_entity_id.clone(),
                                codex_entry_id: result.entity_id.clone(),
                                source: "existing".to_string(),
                            })?;
                        }
                        (
                            "codex_entry",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            Some(result.before_snapshot),
                            "patch",
                        )
                    }
                    OP_KIND_ENTITY_BIND_EXISTING => {
                        let bind_payload = parse_entity_bind_existing_payload(&op.payload)?;
                        let (entity_id, version, snapshot) = apply_codex_entity_bind_existing(
                            conn,
                            &payload.project_id,
                            &bind_payload,
                        )?;
                        commit_map.insert_binding(CodexEntityBinding {
                            narrative_entity_id: bind_payload.narrative_entity_id.clone(),
                            codex_entry_id: entity_id.clone(),
                            source: "existing".to_string(),
                        })?;
                        (
                            "codex_entry",
                            entity_id,
                            version,
                            snapshot.clone(),
                            Some(snapshot),
                            "bind",
                        )
                    }
                    OP_KIND_RELATION_CREATE => {
                        let relation_payload = parse_relation_create_payload(&op.payload)?;
                        let result = apply_codex_relation_create_in_tx(
                            conn,
                            &payload.project_id,
                            &relation_payload,
                            &commit_map,
                            &now,
                        )?;
                        (
                            "codex_relation",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            None,
                            "create",
                        )
                    }
                    OP_KIND_DETAIL_VALUE_SET => {
                        let detail_payload = parse_detail_value_set_payload(&op.payload)?;
                        let result = apply_detail_value_set_in_tx(
                            conn,
                            &payload.project_id,
                            &detail_payload,
                            &commit_map,
                            &now,
                        )?;
                        (
                            "codex_detail_value",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            result.before_snapshot,
                            result.op_kind,
                        )
                    }
                    OP_KIND_PHASE_CREATE => {
                        let phase_payload = parse_phase_create_payload(&op.payload)?;
                        let result = apply_phase_create_in_tx(
                            conn,
                            &payload.project_id,
                            &phase_payload,
                            &commit_map,
                            &now,
                        )?;
                        (
                            "codex_phase",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            result.before_snapshot,
                            result.op_kind,
                        )
                    }
                    OP_KIND_PHASE_PATCH => {
                        let phase_payload = parse_phase_patch_payload(&op.payload)?;
                        let result = apply_phase_patch_in_tx(
                            conn,
                            &payload.project_id,
                            &phase_payload,
                            &now,
                        )?;
                        (
                            "codex_phase",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            result.before_snapshot,
                            result.op_kind,
                        )
                    }
                    OP_KIND_SEMANTIC_BINDING_UPSERT => {
                        let binding_payload = parse_semantic_binding_upsert_payload(&op.payload)?;
                        let result = apply_semantic_binding_upsert_in_tx(
                            conn,
                            &payload.project_id,
                            &binding_payload,
                            &now,
                        )?;
                        (
                            "codex_semantic_binding",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            result.before_snapshot,
                            result.op_kind,
                        )
                    }
                    OP_KIND_NODE_ENSURE => {
                        let node_payload = parse_node_ensure_payload(&op.payload)?;
                        let result = apply_node_ensure_in_tx(
                            conn,
                            &payload.project_id,
                            &node_payload,
                            &now,
                        )?;
                        (
                            "temporal_node",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            None,
                            if result.created {
                                "create"
                            } else {
                                "ensure-existing"
                            },
                        )
                    }
                    OP_KIND_CONSTRAINT_CREATE => {
                        let constraint_payload = parse_constraint_create_payload(&op.payload)?;
                        let result = apply_constraint_create_in_tx(
                            conn,
                            &payload.project_id,
                            &constraint_payload,
                            &now,
                        )?;
                        (
                            "temporal_constraint",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            None,
                            "create",
                        )
                    }
                    OP_KIND_SCENE_METADATA_PATCH => {
                        let scene_payload = parse_scene_metadata_patch_payload(&op.payload)?;
                        let result = apply_scene_metadata_patch_in_tx(
                            conn,
                            &payload.project_id,
                            &scene_payload,
                            &now,
                        )?;
                        if let Some(event) = result.scope_refresh_event.clone() {
                            scene_scope_refresh_events.push(event);
                        }
                        (
                            "temporal_scene_chronicle",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            Some(result.before_snapshot),
                            "patch",
                        )
                    }
                    OP_KIND_EVENT_METADATA_PATCH => {
                        let event_payload = parse_event_metadata_patch_payload(&op.payload)?;
                        let result = apply_event_metadata_patch_in_tx(
                            conn,
                            &payload.project_id,
                            &event_payload,
                            &now,
                        )?;
                        (
                            "temporal_event_chronicle",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            Some(result.before_snapshot),
                            "patch",
                        )
                    }
                    OP_KIND_STORY_ORDER_MATERIALIZE => {
                        let story_order_payload =
                            parse_story_order_materialize_payload(&op.payload)?;
                        let result = apply_story_order_materialize_in_tx(
                            conn,
                            &payload.project_id,
                            &story_order_payload,
                            &now,
                        )?;
                        if let Some(event) = result.scope_refresh_event.clone() {
                            scene_scope_refresh_events.push(event);
                        }
                        (
                            "temporal_scene_story_order",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            Some(result.before_snapshot),
                            "patch",
                        )
                    }
                    OP_KIND_PROJECTION_RECORD => {
                        let projection_payload = parse_projection_record_payload(&op.payload)?;
                        let result = apply_projection_record_in_tx(
                            conn,
                            &payload.project_id,
                            &projection_payload,
                            &now,
                        )?;
                        (
                            "temporal_projection",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            result.before_snapshot,
                            result.op_kind,
                        )
                    }

                    OP_KIND_PLOT_THREAD_CREATE => {
                        let thread_payload = parse_plot_thread_create_payload(&op.payload)?;
                        let result = apply_plot_thread_create_in_tx(
                            conn,
                            &payload.project_id,
                            &thread_payload,
                            &now,
                        )?;
                        commit_map.insert_plot_thread_binding(PlotThreadBinding {
                            hypothesis_id: thread_payload.hypothesis_id.clone(),
                            plot_thread_id: result.entity_id.clone(),
                            source: "created".to_string(),
                        });
                        (
                            "plot_thread",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            result.before_snapshot,
                            result.op_kind,
                        )
                    }
                    OP_KIND_PLOT_THREAD_PATCH => {
                        let thread_payload = parse_plot_thread_patch_payload(&op.payload)?;
                        let result = apply_plot_thread_patch_in_tx(
                            conn,
                            &payload.project_id,
                            &thread_payload,
                            &now,
                        )?;
                        commit_map.insert_plot_thread_binding(PlotThreadBinding {
                            hypothesis_id: thread_payload.hypothesis_id.clone(),
                            plot_thread_id: result.entity_id.clone(),
                            source: "existing".to_string(),
                        });
                        (
                            "plot_thread",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            result.before_snapshot,
                            result.op_kind,
                        )
                    }
                    OP_KIND_PLOT_MARKER_CREATE => {
                        let marker_payload = parse_plot_marker_create_payload(&op.payload)?;
                        let result = apply_plot_marker_create_in_tx(
                            conn,
                            &payload.project_id,
                            &marker_payload,
                            &commit_map,
                            &now,
                        )?;
                        (
                            "plot_thread_marker",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            result.before_snapshot,
                            result.op_kind,
                        )
                    }
                    OP_KIND_PLOT_BRANCH_CREATE => {
                        let branch_payload = parse_plot_branch_create_payload(&op.payload)?;
                        let result = apply_plot_branch_create_in_tx(
                            conn,
                            &payload.project_id,
                            &branch_payload,
                            &commit_map,
                            &now,
                        )?;
                        (
                            "plot_thread_branch",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            result.before_snapshot,
                            result.op_kind,
                        )
                    }
                    OP_KIND_FORESHADOW_AGGREGATE_CREATE => {
                        let foreshadow_payload = parse_foreshadow_create(&op.payload)?;
                        let result = apply_foreshadow_create(
                            conn,
                            &payload.project_id,
                            &foreshadow_payload,
                            &now,
                        )?;
                        commit_map.insert_foreshadow_binding(ForeshadowBinding {
                            hypothesis_id: foreshadow_payload.hypothesis_id.clone(),
                            foreshadow_id: result.entity_id.clone(),
                            source: "created".to_string(),
                        });
                        (
                            "foreshadow",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            result.before_snapshot,
                            result.op_kind,
                        )
                    }
                    OP_KIND_FORESHADOW_AGGREGATE_PATCH => {
                        let foreshadow_payload = parse_foreshadow_patch(&op.payload)?;
                        let result = apply_foreshadow_patch(
                            conn,
                            &payload.project_id,
                            &foreshadow_payload,
                            &now,
                        )?;
                        commit_map.insert_foreshadow_binding(ForeshadowBinding {
                            hypothesis_id: foreshadow_payload.hypothesis_id.clone(),
                            foreshadow_id: result.entity_id.clone(),
                            source: "existing".to_string(),
                        });
                        (
                            "foreshadow",
                            result.entity_id,
                            result.version,
                            result.after_snapshot,
                            result.before_snapshot,
                            result.op_kind,
                        )
                    }
                    other => anyhow::bail!("unsupported commit operation kind: {other}"),
                };

                let operation_id = Uuid::new_v4().to_string();
                operation_ids.push(operation_id.clone());
                operation_op_kinds.push(op_kind);
                conn.execute(
                    "INSERT INTO narrative_apply_operations
                        (id, commit_id, operation_index, operation_kind, payload_json,
                         result_entity_kind, result_entity_id, status, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'applied', ?8)",
                    params![
                        operation_id,
                        commit_id,
                        index as i64,
                        op.kind,
                        serde_json::to_string(&op.payload)?,
                        entity_kind,
                        entity_id,
                        now,
                    ],
                )?;

                let mut entity_row = json!({
                    "entityKind": entity_kind,
                    "entityId": entity_id,
                    "version": version,
                    "opKind": op_kind,
                    "snapshot": snapshot,
                });
                if let Some(before) = before_snapshot {
                    entity_row["beforeSnapshot"] = before;
                }
                after_snapshots.push(entity_row);
                created.push(json!({
                    "operationIndex": index,
                    "entityKind": entity_kind,
                    "entityId": entity_id,
                    "version": version,
                    "proposalId": op.proposal_id,
                    "revisionId": op.revision_id,
                }));
            }

            for (index, application) in payload.applications.iter().enumerate() {
                let created_row = created.get(index).ok_or_else(|| {
                    anyhow::anyhow!("application[{index}] has no matching created entity")
                })?;
                let entity_id = created_row
                    .get("entityId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("application[{index}] missing entityId"))?;
                let entity_kind = created_row
                    .get("entityKind")
                    .and_then(Value::as_str)
                    .unwrap_or("event");
                let application_id = Uuid::new_v4().to_string();
                let (application_kind, compensates_application_id) = load_retraction_metadata(
                    conn,
                    &application.proposal_id,
                    &application.revision_id,
                )?;
                let (application_kind, compensates_application_id) =
                    if application_kind == "retract" {
                        ("compensation", compensates_application_id)
                    } else {
                        ("normal", None)
                    };
                conn.execute(
                    "INSERT INTO narrative_proposal_applications
                        (id, commit_id, proposal_id, revision_id,
                         applied_entity_kind, applied_entity_id, created_at,
                         application_kind, compensates_application_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        application_id,
                        commit_id,
                        application.proposal_id,
                        application.revision_id,
                        entity_kind,
                        entity_id,
                        now,
                        application_kind,
                        compensates_application_id,
                    ],
                )?;
                let source_basis = load_source_basis_rows(conn, &application.revision_id)?;
                let envelope_json: String = conn.query_row(
                    "SELECT reconciliation_envelope_json
                       FROM narrative_proposal_revisions
                      WHERE id = ?1 AND proposal_id = ?2",
                    params![application.revision_id, application.proposal_id],
                    |row| row.get(0),
                )?;
                let envelope: Value = serde_json::from_str(&envelope_json)?;
                let read_set = if envelope_schema_version(&envelope) == Some(2) {
                    super::v2_apply_sources::load_v2_apply_sources(
                        conn,
                        &payload.project_id,
                        &payload.run_id,
                        &application.revision_id,
                        &envelope,
                    )?
                } else {
                    load_read_set_rows(&envelope)?
                };
                let source_rows = source_basis.into_iter().chain(read_set).collect::<Vec<_>>();
                let generic_freshness_canonical = is_generic_freshness_canonical(conn)?;
                if generic_freshness_canonical {
                    write_application_dependencies_in_tx(
                        conn,
                        &payload.project_id,
                        &application_id,
                        &payload.run_id,
                        &source_rows,
                        &now,
                    )?;
                    // Post-cutover, a newly declared Application has no
                    // legacy projection fallback.  Feed-backed mutations
                    // will supersede this seed in the same/next cycle, but a
                    // normal Apply must still publish a canonical
                    // Unknown/Manual row immediately rather than leaving an
                    // authority-shaped hole until a later Feed wake.
                    initialize_application_freshness_in_tx(
                        conn,
                        &payload.project_id,
                        &application_id,
                        &now,
                    )?;
                } else {
                    conn.execute(
                        "INSERT INTO narrative_projection_freshness
                            (application_id, status, reason_json, version, updated_at)
                         VALUES (?1, 'fresh', NULL, 0, ?2)",
                        params![application_id, now],
                    )?;
                    for source in source_rows {
                        conn.execute(
                            "INSERT OR IGNORE INTO narrative_projection_dependencies
                                (application_id, source_kind, source_key,
                                 observed_revision_token, propagation)
                             VALUES (?1, ?2, ?3, ?4, 'freshness-only')",
                            params![
                                application_id,
                                source.source_kind,
                                source.source_key,
                                source.revision_token,
                            ],
                        )?;
                    }
                }
                application_ids.push(application_id);
            }
            record_operation_field_authority(
                conn,
                &payload.project_id,
                &application_pairs(&payload.applications),
                &payload.operations,
                &now,
                &commit_map,
            )?;

            let after_json = json!({
                "entities": after_snapshots,
                "entityBindings": commit_map.to_json(),
            });
            let journal_id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO narrative_commit_journals
                    (id, commit_id, project_id, before_json, after_json, created_at)
                 VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
                params![
                    journal_id,
                    commit_id,
                    payload.project_id,
                    after_json.to_string(),
                    now,
                ],
            )?;

            let change_uid = Uuid::new_v4().to_string();
            let change_payload = json!({
                "commitId": commit_id,
                "requestId": payload.request_id,
                "planDigest": payload.plan_digest,
                "entityIds": created.iter().map(|row| row["entityId"].clone()).collect::<Vec<_>>(),
                "entityBindings": commit_map.to_json(),
            });
            let canonical_append = append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: change_uid.clone(),
                    scene_id: None,
                    domain: "narrative".to_string(),
                    op_type: "narrative.commit.apply".to_string(),
                    entity_type: Some("narrative_apply_commit".to_string()),
                    entity_id: Some(commit_id.clone()),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;
            anyhow::ensure!(
                canonical_append.inserted_count == 1,
                "NEX_CHANGE_EVENT_CORRELATION_FAILED: canonical event was not appended"
            );

            // Gate C2 Lane H (`application_contributions.rs`, wired in
            // C2-T1): record which Application most recently touched which
            // field, reusing the same `affected_fields` coverage table
            // `record_operation_field_authority` above already relies on
            // rather than re-deriving field ownership per operation kind a
            // second, drifting way. `application_ids` is 1:1 with
            // `payload.operations` by construction (both built from the
            // same per-index `payload.applications` loop above).
            //
            // Deliberately *after* the canonical append, not with the rest of
            // the Application bookkeeping: `baseline_sequence` is the
            // canonical `change_events.sequence` this commit's own write
            // landed on, and it does not exist until the append returns. It
            // is the self-stale guard's lower bound (ADR 005) -- without it a
            // later evaluation would read this commit's own event as evidence
            // that the Source changed underneath the Application, and mark
            // the Application stale the instant it was applied. Everything
            // this loop reads (`commit_map`, `payload`, `application_ids`,
            // `operation_ids`, `now`) is still in scope here, and
            // `application_ids` is not moved into the maintenance transaction
            // until below.
            //
            // `Unchanged` is the correct initial `targetState`: this write
            // just landed, so the field currently matches exactly what this
            // Application applied; a later process (Undo/Redo, a
            // superseding Application, a hand edit) is what would ever
            // transition it away from `Unchanged`, not this commit itself.
            for (index, (operation, application_id)) in
                payload.operations.iter().zip(&application_ids).enumerate()
            {
                let application = payload.applications.get(index).ok_or_else(|| {
                    anyhow::anyhow!("operation[{index}] has no matching application")
                })?;
                let provenance = ContributionProvenance {
                    application_id,
                    commit_id: &commit_id,
                    proposal_id: &application.proposal_id,
                    revision_id: &application.revision_id,
                    operation_id: operation_ids.get(index).map(String::as_str),
                    baseline_sequence: Some(canonical_append.tail_sequence),
                };
                // Which *object* was written comes from the Application row,
                // not from `affected_fields`. `affected_fields` is the
                // authority on which fields an operation touches, but its
                // entity id is a Field Authority *coordinate*:
                // `temporal.constraint.create` uses `authority_entity_id()`,
                // which falls back to a fingerprint (then a node id, then the
                // literal "constraint") when the payload carries no
                // `constraintId` -- while the row that was actually inserted
                // got a fresh UUID. Those can never be the same string, so a
                // Contribution addressed that way points at no object.
                //
                // `applied_entity_kind`/`applied_entity_id` are the ids the
                // Apply really wrote, and running them through the same
                // function `legacy_backfill.rs` uses is what makes the two
                // writers agree by construction rather than by coincidence.
                let (applied_entity_kind, applied_entity_id): (String, String) = conn.query_row(
                    "SELECT applied_entity_kind, applied_entity_id
                       FROM narrative_proposal_applications
                      WHERE id = ?1",
                    params![application_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                let target_object_identity = contribution_target_identity_for_application(
                    conn,
                    &applied_entity_kind,
                    &applied_entity_id,
                )?;
                // An operation that wrote nothing still gets its Contribution
                // rows -- "this Application depended on this object" is a real
                // fact the reverse lookup needs -- but `Unchanged` would
                // assert the field currently holds what *this* Application
                // wrote, and this one wrote nothing. `NotApplicable` is the
                // ratified value for exactly that.
                //
                // Deciding it here, at write time, is what keeps Undo simple:
                // an Undo that rolls nothing back for these operations
                // (`undo.rs`'s `op_kind != "ensure-existing"` guard) never has
                // to re-derive which rows it may speak for.
                let wrote_nothing = operation_op_kinds
                    .get(index)
                    .is_some_and(|kind| journal_op_kind_wrote_nothing(kind));
                let target_state = if wrote_nothing {
                    ContributionTargetState::NotApplicable
                } else {
                    ContributionTargetState::Unchanged
                };
                for field in affected_fields(operation, &commit_map)? {
                    record_contribution_in_tx(
                        conn,
                        &payload.project_id,
                        &provenance,
                        &ContributionField {
                            target_object_identity: &target_object_identity,
                            field_path: &field.field_path,
                            target_state,
                            // `affected_fields` *is* the Field Authority
                            // coordinate -- the same `(entity_kind,
                            // entity_id, field_path)` triple
                            // `record_operation_field_authority` writes just
                            // above -- so ownership is read from the ledger
                            // with the key the ledger is actually indexed by,
                            // no translation and no guess. The object the
                            // Contribution is filed under still comes from
                            // the Application row, for the reason spelled out
                            // above; only ownership uses this coordinate.
                            authority: Some(FieldAuthorityCoordinate {
                                entity_kind: &field.entity_kind,
                                entity_id: &field.entity_id,
                            }),
                        },
                        &now,
                    )?;
                }
            }

            let mut maintenance_events = events_from_journal_entities(
                after_json["entities"]
                    .as_array()
                    .ok_or_else(|| anyhow::anyhow!("commit journal entities are missing"))?,
                NarrativeChangeCauseKind::Forward,
            )?;
            maintenance_events.extend(scene_scope_refresh_events);
            let maintenance_transaction = if maintenance_events.is_empty() {
                None
            } else {
                Some(append_narrative_change_transaction_in_tx(
                    conn,
                    &AppendNarrativeChangeTransactionInput {
                        project_id: payload.project_id.clone(),
                        request_id: payload.request_id.clone(),
                        source_domain: "narrative.commit.apply".to_string(),
                        source_change_event_uid: change_uid.clone(),
                        cause_kind: NarrativeChangeCauseKind::Forward,
                        origin: NarrativeChangeOrigin::AiApply,
                        original_transaction_id: None,
                        commit_id: Some(commit_id.clone()),
                        journal_id: Some(journal_id.clone()),
                        undo_journal_id: None,
                        application_ids,
                        occurred_at: now.clone(),
                        events: maintenance_events,
                    },
                )?)
            };

            let mut receipt = json!({
                "commitId": commit_id,
                "requestId": payload.request_id,
                "planDigest": payload.plan_digest,
                "status": STATUS_APPLIED,
                "journalId": journal_id,
                "changeEventUid": change_uid,
                "created": created,
                "entityBindings": commit_map.to_json(),
            });
            if let (Some(receipt), Some(maintenance_transaction)) =
                (receipt.as_object_mut(), maintenance_transaction)
            {
                receipt.insert(
                    "maintenanceTransactionId".to_string(),
                    Value::String(maintenance_transaction.transaction_id.clone()),
                );
                receipt.insert(
                    "maintenanceOriginalTransactionId".to_string(),
                    Value::String(maintenance_transaction.transaction_id),
                );
                receipt.insert(
                    "maintenanceEventIds".to_string(),
                    serde_json::to_value(maintenance_transaction.event_ids)?,
                );
            }

            conn.execute(
                "UPDATE narrative_apply_commits
                    SET status = ?1,
                        receipt_json = ?2,
                        completed_at = ?3,
                        version = version + 1
                  WHERE id = ?4",
                params![STATUS_APPLIED, receipt.to_string(), now, commit_id],
            )?;

            Ok(receipt)
        })
    });

    match apply_result {
        Ok(receipt) => Ok(receipt),
        Err(err) => {
            let message = err.to_string();
            let invalidation = message.contains("NEX_SOURCE_")
                || message.contains("NEX_READ_SET_DRIFT")
                || message.contains("NEX_REVISION_ENVELOPE_CHANGED")
                || message.contains("NEX_REVISION_ENVELOPE_MISSING")
                || message.contains("NEX_CHRONICLE_RESUME_LIVE_CATALOG_DRIFT")
                || message.contains("NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT")
                || message.contains("NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH")
                || message.contains("NEX_CHRONICLE_RESUME_TOPOLOGY_INVALID")
                || message.contains("NEX_SCOPE_AUTHORITY_CORPUS_ARTIFACT_INVALID")
                || message.contains("NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE")
                || message.contains("NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH")
                || message.contains("NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT")
                || message.contains("NEX_PROPOSAL_PAYLOAD_MISMATCH")
                || message.contains("NEX_PREPARED_POLICY_CHANGED")
                || message.contains("NEX_FIELD_AUTHORITY")
                || message.contains("NEX_RETRACTION");
            // Precondition failures must not poison a sealed Prepared Commit —
            // the caller can correct session/version and retry apply.
            let precondition = message.contains("NEX_COMMIT_SESSION_MISMATCH")
                || message.contains("NEX_COMMIT_VERSION_MISMATCH")
                || message.contains("NEX_COMMIT_REQUEST_MISMATCH")
                || message.contains("NEX_COMMIT_NOT_PREPARED")
                || message.contains("NEX_COMMIT_AUTHORITY_CHANGED")
                || message.contains("prepared commit not found")
                || message.contains("NARRATIVE_REVIEW_ONLY")
                || message.contains("NARRATIVE_APPROVAL_REQUIRED");
            if invalidation {
                let _ =
                    persist_terminal_commit_audit(db, &payload, &message, &now, STATUS_INVALIDATED);
            } else if !precondition {
                let _ = persist_failed_commit_audit(db, &payload, &message, &now);
            }
            Err(err)
        }
    }
}

fn persist_terminal_commit_audit(
    db: &Database,
    payload: &ApplyCommitPayload,
    message: &str,
    now: &str,
    status: &str,
) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            conn.execute(
                "UPDATE narrative_apply_commits
                    SET status = ?1,
                        error_message = ?2,
                        completed_at = ?3,
                        version = version + 1
                  WHERE id = ?4
                    AND project_id = ?5
                    AND request_id = ?6
                    AND status = ?7",
                params![
                    status,
                    message,
                    now,
                    payload.prepared_commit_id,
                    payload.project_id,
                    payload.request_id,
                    STATUS_PREPARED,
                ],
            )?;
            Ok(())
        })
    })
}

fn persist_failed_commit_audit(
    db: &Database,
    payload: &ApplyCommitPayload,
    message: &str,
    now: &str,
) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            conn.execute(
                "UPDATE narrative_apply_commits
                    SET status = ?1,
                        error_message = ?2,
                        completed_at = ?3,
                        version = version + 1
                  WHERE id = ?4
                    AND project_id = ?5
                    AND request_id = ?6
                    AND status = ?7",
                params![
                    STATUS_FAILED,
                    message,
                    now,
                    payload.prepared_commit_id,
                    payload.project_id,
                    payload.request_id,
                    STATUS_PREPARED,
                ],
            )?;
            Ok(())
        })
    })
}

pub fn narrative_extraction_get_commit_status(
    db: &Database,
    payload: GetCommitStatusPayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        let row = if let Some(commit_id) = payload.commit_id.as_deref() {
            load_commit_by_id(conn, &payload.project_id, commit_id)?
        } else if let Some(request_id) = payload.request_id.as_deref() {
            load_commit_by_request(conn, &payload.project_id, request_id)?
        } else {
            anyhow::bail!("commitId or requestId is required");
        };
        let Some(row) = row else {
            return Ok(json!({
                "found": false,
            }));
        };
        Ok(json!({
            "found": true,
            "commitId": row.commit_id,
            "requestId": row.request_id,
            "planDigest": row.plan_digest,
            "status": row.status,
            "receipt": row.receipt_json.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok()),
            "errorMessage": row.error_message,
            "createdAt": row.created_at,
            "completedAt": row.completed_at,
            "version": row.version,
        }))
    })
}

pub(crate) struct CommitRow {
    pub commit_id: String,
    #[allow(dead_code)]
    pub project_id: String,
    pub run_id: Option<String>,
    pub request_id: String,
    pub plan_digest: String,
    pub status: String,
    pub prepared_plan_json: Option<String>,
    pub prepared_policy_version: Option<i64>,
    pub authority_digest: Option<String>,
    pub session_id: Option<String>,
    pub receipt_json: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub version: i64,
}

pub(crate) fn load_commit_by_id(
    conn: &Connection,
    project_id: &str,
    commit_id: &str,
) -> anyhow::Result<Option<CommitRow>> {
    conn.query_row(
        "SELECT id, project_id, run_id, request_id, plan_digest, status, receipt_json,
                prepared_plan_json, prepared_policy_version, authority_digest, session_id,
                error_message, created_at, completed_at, version
           FROM narrative_apply_commits
          WHERE id = ?1 AND project_id = ?2",
        params![commit_id, project_id],
        map_commit_row,
    )
    .optional()
    .map_err(Into::into)
}

pub(crate) fn load_commit_by_request(
    conn: &Connection,
    project_id: &str,
    request_id: &str,
) -> anyhow::Result<Option<CommitRow>> {
    conn.query_row(
        "SELECT id, project_id, run_id, request_id, plan_digest, status, receipt_json,
                prepared_plan_json, prepared_policy_version, authority_digest, session_id,
                error_message, created_at, completed_at, version
           FROM narrative_apply_commits
          WHERE project_id = ?1 AND request_id = ?2
          ORDER BY created_at DESC
          LIMIT 1",
        params![project_id, request_id],
        map_commit_row,
    )
    .optional()
    .map_err(Into::into)
}

fn map_commit_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CommitRow> {
    Ok(CommitRow {
        commit_id: row.get(0)?,
        project_id: row.get(1)?,
        run_id: row.get(2)?,
        request_id: row.get(3)?,
        plan_digest: row.get(4)?,
        status: row.get(5)?,
        receipt_json: row.get(6)?,
        prepared_plan_json: row.get(7)?,
        prepared_policy_version: row.get(8)?,
        authority_digest: row.get(9)?,
        session_id: row.get(10)?,
        error_message: row.get(11)?,
        created_at: row.get(12)?,
        completed_at: row.get(13)?,
        version: row.get(14)?,
    })
}

fn replay_or_conflict(existing: CommitRow, plan_digest: &str) -> anyhow::Result<Value> {
    if existing.plan_digest != plan_digest {
        anyhow::bail!(
            "NEX_COMMIT_IDEMPOTENCY_CONFLICT: request id reused with different planDigest"
        );
    }
    match existing.status.as_str() {
        STATUS_APPLIED | STATUS_REDONE | STATUS_UNDONE => {
            if let Some(raw) = existing.receipt_json.as_deref() {
                let mut receipt: Value = serde_json::from_str(raw)?;
                if let Some(obj) = receipt.as_object_mut() {
                    obj.insert("idempotentReplay".to_string(), Value::Bool(true));
                    obj.insert("status".to_string(), Value::String(existing.status.clone()));
                }
                return Ok(receipt);
            }
            Ok(json!({
                "commitId": existing.commit_id,
                "requestId": existing.request_id,
                "planDigest": existing.plan_digest,
                "status": existing.status,
                "idempotentReplay": true,
            }))
        }
        STATUS_FAILED => anyhow::bail!(
            "NEX_COMMIT_PREVIOUSLY_FAILED: {}",
            existing
                .error_message
                .unwrap_or_else(|| "previous commit failed".to_string())
        ),
        STATUS_INVALIDATED => anyhow::bail!(
            "NEX_COMMIT_INVALIDATED: {}",
            existing
                .error_message
                .unwrap_or_else(|| "prepared commit was invalidated".to_string())
        ),
        other => anyhow::bail!("unexpected commit status '{other}' for idempotent replay"),
    }
}

fn validate_commit_plan(
    conn: &Connection,
    ctx: CommitPlanValidationContext<'_>,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !ctx.operations.is_empty(),
        "commit requires at least one operation"
    );
    ensure_run_project(conn, ctx.run_id, ctx.project_id)?;

    if let Some(expected_calendar_version) = ctx.expected_calendar_version {
        ensure_calendar_version(conn, ctx.project_id, expected_calendar_version)?;
    }

    let set_ok: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_proposal_sets
          WHERE id = ?1 AND run_id = ?2 AND project_id = ?3",
        params![ctx.proposal_set_id, ctx.run_id, ctx.project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(set_ok == 1, "proposal set not found for run/project");

    let current_chronicle = current_chronicle_run_spec_for_run(conn, ctx.project_id, ctx.run_id)?;
    let mut chronicle_document_authority = None;

    let has_chronicle = ctx.operations.iter().any(|op| is_chronicle_op(&op.kind));
    if has_chronicle {
        ensure_order_neighbor(conn, ctx.project_id, ctx.expected_tail_ordinal)?;
    }

    for seed in ctx.entity_bindings {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
            params![seed.codex_entry_id, ctx.project_id],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            exists == 1,
            "entity binding codex entry '{}' not found in project '{}'",
            seed.codex_entry_id,
            ctx.project_id
        );
    }

    for op in ctx.operations {
        ensure_operation_kind(&op.kind)?;
        match op.kind.as_str() {
            OP_KIND_EVENT_CREATE => {
                let payload = parse_event_create_payload(&op.payload)?;
                ensure_event_id_available(conn, ctx.project_id, &payload.event_id)?;
                ensure_scene_versions(conn, ctx.project_id, &payload.evidence_scene_links)?;
            }
            OP_KIND_ENTRY_CREATE => {
                let payload = parse_entry_create_payload(&op.payload)?;
                anyhow::ensure!(
                    payload.parent_id.is_none(),
                    "NEX_CODEX_PARENT_ID_FORBIDDEN: kinship must not be projected onto parentId"
                );
                ensure_entry_id_available(conn, ctx.project_id, &payload.entry_id)?;
            }
            OP_KIND_ENTRY_PATCH => {
                let payload = parse_entry_patch_payload(&op.payload)?;
                ensure_entry_version(
                    conn,
                    ctx.project_id,
                    &payload.entry_id,
                    payload.base_version,
                )?;
            }
            OP_KIND_ENTITY_BIND_EXISTING => {
                let payload = parse_entity_bind_existing_payload(&op.payload)?;
                if let Some(expected) = payload.base_version {
                    ensure_entry_version(conn, ctx.project_id, &payload.entry_id, expected)?;
                } else {
                    let exists: i64 = conn.query_row(
                        "SELECT COUNT(*) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
                        params![payload.entry_id, ctx.project_id],
                        |row| row.get(0),
                    )?;
                    anyhow::ensure!(
                        exists == 1,
                        "codex entry '{}' not found in project '{}'",
                        payload.entry_id,
                        ctx.project_id
                    );
                }
            }
            OP_KIND_RELATION_CREATE => {
                let _ = parse_relation_create_payload(&op.payload)?;
            }
            OP_KIND_DETAIL_VALUE_SET => {
                let _ = parse_detail_value_set_payload(&op.payload)?;
            }
            OP_KIND_PHASE_CREATE => {
                let payload = parse_phase_create_payload(&op.payload)?;
                let exists: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM codex_entry_phases WHERE id = ?1",
                    params![payload.phase_id],
                    |row| row.get(0),
                )?;
                anyhow::ensure!(
                    exists == 0,
                    "codex phase '{}' already exists",
                    payload.phase_id
                );
            }
            OP_KIND_PHASE_PATCH => {
                let payload = parse_phase_patch_payload(&op.payload)?;
                let version: Option<i64> = conn
                    .query_row(
                        "SELECT version FROM codex_entry_phases WHERE id = ?1",
                        params![payload.phase_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let Some(version) = version else {
                    anyhow::bail!("codex phase '{}' not found", payload.phase_id);
                };
                if version != payload.base_version {
                    anyhow::bail!(
                        "NEX_PHASE_VERSION_MISMATCH: phase '{}' expected version {}, found {}",
                        payload.phase_id,
                        payload.base_version,
                        version
                    );
                }
            }
            OP_KIND_SEMANTIC_BINDING_UPSERT => {
                let _ = parse_semantic_binding_upsert_payload(&op.payload)?;
            }
            OP_KIND_NODE_ENSURE => {
                let _ = parse_node_ensure_payload(&op.payload)?;
            }
            OP_KIND_CONSTRAINT_CREATE => {
                // Referenced nodes may be created earlier in this same commit
                // (e.g. by `temporal.node.ensure`), so existence is checked
                // at apply time, in operation order, like relation/detail ops.
                let _ = parse_constraint_create_payload(&op.payload)?;
            }
            OP_KIND_SCENE_METADATA_PATCH => {
                let _ = parse_scene_metadata_patch_payload(&op.payload)?;
            }
            OP_KIND_EVENT_METADATA_PATCH => {
                let _ = parse_event_metadata_patch_payload(&op.payload)?;
            }
            OP_KIND_STORY_ORDER_MATERIALIZE => {
                let _ = parse_story_order_materialize_payload(&op.payload)?;
            }
            OP_KIND_PROJECTION_RECORD => {
                let _ = parse_projection_record_payload(&op.payload)?;
            }
            OP_KIND_PLOT_THREAD_CREATE => {
                let payload = parse_plot_thread_create_payload(&op.payload)?;
                ensure_thread_id_available(conn, ctx.project_id, &payload.thread_id)?;
            }
            OP_KIND_PLOT_THREAD_PATCH => {
                let payload = parse_plot_thread_patch_payload(&op.payload)?;
                ensure_thread_version(
                    conn,
                    ctx.project_id,
                    &payload.thread_id,
                    payload.base_version,
                )?;
            }
            OP_KIND_PLOT_MARKER_CREATE => {
                let payload = parse_plot_marker_create_payload(&op.payload)?;
                ensure_marker_id_available(conn, &payload.marker_id)?;
            }
            OP_KIND_PLOT_BRANCH_CREATE => {
                let payload = parse_plot_branch_create_payload(&op.payload)?;
                ensure_branch_id_available(conn, &payload.branch_id)?;
            }
            OP_KIND_FORESHADOW_AGGREGATE_CREATE => {
                let payload = parse_foreshadow_create(&op.payload)?;
                ensure_foreshadow_id_available(conn, ctx.project_id, &payload.foreshadow_id)?;
            }
            OP_KIND_FORESHADOW_AGGREGATE_PATCH => {
                let payload = parse_foreshadow_patch(&op.payload)?;
                ensure_foreshadow_version(
                    conn,
                    ctx.project_id,
                    &payload.foreshadow_id,
                    payload.base_version,
                )?;
            }
            other => anyhow::bail!("unsupported commit operation kind: {other}"),
        }

        if !op.proposal_id.is_empty() {
            if current_chronicle && chronicle_document_authority.is_none() {
                chronicle_document_authority =
                    Some(load_verified_chronicle_commit_document_authority(
                        conn,
                        ctx.project_id,
                        ctx.run_id,
                    )?);
            }
            let operation_chronicle_authority = if current_chronicle {
                ChronicleCommitPlanAuthority::Current(
                    chronicle_document_authority.as_ref().ok_or_else(|| {
                        anyhow::anyhow!(
                            "NEX_CHRONICLE_COMMIT_DOCUMENT_AUTHORITY_MISSING: verified Snapshot document authority was not retained"
                        )
                    })?,
                )
            } else {
                ChronicleCommitPlanAuthority::NonCurrent
            };
            ensure_proposal_approved_and_bound(
                conn,
                &ctx,
                operation_chronicle_authority,
                &op.proposal_id,
                Some(op.revision_id.as_str()),
                &op.kind,
                &op.payload,
            )?;
            ensure_proposal_not_applied(conn, &op.proposal_id)?;
        }
    }

    anyhow::ensure!(
        ctx.applications.len() == ctx.operations.len(),
        "NEX_COMMIT_APPLICATIONS_MISMATCH: applications length {} != operations length {}",
        ctx.applications.len(),
        ctx.operations.len()
    );
    for (index, (operation, application)) in ctx
        .operations
        .iter()
        .zip(ctx.applications.iter())
        .enumerate()
    {
        anyhow::ensure!(
            !operation.proposal_id.is_empty(),
            "NEX_COMMIT_APPLICATIONS_MISMATCH: operation[{index}] missing proposalId"
        );
        anyhow::ensure!(
            !operation.revision_id.is_empty(),
            "NEX_COMMIT_APPLICATIONS_MISMATCH: operation[{index}] missing revisionId"
        );
        anyhow::ensure!(
            operation.proposal_id == application.proposal_id
                && operation.revision_id == application.revision_id,
            "NEX_COMMIT_APPLICATIONS_MISMATCH: index {index} proposal/revision diverge"
        );
        // The operation loop already validated this exact proposal/revision,
        // its current Decision/Envelope, its Native-compiled payload, and its
        // unapplied state. Once the application coordinates are proven equal,
        // repeating that work would add no authority and used to reparse the
        // complete current Chronicle Snapshot a second time.
    }

    Ok(())
}

/// Current Chronicle v2 deliberately exposes one atomic review boundary per
/// ProposalSet. A renderer must not select only the approved subset while
/// leaving another actionable Proposal unresolved: the first Apply would
/// mutate the live Event Catalog and permanently stale the remainder.
///
/// This common Prepare/Apply validator runs under the caller's
/// `BEGIN IMMEDIATE`. Same-request Prepare replay and terminal Apply replay
/// return before this function, while every new mutation attempt must own the
/// exact, duplicate-free roster of approved current revisions.
fn validate_current_chronicle_apply_coverage(
    conn: &Connection,
    ctx: &CommitPlanValidationContext<'_>,
) -> anyhow::Result<()> {
    if !current_chronicle_run_spec_for_run(conn, ctx.project_id, ctx.run_id)? {
        return Ok(());
    }

    let existing_application_count: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM narrative_proposal_applications application
           JOIN narrative_proposals proposal ON proposal.id = application.proposal_id
          WHERE proposal.proposal_set_id = ?1",
        params![ctx.proposal_set_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        existing_application_count == 0,
        "NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH: current Chronicle ProposalSet already contains {existing_application_count} Application row(s); only the original idempotent request may replay an atomic Apply"
    );

    let mut match_by_proposal_key = load_current_chronicle_proposal_matches(
        conn,
        ctx.project_id,
        ctx.run_id,
        ctx.proposal_set_id,
    )?;
    let mut statement = conn.prepare(
        "SELECT proposal.id, proposal.proposal_key, proposal.status,
                proposal.current_revision_id,
                (SELECT decision.decision
                   FROM narrative_proposal_decisions decision
                  WHERE decision.proposal_id = proposal.id
                    AND decision.revision_id = proposal.current_revision_id
                  ORDER BY decision.rowid DESC
                  LIMIT 1) AS current_decision,
                (SELECT decision.decision_json
                   FROM narrative_proposal_decisions decision
                  WHERE decision.proposal_id = proposal.id
                    AND decision.revision_id = proposal.current_revision_id
                  ORDER BY decision.rowid DESC
                  LIMIT 1) AS current_decision_json
           FROM narrative_proposals proposal
          WHERE proposal.proposal_set_id = ?1
          ORDER BY proposal.id ASC",
    )?;
    let proposals = statement
        .query_map(params![ctx.proposal_set_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut expected_approved = Vec::new();
    // Snapshot/catalog verification is O(snapshotBytes). Cache one verified
    // transaction-local authority and reuse it for every terminal Proposal;
    // per-Proposal work below remains a current-revision row lookup + raw
    // title comparison.
    let mut revision_review_authority = None;
    for (
        proposal_id,
        proposal_key,
        status,
        current_revision_id,
        current_decision,
        current_decision_json,
    ) in proposals
    {
        let plan_authority = match_by_proposal_key.remove(&proposal_key).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Proposal '{proposal_id}' has no sealed plan match metadata"
            )
        })?;
        let match_status = plan_authority
            .match_value
            .get("status")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Proposal '{proposal_id}' sealed match has no status"
                )
            })?;
        anyhow::ensure!(
            matches!(match_status, "none" | "probable-duplicate"),
            "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: Proposal '{proposal_id}' has unsupported sealed match status '{match_status}'"
        );
        let decision_json = current_decision_json
            .as_deref()
            .map(serde_json::from_str::<Value>)
            .transpose()
            .map_err(|error| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE: Proposal '{proposal_id}' current Decision JSON is malformed: {error}"
                )
            })?;
        let probable_duplicate_choice = decision_json
            .as_ref()
            .and_then(|value| value.get("probableDuplicateChoice"))
            .and_then(Value::as_str);
        let decision_matches_status = current_decision.as_deref() == Some(status.as_str());
        match status.as_str() {
            "approved" => {
                anyhow::ensure!(
                    decision_matches_status,
                    "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE: approved Proposal '{proposal_id}' has no matching current-revision Decision"
                );
                let revision_id = current_revision_id.as_deref().ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE: approved Proposal '{proposal_id}' has no current revision"
                    )
                })?;
                if revision_review_authority.is_none() {
                    revision_review_authority =
                        Some(load_verified_chronicle_revision_review_authority(
                            conn,
                            ctx.project_id,
                            ctx.run_id,
                        )?);
                }
                let revision_review_authority = revision_review_authority.as_ref().ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_CHRONICLE_REVISION_REVIEW_AUTHORITY_MISSING: verified Snapshot/catalog authority was not retained"
                    )
                })?;
                let requires_probable_duplicate_choice = match_status == "probable-duplicate"
                    || current_chronicle_revision_requires_probable_duplicate_review(
                        conn,
                        revision_review_authority,
                        ctx.proposal_set_id,
                        &proposal_id,
                        revision_id,
                        &plan_authority.planned_title,
                    )?;
                anyhow::ensure!(
                    !requires_probable_duplicate_choice
                        || probable_duplicate_choice == Some("create-as-new"),
                    "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE: current-revision probable-duplicate Proposal '{proposal_id}' requires decisionJson.probableDuplicateChoice='create-as-new' before approval"
                );
                expected_approved.push((proposal_id, revision_id.to_string()));
            }
            "rejected" => {
                let revision_id = current_revision_id.as_deref().ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE: rejected Proposal '{proposal_id}' has no current revision"
                    )
                })?;
                anyhow::ensure!(
                    decision_matches_status,
                    "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE: rejected Proposal '{proposal_id}' has no matching current-revision Decision"
                );
                if revision_review_authority.is_none() {
                    revision_review_authority =
                        Some(load_verified_chronicle_revision_review_authority(
                            conn,
                            ctx.project_id,
                            ctx.run_id,
                        )?);
                }
                let revision_review_authority = revision_review_authority.as_ref().ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_CHRONICLE_REVISION_REVIEW_AUTHORITY_MISSING: verified Snapshot/catalog authority was not retained"
                    )
                })?;
                let requires_probable_duplicate_choice = match_status == "probable-duplicate"
                    || current_chronicle_revision_requires_probable_duplicate_review(
                        conn,
                        revision_review_authority,
                        ctx.proposal_set_id,
                        &proposal_id,
                        revision_id,
                        &plan_authority.planned_title,
                    )?;
                anyhow::ensure!(
                    !requires_probable_duplicate_choice
                        || probable_duplicate_choice == Some("skip-as-same"),
                    "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE: rejected current-revision probable-duplicate Proposal '{proposal_id}' requires decisionJson.probableDuplicateChoice='skip-as-same'"
                );
            }
            "unreviewed" | "held" | "deferred" => anyhow::bail!(
                "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE: Proposal '{proposal_id}' remains '{status}'"
            ),
            other => anyhow::bail!(
                "NEX_CHRONICLE_APPLY_REVIEW_INCOMPLETE: Proposal '{proposal_id}' has unsupported status '{other}'"
            ),
        }
    }
    anyhow::ensure!(
        match_by_proposal_key.is_empty(),
        "NEX_CHRONICLE_PLAN_PROPOSAL_SET_INCONSISTENT: sealed plan match roster contains a Proposal absent from the durable ProposalSet"
    );

    let operation_roster: Vec<(String, String)> = ctx
        .operations
        .iter()
        .map(|operation| (operation.proposal_id.clone(), operation.revision_id.clone()))
        .collect();
    let application_roster: Vec<(String, String)> = ctx
        .applications
        .iter()
        .map(|application| {
            (
                application.proposal_id.clone(),
                application.revision_id.clone(),
            )
        })
        .collect();
    let unique_operations: BTreeSet<_> = operation_roster.iter().cloned().collect();
    let unique_applications: BTreeSet<_> = application_roster.iter().cloned().collect();
    anyhow::ensure!(
        unique_operations.len() == operation_roster.len()
            && unique_applications.len() == application_roster.len(),
        "NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH: operation/application roster contains a duplicate Proposal revision"
    );

    expected_approved.sort();
    let mut actual_operations = operation_roster;
    actual_operations.sort();
    let mut actual_applications = application_roster;
    actual_applications.sort();
    anyhow::ensure!(
        actual_operations == expected_approved && actual_applications == expected_approved,
        "NEX_CHRONICLE_APPLY_COVERAGE_MISMATCH: operation/application roster does not exactly cover every approved current Proposal revision"
    );
    Ok(())
}

fn ensure_proposal_approved_and_bound(
    conn: &Connection,
    ctx: &CommitPlanValidationContext<'_>,
    chronicle_authority: ChronicleCommitPlanAuthority<'_>,
    proposal_id: &str,
    revision_id: Option<&str>,
    operation_kind: &str,
    operation_payload: &Value,
) -> anyhow::Result<()> {
    let current_chronicle = matches!(
        chronicle_authority,
        ChronicleCommitPlanAuthority::Current(_)
    );
    let row: Option<(String, Option<String>, String)> = conn
        .query_row(
            "SELECT status, current_revision_id, kind
              FROM narrative_proposals
              WHERE id = ?1 AND proposal_set_id = ?2",
            params![proposal_id, ctx.proposal_set_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((status, current_revision_id, proposal_kind)) = row else {
        anyhow::bail!(
            "proposal '{proposal_id}' not found in set '{}'",
            ctx.proposal_set_id
        );
    };
    anyhow::ensure!(
        status == "approved",
        "NEX_PROPOSAL_NOT_APPROVED: proposal '{proposal_id}' status is '{status}'"
    );
    let revision_id = revision_id.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_PROPOSAL_REVISION_MISMATCH: proposal '{proposal_id}' missing revisionId"
        )
    })?;
    anyhow::ensure!(
        current_revision_id.as_deref() == Some(revision_id),
        "NEX_PROPOSAL_REVISION_MISMATCH: proposal '{proposal_id}'"
    );

    let proposal_kind_base = proposal_kind
        .split('@')
        .next()
        .unwrap_or(proposal_kind.as_str());
    anyhow::ensure!(
        proposal_kind_allows_operation(proposal_kind_base, operation_kind)
            || (current_chronicle
                && proposal_kind_base == "chronicle.create-event"
                && operation_kind == OP_KIND_EVENT_CREATE),
        "NEX_PROPOSAL_KIND_MISMATCH: proposal '{proposal_id}' kind '{proposal_kind}' != operation '{operation_kind}'"
    );

    let (revision_payload_raw, origin_kind, envelope_json, envelope_digest): (
        String,
        String,
        Option<String>,
        Option<String>,
    ) = conn.query_row(
        "SELECT payload_json, origin_kind, reconciliation_envelope_digest
                    , reconciliation_envelope_json
               FROM narrative_proposal_revisions
              WHERE id = ?1 AND proposal_id = ?2",
        params![revision_id, proposal_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(3)?, row.get(2)?)),
    )?;
    anyhow::ensure!(
        origin_kind == ORIGIN_ENVELOPED && envelope_digest.is_some(),
        "NEX_REVISION_LEGACY_UNBOUND: proposal '{proposal_id}' revision '{revision_id}' requires re-extract/re-review before Apply"
    );
    let revision_payload: Value = serde_json::from_str(&revision_payload_raw)?;
    let comparable = if current_chronicle {
        anyhow::ensure!(
            proposal_kind_base == "chronicle.create-event"
                && operation_kind == OP_KIND_EVENT_CREATE,
            "NEX_PROPOSAL_KIND_MISMATCH: current Chronicle proposal '{proposal_id}' must compile chronicle.create-event@1 to chronicle.event.create"
        );
        let envelope: Value = envelope_json
            .as_deref()
            .map(serde_json::from_str)
            .transpose()?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_REVISION_ENVELOPE_MISSING: current Chronicle proposal '{proposal_id}' has no Envelope"
                )
            })?;
        let validated_envelope = validate_reconciliation_envelope(
            conn,
            ctx.project_id,
            ctx.run_id,
            Some(&envelope),
        )?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_REVISION_ENVELOPE_MISSING: current Chronicle proposal '{proposal_id}' has an unsealed Envelope"
            )
        })?;
        anyhow::ensure!(
            envelope_digest.as_deref() == Some(validated_envelope.digest.as_str()),
            "NEX_REVISION_ENVELOPE_CHANGED: current Chronicle proposal '{proposal_id}' Envelope digest differs"
        );
        let ChronicleCommitPlanAuthority::Current(chronicle_document_authority) =
            chronicle_authority
        else {
            anyhow::bail!(
                "NEX_CHRONICLE_COMMIT_DOCUMENT_AUTHORITY_MISSING: verified Snapshot document authority was not retained"
            );
        };
        anyhow::ensure!(
            chronicle_document_authority.project_id == ctx.project_id
                && chronicle_document_authority.run_id == ctx.run_id,
            "NEX_CHRONICLE_COMMIT_DOCUMENT_AUTHORITY_MISMATCH: verified Snapshot document authority belongs to another Run"
        );
        compile_current_chronicle_event_operation_payload(
            chronicle_document_authority,
            &revision_payload,
            &envelope,
        )?
    } else {
        revision_payload_for_commit_compare(&revision_payload, operation_kind)?.clone()
    };
    let revision_digest = digest_plan(&comparable);
    let operation_digest = digest_plan(operation_payload);
    anyhow::ensure!(
        revision_digest == operation_digest,
        "NEX_PROPOSAL_PAYLOAD_MISMATCH: proposal '{proposal_id}' revision payload does not match operation payload"
    );
    Ok(())
}

/// Load and verify the completed sealed Snapshot once for one current
/// Chronicle commit-plan validation, then retain only the document authority
/// required by every Proposal compiler invocation in that transaction.
fn load_verified_chronicle_commit_document_authority(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
) -> anyhow::Result<VerifiedChronicleCommitDocumentAuthority> {
    let snapshot_payload = load_verified_chronicle_snapshot_for_apply(conn, project_id, run_id)?;
    let snapshot_documents = snapshot_payload
        .pointer("/snapshot/documents")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: sealed Snapshot has no documents"
            )
        })?;
    let mut document_authority = HashMap::with_capacity(snapshot_documents.len());
    for (index, document) in snapshot_documents.iter().enumerate() {
        let document_ref = document.get("ref").and_then(Value::as_str).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Snapshot document {index} has no ref"
            )
        })?;
        let origin = document
            .get("origin")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Snapshot document {index} has no origin"
            )
            })?;
        let scene_id = origin.get("nodeId").and_then(Value::as_str).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Snapshot document {index} has no origin.nodeId"
            )
        })?;
        let source_version = origin
            .get("sourceVersion")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Snapshot document {index} has no origin.sourceVersion"
                )
            })?;
        anyhow::ensure!(
            document_authority
                .insert(
                    document_ref.to_string(),
                    (scene_id.to_string(), source_version),
                )
                .is_none(),
            "NEX_CHRONICLE_RESUME_SNAPSHOT_MISMATCH: Snapshot has duplicate document ref '{document_ref}'"
        );
    }
    Ok(VerifiedChronicleCommitDocumentAuthority {
        project_id: project_id.to_string(),
        run_id: run_id.to_string(),
        documents: document_authority,
    })
}

/// Reproduce `compileCreateChronicleEventOperation` from Native-owned inputs.
/// The current Revision supplies the reviewed IR payload, its validated
/// Envelope supplies the exact evidenceRef -> documentRef pairing, and the
/// once-verified sealed Snapshot supplies document -> Scene/version authority.
/// Renderer-supplied compiled fields never participate in this derivation.
fn compile_current_chronicle_event_operation_payload(
    authority: &VerifiedChronicleCommitDocumentAuthority,
    proposal: &Value,
    envelope: &Value,
) -> anyhow::Result<Value> {
    validate_chronicle_scene_event_proposal_payload(proposal).map_err(|error| {
        anyhow::anyhow!(
            "NEX_PROPOSAL_PAYLOAD_MISMATCH: current Chronicle proposal payload is invalid: {error}"
        )
    })?;
    let document_authority = &authority.documents;

    let evidence_set = envelope
        .pointer("/effectiveMaterialBasis/evidenceSet")
        .or_else(|| envelope.get("evidenceSet"))
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_PROPOSAL_PAYLOAD_MISMATCH: current Chronicle Envelope has no evidenceSet"
            )
        })?;
    let mut document_by_anchor: HashMap<String, String> = HashMap::new();
    let mut envelope_anchor_ids = Vec::with_capacity(evidence_set.len());
    let mut envelope_document_refs = Vec::with_capacity(evidence_set.len());
    for (index, evidence) in evidence_set.iter().enumerate() {
        let evidence_ref = evidence
            .get("evidenceRef")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_PROPOSAL_PAYLOAD_MISMATCH: Envelope evidenceSet[{index}] has no evidenceRef"
                )
            })?;
        let document_ref = evidence
            .get("documentRef")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_PROPOSAL_PAYLOAD_MISMATCH: Envelope evidenceSet[{index}] has no documentRef"
                )
            })?;
        anyhow::ensure!(
            document_by_anchor
                .insert(evidence_ref.to_string(), document_ref.to_string())
                .is_none(),
            "NEX_PROPOSAL_PAYLOAD_MISMATCH: Envelope evidenceSet contains duplicate evidenceRef '{evidence_ref}'"
        );
        envelope_anchor_ids.push(evidence_ref.to_string());
        envelope_document_refs.push(document_ref.to_string());
    }

    let proposal_anchor_ids = proposal
        .get("evidenceAnchorIds")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_PROPOSAL_PAYLOAD_MISMATCH: current Chronicle proposal has no evidenceAnchorIds"
            )
        })?
        .iter()
        .map(|value| {
            value.as_str().map(str::to_string).ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_PROPOSAL_PAYLOAD_MISMATCH: evidenceAnchorIds contains a non-string"
                )
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let proposal_document_refs = proposal
        .get("evidenceDocumentRefs")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_PROPOSAL_PAYLOAD_MISMATCH: current Chronicle proposal has no evidenceDocumentRefs"
            )
        })?
        .iter()
        .map(|value| {
            value.as_str().map(str::to_string).ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_PROPOSAL_PAYLOAD_MISMATCH: evidenceDocumentRefs contains a non-string"
                )
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let mut sorted_proposal_anchors = proposal_anchor_ids.clone();
    let mut sorted_proposal_documents = proposal_document_refs.clone();
    sorted_proposal_anchors.sort();
    sorted_proposal_documents.sort();
    envelope_anchor_ids.sort();
    envelope_document_refs.sort();
    envelope_document_refs.dedup();
    anyhow::ensure!(
        sorted_proposal_anchors
            .windows(2)
            .all(|window| window[0] != window[1])
            && sorted_proposal_documents
                .windows(2)
                .all(|window| window[0] != window[1])
            &&
        sorted_proposal_anchors == envelope_anchor_ids
            && sorted_proposal_documents == envelope_document_refs,
        "NEX_PROPOSAL_PAYLOAD_MISMATCH: proposal evidence does not exactly match current Envelope evidenceSet"
    );

    // The Envelope owns evidenceRef -> documentRef authority, while the
    // reviewed Proposal owns anchor ordering. The renderer compiler iterates
    // proposal.evidenceAnchorIds, so never inherit evidenceSet row order here.
    let mut anchors_by_document: HashMap<String, Vec<String>> = HashMap::new();
    for anchor in &proposal_anchor_ids {
        let document_ref = document_by_anchor.get(anchor).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_PROPOSAL_PAYLOAD_MISMATCH: proposal evidence anchor '{anchor}' is absent from the current Envelope"
            )
        })?;
        anchors_by_document
            .entry(document_ref.clone())
            .or_default()
            .push(anchor.clone());
    }

    let mut evidence_scene_links: Vec<Value> = Vec::new();
    let mut scene_link_index = HashMap::<String, usize>::new();
    for document_ref in &proposal_document_refs {
        let (scene_id, source_version) = document_authority.get(document_ref).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_PROPOSAL_PAYLOAD_MISMATCH: unknown evidence document ref '{document_ref}'"
            )
        })?;
        let link_index = match scene_link_index.get(scene_id) {
            Some(index) => *index,
            None => {
                let index = evidence_scene_links.len();
                evidence_scene_links.push(json!({
                    "sceneId": scene_id,
                    "expectedSceneVersion": source_version,
                    "evidenceAnchorIds": [],
                }));
                scene_link_index.insert(scene_id.clone(), index);
                index
            }
        };
        let link_anchors = evidence_scene_links[link_index]
            .get_mut("evidenceAnchorIds")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| anyhow::anyhow!("unreachable Native evidence link shape"))?;
        if let Some(document_anchors) = anchors_by_document.get(document_ref) {
            for anchor in document_anchors {
                if !link_anchors
                    .iter()
                    .any(|value| value.as_str() == Some(anchor))
                {
                    link_anchors.push(Value::String(anchor.clone()));
                }
            }
        }
        if link_anchors.is_empty() {
            for anchor in &proposal_anchor_ids {
                if !link_anchors
                    .iter()
                    .any(|value| value.as_str() == Some(anchor))
                {
                    link_anchors.push(Value::String(anchor.clone()));
                }
            }
        }
    }

    let reveal_document_ref = proposal
        .pointer("/disclosure/revealDocumentRef")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_PROPOSAL_PAYLOAD_MISMATCH: current Chronicle proposal has no disclosure.revealDocumentRef"
            )
        })?;
    let (reveal_scene_id, _) = document_authority.get(reveal_document_ref).ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_PROPOSAL_PAYLOAD_MISMATCH: unknown reveal document ref '{reveal_document_ref}'"
        )
    })?;
    let mut compiled = json!({
        "eventId": proposal.get("eventId").cloned().unwrap_or(Value::Null),
        "title": proposal.get("title").cloned().unwrap_or(Value::Null),
        "note": proposal.get("note").cloned().unwrap_or(Value::Null),
        "kind": "generic",
        "precision": "unknown",
        "placement": { "mode": "append-tail", "afterOrdinal": null },
        "secret": proposal.pointer("/disclosure/secret").cloned().unwrap_or(Value::Null),
        "revealSceneId": reveal_scene_id,
        "evidenceSceneLinks": evidence_scene_links,
        "detail": null,
        "primaryCodexId": null,
        "locationCodexId": null,
        "participants": [],
        "startTime": null,
        "endTime": null,
        "startGranularity": "none",
        "endGranularity": "none",
    });
    if let Some(semantic_type) = proposal.get("semanticType").and_then(Value::as_str) {
        if !semantic_type.is_empty() {
            compiled["semanticType"] = Value::String(semantic_type.to_string());
        }
    }
    Ok(compiled)
}

/// Codex review revisions store an envelope:
/// `{ version: 1, reviewPayload, compiledOperation: { kind, payload } | null }`.
/// Commit validation must compare `compiledOperation.payload` (when present) to
/// the Domain Operation wire payload. Legacy revisions store the Domain Op
/// payload directly.
fn revision_payload_for_commit_compare<'a>(
    revision_payload: &'a Value,
    operation_kind: &str,
) -> anyhow::Result<&'a Value> {
    let Some(obj) = revision_payload.as_object() else {
        return Ok(revision_payload);
    };
    let is_envelope =
        obj.get("version").and_then(Value::as_u64) == Some(1) && obj.contains_key("reviewPayload");
    if !is_envelope {
        return Ok(revision_payload);
    }

    let compiled = obj.get("compiledOperation").ok_or_else(|| {
        anyhow::anyhow!("NEX_PROPOSAL_PAYLOAD_MISMATCH: review envelope missing compiledOperation")
    })?;
    if compiled.is_null() {
        anyhow::bail!("NEX_PROPOSAL_PAYLOAD_MISMATCH: review envelope has null compiledOperation");
    }
    let compiled_kind = compiled
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_PROPOSAL_PAYLOAD_MISMATCH: compiledOperation.kind missing")
        })?;
    anyhow::ensure!(
        compiled_kind == operation_kind,
        "NEX_PROPOSAL_KIND_MISMATCH: compiledOperation.kind '{compiled_kind}' != operation '{operation_kind}'"
    );
    compiled.get("payload").ok_or_else(|| {
        anyhow::anyhow!("NEX_PROPOSAL_PAYLOAD_MISMATCH: compiledOperation.payload missing")
    })
}

fn proposal_kind_allows_operation(proposal_kind: &str, operation_kind: &str) -> bool {
    if proposal_kind == operation_kind {
        return true;
    }
    // Polymorphic bind proposals compile to create / patch / bind-existing.
    matches!(
        (proposal_kind, operation_kind),
        (
            "codex.entity.bind",
            "codex.entry.create" | "codex.entry.patch" | "codex.entity.bind-existing"
        )
    )
}

/// Stable digest helper for callers that want a canonical plan fingerprint.
pub fn digest_plan(value: &Value) -> String {
    let mut canonical = value.clone();
    canonicalize_json_value(&mut canonical);
    let body = serde_json::to_vec(&canonical).unwrap_or_default();
    hex::encode(Sha256::digest(body))
}

fn canonicalize_json_value(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                canonicalize_json_value(item);
            }
        }
        Value::Object(object) => {
            let mut entries: Vec<_> = std::mem::take(object).into_iter().collect();
            for (_, child) in &mut entries {
                canonicalize_json_value(child);
            }
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            object.extend(entries);
        }
        _ => {}
    }
}
