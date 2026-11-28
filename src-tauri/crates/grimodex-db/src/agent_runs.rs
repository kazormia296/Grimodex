//! Native-owned durable AgentRun operations. No renderer SQL is accepted here.

use std::collections::HashSet;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::Path;

use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::idempotency::{
    insert_idempotent_response, load_idempotent_response, payload_fingerprint, IdempotencyRequest,
};
use crate::Database;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActiveStatus {
    Running,
    WaitingUser,
    WaitingApproval,
}

impl ActiveStatus {
    fn sql(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::WaitingUser => "waiting_user",
            Self::WaitingApproval => "waiting_approval",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalOutcome {
    Completed,
    LimitTokens,
    OutputTruncated,
    ContextWindowExceeded,
    ProviderError,
    RecordFailed,
    Timeout,
    UserStop,
    PolicyRevoked,
    LicenseRestricted,
    PermissionDenied,
    AuthorityLost,
    ResumeUnsupported,
    DiscardedByAuthor,
    SupersededByNewTurn,
}

impl TerminalOutcome {
    fn sql(self) -> (&'static str, &'static str) {
        match self {
            Self::Completed => ("completed", "completed"),
            Self::LimitTokens => ("completed", "limit_tokens"),
            Self::OutputTruncated => ("completed", "output_truncated"),
            Self::ContextWindowExceeded => ("completed", "context_window_exceeded"),
            Self::ProviderError => ("failed", "provider_error"),
            Self::RecordFailed => ("failed", "record_failed"),
            Self::Timeout => ("failed", "timeout"),
            Self::UserStop => ("cancelled", "user_stop"),
            Self::PolicyRevoked => ("cancelled", "policy_revoked"),
            Self::LicenseRestricted => ("cancelled", "license_restricted"),
            Self::PermissionDenied => ("cancelled", "permission_denied"),
            Self::AuthorityLost => ("cancelled", "authority_lost"),
            Self::ResumeUnsupported => ("cancelled", "resume_unsupported"),
            Self::DiscardedByAuthor => ("discarded", "discarded_by_author"),
            Self::SupersededByNewTurn => ("discarded", "superseded_by_new_turn"),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InterruptReason {
    AppShutdown,
    RendererLost,
    WorkspaceSwitched,
    ProfileSwitched,
    QuestionTimeout,
    ApprovalTimeout,
}

impl InterruptReason {
    fn sql(self) -> &'static str {
        match self {
            Self::AppShutdown => "app_shutdown",
            Self::RendererLost => "renderer_lost",
            Self::WorkspaceSwitched => "workspace_switched",
            Self::ProfileSwitched => "profile_switched",
            Self::QuestionTimeout => "question_timeout",
            Self::ApprovalTimeout => "approval_timeout",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NotResumableReason {
    CheckpointWriteFailed,
    LedgerWriteFailed,
    HiddenSourceRead,
    RouteUnsupported,
}

impl NotResumableReason {
    fn sql(self) -> &'static str {
        match self {
            Self::CheckpointWriteFailed => "checkpoint_write_failed",
            Self::LedgerWriteFailed => "ledger_write_failed",
            Self::HiddenSourceRead => "hidden_source_read",
            Self::RouteUnsupported => "route_unsupported",
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Eq, PartialEq)]
pub struct RunState {
    pub run_id: String,
    pub version: i64,
    pub status: String,
}

impl RunState {
    fn new(run_id: &str, version: i64, status: &str) -> Self {
        Self {
            run_id: run_id.into(),
            version,
            status: status.into(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunRoute {
    Legacy,
    Mastra,
    Cli,
    CodexApp,
}

impl RunRoute {
    fn sql(self) -> &'static str {
        match self {
            Self::Legacy => "legacy",
            Self::Mastra => "mastra",
            Self::Cli => "cli",
            Self::CodexApp => "codex_app",
        }
    }
}

pub struct RunStart<'a> {
    pub run_id: &'a str,
    pub project_id: &'a str,
    pub chat_session_id: &'a str,
    pub turn_id: &'a str,
    pub route: RunRoute,
    pub origin_user_message_id: &'a str,
    pub origin_assistant_message_id: Option<&'a str>,
    pub model_provider_id: &'a str,
    pub model_id: &'a str,
    pub endpoint_hash: &'a str,
    pub execution_owner: &'a str,
}

fn insert_run(tx: &Transaction<'_>, run: &RunStart<'_>) -> Result<()> {
    ensure!(
        run.origin_assistant_message_id != Some(""),
        "AGENT_RUN_ASSISTANT_MESSAGE_ID_INVALID"
    );
    let belongs: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE id = ?1 AND project_id = ?2)",
        params![run.chat_session_id, run.project_id],
        |row| row.get(0),
    )?;
    ensure!(belongs, "AGENT_RUN_SESSION_PROJECT_MISMATCH");
    tx.execute(
        "INSERT INTO agent_runs
            (run_id,root_run_id,project_id,chat_session_id,turn_id,route,
             origin_user_message_id,origin_assistant_message_id,model_provider_id,model_id,
             endpoint_hash,execution_owner,status)
         VALUES (?1,?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'running')",
        params![
            run.run_id,
            run.project_id,
            run.chat_session_id,
            run.turn_id,
            run.route.sql(),
            run.origin_user_message_id,
            run.origin_assistant_message_id,
            run.model_provider_id,
            run.model_id,
            run.endpoint_hash,
            run.execution_owner
        ],
    )?;
    Ok(())
}

pub(crate) const UNFINISHED_RUN_EXISTS_SQL: &str =
    "SELECT EXISTS(SELECT 1 FROM agent_runs WHERE chat_session_id=?1
      AND status IN ('running','waiting_user','waiting_approval','finalizing','interrupted'))";

pub fn start_run(db: &Database, run: &RunStart<'_>) -> Result<RunState> {
    immediate(db, |tx| {
        let unfinished: bool =
            tx.query_row(UNFINISHED_RUN_EXISTS_SQL, [run.chat_session_id], |row| {
                row.get(0)
            })?;
        ensure!(!unfinished, "AGENT_RUN_UNFINISHED_SESSION_EXISTS");
        insert_run(tx, run)?;
        Ok(RunState::new(run.run_id, 0, "running"))
    })
}

fn immediate<T>(db: &Database, write: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
    db.with_conn_mut(|conn| {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = write(&tx)?;
        tx.commit()?;
        Ok(result)
    })
}

fn read_owned_state(conn: &Connection, run_id: &str) -> Result<Option<(String, RunState)>> {
    Ok(conn
        .query_row(
            "SELECT execution_owner,version,status FROM agent_runs WHERE run_id=?1",
            [run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    RunState {
                        run_id: run_id.into(),
                        version: row.get(1)?,
                        status: row.get(2)?,
                    },
                ))
            },
        )
        .optional()?)
}

fn require_nonterminal_state(conn: &Connection, run_id: &str, owner: &str) -> Result<RunState> {
    let (actual_owner, state) = read_owned_state(conn, run_id)?.context("AGENT_RUN_NOT_FOUND")?;
    ensure!(actual_owner == owner, "AGENT_RUN_OWNER_MISMATCH");
    ensure!(
        !matches!(
            state.status.as_str(),
            "completed" | "failed" | "cancelled" | "discarded"
        ),
        "AGENT_RUN_TERMINAL"
    );
    Ok(state)
}

fn require_match<T>(conn: &Connection, run_id: &str, owner: &str, matched: Option<T>) -> Result<T> {
    if let Some(value) = matched {
        return Ok(value);
    }
    require_nonterminal_state(conn, run_id, owner)?;
    anyhow::bail!("AGENT_RUN_VERSION_OR_STATUS_MISMATCH");
}

fn require_cas(conn: &Connection, run_id: &str, owner: &str, changed: usize) -> Result<()> {
    require_match(conn, run_id, owner, (changed == 1).then_some(()))
}

pub(crate) const CLEAR_TERMINAL_INTERACTIONS_SQL: &str =
    "UPDATE agent_run_interactions SET request='',resolution='',target_basis=NULL,
            version=version+CASE WHEN status='pending' THEN 1 ELSE 0 END,
            status=CASE WHEN status='pending' THEN 'cancelled' ELSE status END
      WHERE run_id=?1";

fn clear_terminal_interactions(tx: &Transaction<'_>, run_id: &str) -> Result<()> {
    tx.execute(CLEAR_TERMINAL_INTERACTIONS_SQL, [run_id])?;
    Ok(())
}

pub fn interrupt_run(
    db: &Database,
    run_id: &str,
    owner: &str,
    expected: ActiveStatus,
    version: i64,
    reason: InterruptReason,
) -> Result<RunState> {
    immediate(db, |tx| {
        interrupt_in_tx(tx, run_id, owner, expected.sql(), version, reason)
    })
}

fn interrupt_in_tx(
    tx: &Transaction<'_>,
    run_id: &str,
    owner: &str,
    expected: &str,
    version: i64,
    reason: InterruptReason,
) -> Result<RunState> {
    require_cas(
        tx,
        run_id,
        owner,
        tx.execute(
            "UPDATE agent_runs SET status='interrupted',interrupt_reason=?1,
                version=version+1,activity_at=datetime('now'),updated_at=datetime('now')
          WHERE run_id=?2 AND execution_owner=?3 AND status=?4 AND version=?5",
            params![reason.sql(), run_id, owner, expected, version],
        )?,
    )?;
    Ok(RunState::new(run_id, version + 1, "interrupted"))
}

pub fn begin_finalizing(
    db: &Database,
    run_id: &str,
    owner: &str,
    expected: ActiveStatus,
    version: i64,
    target: TerminalOutcome,
    assistant_message_id: &str,
) -> Result<RunState> {
    let (status, reason) = target.sql();
    ensure!(status != "discarded", "AGENT_RUN_INVALID_FINALIZING_TARGET");
    immediate(db, |tx| {
        let origin_id = tx
            .query_row(
                "SELECT origin_assistant_message_id FROM agent_runs
                  WHERE run_id=?1 AND execution_owner=?2 AND status=?3 AND version=?4",
                params![run_id, owner, expected.sql(), version],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?;
        let origin_id = require_match(tx, run_id, owner, origin_id)?;
        ensure!(
            origin_id
                .as_deref()
                .is_none_or(|id| id == assistant_message_id),
            "AGENT_RUN_ASSISTANT_MESSAGE_ID_MISMATCH"
        );
        tx.execute(
            "UPDATE agent_runs SET status='finalizing',finalizing_target_status=?1,
                finalizing_target_reason=?2,origin_assistant_message_id=COALESCE(origin_assistant_message_id,?3),
                version=version+1,activity_at=datetime('now'),updated_at=datetime('now')
              WHERE run_id=?4",
            params![status, reason, assistant_message_id, run_id],
        )?;
        Ok(RunState::new(run_id, version + 1, "finalizing"))
    })
}

#[derive(Debug, Eq, PartialEq)]
pub struct FinalizingRun {
    pub run_id: String,
    pub execution_owner: String,
    pub target_status: String,
    pub target_reason: String,
    pub origin_user_message_id: String,
    pub origin_assistant_message_id: String,
    pub version: i64,
}

impl FinalizingRun {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            run_id: row.get(0)?,
            execution_owner: row.get(1)?,
            target_status: row.get(2)?,
            target_reason: row.get(3)?,
            origin_user_message_id: row.get(4)?,
            origin_assistant_message_id: row.get(5)?,
            version: row.get(6)?,
        })
    }
}

pub fn get_finalizing(db: &Database, run_id: &str, owner: &str) -> Result<Option<FinalizingRun>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT run_id,execution_owner,finalizing_target_status,finalizing_target_reason,
                    origin_user_message_id,origin_assistant_message_id,version
               FROM agent_runs WHERE run_id=?1 AND execution_owner=?2 AND status='finalizing'",
                params![run_id, owner],
                FinalizingRun::from_row,
            )
            .optional()?)
    })
}

