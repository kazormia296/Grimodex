//! What a declaration or revoke write became, and the terminal evidence of it.
//!
//! A bounded write ends in one of three ways: the transaction was never ready
//! to COMMIT (nothing is durable), COMMIT returned `Ok`, or it failed at or
//! after COMMIT with a result nobody can trust (`Nir1CommitState::Unknown`).
//! For the third, [`settle`] follows the draft's "COMMIT の結果が分からないとき":
//! the participant scope already rolled back and kept or retired the
//! connection; this module rereads the exact identifiers of the write on a
//! clean connection and decides success, failure or unknown. Unknown
//! quarantines the workspace's declaration writes until the process restarts.
//!
//! [`DeclarationTerminalEvidence`] can be made only here: its field is private
//! and no function of this module hands out a constructor. A writer therefore
//! cannot return without having gone through [`settle`].

use std::collections::BTreeSet;
use std::sync::Mutex;

use anyhow::Result;
use rusqlite::{params, Connection};

use crate::narrative_maintenance_connection::ParticipantSqlFence;
use crate::nir1_generation::history_context::DurableWorkspaceIdentity;
use crate::nir1_generation::{Nir1CommitState, Nir1PinnedSqlBudget};
use crate::state::ActiveWorkspaceSnapshot;

/// Workspaces whose declaration writes are refused until the process restarts,
/// keyed by the durable workspace identity (workspace ID digest and canonical
/// locator digest). It outlives Close and Open of the workspace and is gone
/// with the process.
static QUARANTINED: Mutex<BTreeSet<(String, String)>> = Mutex::new(BTreeSet::new());

fn quarantine_key(identity: &DurableWorkspaceIdentity) -> (String, String) {
    (
        identity.workspace_id_digest.as_str().to_owned(),
        identity.canonical_locator_digest.as_str().to_owned(),
    )
}

fn quarantined_set() -> std::sync::MutexGuard<'static, BTreeSet<(String, String)>> {
    QUARANTINED
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// True when a COMMIT of a declaration or revoke in this workspace had an
/// unknown outcome in this process. Writes are refused with `restart-required`
/// and CB-4's reader must not disclose while this is true. Other operations
/// (saving a manuscript, reading) are not affected.
pub fn is_scene_body_declaration_quarantined(identity: &DurableWorkspaceIdentity) -> bool {
    quarantined_set().contains(&quarantine_key(identity))
}

/// [`is_scene_body_declaration_quarantined`] for the workspace a snapshot was
/// taken from. A workspace without a durable identity cannot have a
/// declaration, so it is not quarantined.
pub fn is_workspace_scene_body_declaration_quarantined(
    workspace: &ActiveWorkspaceSnapshot,
) -> bool {
    workspace
        .durable_workspace_identity()
        .is_some_and(is_scene_body_declaration_quarantined)
}

fn quarantine_workspace(workspace: &ActiveWorkspaceSnapshot) {
    if let Some(identity) = workspace.durable_workspace_identity() {
        quarantined_set().insert(quarantine_key(identity));
    }
}

/// Stands in for a process restart in tests: releases one workspace.
#[cfg(any(test, feature = "workspace-maintenance-test-support"))]
pub fn clear_scene_body_declaration_quarantine_for_test(identity: &DurableWorkspaceIdentity) {
    quarantined_set().remove(&quarantine_key(identity));
}

/// How a write ended.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalKind {
    /// COMMIT succeeded, or the reread proved it did.
    Committed,
    /// Nothing is durable: the transaction rolled back, or the reread proved
    /// nothing was written and the rollback was confirmed.
    RolledBack,
    /// The outcome could not be decided; the workspace is quarantined until
    /// the process restarts.
    QuarantinedUnknown,
}

/// Proof that a write reached its end and its participant may be released. It
/// cannot be built outside this module.
#[derive(Debug, Eq, PartialEq)]
pub struct DeclarationTerminalEvidence {
    kind: TerminalKind,
}

impl DeclarationTerminalEvidence {
    fn new(kind: TerminalKind) -> Self {
        Self { kind }
    }

    pub fn kind(&self) -> TerminalKind {
        self.kind
    }
}

/// The exact identifiers the reread looks for.
pub(super) struct WriteIdentifiers<'a> {
    pub domain: &'a str,
    pub request_id: &'a str,
    pub payload_hash: &'a str,
    pub project_id: &'a str,
    pub scene_id: &'a str,
    /// The change event UID this attempt generated.
    pub event_uid: &'a str,
    /// The declaration token before the write (`None` is NULL).
    pub token_before: Option<&'a str>,
    /// The declaration token the write sets (`None` is NULL).
    pub token_after: Option<&'a str>,
}

pub(super) enum Settled<T> {
    /// COMMIT succeeded.
    Committed {
        value: T,
        evidence: DeclarationTerminalEvidence,
    },
    /// COMMIT's outcome was unknown and the reread proved the write is there.
    Recovered {
        evidence: DeclarationTerminalEvidence,
    },
    /// Failed before COMMIT; the caller turns `error` into a refusal.
    NotCommitted {
        error: anyhow::Error,
        evidence: DeclarationTerminalEvidence,
    },
    /// COMMIT's outcome was unknown and the reread proved nothing was written.
    CommitFailed {
        evidence: DeclarationTerminalEvidence,
    },
    /// The outcome could not be decided; the workspace is quarantined.
    Quarantined {
        evidence: DeclarationTerminalEvidence,
    },
}

