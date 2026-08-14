//! Persistent run runtime for Narrative Extraction (Chronicle + Codex Vertical Slice).

pub mod change_feed;
mod chronicle_operations;
mod codex_operations;
mod codex_snapshots;
mod codex_undo;
mod commit;
mod detail_operations;
mod field_authority;
mod foreshadow_operations;
mod foreshadow_undo;
mod models;
mod phase_operations;
mod phase_snapshots;
mod phase_undo;
mod plot_thread_operations;
mod plot_thread_undo;
mod reconciliation_envelope;
mod repository;
mod semantic_bindings;
mod source_revision;
mod task_leases;
mod temporal_constraints;
mod temporal_nodes;
mod temporal_operations;
mod temporal_projections;
mod temporal_snapshots;
mod temporal_undo;
mod undo;

pub(crate) use foreshadow_operations::collect_aggregate_snapshot;
pub(crate) use foreshadow_undo::{
    delete_snapshot_at_version, ensure_matches_snapshot as ensure_foreshadow_snapshot_matches,
    reapply_created_snapshot,
};
pub(crate) use phase_operations::collect_phase_snapshot;
pub(crate) use semantic_bindings::collect_semantic_binding_snapshot;
pub(crate) use temporal_snapshots::{
    collect_constraint_snapshot, collect_node_snapshot, collect_projection_snapshot,
};

pub use commit::digest_plan;
pub(crate) use field_authority::{
    legacy_value_present, propagate_source_change_freshness_in_tx, record_human_field_write,
};
pub use models::{
    AppendDecisionPayload, AppendRevisionPayload, ApplyCommitPayload, ArtifactInput,
    ClaimTaskPayload, CommitApplicationRef, CommitOperation, CreateRunPayload, CreateTaskSeed,
    EntityBindingSeed, FailTaskPayload, FinishTaskPayload, GetCommitStatusPayload,
    HumanFieldLockPayload, ListResumableRunsPayload, PrepareCommitPayload, ProposalSeed,
    ReconciliationEnvelopeInheritance, ReviseAndDecidePayload, RunRefPayload,
    SaveProposalSetPayload, UndoCommitPayload,
};
pub use repository::ensure_test_schema;
pub use temporal_operations::TemporalScenePatchPayload;

use serde_json::Value;

use crate::change_events::AppendChangeEvent;
use crate::idempotency::{
    canonical_write_payload_fingerprint, insert_idempotent_response, load_idempotent_response,
    IdempotencyRequest,
};
use crate::Database;
use change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_snapshot_digest,
    require_replay_lineage_in_project, AppendNarrativeChangeTransactionInput,
    NarrativeChangeCauseKind, NarrativeChangeEventInput, NarrativeChangeOrigin,
};

pub fn narrative_extraction_create_run(
    db: &Database,
    payload: CreateRunPayload,
) -> anyhow::Result<Value> {
    repository::create_run(db, payload)
}

pub fn narrative_extraction_get_run(
    db: &Database,
    run_id: String,
    project_id: String,
) -> anyhow::Result<Value> {
    repository::get_run(db, run_id, project_id)
}

pub fn narrative_extraction_list_resumable_runs(
    db: &Database,
    payload: ListResumableRunsPayload,
) -> anyhow::Result<Value> {
    repository::list_resumable_runs(db, payload)
}

pub fn narrative_extraction_cancel_run(
    db: &Database,
    payload: RunRefPayload,
) -> anyhow::Result<Value> {
    repository::cancel_run(db, payload.run_id, payload.project_id)
}

pub fn narrative_extraction_claim_task(
    db: &Database,
    payload: ClaimTaskPayload,
) -> anyhow::Result<Value> {
    repository::claim_task(db, payload)
}

pub fn narrative_extraction_finish_task(
    db: &Database,
    payload: FinishTaskPayload,
) -> anyhow::Result<Value> {
    repository::finish_task(db, payload)
}

pub fn narrative_extraction_fail_task(
    db: &Database,
    payload: FailTaskPayload,
) -> anyhow::Result<Value> {
    repository::fail_task(db, payload)
}

pub fn narrative_extraction_save_proposal_set(
    db: &Database,
    payload: SaveProposalSetPayload,
) -> anyhow::Result<Value> {
    repository::save_proposal_set(db, payload)
}

pub fn narrative_extraction_get_run_review_bundle(
    db: &Database,
    payload: RunRefPayload,
) -> anyhow::Result<Value> {
    repository::get_run_review_bundle(db, payload.run_id, payload.project_id)
}

pub fn narrative_extraction_append_revision(
    db: &Database,
    payload: AppendRevisionPayload,
) -> anyhow::Result<Value> {
    repository::append_revision(db, payload)
}

pub fn narrative_extraction_append_decision(
    db: &Database,
    payload: AppendDecisionPayload,
) -> anyhow::Result<Value> {
    repository::append_decision(db, payload)
}

