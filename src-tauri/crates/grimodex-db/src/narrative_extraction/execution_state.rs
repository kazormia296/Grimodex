//! Typed execution-state enums and transition graph for narrative
//! extraction Run / Task / Attempt, physically enforcing
//! `policies/narrative/narrative-execution-state.json`.
//!
//! `narrative_extraction/repository.rs` retains raw status string literals
//! (`"pending"`, `"queued"`, ...) for its generic task API's narrow CAS
//! statements, while all of its Run lifecycle timestamps use the shared
//! project-scoped allocator below. Runtime-owned routes use the typed
//! fail-closed transition primitive instead of trusting a bare
//! `UPDATE ... SET status = ?`.
//!
//! Some enum transition helpers are still exercised only by their focused
//! tests, so this file intentionally silences `dead_code` at module scope
//! rather than sprinkling per-item `#[allow(dead_code)]`.
#![allow(dead_code)]

use chrono::{DateTime, Datelike, Duration, NaiveDateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};

/// Run-level execution status. Mirrors
/// `policies/narrative/narrative-execution-state.json` →
/// `entities.run.statuses` and the `CHECK` constraint SCHEMA_VERSION 23
/// (`migrate_narrative_extraction_status_v23`) puts on
/// `narrative_extraction_runs.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NarrativeRunStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
    Superseded,
}

impl NarrativeRunStatus {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            NarrativeRunStatus::Pending => "pending",
            NarrativeRunStatus::Running => "running",
            NarrativeRunStatus::Completed => "completed",
            NarrativeRunStatus::Failed => "failed",
            NarrativeRunStatus::Cancelled => "cancelled",
            NarrativeRunStatus::Superseded => "superseded",
        }
    }

    /// `entities.run.terminalStatuses` in narrative-execution-state.json.
    pub(crate) fn is_terminal(&self) -> bool {
        matches!(
            self,
            NarrativeRunStatus::Completed
                | NarrativeRunStatus::Failed
                | NarrativeRunStatus::Cancelled
                | NarrativeRunStatus::Superseded
        )
    }
}

impl TryFrom<&str> for NarrativeRunStatus {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "pending" => Ok(NarrativeRunStatus::Pending),
            "running" => Ok(NarrativeRunStatus::Running),
            "completed" => Ok(NarrativeRunStatus::Completed),
            "failed" => Ok(NarrativeRunStatus::Failed),
            "cancelled" => Ok(NarrativeRunStatus::Cancelled),
            "superseded" => Ok(NarrativeRunStatus::Superseded),
            other => {
                anyhow::bail!("NEX_EXECUTION_STATUS_INVALID: unrecognized run status '{other}'")
            }
        }
    }
}

/// Task-level execution status. Mirrors
/// `policies/narrative/narrative-execution-state.json` →
/// `entities.task.statuses` and the `CHECK` constraint on
/// `narrative_extraction_tasks.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NarrativeTaskStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl NarrativeTaskStatus {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            NarrativeTaskStatus::Queued => "queued",
            NarrativeTaskStatus::Running => "running",
            NarrativeTaskStatus::Completed => "completed",
            NarrativeTaskStatus::Failed => "failed",
            NarrativeTaskStatus::Cancelled => "cancelled",
        }
    }

    /// `entities.task.terminalStatuses` in narrative-execution-state.json.
    pub(crate) fn is_terminal(&self) -> bool {
        matches!(
            self,
            NarrativeTaskStatus::Completed
                | NarrativeTaskStatus::Failed
                | NarrativeTaskStatus::Cancelled
        )
    }
}

impl TryFrom<&str> for NarrativeTaskStatus {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "queued" => Ok(NarrativeTaskStatus::Queued),
            "running" => Ok(NarrativeTaskStatus::Running),
            "completed" => Ok(NarrativeTaskStatus::Completed),
            "failed" => Ok(NarrativeTaskStatus::Failed),
            "cancelled" => Ok(NarrativeTaskStatus::Cancelled),
            other => {
                anyhow::bail!("NEX_EXECUTION_STATUS_INVALID: unrecognized task status '{other}'")
            }
        }
    }
}

