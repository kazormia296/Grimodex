//! Persistent run runtime for Narrative Extraction (Chronicle + Codex Vertical Slice).

mod chronicle_operations;
mod codex_operations;
mod codex_snapshots;
mod codex_undo;
mod commit;
mod detail_operations;
mod models;
mod phase_operations;
mod phase_snapshots;
mod phase_undo;
mod repository;
mod semantic_bindings;
mod task_leases;
mod undo;

pub use models::{
    AppendDecisionPayload, AppendRevisionPayload, ApplyCommitPayload, ClaimTaskPayload,
    CommitApplicationRef, CommitOperation, CreateRunPayload, CreateTaskSeed,
    EntityBindingSeed, FailTaskPayload, FinishTaskPayload, GetCommitStatusPayload,
    PrepareCommitPayload, ProposalSeed, RunRefPayload, SaveProposalSetPayload, UndoCommitPayload,
};
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