pub fn list_owners_with_active_runs(db: &Database) -> Result<Vec<String>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT execution_owner FROM agent_runs
              WHERE status IN ('running','waiting_user','waiting_approval','finalizing')
              ORDER BY execution_owner",
        )?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    })
}

pub fn list_finalizing(db: &Database) -> Result<Vec<FinalizingRun>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT run_id,execution_owner,finalizing_target_status,finalizing_target_reason,
                origin_user_message_id,origin_assistant_message_id,version
               FROM agent_runs WHERE status='finalizing' ORDER BY run_id",
        )?;
        let rows = stmt.query_map([], FinalizingRun::from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    })
}

#[derive(Debug, Eq, PartialEq)]
pub struct RunStatus {
    pub run_id: String,
    pub project_id: String,
    pub chat_session_id: String,
    pub execution_owner: String,
    pub status: String,
    pub version: i64,
    pub resumable: bool,
    pub terminal_reason: Option<String>,
    pub interrupt_reason: Option<String>,
    pub not_resumable_reason: Option<String>,
    pub resume_block_detail: Option<String>,
    pub finalizing_target_reason: Option<String>,
}

impl RunStatus {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            run_id: row.get(0)?,
            project_id: row.get(1)?,
            chat_session_id: row.get(2)?,
            execution_owner: row.get(3)?,
            status: row.get(4)?,
            version: row.get(5)?,
            resumable: row.get(6)?,
            terminal_reason: row.get(7)?,
            interrupt_reason: row.get(8)?,
            not_resumable_reason: row.get(9)?,
            resume_block_detail: row.get(10)?,
            finalizing_target_reason: row.get(11)?,
        })
    }
}

pub fn get_run_status(db: &Database, run_id: &str) -> Result<Option<RunStatus>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT run_id,project_id,chat_session_id,execution_owner,status,version,resumable,
                    terminal_reason,interrupt_reason,not_resumable_reason,resume_block_detail,
                    finalizing_target_reason
                   FROM agent_runs WHERE run_id=?1",
                [run_id],
                RunStatus::from_row,
            )
            .optional()?)
    })
}

pub(crate) const UNFINISHED_RUN_FOR_SESSION_SQL: &str =
    "SELECT run_id,project_id,chat_session_id,execution_owner,status,version,resumable,
            terminal_reason,interrupt_reason,not_resumable_reason,resume_block_detail,
            finalizing_target_reason
       FROM agent_runs WHERE chat_session_id=?1
        AND status IN ('running','waiting_user','waiting_approval','finalizing','interrupted')";

pub fn get_unfinished_run_for_session(
    db: &Database,
    chat_session_id: &str,
) -> Result<Option<RunStatus>> {
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                UNFINISHED_RUN_FOR_SESSION_SQL,
                [chat_session_id],
                RunStatus::from_row,
            )
            .optional()?)
    })
}

