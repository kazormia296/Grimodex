//! N-API entries of the DA-2b typed Native writers (NIR-1 DA-2b ST4-A,
//! DR-DA2-50..53). They are ordinary `internal` commands reached from the
//! renderer's typed wrappers through Main's `NAPI_COMMANDS` (not Main-only
//! N-API), and they return counts and typed results only.
//!
//! * CW (the chat writes that stay open under a restricted profile): the
//!   caller identity Main attached is admitted with the existing
//!   [`crate::publication_guard::PublicationGuard`] (a restricted profile
//!   needs the registered identity of the active workspace and the confirmed
//!   stop barrier; an unrestricted profile is not checked), and
//!   `expectedWorkspacePath` must canonically equal the open workspace.
//! * M and T (version history, snapshot deletion, baseline visibility): the
//!   same shape as the other typed writers (no caller admission).
//!
//! A malformed request is the family's typed `invalid-request`; no refusal
//! carries a path, an id or a body.

use std::path::PathBuf;
use std::sync::Arc;

use grimodex_db::chat_typed_writes::{self, ChatWriteRefusal};
use grimodex_db::impact_review_baselines::{self, ImpactBaselineWriteRefusal};
use grimodex_db::revision_writes::{self, ProjectSnapshotWriteRefusal, RevisionWriteRefusal};
use grimodex_db::state::{active_workspace_snapshot, with_db_state};
use grimodex_db::{AppError, Database};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::convert::normalize_integer_numbers;
use crate::state::AppState;

fn refused(error: impl std::error::Error + Send + Sync + 'static) -> AppError {
    AppError::Anyhow(anyhow::Error::new(error))
}

fn decode<T: DeserializeOwned>(
    mut value: Value,
    invalid: impl FnOnce() -> AppError,
) -> Result<T, AppError> {
    normalize_integer_numbers(&mut value);
    serde_json::from_value(value).map_err(|_| invalid())
}

fn encode<T: Serialize>(value: &T) -> Result<String, AppError> {
    serde_json::to_string(value).map_err(|error| AppError::Anyhow(error.into()))
}

/// Admit a CW call and run `write` on the open workspace's database.
fn run_chat_writer<R, T>(
    state: &Arc<AppState>,
    payload: Value,
    caller_identity: Option<String>,
    write: impl FnOnce(&Database, R) -> anyhow::Result<T>,
) -> Result<String, AppError>
where
    R: DeserializeOwned,
    T: Serialize,
{
    // One snapshot for the admission, the workspace check and the write
    // (DR-DA2-56): the identity is matched to the workspace written to.
    let workspace = active_workspace_snapshot(&state.ws);
    let _admission = crate::publication_guard::PublicationGuard::admit_on(
        state,
        caller_identity,
        workspace.as_ref().ok(),
    )
    .map_err(AppError::Anyhow)?;
    let Value::Object(mut fields) = payload else {
        return Err(refused(ChatWriteRefusal::InvalidRequest));
    };
    let Some(Value::String(expected_workspace_path)) = fields.remove("expectedWorkspacePath")
    else {
        return Err(refused(ChatWriteRefusal::InvalidRequest));
    };
    let request: R = decode(Value::Object(fields), || {
        refused(ChatWriteRefusal::InvalidRequest)
    })?;
    let workspace = workspace?;
    let active = workspace.path().canonicalize();
    let expected = PathBuf::from(&expected_workspace_path).canonicalize();
    match (active, expected) {
        (Ok(active), Ok(expected)) if active == expected => {}
        _ => return Err(refused(ChatWriteRefusal::WorkspaceMismatch)),
    }
    let result = write(workspace.authority.db(), request)?;
    encode(&result)
}

pub(crate) fn chat_messages_delete(
    state: &Arc<AppState>,
    payload: Value,
    caller_identity: Option<String>,
) -> Result<String, AppError> {
    run_chat_writer(
        state,
        payload,
        caller_identity,
        chat_typed_writes::delete_messages,
    )
}

pub(crate) fn chat_session_delete(
    state: &Arc<AppState>,
    payload: Value,
    caller_identity: Option<String>,
) -> Result<String, AppError> {
    run_chat_writer(
        state,
        payload,
        caller_identity,
        chat_typed_writes::delete_session,
    )
}

pub(crate) fn chat_project_history_clear(
    state: &Arc<AppState>,
    payload: Value,
    caller_identity: Option<String>,
) -> Result<String, AppError> {
    run_chat_writer(
        state,
        payload,
        caller_identity,
        chat_typed_writes::clear_project_history,
    )
}

pub(crate) fn chat_session_rename(
    state: &Arc<AppState>,
    payload: Value,
    caller_identity: Option<String>,
) -> Result<String, AppError> {
    run_chat_writer(
        state,
        payload,
        caller_identity,
        chat_typed_writes::rename_session,
    )
}

pub(crate) fn chat_message_metadata_record(
    state: &Arc<AppState>,
    payload: Value,
    caller_identity: Option<String>,
) -> Result<String, AppError> {
    run_chat_writer(
        state,
        payload,
        caller_identity,
        chat_typed_writes::record_message_metadata,
    )
}

/// Run an M or T writer on the open workspace's database.
fn run_writer<R, T>(
    state: &Arc<AppState>,
    payload: Value,
    invalid: impl FnOnce() -> AppError,
    write: impl FnOnce(&Database, R) -> anyhow::Result<T>,
) -> Result<String, AppError>
where
    R: DeserializeOwned,
    T: Serialize,
{
    let request: R = decode(payload, invalid)?;
    let result = with_db_state(&state.ws, |db| write(db, request))?;
    encode(&result)
}

pub(crate) fn revision_create(state: &Arc<AppState>, payload: Value) -> Result<String, AppError> {
    run_writer(
        state,
        payload,
        || refused(RevisionWriteRefusal::InvalidRequest),
        revision_writes::create_revision,
    )
}

pub(crate) fn revision_prune(state: &Arc<AppState>, payload: Value) -> Result<String, AppError> {
    run_writer(
        state,
        payload,
        || refused(RevisionWriteRefusal::InvalidRequest),
        revision_writes::prune_revisions,
    )
}

pub(crate) fn project_snapshot_delete(
    state: &Arc<AppState>,
    payload: Value,
) -> Result<String, AppError> {
    run_writer(
        state,
        payload,
        || refused(ProjectSnapshotWriteRefusal),
        revision_writes::delete_project_snapshot,
    )
}

pub(crate) fn impact_review_baseline_update_visibility(
    state: &Arc<AppState>,
    payload: Value,
) -> Result<String, AppError> {
    run_writer(
        state,
        payload,
        || refused(ImpactBaselineWriteRefusal::InvalidRequest),
        impact_review_baselines::update_visibility,
    )
}

#[cfg(test)]
#[path = "typed_writers_tests.rs"]
mod tests;
