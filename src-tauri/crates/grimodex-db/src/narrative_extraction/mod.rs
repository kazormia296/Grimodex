//! Persistent run runtime for Narrative Extraction (Chronicle + Codex Vertical Slice).

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
mod repository;
mod reconciliation_envelope;
mod source_revision;
mod semantic_bindings;
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

pub use models::{
    AppendDecisionPayload, AppendRevisionPayload, ApplyCommitPayload, ArtifactInput,
    ClaimTaskPayload, CommitApplicationRef, CommitOperation, CreateRunPayload, CreateTaskSeed,
    EntityBindingSeed, FailTaskPayload, FinishTaskPayload, GetCommitStatusPayload,
    ListResumableRunsPayload, PrepareCommitPayload, ProposalSeed, ReviseAndDecidePayload,
    ReconciliationEnvelopeInheritance, RunRefPayload, SaveProposalSetPayload,
    UndoCommitPayload, HumanFieldLockPayload,
};
pub use commit::digest_plan;
pub use temporal_operations::TemporalScenePatchPayload;
pub use repository::ensure_test_schema;
pub(crate) use field_authority::{
    propagate_source_change_freshness_in_tx, record_human_field_write,
};

use serde_json::Value;

use crate::Database;

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
    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let result = temporal_operations::apply_scene_temporal_patch_in_tx(
            conn,
            &payload.project_id,
            &payload,
            &now,
        );
        match result {
            Ok(value) => {
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
                    "temporal-scene-writer",
                )?;
                conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}