#[derive(Debug, Eq, PartialEq)]
pub struct UnfinishedRun {
    pub run_id: String,
    pub project_id: String,
    pub chat_session_id: String,
    pub turn_id: String,
    pub status: String,
    pub version: i64,
    pub interrupt_reason: Option<String>,
    pub finalizing_target_status: Option<String>,
    pub origin_user_message_id: String,
    pub origin_assistant_message_id: Option<String>,
    pub activity_at: String,
}

pub fn list_unfinished_runs_for_owner(db: &Database, owner: &str) -> Result<Vec<UnfinishedRun>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT run_id,project_id,chat_session_id,turn_id,status,version,interrupt_reason,
                    finalizing_target_status,origin_user_message_id,origin_assistant_message_id,activity_at
               FROM agent_runs WHERE execution_owner=?1
                AND status IN ('running','waiting_user','waiting_approval','finalizing','interrupted')
              ORDER BY run_id",
        )?;
        let rows = stmt.query_map([owner], |row| {
            Ok(UnfinishedRun {
                run_id: row.get(0)?,
                project_id: row.get(1)?,
                chat_session_id: row.get(2)?,
                turn_id: row.get(3)?,
                status: row.get(4)?,
                version: row.get(5)?,
                interrupt_reason: row.get(6)?,
                finalizing_target_status: row.get(7)?,
                origin_user_message_id: row.get(8)?,
                origin_assistant_message_id: row.get(9)?,
                activity_at: row.get(10)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    })
}

fn finish_finalizing_in_tx(
    tx: &Transaction<'_>,
    run_id: &str,
    owner: &str,
    version: i64,
) -> Result<RunState> {
    let status = tx
        .query_row(
            "UPDATE agent_runs SET status=finalizing_target_status,
                terminal_reason=finalizing_target_reason,checkpoint=NULL,
                checkpoint_digest=NULL,checkpoint_step=0,tool_call_ledger='[]',
                version=version+1,activity_at=datetime('now'),updated_at=datetime('now')
          WHERE run_id=?1 AND execution_owner=?2 AND status='finalizing' AND version=?3
          RETURNING status",
            params![run_id, owner, version],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let status = require_match(tx, run_id, owner, status)?;
    clear_terminal_interactions(tx, run_id)?;
    Ok(RunState::new(run_id, version + 1, &status))
}

pub fn finish_finalizing(
    db: &Database,
    run_id: &str,
    owner: &str,
    version: i64,
) -> Result<RunState> {
    immediate(db, |tx| finish_finalizing_in_tx(tx, run_id, owner, version))
}

pub fn finish_run_without_messages(
    db: &Database,
    run_id: &str,
    owner: &str,
    version: i64,
    outcome: TerminalOutcome,
) -> Result<RunState> {
    ensure!(
        outcome.sql().0 != "discarded",
        "AGENT_RUN_INVALID_TERMINAL_TARGET"
    );
    immediate(db, |tx| {
        finish_without_messages_in_tx(tx, run_id, owner, "running", version, outcome)
    })
}

fn finish_without_messages_in_tx(
    tx: &Transaction<'_>,
    run_id: &str,
    owner: &str,
    expected: &str,
    version: i64,
    outcome: TerminalOutcome,
) -> Result<RunState> {
    let (status, reason) = outcome.sql();
    require_cas(
        tx,
        run_id,
        owner,
        tx.execute(
            "UPDATE agent_runs SET status=?1,terminal_reason=?2,
                checkpoint=NULL,checkpoint_digest=NULL,checkpoint_step=0,tool_call_ledger='[]',
                version=version+1,activity_at=datetime('now'),updated_at=datetime('now')
          WHERE run_id=?3 AND execution_owner=?4 AND status=?5 AND version=?6",
            params![status, reason, run_id, owner, expected, version],
        )?,
    )?;
    clear_terminal_interactions(tx, run_id)?;
    Ok(RunState::new(run_id, version + 1, status))
}

pub fn discard_run(db: &Database, run_id: &str, owner: &str, version: i64) -> Result<RunState> {
    immediate(db, |tx| {
        finish_without_messages_in_tx(
            tx,
            run_id,
            owner,
            "interrupted",
            version,
            TerminalOutcome::DiscardedByAuthor,
        )
    })
}

#[derive(Debug, Eq, PartialEq)]
pub struct SupersedingRunResult {
    pub discarded: RunState,
    pub started: RunState,
}

pub fn start_superseding_run(
    db: &Database,
    old_run_id: &str,
    old_owner: &str,
    old_version: i64,
    new_run: &RunStart<'_>,
) -> Result<SupersedingRunResult> {
    immediate(db, |tx| {
        let old_session = tx
            .query_row(
                "SELECT chat_session_id FROM agent_runs WHERE run_id=?1 AND execution_owner=?2
               AND status='interrupted' AND version=?3",
                params![old_run_id, old_owner, old_version],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let old_session = require_match(tx, old_run_id, old_owner, old_session)?;
        ensure!(
            old_session == new_run.chat_session_id,
            "AGENT_RUN_SESSION_MISMATCH"
        );
        let discarded = finish_without_messages_in_tx(
            tx,
            old_run_id,
            old_owner,
            "interrupted",
            old_version,
            TerminalOutcome::SupersededByNewTurn,
        )?;
        insert_run(tx, new_run)?;
        Ok(SupersedingRunResult {
            discarded,
            started: RunState::new(new_run.run_id, 0, "running"),
        })
    })
}

#[derive(Clone, Copy)]
pub enum ResumeGate {
    Allowed,
    Blocked(ResumeBlockReason),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResumeBlockReason {
    LicenseRestricted,
    AiPolicy,
    ProfileEgress,
    RouteUnavailable,
    ProviderUnavailable,
    ModelUnavailable,
    EndpointChanged,
}

impl ResumeBlockReason {
    fn sql(self) -> &'static str {
        match self {
            Self::LicenseRestricted => "license_restricted",
            Self::AiPolicy => "ai_policy",
            Self::ProfileEgress => "profile_egress",
            Self::RouteUnavailable => "route_unavailable",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::ModelUnavailable => "model_unavailable",
            Self::EndpointChanged => "endpoint_changed",
        }
    }
}

#[derive(Serialize)]
pub struct ClaimAnswer<'a> {
    pub interaction_id: &'a str,
    pub expected_version: i64,
    pub resolution: &'a str,
}

pub type ClaimResult = RunState;

pub struct ClaimRequest<'a> {
    pub run_id: &'a str,
    pub old_owner: &'a str,
    pub new_owner: &'a str,
    pub expected_version: i64,
    pub request_id: &'a str,
    pub gate: ResumeGate,
    pub answer: Option<&'a ClaimAnswer<'a>>,
}

fn require_claim_target(
    conn: &Connection,
    run_id: &str,
    owner: &str,
    version: i64,
) -> Result<(String, String, String)> {
    let target = conn
        .query_row(
            "SELECT project_id,root_run_id,chat_session_id,resumable
               FROM agent_runs WHERE run_id=?1 AND execution_owner=?2
                AND status='interrupted' AND version=?3",
            params![run_id, owner, version],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get::<_, bool>(3)?,
                ))
            },
        )
        .optional()?;
    let (project_id, root_run_id, chat_session_id, resumable) =
        require_match(conn, run_id, owner, target)?;
    ensure!(resumable, "AGENT_RUN_NOT_RESUMABLE");
    Ok((project_id, root_run_id, chat_session_id))
}