/// Attempt-level execution status. Mirrors
/// `policies/narrative/narrative-execution-state.json` →
/// `entities.attempt.statuses` and the `CHECK` constraint on
/// `narrative_extraction_attempts.status`. Unlike Run/Task there is no
/// `queued`/`pending` member — an Attempt row is only ever created once a
/// Task lease claims it (see `task_leases::claim_next_task`), so it starts
/// `running`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NarrativeAttemptStatus {
    Running,
    Completed,
    Failed,
}

impl NarrativeAttemptStatus {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            NarrativeAttemptStatus::Running => "running",
            NarrativeAttemptStatus::Completed => "completed",
            NarrativeAttemptStatus::Failed => "failed",
        }
    }

    /// `entities.attempt.terminalStatuses` in narrative-execution-state.json.
    pub(crate) fn is_terminal(&self) -> bool {
        matches!(
            self,
            NarrativeAttemptStatus::Completed | NarrativeAttemptStatus::Failed
        )
    }
}

impl TryFrom<&str> for NarrativeAttemptStatus {
    type Error = anyhow::Error;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "running" => Ok(NarrativeAttemptStatus::Running),
            "completed" => Ok(NarrativeAttemptStatus::Completed),
            "failed" => Ok(NarrativeAttemptStatus::Failed),
            other => {
                anyhow::bail!("NEX_EXECUTION_STATUS_INVALID: unrecognized attempt status '{other}'")
            }
        }
    }
}

/// Run transition graph: pending -> running; running -> any terminal state
/// (including `superseded`); pending -> {cancelled, superseded} for
/// before-start cancellation/supersede. Every other pair — including
/// terminal -> anything, which covers the "completed -> running" example
/// in the Lane B spec — is fail closed.
fn run_transition_allowed(from: NarrativeRunStatus, to: NarrativeRunStatus) -> bool {
    use NarrativeRunStatus::{Cancelled, Completed, Failed, Pending, Running, Superseded};
    matches!(
        (from, to),
        (Pending, Running)
            | (Pending, Cancelled)
            | (Pending, Superseded)
            | (Running, Completed)
            | (Running, Failed)
            | (Running, Cancelled)
            | (Running, Superseded)
    )
}

/// Task transition graph: queued -> running; running -> any terminal state;
/// queued -> cancelled directly (a Run can be cancelled/superseded before a
/// Task is ever claimed).
fn task_transition_allowed(from: NarrativeTaskStatus, to: NarrativeTaskStatus) -> bool {
    use NarrativeTaskStatus::{Cancelled, Completed, Failed, Queued, Running};
    matches!(
        (from, to),
        (Queued, Running)
            | (Queued, Cancelled)
            | (Running, Completed)
            | (Running, Failed)
            | (Running, Cancelled)
    )
}

/// Attempt transition graph: running -> {completed, failed}. Once an
/// Attempt reaches a terminal state it is immutable — there is no path
/// back to `running`.
fn attempt_transition_allowed(from: NarrativeAttemptStatus, to: NarrativeAttemptStatus) -> bool {
    use NarrativeAttemptStatus::{Completed, Failed, Running};
    matches!((from, to), (Running, Completed) | (Running, Failed))
}

fn parse_run_lifecycle_instant(value: &str) -> anyhow::Result<DateTime<Utc>> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Ok(parsed.with_timezone(&Utc));
    }
    NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S"))
        .map(|parsed| DateTime::<Utc>::from_naive_utc_and_offset(parsed, Utc))
        .map_err(|_| {
            anyhow::anyhow!(
                "NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: lifecycle timestamp '{value}' is not a supported instant"
            )
        })
}

