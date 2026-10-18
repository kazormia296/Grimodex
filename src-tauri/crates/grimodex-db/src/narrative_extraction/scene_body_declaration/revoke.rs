//! The revoke writer (CB-2, K2-3). No grant: revoking only stops a disclosure.
//!
//! [`revoke_scene_body`] sets the two declaration columns to NULL when the
//! Scene's current declaration token is the one the request names, and writes
//! the feed event and the idempotency record in the same transaction. When
//! there is no declaration, or the token differs, nothing at all is written
//! (no feed event, no idempotency record) and a closed response says so. Its
//! responses never say anything about Graph reach, candidates or vetoes. There
//! is no undo: a resend of the same request returns the recorded response and
//! does not bring the declaration back.

use std::cell::Cell;
use std::fmt;
use std::panic::{catch_unwind, AssertUnwindSafe};

use anyhow::{anyhow, Result};
use rusqlite::params;
use uuid::Uuid;

use super::binding::{DeclareRefusal, RevokeRequest, RevokeResponse, REVOKE_IDEMPOTENCY_DOMAIN};
use super::commit_outcome::{settle, DeclarationTerminalEvidence, Settled, WriteIdentifiers};
use super::facts::{ensure_no_sql_owner, read_declaration_occ, refuse, DeclarationOcc};
use super::writer::{
    append_declaration_change, inject, writer_refusal, DeclarationChange, DeclareFailure, Stage,
    REQUEST_CONFLICT_MARKER,
};
use super::{canonical_scene_body_declaration_snapshot, null_declaration_columns};
use crate::idempotency::{
    canonical_write_payload_fingerprint, insert_idempotent_response, load_idempotent_response,
    IdempotencyRequest,
};
use crate::nir1_generation::{bounded_write, Nir1AdmissionSqlBudget, Nir1CommitState};
use crate::state::ActiveWorkspaceSnapshot;

use super::commit_outcome::is_scene_body_declaration_quarantined;

/// A successful revoke call (including the two that write nothing).
#[derive(Debug)]
pub struct RevokeOutcome {
    pub response: RevokeResponse,
    pub replayed: bool,
    pub recovered_after_unknown_commit: bool,
    pub evidence: DeclarationTerminalEvidence,
}

/// "Nothing to write": raised inside the transaction so it rolls back without
/// a COMMIT; the caller turns it into the closed response.
#[derive(Debug)]
struct NothingToWrite(RevokeResponse);

impl fmt::Display for NothingToWrite {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "NEX_BODY_DECLARATION_REVOKE_NOTHING_TO_WRITE:{}",
            self.0.code()
        )
    }
}

impl std::error::Error for NothingToWrite {}

enum Written {
    Revoked,
    Replayed(RevokeResponse),
}