enum Reread {
    WrittenAfter,
    WrittenBefore,
    Inconclusive,
}

/// Turns the result of a bounded write into a settled outcome with its
/// terminal evidence. A write whose closure panicked after the transaction was
/// ready to COMMIT is passed in as `Unknown`.
pub(super) fn settle<T>(
    workspace: &ActiveWorkspaceSnapshot,
    ids: &WriteIdentifiers<'_>,
    result: Result<T, (anyhow::Error, Nir1CommitState)>,
) -> Settled<T> {
    match result {
        Ok(value) => Settled::Committed {
            value,
            evidence: DeclarationTerminalEvidence::new(TerminalKind::Committed),
        },
        Err((error, Nir1CommitState::NotCommitted)) => Settled::NotCommitted {
            error,
            evidence: DeclarationTerminalEvidence::new(TerminalKind::RolledBack),
        },
        Err((_, Nir1CommitState::Unknown)) => resolve_unknown(workspace, ids),
    }
}

fn resolve_unknown<T>(
    workspace: &ActiveWorkspaceSnapshot,
    ids: &WriteIdentifiers<'_>,
) -> Settled<T> {
    // The participant scope rolled back and either proved the connection
    // reusable or retired it; if neither could be proved the connection is
    // quarantined and a failure cannot be concluded.
    let rollback_confirmed = workspace.db().db().connection_reusable();
    match reread(workspace, ids) {
        Reread::WrittenAfter => Settled::Recovered {
            evidence: DeclarationTerminalEvidence::new(TerminalKind::Committed),
        },
        Reread::WrittenBefore if rollback_confirmed => Settled::CommitFailed {
            evidence: DeclarationTerminalEvidence::new(TerminalKind::RolledBack),
        },
        Reread::WrittenBefore | Reread::Inconclusive => {
            quarantine_workspace(workspace);
            Settled::Quarantined {
                evidence: DeclarationTerminalEvidence::new(TerminalKind::QuarantinedUnknown),
            }
        }
    }
}

/// Reads the three identifiers on a clean connection in a bounded read
/// transaction. A read that fails or finds a mixed state is inconclusive.
fn reread(workspace: &ActiveWorkspaceSnapshot, ids: &WriteIdentifiers<'_>) -> Reread {
    #[cfg(test)]
    {
        test_hooks::REREADS.with(|count| count.set(count.get() + 1));
        test_hooks::BEFORE_REREAD.with(|hook| {
            if let Some(hook) = hook.borrow().as_ref() {
                hook();
            }
        });
        if test_hooks::FAIL_REREAD.with(std::cell::Cell::get) {
            return Reread::Inconclusive;
        }
    }
    let budget = Nir1PinnedSqlBudget::new();
    #[cfg(any(test, feature = "workspace-maintenance-test-support"))]
    let budget = budget.for_untimed_test();
    workspace
        .db()
        .db()
        .with_participant_read_transaction_bounded_in(
            workspace.participant(),
            ParticipantSqlFence::Pinned,
            budget.sql_budget(),
            |conn| reread_in_tx(conn, ids),
        )
        .unwrap_or(Reread::Inconclusive)
}

fn reread_in_tx(conn: &Connection, ids: &WriteIdentifiers<'_>) -> Result<Reread> {
    let record: Option<String> = rusqlite::OptionalExtension::optional(conn.query_row(
        "SELECT payload_hash FROM idempotency_requests
          WHERE domain = ?1 AND request_id = ?2",
        params![ids.domain, ids.request_id],
        |row| row.get(0),
    ))?;
    let event: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM change_events WHERE project_id = ?1 AND event_uid = ?2)",
        params![ids.project_id, ids.event_uid],
        |row| row.get(0),
    )?;
    let token: Option<Option<String>> = rusqlite::OptionalExtension::optional(conn.query_row(
        "SELECT body_declaration_token FROM narrative_scene_scope_bindings
          WHERE project_id = ?1 AND scene_id = ?2",
        params![ids.project_id, ids.scene_id],
        |row| row.get::<_, Option<String>>(0),
    ))?;
    let Some(token) = token else {
        return Ok(Reread::Inconclusive);
    };
    let token = token.as_deref();
    Ok(match record.as_deref() {
        Some(hash) if hash == ids.payload_hash && event && token == ids.token_after => {
            Reread::WrittenAfter
        }
        None if !event && token == ids.token_before => Reread::WrittenBefore,
        _ => Reread::Inconclusive,
    })
}

#[cfg(test)]
pub(super) mod test_hooks {
    use std::cell::{Cell, RefCell};

    type Hook = Box<dyn Fn()>;

    thread_local! {
        pub(super) static BEFORE_REREAD: RefCell<Option<Hook>> = const { RefCell::new(None) };
        pub(super) static FAIL_REREAD: Cell<bool> = const { Cell::new(false) };
        pub(super) static REREADS: Cell<usize> = const { Cell::new(0) };
    }

    pub(crate) fn set_before_reread(hook: Option<Hook>) {
        BEFORE_REREAD.with(|slot| *slot.borrow_mut() = hook);
    }

    pub(crate) fn fail_reread(fail: bool) {
        FAIL_REREAD.with(|flag| flag.set(fail));
    }

    pub(crate) fn rereads() -> usize {
        REREADS.with(Cell::get)
    }

    pub(crate) fn reset() {
        set_before_reread(None);
        fail_reread(false);
        REREADS.with(|count| count.set(0));
    }
}