/// Return the next canonical millisecond in the project's persisted Run
/// lifecycle authority. Wall-clock time is only a lower bound: an imported
/// image may legitimately contain a future lifecycle instant, and terminal
/// completion must not move the ordering cursor backwards from that evidence.
pub(crate) fn next_run_lifecycle_timestamp_in_tx(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<String> {
    let now = Utc::now();
    let now_millis = DateTime::<Utc>::from_timestamp_millis(now.timestamp_millis())
        .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: current clock"))?;
    let mut statement = conn.prepare(
        "SELECT created_at, started_at, completed_at
           FROM narrative_extraction_runs
          WHERE project_id = ?1",
    )?;
    let rows = statement.query_map(params![project_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut latest = None;
    for row in rows {
        let (created_at, started_at, completed_at) = row?;
        for value in [Some(created_at), started_at, completed_at]
            .into_iter()
            .flatten()
        {
            let parsed = parse_run_lifecycle_instant(&value)?;
            latest = Some(latest.map_or(parsed, |current: DateTime<Utc>| current.max(parsed)));
        }
    }
    let next = latest
        .map(|latest| {
            let next = latest
                .checked_add_signed(Duration::milliseconds(1))
                .ok_or_else(|| {
                    anyhow::anyhow!(
                    "NEX_MAINTENANCE_RUN_TIMESTAMP_OVERFLOW: cannot advance lifecycle instant '{}'",
                    latest.to_rfc3339()
                )
                })?;
            anyhow::ensure!(
                next.year() <= 9999,
                "NEX_MAINTENANCE_RUN_TIMESTAMP_OVERFLOW: cannot persist lifecycle instant '{}'",
                next.to_rfc3339()
            );
            Ok(next)
        })
        .transpose()?
        .map_or(now_millis, |latest| now_millis.max(latest));
    Ok(next.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// Transition a Run's status, fail closed against `run_transition_allowed`.
/// Sets `started_at` (once, via `COALESCE`) on entry into `running` and
/// `completed_at` on entry into any terminal status. Callers own the
/// surrounding `BEGIN`/`COMMIT` (see `with_immediate_transaction`).
pub(crate) fn transition_run_status_in_tx(
    conn: &Connection,
    run_id: &str,
    to: NarrativeRunStatus,
) -> anyhow::Result<String> {
    let current: Option<(String, String)> = conn
        .query_row(
            "SELECT status, project_id FROM narrative_extraction_runs WHERE id = ?1",
            params![run_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (current_raw, project_id) =
        current.ok_or_else(|| anyhow::anyhow!("narrative extraction run not found: '{run_id}'"))?;
    let from = NarrativeRunStatus::try_from(current_raw.as_str())?;

    anyhow::ensure!(
        run_transition_allowed(from, to),
        "NEX_EXECUTION_STATUS_TRANSITION_INVALID: run '{run_id}' cannot transition from '{}' to '{}'",
        from.as_str(),
        to.as_str()
    );

    // Run timestamps are also terminal Finding ordering evidence. SQLite's
    // datetime('now') is only second precision, while terminal Observations
    // use the shared RFC3339-millisecond clock. Keep every status transition
    // on that same canonical clock so a same-second .500 failure and .900
    // success remain chronologically distinguishable.
    let transition_at = next_run_lifecycle_timestamp_in_tx(conn, &project_id)?;
    let updated = conn.execute(
        "UPDATE narrative_extraction_runs
            SET status = ?1,
                started_at = CASE WHEN ?1 = 'running' THEN COALESCE(started_at, ?3) ELSE started_at END,
                completed_at = CASE WHEN ?2 THEN ?3 ELSE completed_at END,
                version = version + 1
          WHERE id = ?4 AND status = ?5",
        params![to.as_str(), to.is_terminal(), transition_at, run_id, from.as_str()],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_EXECUTION_STATUS_TRANSITION_CONFLICT: run '{run_id}' status changed concurrently"
    );
    Ok(transition_at)
}

/// Transition a Task's status, fail closed against `task_transition_allowed`.
/// Sets `started_at` (once, via `COALESCE`) on entry into `running` and
/// `completed_at` on entry into any terminal status. Callers own the
/// surrounding `BEGIN`/`COMMIT`.
pub(crate) fn transition_task_status_in_tx(
    conn: &Connection,
    task_id: &str,
    to: NarrativeTaskStatus,
) -> anyhow::Result<()> {
    let current_raw: Option<String> = conn
        .query_row(
            "SELECT status FROM narrative_extraction_tasks WHERE id = ?1",
            params![task_id],
            |row| row.get(0),
        )
        .optional()?;
    let current_raw = current_raw
        .ok_or_else(|| anyhow::anyhow!("narrative extraction task not found: '{task_id}'"))?;
    let from = NarrativeTaskStatus::try_from(current_raw.as_str())?;

    anyhow::ensure!(
        task_transition_allowed(from, to),
        "NEX_EXECUTION_STATUS_TRANSITION_INVALID: task '{task_id}' cannot transition from '{}' to '{}'",
        from.as_str(),
        to.as_str()
    );

    let transition_at = grimodex_core::now_rfc3339_millis();
    let updated = conn.execute(
        "UPDATE narrative_extraction_tasks
            SET status = ?1,
                started_at = CASE WHEN ?1 = 'running' THEN COALESCE(started_at, ?3) ELSE started_at END,
                completed_at = CASE WHEN ?2 THEN ?3 ELSE completed_at END,
                version = version + 1
          WHERE id = ?4 AND status = ?5",
        params![to.as_str(), to.is_terminal(), transition_at, task_id, from.as_str()],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_EXECUTION_STATUS_TRANSITION_CONFLICT: task '{task_id}' status changed concurrently"
    );
    Ok(())
}

/// Transition an Attempt's status, fail closed against
/// `attempt_transition_allowed`. Sets `completed_at` on entry into any
/// terminal status. `narrative_extraction_attempts` has no `version`
/// column, so the optimistic guard is the `status = ?` predicate alone.
/// Callers own the surrounding `BEGIN`/`COMMIT`.
pub(crate) fn transition_attempt_status_in_tx(
    conn: &Connection,
    attempt_id: &str,
    to: NarrativeAttemptStatus,
) -> anyhow::Result<()> {
    let current_raw: Option<String> = conn
        .query_row(
            "SELECT status FROM narrative_extraction_attempts WHERE id = ?1",
            params![attempt_id],
            |row| row.get(0),
        )
        .optional()?;
    let current_raw = current_raw
        .ok_or_else(|| anyhow::anyhow!("narrative extraction attempt not found: '{attempt_id}'"))?;
    let from = NarrativeAttemptStatus::try_from(current_raw.as_str())?;

    anyhow::ensure!(
        attempt_transition_allowed(from, to),
        "NEX_EXECUTION_STATUS_TRANSITION_INVALID: attempt '{attempt_id}' cannot transition from '{}' to '{}'",
        from.as_str(),
        to.as_str()
    );

    let transition_at = grimodex_core::now_rfc3339_millis();
    let updated = conn.execute(
        "UPDATE narrative_extraction_attempts
            SET status = ?1,
                completed_at = CASE WHEN ?2 THEN ?3 ELSE completed_at END
          WHERE id = ?4 AND status = ?5",
        params![
            to.as_str(),
            to.is_terminal(),
            transition_at,
            attempt_id,
            from.as_str()
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_EXECUTION_STATUS_TRANSITION_CONFLICT: attempt '{attempt_id}' status changed concurrently"
    );
    Ok(())
}

/// Cascade a Run into `superseded` per `runSupersedeCascade` in
/// `policies/narrative/narrative-execution-state.json`: the Run itself
/// transitions through `transition_run_status_in_tx` (fail closed, same as
/// any other Run transition — a Run already in a terminal, non-superseding
/// state cannot be superseded), then every non-terminal Task under it is
/// forced to `cancelled` and every `running` Attempt under it is forced to
/// `failed`, tagged with the `NEX_RUN_SUPERSEDED` failure code and
/// `superseded` retry disposition from
/// `policies/narrative/narrative-failure-policy.json` (`maxAttempts: 0`,
/// `backoffPolicy: none` — a superseded attempt is never retried).
///
/// Both cascade UPDATEs are bulk statements (mirroring `cancel_run` in
/// `repository.rs`) rather than a per-row loop through
/// `transition_task_status_in_tx`/`transition_attempt_status_in_tx`: the
/// only source statuses touched (`queued`/`running` for Task,
/// `running` for Attempt) are exactly the edges those graphs already allow
/// into `cancelled`/`failed`, so the bulk form cannot produce a status the
/// per-row graph would otherwise reject.
///
/// Runs entirely inside the caller's transaction — callers own the
/// surrounding `BEGIN`/`COMMIT` (see `with_immediate_transaction`).
pub(crate) fn supersede_run_in_tx(conn: &Connection, run_id: &str) -> anyhow::Result<()> {
    let transition_at = transition_run_status_in_tx(conn, run_id, NarrativeRunStatus::Superseded)?;

    conn.execute(
        "UPDATE narrative_extraction_tasks
            SET status = 'cancelled',
                lease_owner = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                completed_at = ?2,
                version = version + 1
          WHERE run_id = ?1
            AND status IN ('queued', 'running')",
        params![run_id, transition_at],
    )?;

    conn.execute(
        "UPDATE narrative_extraction_attempts
            SET status = 'failed',
                completed_at = ?2,
                failure_code = 'NEX_RUN_SUPERSEDED',
                retry_disposition = 'superseded'
          WHERE status = 'running'
            AND task_id IN (
              SELECT id FROM narrative_extraction_tasks WHERE run_id = ?1
            )",
        params![run_id, transition_at],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::repository::{create_system_run_in_tx, SystemRunWorkKeyReuse};
    use crate::Database;
    use serde_json::json;

    fn open_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate to current schema");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            Ok(())
        })
        .expect("seed project");
        db
    }

    fn insert_run(conn: &Connection, run_id: &str, status: &str) {
        conn.execute(
            "INSERT INTO narrative_extraction_runs
                (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                 status, coverage_json, created_at, version)
             VALUES (?1, 'project-1', 'chronicle.extract', '{}', '{}', 'digest-1',
                     ?2, '{}', datetime('now'), 0)",
            params![run_id, status],
        )
        .expect("insert run");
    }

    fn insert_task(conn: &Connection, task_id: &str, run_id: &str, status: &str) {
        conn.execute(
            "INSERT INTO narrative_extraction_tasks
                (id, run_id, task_kind, status, input_json, priority, attempt_count,
                 created_at, version)
             VALUES (?1, ?2, 'plan_windows', ?3, '{}', 0, 0, datetime('now'), 0)",
            params![task_id, run_id, status],
        )
        .expect("insert task");
    }

    fn insert_attempt(conn: &Connection, attempt_id: &str, task_id: &str, status: &str) {
        conn.execute(
            "INSERT INTO narrative_extraction_attempts
                (id, task_id, attempt_number, status, started_at)
             VALUES (?1, ?2, 1, ?3, datetime('now'))",
            params![attempt_id, task_id, status],
        )
        .expect("insert attempt");
    }

    #[test]
    fn run_status_round_trips_through_as_str_and_try_from() {
        for status in [
            NarrativeRunStatus::Pending,
            NarrativeRunStatus::Running,
            NarrativeRunStatus::Completed,
            NarrativeRunStatus::Failed,
            NarrativeRunStatus::Cancelled,
            NarrativeRunStatus::Superseded,
        ] {
            let round_tripped = NarrativeRunStatus::try_from(status.as_str()).expect("parse");
            assert_eq!(round_tripped, status);
        }
    }

    #[test]
    fn task_status_round_trips_through_as_str_and_try_from() {
        for status in [
            NarrativeTaskStatus::Queued,
            NarrativeTaskStatus::Running,
            NarrativeTaskStatus::Completed,
            NarrativeTaskStatus::Failed,
            NarrativeTaskStatus::Cancelled,
        ] {
            let round_tripped = NarrativeTaskStatus::try_from(status.as_str()).expect("parse");
            assert_eq!(round_tripped, status);
        }
    }

    #[test]
    fn attempt_status_round_trips_through_as_str_and_try_from() {
        for status in [
            NarrativeAttemptStatus::Running,
            NarrativeAttemptStatus::Completed,
            NarrativeAttemptStatus::Failed,
        ] {
            let round_tripped = NarrativeAttemptStatus::try_from(status.as_str()).expect("parse");
            assert_eq!(round_tripped, status);
        }
    }

    #[test]
    fn unrecognized_status_strings_fail_closed_with_nex_code() {
        let run_error = NarrativeRunStatus::try_from("bogus").unwrap_err();
        assert!(run_error
            .to_string()
            .contains("NEX_EXECUTION_STATUS_INVALID: unrecognized run status 'bogus'"));

        let task_error = NarrativeTaskStatus::try_from("bogus").unwrap_err();
        assert!(task_error
            .to_string()
            .contains("NEX_EXECUTION_STATUS_INVALID: unrecognized task status 'bogus'"));

        let attempt_error = NarrativeAttemptStatus::try_from("bogus").unwrap_err();
        assert!(attempt_error
            .to_string()
            .contains("NEX_EXECUTION_STATUS_INVALID: unrecognized attempt status 'bogus'"));
    }

    #[test]
    fn run_transition_pending_to_running_to_completed_succeeds() {
        let db = open_db();
        db.with_conn(|conn| {
            insert_run(conn, "run-1", "pending");
            transition_run_status_in_tx(conn, "run-1", NarrativeRunStatus::Running)?;
            let (status, started_at): (String, Option<String>) = conn.query_row(
                "SELECT status, started_at FROM narrative_extraction_runs WHERE id = 'run-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(status, "running");
            assert!(started_at.is_some());

            transition_run_status_in_tx(conn, "run-1", NarrativeRunStatus::Completed)?;
            let (status, completed_at, version): (String, Option<String>, i64) = conn.query_row(
                "SELECT status, completed_at, version FROM narrative_extraction_runs WHERE id = 'run-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(status, "completed");
            assert!(completed_at.is_some());
            assert_eq!(version, 2);
            Ok(())
        })
        .expect("transitions succeed");
    }

    #[test]
    fn run_transition_persists_millisecond_rfc3339_timestamps() {
        let db = open_db();
        db.with_conn(|conn| {
            insert_run(conn, "run-millisecond-clock", "pending");
            transition_run_status_in_tx(
                conn,
                "run-millisecond-clock",
                NarrativeRunStatus::Running,
            )?;
            transition_run_status_in_tx(
                conn,
                "run-millisecond-clock",
                NarrativeRunStatus::Completed,
            )?;
            let (started_at, completed_at): (String, String) = conn.query_row(
                "SELECT started_at, completed_at
                   FROM narrative_extraction_runs
                  WHERE id = 'run-millisecond-clock'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            for timestamp in [started_at, completed_at] {
                assert!(timestamp.ends_with('Z'));
                let fractional = timestamp
                    .rsplit_once('.')
                    .expect("RFC3339 timestamp has fractional seconds")
                    .1;
                assert_eq!(
                    fractional.len(),
                    4,
                    "timestamp must retain three millis: {timestamp}"
                );
            }
            Ok(())
        })
        .expect("millisecond timestamps are persisted");
    }

    #[test]
    fn run_transition_completed_to_running_is_fail_closed() {
        let db = open_db();
        db.with_conn(|conn| {
            insert_run(conn, "run-1", "completed");
            let error = transition_run_status_in_tx(conn, "run-1", NarrativeRunStatus::Running)
                .expect_err("backward transition must be rejected");
            assert!(
                error
                    .to_string()
                    .contains("NEX_EXECUTION_STATUS_TRANSITION_INVALID"),
                "unexpected error: {error}"
            );
            // The row must be untouched by the rejected transition.
            let status: String = conn.query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = 'run-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(status, "completed");
            Ok(())
        })
        .expect("query after rejected transition");
    }

    #[test]
    fn task_transition_queued_to_cancelled_succeeds() {
        let db = open_db();
        db.with_conn(|conn| {
            insert_run(conn, "run-1", "running");
            insert_task(conn, "task-1", "run-1", "queued");
            transition_task_status_in_tx(conn, "task-1", NarrativeTaskStatus::Cancelled)?;
            let status: String = conn.query_row(
                "SELECT status FROM narrative_extraction_tasks WHERE id = 'task-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(status, "cancelled");
            Ok(())
        })
        .expect("transition succeeds");
    }

    #[test]
    fn task_transition_completed_to_running_is_fail_closed() {
        let db = open_db();
        db.with_conn(|conn| {
            insert_run(conn, "run-1", "running");
            insert_task(conn, "task-1", "run-1", "completed");
            let error = transition_task_status_in_tx(conn, "task-1", NarrativeTaskStatus::Running)
                .expect_err("backward transition must be rejected");
            assert!(error
                .to_string()
                .contains("NEX_EXECUTION_STATUS_TRANSITION_INVALID"));
            Ok(())
        })
        .expect("query after rejected transition");
    }

    #[test]
    fn attempt_transition_completed_to_running_is_fail_closed() {
        let db = open_db();
        db.with_conn(|conn| {
            insert_run(conn, "run-1", "running");
            insert_task(conn, "task-1", "run-1", "running");
            insert_attempt(conn, "attempt-1", "task-1", "completed");
            let error =
                transition_attempt_status_in_tx(conn, "attempt-1", NarrativeAttemptStatus::Running)
                    .expect_err("attempts are immutable after a terminal status");
            assert!(error
                .to_string()
                .contains("NEX_EXECUTION_STATUS_TRANSITION_INVALID"));
            Ok(())
        })
        .expect("query after rejected transition");
    }

    #[test]
    fn attempt_transition_running_to_failed_succeeds() {
        let db = open_db();
        db.with_conn(|conn| {
            insert_run(conn, "run-1", "running");
            insert_task(conn, "task-1", "run-1", "running");
            insert_attempt(conn, "attempt-1", "task-1", "running");
            transition_attempt_status_in_tx(conn, "attempt-1", NarrativeAttemptStatus::Failed)?;
            let (status, completed_at): (String, Option<String>) = conn.query_row(
                "SELECT status, completed_at FROM narrative_extraction_attempts WHERE id = 'attempt-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(status, "failed");
            assert!(completed_at.is_some());
            Ok(())
        })
        .expect("transition succeeds");
    }

    #[test]
    fn supersede_run_cascades_queued_and_running_tasks_to_cancelled() {
        let db = open_db();
        db.with_conn(|conn| {
            insert_run(conn, "run-1", "running");
            insert_task(conn, "task-queued", "run-1", "queued");
            insert_task(conn, "task-running", "run-1", "running");
            insert_task(conn, "task-completed", "run-1", "completed");

            supersede_run_in_tx(conn, "run-1")?;

            let run_status: String = conn.query_row(
                "SELECT status FROM narrative_extraction_runs WHERE id = 'run-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(run_status, "superseded");

            let queued_status: String = conn.query_row(
                "SELECT status FROM narrative_extraction_tasks WHERE id = 'task-queued'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(queued_status, "cancelled");

            let running_status: String = conn.query_row(
                "SELECT status FROM narrative_extraction_tasks WHERE id = 'task-running'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(running_status, "cancelled");

            // A Task that was already terminal before the supersede must not
            // be disturbed.
            let completed_status: String = conn.query_row(
                "SELECT status FROM narrative_extraction_tasks WHERE id = 'task-completed'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(completed_status, "completed");
            Ok(())
        })
        .expect("supersede cascade succeeds");
    }

    #[test]
    fn supersede_run_cascades_running_attempts_to_failed_with_superseded_disposition() {
        let db = open_db();
        db.with_conn(|conn| {
            insert_run(conn, "run-1", "running");
            insert_task(conn, "task-running", "run-1", "running");
            insert_attempt(conn, "attempt-running", "task-running", "running");
            insert_task(conn, "task-done", "run-1", "completed");
            insert_attempt(conn, "attempt-done", "task-done", "completed");

            supersede_run_in_tx(conn, "run-1")?;

            let (status, failure_code, retry_disposition): (String, Option<String>, Option<String>) =
                conn.query_row(
                    "SELECT status, failure_code, retry_disposition
                       FROM narrative_extraction_attempts WHERE id = 'attempt-running'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            assert_eq!(status, "failed");
            assert_eq!(failure_code.as_deref(), Some("NEX_RUN_SUPERSEDED"));
            assert_eq!(retry_disposition.as_deref(), Some("superseded"));

            // An Attempt that was already terminal before the supersede must
            // not be disturbed or relabeled.
            let (done_status, done_failure_code): (String, Option<String>) = conn.query_row(
                "SELECT status, failure_code FROM narrative_extraction_attempts WHERE id = 'attempt-done'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(done_status, "completed");
            assert_eq!(done_failure_code, None);
            Ok(())
        })
        .expect("supersede cascade succeeds");
    }

    #[test]
    fn supersede_run_from_terminal_run_status_is_fail_closed() {
        let db = open_db();
        db.with_conn(|conn| {
            insert_run(conn, "run-1", "completed");
            let error = supersede_run_in_tx(conn, "run-1")
                .expect_err("a completed run cannot be superseded");
            assert!(error
                .to_string()
                .contains("NEX_EXECUTION_STATUS_TRANSITION_INVALID"));
            Ok(())
        })
        .expect("query after rejected supersede");
    }

    #[test]
    fn terminal_system_run_after_imported_future_lifecycle_stays_latest() {
        let db = open_db();
        let timestamps: (String, String) = db
            .with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_semantic_epochs
                        (id, project_id, epoch_number, reason, created_at)
                     VALUES ('epoch-1', 'project-1', 0, 'initial',
                             '2099-01-01T00:00:00.000Z')",
                    [],
                )?;
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, created_at, started_at, completed_at,
                         run_kind, semantic_epoch_id, work_key, version)
                     VALUES ('imported-future-run', 'project-1', 'maintenance', '{}', '{}',
                             'digest', 'completed', '{}', '2099-01-01T00:00:00.000Z',
                             '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z',
                             'dependency-verify', 'epoch-1', 'imported-future-run', 0)",
                    [],
                )?;
                let created = create_system_run_in_tx(
                    conn,
                    "project-1",
                    "semantic-index-rebuild",
                    "epoch-1",
                    "dependency-rebuild-derived",
                    &json!({}),
                    "sha256:test",
                    SystemRunWorkKeyReuse::None,
                    None,
                )?;
                let run_id = created["runId"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("created Run has no id"))?;
                transition_run_status_in_tx(conn, run_id, NarrativeRunStatus::Completed)?;
                conn.query_row(
                    "SELECT created_at, completed_at
                       FROM narrative_extraction_runs WHERE id = ?1",
                    [run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(Into::into)
            })
            .expect("complete a new system Run after importing a future Run");

        assert_eq!(timestamps.0, "2099-01-01T00:00:00.001Z");
        assert_eq!(timestamps.1, "2099-01-01T00:00:00.002Z");
        assert!(timestamps.1.ends_with(".002Z"));
    }
}