pub fn claim_run(db: &Database, claim: ClaimRequest<'_>) -> Result<Option<ClaimResult>> {
    let ClaimRequest {
        run_id,
        old_owner,
        new_owner,
        expected_version,
        request_id,
        gate,
        answer,
    } = claim;
    match gate {
        ResumeGate::Blocked(detail) => {
            immediate(db, |tx| {
                require_claim_target(tx, run_id, old_owner, expected_version)?;
                require_cas(tx, run_id, old_owner, tx.execute(
                    "UPDATE agent_runs SET resume_block_detail=?1,resume_blocked_at=datetime('now')
                      WHERE run_id=?2 AND execution_owner=?3 AND status='interrupted' AND version=?4",
                    params![detail.sql(), run_id, old_owner, expected_version],
                )?)
            })?;
            Ok(None)
        }
        ResumeGate::Allowed => {
            // `old_owner` is left out: a replaying caller reads it from the row, which
            // already names `new_owner` after the first claim committed.
            let payload_hash = payload_fingerprint(
                "agent_run_claim",
                &(run_id, new_owner, expected_version, answer),
            )?;
            let request = IdempotencyRequest {
                domain: "agent_run_claim",
                request_id: Some(request_id),
                payload_hash: &payload_hash,
                conflict_marker: "AGENT_RUN_CLAIM_IDEMPOTENCY_CONFLICT",
            };
            immediate(db, |tx| {
                if let Some(response) = load_idempotent_response(tx, &request)? {
                    let result: ClaimResult = serde_json::from_value(response)?;
                    ensure!(
                        matches!(read_owned_state(tx, run_id)?, Some((owner, state))
                            if owner == new_owner && state == result),
                        "AGENT_RUN_CLAIM_REPLAY_STALE"
                    );
                    return Ok(Some(result));
                }
                let (project_id, root_run_id, chat_session_id) =
                    require_claim_target(tx, run_id, old_owner, expected_version)?;
                let pending: Option<(String, String)> = tx
                    .query_row(
                        "SELECT interaction_id,kind FROM agent_run_interactions
                      WHERE root_run_id=?1 AND status='pending'",
                        [&root_run_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let status = match (&pending, answer) {
                    (Some((_, kind)), Some(_)) if kind == "approval" => {
                        anyhow::bail!("AGENT_RUN_APPROVAL_ANSWER_NOT_ALLOWED")
                    }
                    (Some((id, kind)), Some(answer))
                        if kind == "user_question" && id == answer.interaction_id =>
                    {
                        "running"
                    }
                    (Some((_, kind)), None) if kind == "approval" => "waiting_approval",
                    (Some((_, kind)), None) if kind == "user_question" => "waiting_user",
                    (None, None) => "running",
                    _ => anyhow::bail!("AGENT_RUN_CLAIM_ANSWER_MISMATCH"),
                };
                let other_active: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM agent_runs WHERE chat_session_id=?1 AND run_id<>?2
                      AND status IN ('running','waiting_user','waiting_approval','finalizing'))",
                    params![chat_session_id, run_id],
                    |row| row.get(0),
                )?;
                ensure!(!other_active, "AGENT_RUN_ACTIVE_SESSION_EXISTS");
                if let Some(answer) = answer {
                    require_cas(tx, run_id, old_owner, tx.execute(
                        "UPDATE agent_run_interactions SET status='resolved',resolution=?1,version=version+1
                          WHERE interaction_id=?2 AND run_id=?3 AND kind='user_question'
                            AND status='pending' AND version=?4",
                        params![answer.resolution, answer.interaction_id, run_id, answer.expected_version],
                    )?)?;
                }
                require_cas(tx, run_id, old_owner, tx.execute(
                    "UPDATE agent_runs SET status=?5,execution_owner=?1,
                            interrupt_reason=NULL,resume_block_detail=NULL,resume_blocked_at=NULL,version=version+1,
                            activity_at=datetime('now'),updated_at=datetime('now')
                      WHERE run_id=?2 AND execution_owner=?3 AND status='interrupted'
                        AND version=?4 AND resumable=1",
                    params![new_owner, run_id, old_owner, expected_version, status],
                )?)?;
                let result = ClaimResult::new(run_id, expected_version + 1, status);
                insert_idempotent_response(
                    tx,
                    &request,
                    &project_id,
                    &serde_json::to_value(&result)?,
                )?;
                Ok(Some(result))
            })
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CapabilityState {
    NotIssued,
    AwaitingApproval,
    Issued,
    Consumed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionState {
    Pending,
    Committed,
    Failed,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub tool_call_id: String,
    pub name: String,
    pub canonical_args: Value,
    pub args_digest: String,
    pub execution_id: String,
    pub chat_message_id: String,
    pub main_owned_provenance_id: String,
    pub model: String,
    pub capability_state: CapabilityState,
    pub execution_state: ExecutionState,
}

fn validate_tool_call_key(execution_id: &str, tool_call_id: &str) -> Result<()> {
    ensure!(!execution_id.is_empty(), "AGENT_RUN_EXECUTION_ID_INVALID");
    ensure!(!tool_call_id.is_empty(), "AGENT_RUN_TOOL_CALL_ID_INVALID");
    Ok(())
}

pub fn append_tool_calls(
    db: &Database,
    run_id: &str,
    owner: &str,
    entries: Vec<LedgerEntry>,
) -> Result<()> {
    immediate(db, |tx| {
        let execution_id = entries
            .first()
            .context("AGENT_RUN_EMPTY_TOOL_CALL_BATCH")?
            .execution_id
            .as_str();
        let mut ledger = read_ledger(tx, run_id, owner, true)?;
        let pending_tool_call_id: Option<String> = tx
            .query_row(
                "SELECT tool_call_id FROM agent_run_interactions
                  WHERE run_id=?1 AND status='pending'",
                [run_id],
                |row| row.get(0),
            )
            .optional()?;
        let mut tool_call_ids: HashSet<_> = ledger
            .iter()
            .filter(|entry| entry.execution_id == execution_id)
            .map(|entry| entry.tool_call_id.as_str())
            .collect();
        for entry in &entries {
            validate_tool_call_key(&entry.execution_id, &entry.tool_call_id)?;
            ensure!(
                entry.execution_id == execution_id,
                "AGENT_RUN_TOOL_CALL_BATCH_EXECUTION_MISMATCH"
            );
            ensure!(
                pending_tool_call_id.as_deref() != Some(entry.tool_call_id.as_str()),
                "AGENT_RUN_PENDING_INTERACTION_EXISTS"
            );
            ensure!(
                tool_call_ids.insert(entry.tool_call_id.as_str()),
                "AGENT_RUN_DUPLICATE_TOOL_CALL_ID"
            );
        }
        add_audit_execution_id_in_tx(tx, run_id, owner, execution_id)?;
        ledger.extend(entries);
        write_ledger(tx, run_id, owner, &ledger)
    })
}

fn read_ledger(
    tx: &Transaction<'_>,
    run_id: &str,
    owner: &str,
    active_only: bool,
) -> Result<Vec<LedgerEntry>> {
    let ledger = tx
        .query_row(
            "SELECT tool_call_ledger FROM agent_runs
          WHERE run_id=?1 AND execution_owner=?2 AND status IN
            ('running','waiting_user','waiting_approval','finalizing','interrupted')
            AND (?3=0 OR status IN ('running','waiting_user','waiting_approval'))",
            params![run_id, owner, active_only],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let ledger = require_match(tx, run_id, owner, ledger)?;
    Ok(serde_json::from_str(&ledger)?)
}

fn write_ledger(
    tx: &Transaction<'_>,
    run_id: &str,
    owner: &str,
    ledger: &[LedgerEntry],
) -> Result<()> {
    tx.execute(
        "UPDATE agent_runs SET tool_call_ledger=?1,activity_at=datetime('now')
          WHERE run_id=?2 AND execution_owner=?3",
        params![serde_json::to_string(ledger)?, run_id, owner],
    )?;
    Ok(())
}

const MAX_AUDIT_EXECUTION_IDS: usize = 512;

pub fn add_audit_execution_id(
    db: &Database,
    run_id: &str,
    owner: &str,
    execution_id: &str,
) -> Result<()> {
    immediate(db, |tx| {
        require_nonterminal_state(tx, run_id, owner)?;
        add_audit_execution_id_in_tx(tx, run_id, owner, execution_id)
    })
}

fn add_audit_execution_id_in_tx(
    tx: &Transaction<'_>,
    run_id: &str,
    owner: &str,
    execution_id: &str,
) -> Result<()> {
    ensure!(!execution_id.is_empty(), "AGENT_RUN_EXECUTION_ID_INVALID");
    let stored: String = tx.query_row(
        "SELECT audit_execution_ids FROM agent_runs WHERE run_id=?1 AND execution_owner=?2",
        params![run_id, owner],
        |row| row.get(0),
    )?;
    let mut ids: Vec<String> = serde_json::from_str(&stored)?;
    if ids.iter().any(|id| id == execution_id) {
        return Ok(());
    }
    ensure!(
        ids.len() < MAX_AUDIT_EXECUTION_IDS,
        "AGENT_RUN_AUDIT_EXECUTION_IDS_LIMIT"
    );
    ids.push(execution_id.into());
    tx.execute(
        "UPDATE agent_runs SET audit_execution_ids=?1 WHERE run_id=?2 AND execution_owner=?3",
        params![serde_json::to_string(&ids)?, run_id, owner],
    )?;
    Ok(())
}

pub struct ToolCallUpdate<'a> {
    pub run_id: &'a str,
    pub owner: &'a str,
    pub execution_id: &'a str,
    pub tool_call_id: &'a str,
    pub main_owned_provenance_id: Option<&'a str>,
    pub capability_state: Option<CapabilityState>,
    pub execution_state: Option<ExecutionState>,
}

pub fn update_tool_call(db: &Database, update: ToolCallUpdate<'_>) -> Result<()> {
    let ToolCallUpdate {
        run_id,
        owner,
        execution_id,
        tool_call_id,
        main_owned_provenance_id,
        capability_state,
        execution_state,
    } = update;
    validate_tool_call_key(execution_id, tool_call_id)?;
    immediate(db, |tx| {
        let mut ledger = read_ledger(tx, run_id, owner, false)?;
        let entry = ledger
            .iter_mut()
            .find(|entry| entry.execution_id == execution_id && entry.tool_call_id == tool_call_id)
            .context("AGENT_RUN_UNKNOWN_TOOL_CALL_ID")?;
        ensure!(
            main_owned_provenance_id.is_some()
                || capability_state.is_some()
                || execution_state.is_some(),
            "AGENT_RUN_TOOL_CALL_TRANSITION_INVALID"
        );
        if let Some(id) = main_owned_provenance_id {
            ensure!(
                !id.is_empty() && entry.main_owned_provenance_id.is_empty(),
                "AGENT_RUN_TOOL_CALL_TRANSITION_INVALID"
            );
            entry.main_owned_provenance_id = id.to_string();
        }
        if let Some(next) = capability_state {
            let rank = |state| match state {
                CapabilityState::NotIssued => 0,
                CapabilityState::AwaitingApproval => 1,
                CapabilityState::Issued => 2,
                CapabilityState::Consumed => 3,
            };
            ensure!(
                rank(next) > rank(entry.capability_state),
                "AGENT_RUN_TOOL_CALL_TRANSITION_INVALID"
            );
            entry.capability_state = next;
        }
        if let Some(next) = execution_state {
            ensure!(
                matches!(entry.execution_state, ExecutionState::Pending)
                    && !matches!(next, ExecutionState::Pending),
                "AGENT_RUN_TOOL_CALL_TRANSITION_INVALID"
            );
            entry.execution_state = next;
        }
        write_ledger(tx, run_id, owner, &ledger)
    })
}

pub fn write_checkpoint(
    db: &Database,
    run_id: &str,
    owner: &str,
    step: i64,
    checkpoint: &Value,
    digest: &str,
) -> Result<()> {
    ensure!(
        step > 0 && checkpoint.is_object(),
        "AGENT_RUN_CHECKPOINT_INVALID"
    );
    immediate(db, |tx| {
        let changed = tx.execute(
            "UPDATE agent_runs SET checkpoint=?1,checkpoint_digest=?2,checkpoint_step=?3,
                    activity_at=datetime('now')
              WHERE run_id=?4 AND execution_owner=?5 AND checkpoint_step<?3 AND status IN
                ('running','waiting_user','waiting_approval','finalizing','interrupted')",
            params![
                serde_json::to_string(checkpoint)?,
                digest,
                step,
                run_id,
                owner
            ],
        )?;
        if changed == 0 {
            require_nonterminal_state(tx, run_id, owner)?;
            anyhow::bail!("AGENT_RUN_CHECKPOINT_STEP_MISMATCH");
        }
        Ok(())
    })
}

pub fn mark_not_resumable(
    db: &Database,
    run_id: &str,
    owner: &str,
    expected: &str,
    reason: NotResumableReason,
) -> Result<RunState> {
    immediate(db, |tx| {
        let state = require_nonterminal_state(tx, run_id, owner)?;
        ensure!(
            state.status == expected,
            "AGENT_RUN_VERSION_OR_STATUS_MISMATCH"
        );
        tx.execute(
            "UPDATE agent_runs SET resumable=0,not_resumable_reason=?1
              WHERE run_id=?2 AND execution_owner=?3 AND status=?4 AND resumable=1",
            params![reason.sql(), run_id, owner, expected],
        )?;
        Ok(state)
    })
}

pub fn touch_activity(db: &Database, run_id: &str, owner: &str) -> Result<()> {
    immediate(db, |tx| {
        require_cas(tx, run_id, owner, tx.execute(
            "UPDATE agent_runs SET activity_at=datetime('now') WHERE run_id=?1 AND execution_owner=?2
               AND status IN ('running','waiting_user','waiting_approval','finalizing','interrupted')",
            params![run_id, owner],
        )?)
    })
}

pub struct OpenQuestion<'a> {
    pub interaction_id: &'a str,
    pub run_id: &'a str,
    pub owner: &'a str,
    pub expected_version: i64,
    pub execution_id: &'a str,
    pub tool_call_id: &'a str,
    pub args_digest: &'a str,
    pub request: &'a str,
}

fn open_interaction_target(
    tx: &Transaction<'_>,
    run_id: &str,
    owner: &str,
    execution_id: &str,
    tool_call_id: &str,
    args_digest: &str,
    tool_name: Option<&str>,
) -> Result<(String, String)> {
    let target = tx.query_row(
        "SELECT root_run_id,chat_session_id FROM agent_runs WHERE run_id=?1 AND execution_owner=?2
          AND status IN ('running','waiting_user','waiting_approval','finalizing','interrupted')",
        params![run_id, owner], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    ).optional()?;
    let target = require_match(tx, run_id, owner, target)?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_run_interactions WHERE root_run_id=?1 AND status='pending')",
        [&target.0], |row| row.get(0),
    )?;
    ensure!(!exists, "AGENT_RUN_PENDING_INTERACTION_EXISTS");
    validate_tool_call_key(execution_id, tool_call_id)?;
    let ledger = read_ledger(tx, run_id, owner, false)?;
    let entry = latest_tool_call(&ledger, tool_call_id)?;
    ensure!(
        entry.execution_id == execution_id,
        "AGENT_RUN_TOOL_CALL_EXECUTION_MISMATCH"
    );
    ensure!(
        entry.args_digest == args_digest && tool_name.is_none_or(|name| entry.name == name),
        "AGENT_RUN_TOOL_CALL_MISMATCH"
    );
    Ok(target)
}

fn latest_tool_call<'a>(ledger: &'a [LedgerEntry], tool_call_id: &str) -> Result<&'a LedgerEntry> {
    ledger
        .iter()
        .rev()
        .find(|entry| entry.tool_call_id == tool_call_id)
        .context("AGENT_RUN_UNKNOWN_TOOL_CALL_ID")
}

