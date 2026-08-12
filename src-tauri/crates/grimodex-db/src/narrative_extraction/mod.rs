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
    RunRefPayload, SaveProposalSetPayload, UndoCommitPayload,
};
pub use commit::digest_plan;
pub use temporal_operations::TemporalScenePatchPayload;
pub use repository::ensure_test_schema;

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

pub fn narrative_extraction_revise_and_decide(
    db: &Database,
    payload: ReviseAndDecidePayload,
) -> anyhow::Result<Value> {
    repository::revise_and_decide(db, payload)
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