pub fn revoke_scene_body(
    workspace: &ActiveWorkspaceSnapshot,
    request: RevokeRequest,
    budget: &Nir1AdmissionSqlBudget,
) -> Result<RevokeOutcome, DeclareFailure> {
    let before_write = |refusal| DeclareFailure {
        refusal,
        evidence: None,
    };
    request.validate().map_err(before_write)?;
    ensure_no_sql_owner().map_err(before_write)?;
    // A workspace without a durable identity cannot have a quarantine or a
    // valid declaration; revoking stays possible there.
    if workspace
        .durable_workspace_identity()
        .is_some_and(is_scene_body_declaration_quarantined)
    {
        return Err(before_write(DeclareRefusal::RestartRequired));
    }

    let payload_hash = canonical_write_payload_fingerprint(REVOKE_IDEMPOTENCY_DOMAIN, &request)
        .map_err(|_| before_write(DeclareRefusal::Internal))?;
    let idempotency = IdempotencyRequest {
        domain: REVOKE_IDEMPOTENCY_DOMAIN,
        request_id: Some(&request.request_id),
        payload_hash: &payload_hash,
        conflict_marker: REQUEST_CONFLICT_MARKER,
    };
    let event_uid = Uuid::new_v4().hyphenated().to_string();
    let ready = Cell::new(false);
    let replay_response: Cell<Option<RevokeResponse>> = Cell::new(None);

    let participant = workspace.participant();
    let sql_budget = budget.sql_budget();
    let checkpoint_budget = sql_budget.clone();
    let write = catch_unwind(AssertUnwindSafe(|| {
        bounded_write(
            workspace,
            budget.fence(),
            sql_budget,
            budget.failpoint(),
            |conn| -> Result<Written> {
                #[cfg(test)]
                super::writer::test_hooks::TRANSACTIONS_OPENED
                    .with(|count| count.set(count.get() + 1));
                checkpoint_budget.check(participant)?;

                if let Some(recorded) = load_idempotent_response(conn, &idempotency)? {
                    let Some(response) = RevokeResponse::from_recorded(&recorded) else {
                        return refuse(DeclareRefusal::Internal);
                    };
                    ready.set(true);
                    replay_response.set(Some(response));
                    return Ok(Written::Replayed(response));
                }
                if workspace
                    .durable_workspace_identity()
                    .is_some_and(is_scene_body_declaration_quarantined)
                {
                    return refuse(DeclareRefusal::RestartRequired);
                }
                if workspace.check_current_binding().is_err() {
                    return refuse(DeclareRefusal::WorkspaceMismatch);
                }
                let scene_exists: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM tree_nodes
                                    WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene')",
                    params![request.scene_id, request.project_id],
                    |row| row.get(0),
                )?;
                if !scene_exists {
                    return refuse(DeclareRefusal::SceneNotFound);
                }
                match read_declaration_occ(conn, &request.project_id, &request.scene_id)? {
                    DeclarationOcc::None => {
                        return Err(anyhow::Error::new(NothingToWrite(
                            RevokeResponse::NoDeclaration,
                        )))
                    }
                    DeclarationOcc::Unreadable => {
                        return refuse(DeclareRefusal::DeclarationUnreadable)
                    }
                    DeclarationOcc::Token(token) if token != request.declaration_token => {
                        return Err(anyhow::Error::new(NothingToWrite(
                            RevokeResponse::DeclarationChanged,
                        )))
                    }
                    DeclarationOcc::Token(_) => {}
                }

                let before = canonical_scene_body_declaration_snapshot(
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )?;
                inject(
                    Stage::BeforeUpdate,
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )?;
                if !null_declaration_columns(conn, &request.project_id, &request.scene_id)? {
                    return Err(anyhow::Error::new(NothingToWrite(
                        RevokeResponse::DeclarationChanged,
                    )));
                }
                inject(
                    Stage::AfterUpdate,
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )?;
                let after = canonical_scene_body_declaration_snapshot(
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )?;
                append_declaration_change(
                    conn,
                    &DeclarationChange {
                        project_id: &request.project_id,
                        scene_id: &request.scene_id,
                        request_id: &request.request_id,
                        operation: "revoke",
                        event_uid: &event_uid,
                        before: &before,
                        after: &after,
                    },
                )?;
                inject(
                    Stage::AfterFeed,
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )?;
                insert_idempotent_response(
                    conn,
                    &idempotency,
                    &request.project_id,
                    &RevokeResponse::Revoked.recorded(),
                )?;
                inject(
                    Stage::AfterIdempotency,
                    conn,
                    &request.project_id,
                    &request.scene_id,
                )?;
                if workspace.check_current_binding().is_err() {
                    return refuse(DeclareRefusal::WorkspaceMismatch);
                }
                ready.set(true);
                Ok(Written::Revoked)
            },
        )
    }));
    let result = match write {
        Ok(result) => result,
        Err(_) if ready.get() => Err((
            anyhow!("NEX_BODY_DECLARATION_PANIC_AFTER_READY"),
            Nir1CommitState::Unknown,
        )),
        Err(_) => Err((
            anyhow!("NEX_BODY_DECLARATION_PANIC_BEFORE_COMMIT"),
            Nir1CommitState::NotCommitted,
        )),
    };

    let ids = WriteIdentifiers {
        domain: REVOKE_IDEMPOTENCY_DOMAIN,
        request_id: &request.request_id,
        payload_hash: &payload_hash,
        project_id: &request.project_id,
        scene_id: &request.scene_id,
        event_uid: &event_uid,
        token_before: Some(&request.declaration_token),
        token_after: None,
        replayed: replay_response.get().is_some(),
    };
    match settle(workspace, &ids, result) {
        Settled::Committed { value, evidence } => Ok(match value {
            Written::Revoked => RevokeOutcome {
                response: RevokeResponse::Revoked,
                replayed: false,
                recovered_after_unknown_commit: false,
                evidence,
            },
            Written::Replayed(response) => RevokeOutcome {
                response,
                replayed: true,
                recovered_after_unknown_commit: false,
                evidence,
            },
        }),
        Settled::ReplayedAfterUnknown { evidence } => match replay_response.get() {
            Some(response) => Ok(RevokeOutcome {
                response,
                replayed: true,
                recovered_after_unknown_commit: false,
                evidence,
            }),
            None => Err(DeclareFailure {
                refusal: DeclareRefusal::Internal,
                evidence: Some(evidence),
            }),
        },
        Settled::Recovered { evidence } => Ok(RevokeOutcome {
            response: RevokeResponse::Revoked,
            replayed: false,
            recovered_after_unknown_commit: true,
            evidence,
        }),
        Settled::NotCommitted { error, evidence } => {
            if let Some(nothing) = error
                .chain()
                .find_map(|cause| cause.downcast_ref::<NothingToWrite>())
            {
                return Ok(RevokeOutcome {
                    response: nothing.0,
                    replayed: false,
                    recovered_after_unknown_commit: false,
                    evidence,
                });
            }
            Err(DeclareFailure {
                refusal: writer_refusal(&error, budget.cancel_requested()),
                evidence: Some(evidence),
            })
        }
        Settled::CommitFailed { evidence } => Err(DeclareFailure {
            refusal: DeclareRefusal::CommitFailed,
            evidence: Some(evidence),
        }),
        Settled::Quarantined { evidence } => Err(DeclareFailure {
            refusal: DeclareRefusal::RestartRequired,
            evidence: Some(evidence),
        }),
    }
}