/// Human review endpoint. The actor class is fixed by this Native entrypoint;
/// renderer fields can request only exact field paths, never change the actor
/// or scope that Native records.
pub fn narrative_extraction_append_human_decision(
    db: &Database,
    payload: AppendDecisionPayload,
) -> anyhow::Result<Value> {
    repository::append_human_decision(db, payload)
}

pub fn narrative_extraction_revise_and_decide(
    db: &Database,
    payload: ReviseAndDecidePayload,
) -> anyhow::Result<Value> {
    repository::revise_and_decide(db, payload)
}

pub fn narrative_extraction_revise_and_decide_as_human(
    db: &Database,
    payload: ReviseAndDecidePayload,
) -> anyhow::Result<Value> {
    repository::revise_and_decide_as_human(db, payload)
}

pub fn narrative_extraction_prepare_commit(
    db: &Database,
    payload: PrepareCommitPayload,
) -> anyhow::Result<Value> {
    commit::narrative_extraction_prepare_commit(db, payload)
}

pub fn narrative_extraction_apply_commit(
    db: &Database,
    payload: ApplyCommitPayload,
) -> anyhow::Result<Value> {
    commit::narrative_extraction_apply_commit(db, payload)
}

pub fn narrative_extraction_get_commit_status(
    db: &Database,
    payload: GetCommitStatusPayload,
) -> anyhow::Result<Value> {
    commit::narrative_extraction_get_commit_status(db, payload)
}

pub fn narrative_extraction_undo_commit(
    db: &Database,
    payload: UndoCommitPayload,
) -> anyhow::Result<Value> {
    undo::narrative_extraction_undo_commit(db, payload)
}

pub fn narrative_extraction_redo_commit(
    db: &Database,
    payload: UndoCommitPayload,
) -> anyhow::Result<Value> {
    undo::narrative_extraction_redo_commit(db, payload)
}

/// Human-only CAS for explicit field locks. The Electron endpoint below is
/// the only production caller; automated Apply has no route to this function.
pub fn narrative_extraction_set_human_field_lock(
    db: &Database,
    payload: HumanFieldLockPayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        crate::narrative_runtime_policy::require_narrative_extraction_allowed(conn)?;
        task_leases::with_immediate_transaction(conn, |conn| {
            field_authority::set_human_field_lock_in_tx(conn, &payload)
        })
    })
}