const MAX_INTERACTION_REQUEST_BYTES: usize = 65_536;

pub fn open_user_question(db: &Database, question: &OpenQuestion<'_>) -> Result<RunState> {
    ensure!(
        question.request.len() <= MAX_INTERACTION_REQUEST_BYTES,
        "AGENT_RUN_REQUEST_TOO_LARGE"
    );
    immediate(db, |tx| {
        let (root_run_id, chat_session_id) = open_interaction_target(
            tx,
            question.run_id,
            question.owner,
            question.execution_id,
            question.tool_call_id,
            question.args_digest,
            None,
        )?;
        require_cas(
            tx,
            question.run_id,
            question.owner,
            tx.execute(
                "UPDATE agent_runs SET status='waiting_user',version=version+1,
                    activity_at=datetime('now'),updated_at=datetime('now')
              WHERE run_id=?1 AND execution_owner=?2 AND status='running' AND version=?3",
                params![question.run_id, question.owner, question.expected_version],
            )?,
        )?;
        tx.execute(
            "INSERT INTO agent_run_interactions
                (interaction_id,run_id,root_run_id,chat_session_id,kind,tool_call_id,tool_name,args_digest,request,status)
             VALUES (?1,?2,?3,?4,'user_question',?5,'ask_user',?6,?7,'pending')",
            params![question.interaction_id, question.run_id, root_run_id, chat_session_id,
                    question.tool_call_id, question.args_digest, question.request],
        )?;
        Ok(RunState::new(
            question.run_id,
            question.expected_version + 1,
            "waiting_user",
        ))
    })
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", from = "AnalysisReadBasisEntryJson")]
pub struct AnalysisReadBasisEntryV1 {
    pub source_kind: String,
    pub source_id: String,
    #[serde(flatten)]
    pub revision: AnalysisReadBasisRevision,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AnalysisReadBasisRevision {
    Version(String),
    ContentHash(String),
}

#[derive(Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase", deny_unknown_fields)]
enum AnalysisReadBasisEntryJson {
    Version {
        source_kind: String,
        source_id: String,
        version: String,
    },
    ContentHash {
        source_kind: String,
        source_id: String,
        content_hash: String,
    },
}

impl From<AnalysisReadBasisEntryJson> for AnalysisReadBasisEntryV1 {
    fn from(entry: AnalysisReadBasisEntryJson) -> Self {
        let (source_kind, source_id, revision) = match entry {
            AnalysisReadBasisEntryJson::Version {
                source_kind,
                source_id,
                version,
            } => (
                source_kind,
                source_id,
                AnalysisReadBasisRevision::Version(version),
            ),
            AnalysisReadBasisEntryJson::ContentHash {
                source_kind,
                source_id,
                content_hash,
            } => (
                source_kind,
                source_id,
                AnalysisReadBasisRevision::ContentHash(content_hash),
            ),
        };
        Self {
            source_kind,
            source_id,
            revision,
        }
    }
}

const MAX_TARGET_BASIS_JSON_BYTES: usize = 32 * 1024;
const TARGET_BASIS_INVALID: &str = "AGENT_RUN_TARGET_BASIS_INVALID";

fn validate_target_basis(entries: &[AnalysisReadBasisEntryV1]) -> Result<()> {
    ensure!((1..=64).contains(&entries.len()), TARGET_BASIS_INVALID);
    for entry in entries {
        let revision = match &entry.revision {
            AnalysisReadBasisRevision::Version(value)
            | AnalysisReadBasisRevision::ContentHash(value) => value,
        };
        ensure!(
            (1..=64).contains(&entry.source_kind.len())
                && (1..=256).contains(&entry.source_id.len())
                && (1..=256).contains(&revision.len()),
            TARGET_BASIS_INVALID
        );
    }
    Ok(())
}

fn encode_target_basis(entries: &[AnalysisReadBasisEntryV1]) -> Result<String> {
    validate_target_basis(entries)?;
    let json = serde_json::to_string(entries).context(TARGET_BASIS_INVALID)?;
    ensure!(
        json.len() <= MAX_TARGET_BASIS_JSON_BYTES,
        TARGET_BASIS_INVALID
    );
    Ok(json)
}

fn decode_target_basis(json: &str) -> Result<Vec<AnalysisReadBasisEntryV1>> {
    ensure!(
        json.len() <= MAX_TARGET_BASIS_JSON_BYTES,
        TARGET_BASIS_INVALID
    );
    let entries: Vec<AnalysisReadBasisEntryV1> =
        serde_json::from_str(json).map_err(|_| anyhow::anyhow!(TARGET_BASIS_INVALID))?;
    validate_target_basis(&entries)?;
    Ok(entries)
}

pub struct OpenApproval<'a> {
    pub interaction_id: &'a str,
    pub run_id: &'a str,
    pub owner: &'a str,
    pub expected_version: i64,
    pub execution_id: &'a str,
    pub tool_call_id: &'a str,
    pub tool_name: &'a str,
    pub args_digest: &'a str,
    pub request: &'a str,
    pub target_basis: Option<&'a [AnalysisReadBasisEntryV1]>,
}

pub fn open_approval(db: &Database, approval: &OpenApproval<'_>) -> Result<RunState> {
    ensure!(
        approval.request.len() <= MAX_INTERACTION_REQUEST_BYTES,
        "AGENT_RUN_REQUEST_TOO_LARGE"
    );
    let target_basis = approval.target_basis.map(encode_target_basis).transpose()?;
    immediate(db, |tx| {
        let (root_run_id, chat_session_id) = open_interaction_target(
            tx,
            approval.run_id,
            approval.owner,
            approval.execution_id,
            approval.tool_call_id,
            approval.args_digest,
            Some(approval.tool_name),
        )?;
        require_cas(
            tx,
            approval.run_id,
            approval.owner,
            tx.execute(
                "UPDATE agent_runs SET status='waiting_approval',version=version+1,
                    activity_at=datetime('now'),updated_at=datetime('now')
              WHERE run_id=?1 AND execution_owner=?2 AND status='running' AND version=?3",
                params![approval.run_id, approval.owner, approval.expected_version],
            )?,
        )?;
        tx.execute(
            "INSERT INTO agent_run_interactions
                (interaction_id,run_id,root_run_id,chat_session_id,kind,tool_call_id,tool_name,args_digest,request,target_basis,status)
             VALUES (?1,?2,?3,?4,'approval',?5,?6,?7,?8,?9,'pending')",
            params![approval.interaction_id, approval.run_id, root_run_id, chat_session_id,
                    approval.tool_call_id, approval.tool_name, approval.args_digest, approval.request, target_basis],
        )?;
        Ok(RunState::new(
            approval.run_id,
            approval.expected_version + 1,
            "waiting_approval",
        ))
    })
}

#[derive(Debug, Eq, PartialEq)]
pub struct PendingApproval {
    pub interaction_id: String,
    pub version: i64,
    pub execution_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub args_digest: String,
    pub target_basis: Option<Vec<AnalysisReadBasisEntryV1>>,
}

pub fn get_pending_approval(db: &Database, run_id: &str) -> Result<Option<PendingApproval>> {
    db.with_conn(|conn| {
        let pending = conn
            .query_row(
                "SELECT i.interaction_id,i.version,i.tool_call_id,i.tool_name,i.args_digest,
                        i.target_basis,r.tool_call_ledger
                   FROM agent_run_interactions i JOIN agent_runs r
                     ON r.run_id=i.run_id AND r.root_run_id=i.root_run_id
                  WHERE i.run_id=?1 AND i.kind='approval' AND i.status='pending'",
                [run_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get::<_, String>(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((
            interaction_id,
            version,
            tool_call_id,
            tool_name,
            args_digest,
            target_basis,
            ledger,
        )) = pending
        else {
            return Ok(None);
        };
        let ledger: Vec<LedgerEntry> = serde_json::from_str(&ledger)?;
        let execution_id = latest_tool_call(&ledger, &tool_call_id)?
            .execution_id
            .clone();
        validate_tool_call_key(&execution_id, &tool_call_id)?;
        Ok(Some(PendingApproval {
            interaction_id,
            version,
            execution_id,
            tool_call_id,
            tool_name,
            args_digest,
            target_basis: target_basis
                .as_deref()
                .map(decode_target_basis)
                .transpose()?,
        }))
    })
}

#[derive(Clone, Copy, Debug)]
pub enum ApprovalDecision {
    Approved,
    Rejected,
}

impl ApprovalDecision {
    fn sql(self) -> &'static str {
        match self {
            Self::Approved => "approved",
            Self::Rejected => "rejected",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum ApprovalInvalidation {
    Superseded,
    Expired,
}

impl ApprovalInvalidation {
    fn sql(self) -> &'static str {
        match self {
            Self::Superseded => "superseded",
            Self::Expired => "expired",
        }
    }
}

fn close_approval(
    db: &Database,
    run_id: &str,
    owner: &str,
    run_version: i64,
    interaction_id: &str,
    interaction_version: i64,
    outcome: (&str, Option<&str>),
) -> Result<RunState> {
    let (status, resolution) = outcome;
    immediate(db, |tx| {
        require_cas(
            tx,
            run_id,
            owner,
            tx.execute(
                "UPDATE agent_run_interactions SET status=?1,resolution=?2,version=version+1
              WHERE interaction_id=?3 AND run_id=?4 AND kind='approval' AND status='pending'
                AND version=?5 AND EXISTS (SELECT 1 FROM agent_runs WHERE run_id=?4
                AND execution_owner=?6 AND status='waiting_approval' AND version=?7)",
                params![
                    status,
                    resolution,
                    interaction_id,
                    run_id,
                    interaction_version,
                    owner,
                    run_version
                ],
            )?,
        )?;
        require_cas(
            tx,
            run_id,
            owner,
            tx.execute(
                "UPDATE agent_runs SET status='running',version=version+1,
                    activity_at=datetime('now'),updated_at=datetime('now')
              WHERE run_id=?1 AND execution_owner=?2 AND status='waiting_approval' AND version=?3",
                params![run_id, owner, run_version],
            )?,
        )?;
        Ok(RunState::new(run_id, run_version + 1, "running"))
    })
}

pub fn decide_approval(
    db: &Database,
    run_id: &str,
    owner: &str,
    run_version: i64,
    interaction_id: &str,
    interaction_version: i64,
    decision: ApprovalDecision,
) -> Result<RunState> {
    close_approval(
        db,
        run_id,
        owner,
        run_version,
        interaction_id,
        interaction_version,
        ("resolved", Some(decision.sql())),
    )
}

pub fn invalidate_approval(
    db: &Database,
    run_id: &str,
    owner: &str,
    run_version: i64,
    interaction_id: &str,
    interaction_version: i64,
    invalidation: ApprovalInvalidation,
) -> Result<RunState> {
    close_approval(
        db,
        run_id,
        owner,
        run_version,
        interaction_id,
        interaction_version,
        (invalidation.sql(), None),
    )
}

pub fn answer_live(
    db: &Database,
    run_id: &str,
    owner: &str,
    run_version: i64,
    interaction_id: &str,
    interaction_version: i64,
    resolution: &str,
) -> Result<RunState> {
    immediate(db, |tx| {
        require_cas(tx, run_id, owner, tx.execute(
            "UPDATE agent_run_interactions SET status='resolved',resolution=?1,version=version+1
              WHERE interaction_id=?2 AND run_id=?3 AND kind='user_question' AND status='pending' AND version=?4
                AND EXISTS (SELECT 1 FROM agent_runs WHERE run_id=?3 AND execution_owner=?5
                            AND status='waiting_user' AND version=?6)",
            params![
                resolution,
                interaction_id,
                run_id,
                interaction_version,
                owner,
                run_version
            ],
        )?)?;
        require_cas(
            tx,
            run_id,
            owner,
            tx.execute(
                "UPDATE agent_runs SET status='running',version=version+1,
                    activity_at=datetime('now'),updated_at=datetime('now')
              WHERE run_id=?1 AND execution_owner=?2 AND status='waiting_user' AND version=?3",
                params![run_id, owner, run_version],
            )?,
        )?;
        Ok(RunState::new(run_id, run_version + 1, "running"))
    })
}

pub struct FinalizingEvidence<'a> {
    pub run_id: &'a str,
    /// The finalizing version used to look up the two messages.
    pub version: i64,
    pub user_message_complete: bool,
    pub assistant_message_complete: bool,
}

#[derive(Debug, Eq, PartialEq)]
pub enum RecoveryOutcome {
    Interrupted,
    Finalized { status: String },
    NeedsStopMessageReplay,
    Skipped { reason: &'static str },
}

#[derive(Debug, Eq, PartialEq)]
pub struct RecoveryResult {
    pub run_id: String,
    pub version: i64,
    pub outcome: RecoveryOutcome,
}

fn recover_run_in_tx(
    tx: &Transaction<'_>,
    owner: &str,
    run: RunState,
    cancelled_target: bool,
    evidence: Option<&FinalizingEvidence<'_>>,
    interrupt_reason: InterruptReason,
) -> Result<RecoveryResult> {
    let RunState {
        run_id,
        version,
        status,
    } = run;
    let (version, outcome) = match (status.as_str(), evidence) {
        ("finalizing", None) => (
            version,
            RecoveryOutcome::Skipped {
                reason: "AGENT_RUN_FINALIZING_EVIDENCE_MISSING",
            },
        ),
        ("finalizing", Some(evidence))
            if evidence.user_message_complete && evidence.assistant_message_complete =>
        {
            let finished = finish_finalizing_in_tx(tx, &run_id, owner, version)?;
            (
                finished.version,
                RecoveryOutcome::Finalized {
                    status: finished.status,
                },
            )
        }
        ("finalizing", Some(_)) if cancelled_target => {
            (version, RecoveryOutcome::NeedsStopMessageReplay)
        }
        _ => {
            let interrupted =
                interrupt_in_tx(tx, &run_id, owner, &status, version, interrupt_reason)?;
            (interrupted.version, RecoveryOutcome::Interrupted)
        }
    };
    Ok(RecoveryResult {
        run_id,
        version,
        outcome,
    })
}

pub fn recover_finalizing(
    db: &Database,
    owner: &str,
    evidence: &FinalizingEvidence<'_>,
    interrupt_reason: InterruptReason,
    min_activity_age_secs: Option<u32>,
) -> Result<RecoveryResult> {
    immediate(db, |tx| {
        let target = tx
            .query_row(
                "SELECT finalizing_target_status='cancelled',
                        COALESCE(?4 IS NULL OR unixepoch(activity_at)<=unixepoch('now')-?4,0)
                   FROM agent_runs
                  WHERE run_id=?1 AND execution_owner=?2 AND status='finalizing' AND version=?3",
                params![
                    evidence.run_id,
                    owner,
                    evidence.version,
                    min_activity_age_secs
                ],
                |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
            )
            .optional()?;
        let (cancelled_target, old_enough) = require_match(tx, evidence.run_id, owner, target)?;
        if !old_enough {
            return Ok(RecoveryResult {
                run_id: evidence.run_id.into(),
                version: evidence.version,
                outcome: RecoveryOutcome::Skipped {
                    reason: "AGENT_RUN_ACTIVITY_TOO_RECENT",
                },
            });
        }
        recover_run_in_tx(
            tx,
            owner,
            RunState::new(evidence.run_id, evidence.version, "finalizing"),
            cancelled_target,
            Some(evidence),
            interrupt_reason,
        )
    })
}

/// Hold the owner's lock until the recovery transaction has committed or rolled back.
pub fn recover_owner(
    db: &Database,
    workspace: &Path,
    owner: &str,
    min_activity_age_secs: u32,
    finalizing_evidence: &[FinalizingEvidence<'_>],
) -> Result<Vec<RecoveryResult>> {
    let Some(_lock) = acquire_owner_lock(workspace, owner)? else {
        return Ok(Vec::new());
    };
    immediate(db, |tx| {
        let rows = {
            let mut stmt = tx.prepare(
                "SELECT run_id,version,status,COALESCE(finalizing_target_status='cancelled',0)
                   FROM agent_runs WHERE execution_owner=?1 AND status IN
                    ('running','waiting_user','waiting_approval','finalizing')
                    AND unixepoch(activity_at)<=unixepoch('now')-?2
                  ORDER BY run_id",
            )?;
            let rows = stmt.query_map(params![owner, min_activity_age_secs], |row| {
                Ok((
                    RunState {
                        run_id: row.get(0)?,
                        version: row.get(1)?,
                        status: row.get(2)?,
                    },
                    row.get::<_, bool>(3)?,
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        rows.into_iter()
            .map(|(run, cancelled_target)| {
                let evidence = if run.status == "finalizing" {
                    finalizing_evidence
                        .iter()
                        .find(|item| item.run_id == run.run_id && item.version == run.version)
                } else {
                    None
                };
                recover_run_in_tx(
                    tx,
                    owner,
                    run,
                    cancelled_target,
                    evidence,
                    InterruptReason::AppShutdown,
                )
            })
            .collect()
    })
}

fn owner_lock_path(workspace: &Path, owner: &str) -> Result<std::path::PathBuf> {
    ensure!(
        !owner.is_empty()
            && owner
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
        "AGENT_RUN_OWNER_ID_INVALID"
    );
    Ok(workspace
        .join(".grimodex/agent-run-owners")
        .join(format!("{owner}.lock")))
}

fn open_owner_lock(workspace: &Path, owner: &str) -> Result<File> {
    let path = owner_lock_path(workspace, owner)?;
    std::fs::create_dir_all(path.parent().context("AGENT_RUN_LOCK_PATH_INVALID")?)?;
    Ok(OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?)
}

fn acquire_owner_lock(workspace: &Path, owner: &str) -> Result<Option<File>> {
    let file = open_owner_lock(workspace, owner)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(error)) => Err(error.into()),
    }
}

/// The returned file is the lease. Keep it open until this owner's runs are interrupted.
pub fn try_lock_owner(workspace: &Path, owner: &str) -> Result<File> {
    acquire_owner_lock(workspace, owner)?.context("AGENT_RUN_OWNER_LOCK_BUSY")
}

/// An informational probe. Recovery acquires and holds its own lock.
pub fn owner_lock_is_available(workspace: &Path, owner: &str) -> Result<bool> {
    Ok(acquire_owner_lock(workspace, owner)?.is_some())
}

/// Scrub a disposable SQLite copy, removing it on failure so unsanitized data cannot be retained.
pub fn scrub_snapshot_copy(path: &Path) -> Result<()> {
    let result = (|| -> Result<()> {
        let mut conn =
            Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        if scrub_snapshot_copy_on_connection(&mut conn)? {
            conn.execute_batch("VACUUM")?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        if let Err(cleanup) = std::fs::remove_file(path) {
            if cleanup.kind() != std::io::ErrorKind::NotFound {
                anyhow::bail!("AGENT_RUN_SNAPSHOT_CLEANUP_FAILED: {cleanup}; scrub: {error:#}");
            }
        }
        anyhow::bail!("AGENT_RUN_SNAPSHOT_SCRUB_FAILED: {error:#}");
    }
    Ok(())
}

pub(crate) fn scrub_snapshot_copy_on_connection(conn: &mut Connection) -> Result<bool> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_runs')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        return Ok(false);
    }
    conn.pragma_update(None, "secure_delete", "ON")?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let runs = tx.execute(
        "UPDATE agent_runs SET checkpoint=NULL,checkpoint_step=0,checkpoint_digest=NULL,
                tool_call_ledger='[]',
                status=CASE WHEN status IN ('completed','failed','cancelled','discarded') THEN status ELSE 'interrupted' END,
                interrupt_reason=CASE WHEN status IN ('completed','failed','cancelled','discarded') THEN interrupt_reason ELSE 'copied_snapshot' END,
                resumable=CASE WHEN status IN ('completed','failed','cancelled','discarded') THEN resumable ELSE 0 END,
                not_resumable_reason=CASE WHEN status IN ('completed','failed','cancelled','discarded') THEN not_resumable_reason ELSE 'restored_from_copy' END,
                version=CASE WHEN status IN ('completed','failed','cancelled','discarded') THEN version ELSE version+1 END,
                activity_at=CASE WHEN status IN ('completed','failed','cancelled','discarded') THEN activity_at ELSE datetime('now') END
          WHERE checkpoint IS NOT NULL OR checkpoint_step != 0 OR checkpoint_digest IS NOT NULL
             OR tool_call_ledger != '[]'
             OR (status NOT IN ('completed','failed','cancelled','discarded')
                 AND (status != 'interrupted' OR interrupt_reason IS NOT 'copied_snapshot'
                      OR resumable != 0 OR not_resumable_reason IS NOT 'restored_from_copy'))",
        [],
    )?;
    let interactions = tx.execute(
        "UPDATE agent_run_interactions SET request='',resolution='',target_basis=NULL
          WHERE request != '' OR resolution IS NOT '' OR target_basis IS NOT NULL",
        [],
    )?;
    tx.commit()?;
    Ok(runs != 0 || interactions != 0)
}