pub fn temporal_scene_patch(
    db: &Database,
    payload: TemporalScenePatchPayload,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !payload.request_id.trim().is_empty(),
        "requestId is required"
    );
    anyhow::ensure!(
        !payload.session_id.trim().is_empty(),
        "sessionId is required"
    );
    anyhow::ensure!(!payload.event_uid.trim().is_empty(), "eventUid is required");
    let replay = matches!(
        payload.origin,
        NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
    );
    let complete_lineage = payload
        .original_transaction_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        && payload
            .undo_journal_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    anyhow::ensure!(
        replay == complete_lineage
            && (replay
                || (payload.original_transaction_id.is_none()
                    && payload.undo_journal_id.is_none())),
        "undo/redo origin requires originalTransactionId and undoJournalId"
    );
    let request_hash = canonical_write_payload_fingerprint("temporal_scene_patch", &payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "temporal_scene_patch",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "TEMPORAL_SCENE_REQUEST_CONFLICT",
    };
    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            if let Some(response) = load_idempotent_response(conn, &idempotency_request)? {
                return Ok(response);
            }
            if replay {
                let original_transaction_id = payload
                    .original_transaction_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("originalTransactionId is required"))?;
                let undo_journal_id = payload
                    .undo_journal_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("undoJournalId is required"))?;
                require_replay_lineage_in_project(
                    conn,
                    &payload.project_id,
                    original_transaction_id,
                    undo_journal_id,
                )?;
            }
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let before = temporal_operations::collect_scene_temporal_snapshot(
                conn,
                &payload.project_id,
                &payload.target_id,
            )?;
            let before_feed = crate::canonical_feed_snapshots::canonical_scene_snapshot(
                conn,
                &payload.project_id,
                &payload.target_id,
            )?;
            let mut value = temporal_operations::apply_scene_temporal_patch_in_tx(
                conn,
                &payload.project_id,
                &payload,
                &now,
            )?;
            if payload.origin == NarrativeChangeOrigin::Human {
                crate::narrative_extraction::record_human_field_write(
                    conn,
                    &payload.project_id,
                    "scene",
                    &payload.target_id,
                    &[
                        "/storyTimeOrder",
                        "/storyTimeLabel",
                        "/startTime",
                        "/startMinute",
                        "/startGranularity",
                        "/endTime",
                        "/endMinute",
                        "/endGranularity",
                        "/precision",
                    ],
                    &now,
                )?;
            }
            let version = value
                .get("version")
                .and_then(Value::as_i64)
                .ok_or_else(|| anyhow::anyhow!("temporal scene patch result has no version"))?;
            let updated_at = value
                .get("updatedAt")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("temporal scene patch result has no updatedAt"))?;
            let source_key = format!("project:scene:{}", payload.target_id);
            let source_token = format!("v{version}@{updated_at}");
            crate::narrative_extraction::propagate_source_change_freshness_in_tx(
                conn,
                &payload.project_id,
                "scene-body",
                &source_key,
                Some(&source_token),
                &now,
                &payload.session_id,
            )?;
            let after = temporal_operations::collect_scene_temporal_snapshot(
                conn,
                &payload.project_id,
                &payload.target_id,
            )?;
            let after_feed = crate::canonical_feed_snapshots::canonical_scene_snapshot(
                conn,
                &payload.project_id,
                &payload.target_id,
            )?;
            let undo_journal_id = payload
                .undo_journal_id
                .clone()
                .unwrap_or_else(|| payload.request_id.clone());
            if !replay {
                let before_json = serde_json::to_string(&before)?;
                let after_json = serde_json::to_string(&after)?;
                crate::undo_journal::insert_undo_journal_in_tx(
                    conn,
                    crate::undo_journal::UndoJournalInsert {
                        id: &undo_journal_id,
                        project_id: &payload.project_id,
                        surface: "tree",
                        entity_kind: "scene_temporal",
                        entity_id: &payload.target_id,
                        op_kind: "update",
                        before_json: Some(&before_json),
                        after_json: Some(&after_json),
                        base_version: payload.base_version,
                        result_version: version,
                        change_event_uid: Some(&payload.event_uid),
                    },
                )?;
            }
            let field_paths = [
                ("endGranularity", "/endGranularity"),
                ("endMinute", "/endMinute"),
                ("endTime", "/endTime"),
                ("precision", "/precision"),
                ("startGranularity", "/startGranularity"),
                ("startMinute", "/startMinute"),
                ("startTime", "/startTime"),
                ("storyTimeLabel", "/storyTimeLabel"),
                ("storyTimeOrder", "/storyTimeOrder"),
            ];
            let mut changed_paths = field_paths
                .iter()
                .filter(|(field, _)| before.get(*field) != after.get(*field))
                .map(|(_, path)| (*path).to_string())
                .collect::<Vec<_>>();
            if changed_paths.is_empty() {
                changed_paths.push("/version".to_string());
            }
            let timestamp = chrono::DateTime::parse_from_rfc3339(&now)
                .map(|value| value.timestamp_millis())
                .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis());
            let append = append_canonical_and_narrative_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &AppendChangeEvent {
                    event_uid: payload.event_uid.clone(),
                    scene_id: Some(payload.target_id.clone()),
                    domain: "tree".to_string(),
                    op_type: "temporal.scene.patch".to_string(),
                    entity_type: Some("scene".to_string()),
                    entity_id: Some(payload.target_id.clone()),
                    payload: serde_json::json!({
                        "fields": changed_paths.clone(),
                        "before": before.clone(),
                        "after": after.clone(),
                    })
                    .to_string(),
                    timestamp,
                },
                &AppendNarrativeChangeTransactionInput {
                    project_id: payload.project_id.clone(),
                    request_id: payload.request_id.clone(),
                    source_domain: "temporal.scene.patch".to_string(),
                    source_change_event_uid: payload.event_uid.clone(),
                    cause_kind: match payload.origin {
                        NarrativeChangeOrigin::Undo => NarrativeChangeCauseKind::Undo,
                        NarrativeChangeOrigin::Redo => NarrativeChangeCauseKind::Redo,
                        _ => NarrativeChangeCauseKind::Forward,
                    },
                    origin: payload.origin,
                    original_transaction_id: payload.original_transaction_id.clone(),
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: Some(undo_journal_id.clone()),
                    application_ids: Vec::new(),
                    occurred_at: now,
                    events: vec![NarrativeChangeEventInput {
                        object_key: serde_json::json!({
                            "kind": "scene",
                            "sceneId": payload.target_id,
                        }),
                        change_kind: if changed_paths
                            .iter()
                            .any(|path| path == "/storyTimeOrder" || path == "/storyTimeLabel")
                        {
                            "order".to_string()
                        } else {
                            "calendar".to_string()
                        },
                        mutation_kind: "update".to_string(),
                        before_version: Some(payload.base_version),
                        before_digest: Some(narrative_snapshot_digest(&before_feed)?),
                        after_version: Some(version),
                        after_digest: Some(narrative_snapshot_digest(&after_feed)?),
                        structural_impact: Some(serde_json::json!({
                            "changedPaths": changed_paths.clone(),
                        })),
                        changed_paths,
                        text_impact: None,
                    }],
                },
            )?;
            value["maintenanceTransactionId"] = Value::String(append.narrative.transaction_id);
            value["changeEventUid"] = Value::String(payload.event_uid.clone());
            value["undoJournalId"] = Value::String(undo_journal_id);
            insert_idempotent_response(conn, &idempotency_request, &payload.project_id, &value)?;
            Ok(value)
        })();
        match result {
            Ok(value) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}
