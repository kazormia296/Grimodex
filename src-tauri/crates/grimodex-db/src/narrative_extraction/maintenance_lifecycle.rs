//! Crate-private lifecycle authority for automatic Narrative Maintenance.
//!
//! C2-5B maintenance Runs own exactly one Task and one Attempt.  The owner
//! creates those three rows in the same transaction and terminalizes them as
//! one unit; the generic repository task APIs deliberately remain outside
//! this boundary.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use super::execution_state::next_run_lifecycle_timestamp_in_tx;
use super::repository::{create_system_run_in_tx, SystemRunWorkKeyReuse};

const FAILURE_POLICY_VERSION: &str = "v1";
const BACKFILL_RUN_KIND: &str = "backfill";
const VERIFY_RUN_KIND: &str = "dependency-verify";
const REBUILD_RUN_KIND: &str = "semantic-index-rebuild";
const BACKFILL_TASK_KIND: &str = "maintenance-backfill";
const VERIFY_TASK_KIND: &str = "maintenance-dependency-verify";
const REBUILD_TASK_KIND: &str = "maintenance-semantic-index-rebuild";
const BACKFILL_WORK_KEY: &str = "legacy-dependency-backfill:v2";
const REBUILD_WORK_KEY: &str = "dependency-rebuild-derived";
const VERIFY_WORK_KEY_PREFIX: &str = "dependency-verify:";
const BACKFILL_ALGORITHM_VERSION: &str = "2";
const VERIFY_CONTRACT_VERSION: &str = "6";

/// The bounded failure policy understood by an automatic maintenance owner.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MaintenanceFailureKind {
    Transient,
    Manual,
    Interrupted,
}

impl MaintenanceFailureKind {
    pub(crate) fn failure_code(self) -> &'static str {
        match self {
            Self::Transient => "NEX_MAINTENANCE_TRANSIENT",
            Self::Manual => "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION",
            Self::Interrupted => "NEX_MAINTENANCE_INTERRUPTED",
        }
    }

    fn retry_disposition(self) -> &'static str {
        match self {
            Self::Transient | Self::Interrupted => "retryable",
            Self::Manual => "manual",
        }
    }

    fn is_retryable(self) -> bool {
        matches!(self, Self::Transient | Self::Interrupted)
    }
}

pub(crate) fn canonical_failure_message(
    failure_kind: MaintenanceFailureKind,
    message: &str,
) -> String {
    format!("{}: {message}", failure_kind.failure_code())
}

/// The exact ownership tuple for a maintenance Run and its one lifecycle
/// Task/Attempt pair.
#[derive(Debug, Clone)]
pub(crate) struct MaintenanceRunHandle {
    pub(crate) project_id: String,
    pub(crate) run_id: String,
    pub(crate) run_kind: String,
    pub(crate) semantic_epoch_id: String,
    pub(crate) work_key: String,
    pub(crate) spec_json: String,
    pub(crate) spec_digest: String,
    pub(crate) task_id: String,
    pub(crate) attempt_id: String,
    pub(crate) reused: bool,
}

fn maintenance_task_kind(run_kind: &str) -> anyhow::Result<&'static str> {
    match run_kind {
        BACKFILL_RUN_KIND => Ok(BACKFILL_TASK_KIND),
        VERIFY_RUN_KIND => Ok(VERIFY_TASK_KIND),
        REBUILD_RUN_KIND => Ok(REBUILD_TASK_KIND),
        other => anyhow::bail!(
            "NEX_MAINTENANCE_RUN_KIND_INVALID: unsupported maintenance Run kind '{other}'"
        ),
    }
}

fn canonical_work_key(run_kind: &str, semantic_epoch_id: &str) -> anyhow::Result<String> {
    match run_kind {
        BACKFILL_RUN_KIND => Ok(BACKFILL_WORK_KEY.to_owned()),
        VERIFY_RUN_KIND => Ok(format!("{VERIFY_WORK_KEY_PREFIX}{semantic_epoch_id}")),
        REBUILD_RUN_KIND => Ok(REBUILD_WORK_KEY.to_owned()),
        other => anyhow::bail!(
            "NEX_MAINTENANCE_RUN_KIND_INVALID: unsupported maintenance Run kind '{other}'"
        ),
    }
}

fn canonical_spec(run_kind: &str) -> anyhow::Result<Value> {
    match run_kind {
        BACKFILL_RUN_KIND => Ok(json!({
            "backfillAlgorithmVersion": BACKFILL_ALGORITHM_VERSION
        })),
        VERIFY_RUN_KIND => Ok(json!({
            "verifyContractVersion": VERIFY_CONTRACT_VERSION
        })),
        REBUILD_RUN_KIND => Ok(json!({})),
        other => anyhow::bail!(
            "NEX_MAINTENANCE_RUN_KIND_INVALID: unsupported maintenance Run kind '{other}'"
        ),
    }
}

fn ownership_error(message: impl Into<String>) -> anyhow::Error {
    anyhow::anyhow!(
        "NEX_MAINTENANCE_LIFECYCLE_OWNERSHIP_INVALID: {}",
        message.into()
    )
}

/// Create or reuse a maintenance Run and, on a fresh Run, its exact one
/// running Task and running Attempt #1. Callers must hold the surrounding
/// IMMEDIATE transaction.
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_maintenance_run_in_tx(
    conn: &Connection,
    project_id: &str,
    run_kind: &str,
    semantic_epoch_id: &str,
    work_key: &str,
    spec_json: &Value,
    spec_digest: &str,
    reuse: SystemRunWorkKeyReuse,
) -> anyhow::Result<MaintenanceRunHandle> {
    anyhow::ensure!(
        !project_id.trim().is_empty()
            && !semantic_epoch_id.trim().is_empty()
            && !work_key.trim().is_empty()
            && !spec_digest.trim().is_empty(),
        "NEX_MAINTENANCE_LIFECYCLE_INPUT_INVALID: ownership fields must not be empty"
    );
    let task_kind = maintenance_task_kind(run_kind)?;
    let spec_json_text = serde_json::to_string(spec_json)?;
    let run = create_system_run_in_tx(
        conn,
        project_id,
        run_kind,
        semantic_epoch_id,
        work_key,
        spec_json,
        spec_digest,
        reuse,
        None,
    )?;
    let run_id = run
        .get("runId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_LIFECYCLE_RUN_INVALID: missing runId"))?;
    let reused = run.get("reused").and_then(Value::as_bool).unwrap_or(false);

    if reused {
        let mut handle = load_maintenance_run_in_tx(conn, &run_id)?;
        if !(handle.project_id == project_id
            && handle.run_kind == run_kind
            && handle.semantic_epoch_id == semantic_epoch_id
            && handle.work_key == work_key
            && handle.spec_json == spec_json_text
            && handle.spec_digest == spec_digest)
        {
            return Err(ownership_error(format!(
                "reused Run '{run_id}' does not match the requested sealed work"
            )));
        }
        handle.reused = true;
        return Ok(handle);
    }

    let run_started_at: String = conn.query_row(
        "SELECT COALESCE(started_at, created_at)
           FROM narrative_extraction_runs
          WHERE id = ?1",
        params![&run_id],
        |row| row.get(0),
    )?;
    let task_id = Uuid::new_v4().to_string();
    let attempt_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO narrative_extraction_tasks
            (id, run_id, task_kind, status, input_json, priority, attempt_count,
             created_at, started_at, version)
         VALUES (?1, ?2, ?3, 'running', ?4, 0, 1, ?5, ?5, 0)",
        params![
            &task_id,
            &run_id,
            task_kind,
            &spec_json_text,
            &run_started_at
        ],
    )?;
    conn.execute(
        "INSERT INTO narrative_extraction_attempts
            (id, task_id, attempt_number, status, started_at)
         VALUES (?1, ?2, 1, 'running', ?3)",
        params![&attempt_id, &task_id, &run_started_at],
    )?;

    let handle = MaintenanceRunHandle {
        project_id: project_id.to_owned(),
        run_id,
        run_kind: run_kind.to_owned(),
        semantic_epoch_id: semantic_epoch_id.to_owned(),
        work_key: work_key.to_owned(),
        spec_json: spec_json_text,
        spec_digest: spec_digest.to_owned(),
        task_id,
        attempt_id,
        reused: false,
    };
    validate_handle_in_tx(conn, &handle)?;
    Ok(handle)
}

/// Recover a legacy/imported automatic maintenance Run that was persisted
/// while running before the lifecycle pair was introduced. This is the sole
/// compatibility boundary: callers must be in startup recovery, and ordinary
/// creation/finalization paths must continue to use the strict loader.
///
/// Only a canonical automatic Run with zero owned Tasks and zero owned
/// Attempts can be synthesized. The persisted Run coordinates and lifecycle
/// timestamp seed Task and Attempt #1 so the caller can terminalize all three
/// rows in the same recovery transaction.
pub(crate) fn synthesize_recovery_lifecycle_in_tx(
    conn: &Connection,
    run_id: &str,
) -> anyhow::Result<MaintenanceRunHandle> {
    let run = conn
        .query_row(
            "SELECT project_id, run_kind, semantic_epoch_id, work_key,
                    spec_json, spec_digest, status,
                    COALESCE(started_at, created_at)
               FROM narrative_extraction_runs
              WHERE id = ?1",
            params![run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| ownership_error(format!("Run '{run_id}' was not found")))?;
    let (
        project_id,
        run_kind,
        semantic_epoch_id,
        work_key,
        spec_json,
        spec_digest,
        status,
        lifecycle_at,
    ) = run;
    if status != "running" {
        return Err(ownership_error(format!(
            "Run '{run_id}' is not running during recovery"
        )));
    }
    let run_kind = run_kind.ok_or_else(|| ownership_error("Run kind is missing"))?;
    let semantic_epoch_id =
        semantic_epoch_id.ok_or_else(|| ownership_error("semantic epoch is missing"))?;
    let work_key = work_key.ok_or_else(|| ownership_error("sealed work key is missing"))?;
    let task_kind =
        maintenance_task_kind(&run_kind).map_err(|error| ownership_error(error.to_string()))?;
    let expected_work_key = canonical_work_key(&run_kind, &semantic_epoch_id)
        .map_err(|error| ownership_error(error.to_string()))?;
    if work_key != expected_work_key {
        return Err(ownership_error(format!(
            "Run '{run_id}' work key is not canonical for its Run kind and epoch"
        )));
    }
    if spec_digest.trim().is_empty() || lifecycle_at.trim().is_empty() {
        return Err(ownership_error(
            "sealed spec digest and lifecycle timestamp are required",
        ));
    }
    let persisted_spec = serde_json::from_str::<Value>(&spec_json)
        .map_err(|error| ownership_error(format!("sealed spec JSON is invalid: {error}")))?;
    let expected_spec =
        canonical_spec(&run_kind).map_err(|error| ownership_error(error.to_string()))?;
    if persisted_spec != expected_spec {
        return Err(ownership_error(format!(
            "Run '{run_id}' spec does not match the canonical maintenance phase contract"
        )));
    }

    let task_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_extraction_tasks WHERE run_id = ?1",
        params![run_id],
        |row| row.get(0),
    )?;
    let attempt_count: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM narrative_extraction_attempts a
           JOIN narrative_extraction_tasks t ON t.id = a.task_id
          WHERE t.run_id = ?1",
        params![run_id],
        |row| row.get(0),
    )?;
    if task_count != 0 || attempt_count != 0 {
        return Err(ownership_error(format!(
            "Run '{run_id}' has {task_count} Tasks and {attempt_count} Attempts; recovery synthesis requires zero children"
        )));
    }

    let task_id = Uuid::new_v4().to_string();
    let attempt_id = Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO narrative_extraction_tasks
            (id, run_id, task_kind, status, input_json, priority, attempt_count,
             created_at, started_at, version)
         VALUES (?1, ?2, ?3, 'running', ?4, 0, 1, ?5, ?5, 0)",
        params![&task_id, run_id, task_kind, &spec_json, &lifecycle_at],
    )?;
    conn.execute(
        "INSERT INTO narrative_extraction_attempts
            (id, task_id, attempt_number, status, started_at)
         VALUES (?1, ?2, 1, 'running', ?3)",
        params![&attempt_id, &task_id, &lifecycle_at],
    )?;

    let handle = MaintenanceRunHandle {
        project_id,
        run_id: run_id.to_owned(),
        run_kind,
        semantic_epoch_id,
        work_key,
        spec_json,
        spec_digest,
        task_id,
        attempt_id,
        reused: false,
    };
    validate_handle_in_tx(conn, &handle)?;
    Ok(handle)
}

/// Load and validate the exact lifecycle pair for a maintenance Run.
pub(crate) fn load_maintenance_run_in_tx(
    conn: &Connection,
    run_id: &str,
) -> anyhow::Result<MaintenanceRunHandle> {
    let run = conn
        .query_row(
            "SELECT project_id, run_kind, semantic_epoch_id, work_key,
                    spec_json, spec_digest
               FROM narrative_extraction_runs
              WHERE id = ?1
                AND status = 'running'",
            params![run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| ownership_error(format!("running maintenance Run '{run_id}' not found")))?;
    let (project_id, run_kind, semantic_epoch_id, work_key, spec_json, spec_digest) = run;
    let run_kind = run_kind.ok_or_else(|| ownership_error("Run kind is missing"))?;
    let semantic_epoch_id =
        semantic_epoch_id.ok_or_else(|| ownership_error("semantic epoch is missing"))?;
    let work_key = work_key.ok_or_else(|| ownership_error("sealed work key is missing"))?;
    let task_kind =
        maintenance_task_kind(&run_kind).map_err(|error| ownership_error(error.to_string()))?;

    let task_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_extraction_tasks WHERE run_id = ?1",
        params![run_id],
        |row| row.get(0),
    )?;
    if task_count != 1 {
        return Err(ownership_error(format!(
            "maintenance Run '{run_id}' owns {task_count} Tasks instead of exactly one"
        )));
    }
    let (task_id, task_kind_stored, task_status, task_input, attempt_count): (
        String,
        String,
        String,
        String,
        i64,
    ) = conn.query_row(
        "SELECT id, task_kind, status, input_json, attempt_count
           FROM narrative_extraction_tasks
          WHERE run_id = ?1",
        params![run_id],
        |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        },
    )?;
    if !(task_kind_stored == task_kind
        && task_status == "running"
        && task_input == spec_json
        && attempt_count == 1)
    {
        return Err(ownership_error(format!(
            "Task for maintenance Run '{run_id}' is not the exact running owner"
        )));
    }

    let attempt_count_for_task: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM narrative_extraction_attempts
          WHERE task_id = ?1",
        params![&task_id],
        |row| row.get(0),
    )?;
    if attempt_count_for_task != 1 {
        return Err(ownership_error(format!(
            "maintenance Task '{task_id}' owns {attempt_count_for_task} Attempts instead of exactly one"
        )));
    }
    let (attempt_id, attempt_number, attempt_status): (String, i64, String) = conn.query_row(
        "SELECT id, attempt_number, status
           FROM narrative_extraction_attempts
          WHERE task_id = ?1",
        params![&task_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if !(attempt_number == 1 && attempt_status == "running") {
        return Err(ownership_error(format!(
            "Attempt for maintenance Task '{task_id}' is not the exact running Attempt #1"
        )));
    }

    let handle = MaintenanceRunHandle {
        project_id,
        run_id: run_id.to_owned(),
        run_kind,
        semantic_epoch_id,
        work_key,
        spec_json,
        spec_digest,
        task_id,
        attempt_id,
        reused: true,
    };
    validate_handle_in_tx(conn, &handle)?;
    Ok(handle)
}

fn validate_handle_in_tx(conn: &Connection, handle: &MaintenanceRunHandle) -> anyhow::Result<()> {
    let expected_task_kind = maintenance_task_kind(&handle.run_kind)
        .map_err(|error| ownership_error(error.to_string()))?;
    let run_matches: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1
               FROM narrative_extraction_runs
              WHERE id = ?1
                AND project_id = ?2
                AND run_kind = ?3
                AND semantic_epoch_id = ?4
                AND work_key = ?5
                AND spec_json = ?6
                AND spec_digest = ?7
                AND status = 'running'
           )",
        params![
            &handle.run_id,
            &handle.project_id,
            &handle.run_kind,
            &handle.semantic_epoch_id,
            &handle.work_key,
            &handle.spec_json,
            &handle.spec_digest
        ],
        |row| row.get(0),
    )?;
    if !run_matches {
        return Err(ownership_error("Run ownership tuple mismatch"));
    }

    let task_matches: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1
               FROM narrative_extraction_tasks
              WHERE id = ?1
                AND run_id = ?2
                AND task_kind = ?3
                AND status = 'running'
                AND input_json = ?4
                AND attempt_count = 1
           )",
        params![
            &handle.task_id,
            &handle.run_id,
            expected_task_kind,
            &handle.spec_json
        ],
        |row| row.get(0),
    )?;
    if !task_matches {
        return Err(ownership_error("Task ownership tuple mismatch"));
    }

    let attempt_matches: bool = conn.query_row(
        "SELECT EXISTS(
             SELECT 1
               FROM narrative_extraction_attempts
              WHERE id = ?1
                AND task_id = ?2
                AND attempt_number = 1
                AND status = 'running'
           )",
        params![&handle.attempt_id, &handle.task_id],
        |row| row.get(0),
    )?;
    if !attempt_matches {
        return Err(ownership_error("Attempt ownership tuple mismatch"));
    }
    Ok(())
}

/// A foreground hold intentionally leaves every lifecycle row running.
pub(crate) fn hold_maintenance_run_in_tx(
    conn: &Connection,
    handle: &MaintenanceRunHandle,
) -> anyhow::Result<()> {
    validate_handle_in_tx(conn, handle)
}

/// Complete Attempt, Task, and Run with the same project-scoped lifecycle
/// instant. The surrounding transaction owns atomicity.
pub(crate) fn complete_maintenance_run_in_tx(
    conn: &Connection,
    handle: &MaintenanceRunHandle,
) -> anyhow::Result<String> {
    validate_handle_in_tx(conn, handle)?;
    let completed_at = next_run_lifecycle_timestamp_in_tx(conn, &handle.project_id)?;
    let attempt_updated = conn.execute(
        "UPDATE narrative_extraction_attempts
            SET status = 'completed',
                completed_at = ?1,
                error_message = NULL,
                failure_code = NULL,
                retry_disposition = NULL,
                policy_version = NULL,
                next_attempt_at = NULL
          WHERE id = ?2
            AND task_id = ?3
            AND status = 'running'",
        params![&completed_at, &handle.attempt_id, &handle.task_id],
    )?;
    anyhow::ensure!(
        attempt_updated == 1,
        "NEX_MAINTENANCE_LIFECYCLE_TRANSITION_CONFLICT: Attempt changed concurrently"
    );
    let task_updated = conn.execute(
        "UPDATE narrative_extraction_tasks
            SET status = 'completed',
                completed_at = ?1,
                error_message = NULL,
                lease_owner = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                version = version + 1
          WHERE id = ?2
            AND run_id = ?3
            AND status = 'running'",
        params![&completed_at, &handle.task_id, &handle.run_id],
    )?;
    anyhow::ensure!(
        task_updated == 1,
        "NEX_MAINTENANCE_LIFECYCLE_TRANSITION_CONFLICT: Task changed concurrently"
    );
    let run_updated = conn.execute(
        "UPDATE narrative_extraction_runs
            SET status = 'completed',
                completed_at = ?1,
                terminal_reason_code = NULL,
                version = version + 1
          WHERE id = ?2
            AND project_id = ?3
            AND status = 'running'",
        params![&completed_at, &handle.run_id, &handle.project_id],
    )?;
    anyhow::ensure!(
        run_updated == 1,
        "NEX_MAINTENANCE_LIFECYCLE_TRANSITION_CONFLICT: Run changed concurrently"
    );
    Ok(completed_at)
}

/// Exact foreground release is the same atomic terminal transition as normal
/// success.
pub(crate) fn release_foreground_maintenance_run_in_tx(
    conn: &Connection,
    handle: &MaintenanceRunHandle,
) -> anyhow::Result<String> {
    complete_maintenance_run_in_tx(conn, handle)
}

/// Fail Attempt, Task, and Run with exact C2-5B metadata and one shared
/// lifecycle instant. The surrounding transaction owns atomicity.
pub(crate) fn fail_maintenance_run_in_tx(
    conn: &Connection,
    handle: &MaintenanceRunHandle,
    failure_kind: MaintenanceFailureKind,
    error_message: &str,
) -> anyhow::Result<String> {
    anyhow::ensure!(
        !error_message.trim().is_empty(),
        "NEX_MAINTENANCE_LIFECYCLE_FAILURE_INVALID: error message must not be empty"
    );
    validate_handle_in_tx(conn, handle)?;
    let completed_at = next_run_lifecycle_timestamp_in_tx(conn, &handle.project_id)?;
    let next_attempt_at = failure_kind.is_retryable().then_some(completed_at.as_str());
    let failure_code = failure_kind.failure_code();
    let retry_disposition = failure_kind.retry_disposition();
    let attempt_updated = conn.execute(
        "UPDATE narrative_extraction_attempts
            SET status = 'failed',
                completed_at = ?1,
                error_message = ?2,
                failure_code = ?3,
                retry_disposition = ?4,
                policy_version = ?5,
                next_attempt_at = ?6
          WHERE id = ?7
            AND task_id = ?8
            AND status = 'running'",
        params![
            &completed_at,
            error_message,
            failure_code,
            retry_disposition,
            FAILURE_POLICY_VERSION,
            next_attempt_at,
            &handle.attempt_id,
            &handle.task_id
        ],
    )?;
    anyhow::ensure!(
        attempt_updated == 1,
        "NEX_MAINTENANCE_LIFECYCLE_TRANSITION_CONFLICT: Attempt changed concurrently"
    );
    let task_updated = conn.execute(
        "UPDATE narrative_extraction_tasks
            SET status = 'failed',
                completed_at = ?1,
                error_message = ?2,
                lease_owner = NULL,
                lease_expires_at = NULL,
                heartbeat_at = NULL,
                version = version + 1
          WHERE id = ?3
            AND run_id = ?4
            AND status = 'running'",
        params![
            &completed_at,
            error_message,
            &handle.task_id,
            &handle.run_id
        ],
    )?;
    anyhow::ensure!(
        task_updated == 1,
        "NEX_MAINTENANCE_LIFECYCLE_TRANSITION_CONFLICT: Task changed concurrently"
    );
    let run_updated = conn.execute(
        "UPDATE narrative_extraction_runs
            SET status = 'failed',
                completed_at = ?1,
                terminal_reason_code = ?2,
                version = version + 1
          WHERE id = ?3
            AND project_id = ?4
            AND status = 'running'",
        params![
            &completed_at,
            failure_code,
            &handle.run_id,
            &handle.project_id
        ],
    )?;
    anyhow::ensure!(
        run_updated == 1,
        "NEX_MAINTENANCE_LIFECYCLE_TRANSITION_CONFLICT: Run changed concurrently"
    );
    Ok(completed_at)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::narrative_extraction::repository::SystemRunWorkKeyReuse;
    use crate::narrative_extraction::task_leases::with_immediate_transaction;
    use crate::Database;
    use rusqlite::{params, Connection};
    use serde_json::json;
    use std::path::Path;

    fn open_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate current schema");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Maintenance')",
                [],
            )?;
            Ok(())
        })
        .expect("seed project");
        db
    }

    fn work(run_kind: &str) -> (&'static str, &'static str) {
        match run_kind {
            "backfill" => ("epoch-1", "legacy-dependency-backfill:v2"),
            "dependency-verify" => ("epoch-1", "dependency-verify:epoch-1"),
            "semantic-index-rebuild" => ("epoch-1", "dependency-rebuild-derived"),
            other => panic!("unsupported maintenance kind: {other}"),
        }
    }

    fn create(conn: &Connection, run_kind: &str) -> anyhow::Result<MaintenanceRunHandle> {
        let (epoch_id, work_key) = work(run_kind);
        create_maintenance_run_in_tx(
            conn,
            "project-1",
            run_kind,
            epoch_id,
            work_key,
            &json!({ "sealed": run_kind }),
            "sha256:maintenance-test",
            SystemRunWorkKeyReuse::RunningOnly,
        )
    }

    #[test]
    fn fresh_maintenance_run_has_exactly_one_running_task_and_attempt_one() {
        let db = open_db();
        for (index, run_kind) in ["backfill", "dependency-verify", "semantic-index-rebuild"]
            .into_iter()
            .enumerate()
        {
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_semantic_epochs
                        (id, project_id, epoch_number, reason, created_at)
                     VALUES (?1, 'project-1', ?2, 'initial', ?3)",
                    params![
                        format!("epoch-{}", index + 1),
                        index as i64,
                        format!("2026-08-23T00:00:0{index}.000Z")
                    ],
                )?;
                let handle = create(conn, run_kind)?;
                let (task_count, attempt_count, task_status, attempt_status, attempt_number): (
                    i64,
                    i64,
                    String,
                    String,
                    i64,
                ) = conn.query_row(
                    "SELECT
                         (SELECT COUNT(*) FROM narrative_extraction_tasks WHERE run_id = ?1),
                         (SELECT COUNT(*)
                            FROM narrative_extraction_attempts a
                            JOIN narrative_extraction_tasks t ON t.id = a.task_id
                           WHERE t.run_id = ?1),
                         (SELECT status FROM narrative_extraction_tasks WHERE id = ?2),
                         (SELECT status FROM narrative_extraction_attempts WHERE id = ?3),
                         (SELECT attempt_number FROM narrative_extraction_attempts WHERE id = ?3)",
                    params![handle.run_id, handle.task_id, handle.attempt_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )?;
                assert_eq!(task_count, 1);
                assert_eq!(attempt_count, 1);
                assert_eq!(task_status, "running");
                assert_eq!(attempt_status, "running");
                assert_eq!(attempt_number, 1);
                Ok(())
            })
            .expect("create maintenance lifecycle");
        }
    }

    #[test]
    fn reuse_validates_exact_ownership_and_never_duplicates() {
        let db = open_db();
        db.with_conn(|conn| {
            let first = create(conn, "backfill")?;
            let second = create(conn, "backfill")?;
            assert!(second.reused);
            assert_eq!(second.run_id, first.run_id);
            assert_eq!(second.task_id, first.task_id);
            assert_eq!(second.attempt_id, first.attempt_id);

            conn.execute(
                "UPDATE narrative_extraction_tasks SET task_kind = 'wrong-owner' WHERE id = ?1",
                params![first.task_id],
            )?;
            let error = create(conn, "backfill").expect_err("wrong task owner must fail closed");
            assert!(error
                .to_string()
                .contains("NEX_MAINTENANCE_LIFECYCLE_OWNERSHIP_INVALID"));
            Ok(())
        })
        .expect("reuse validation");
    }

    #[test]
    fn creation_rolls_back_run_task_and_attempt_together() {
        let db = open_db();
        db.with_conn(|conn| {
            let error = with_immediate_transaction(conn, |conn| {
                let _ = create(conn, "backfill")?;
                anyhow::bail!("force lifecycle transaction rollback")
            })
            .expect_err("forced rollback");
            assert!(error
                .to_string()
                .contains("force lifecycle transaction rollback"));

            let counts: (i64, i64, i64) = conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM narrative_extraction_runs),
                    (SELECT COUNT(*) FROM narrative_extraction_tasks),
                    (SELECT COUNT(*) FROM narrative_extraction_attempts)",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(counts, (0, 0, 0));
            Ok(())
        })
        .expect("rollback leaves no lifecycle rows");
    }

    #[test]
    fn success_terminalizer_transitions_attempt_task_and_run_at_one_timestamp() {
        let db = open_db();
        db.with_conn(|conn| {
            let handle = create(conn, "backfill")?;
            let completed_at = complete_maintenance_run_in_tx(conn, &handle)?;
            let (run_status, task_status, attempt_status, run_at, task_at, attempt_at): (
                String,
                String,
                String,
                String,
                String,
                String,
            ) = conn.query_row(
                "SELECT r.status, t.status, a.status,
                        r.completed_at, t.completed_at, a.completed_at
                   FROM narrative_extraction_runs r
                   JOIN narrative_extraction_tasks t ON t.run_id = r.id
                   JOIN narrative_extraction_attempts a ON a.task_id = t.id
                  WHERE r.id = ?1",
                params![handle.run_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )?;
            assert_eq!(run_status, "completed");
            assert_eq!(task_status, "completed");
            assert_eq!(attempt_status, "completed");
            assert_eq!(run_at, completed_at);
            assert_eq!(task_at, completed_at);
            assert_eq!(attempt_at, completed_at);
            Ok(())
        })
        .expect("success terminalization");
    }

    #[test]
    fn failure_terminalizer_persists_exact_retryable_and_manual_metadata() {
        let db = open_db();
        db.with_conn(|conn| {
            let retryable = create(conn, "backfill")?;
            fail_maintenance_run_in_tx(
                conn,
                &retryable,
                MaintenanceFailureKind::Transient,
                "transient I/O",
            )?;
            let retry_metadata: (String, String, String, Option<String>) = conn.query_row(
                "SELECT failure_code, retry_disposition, policy_version, next_attempt_at
                   FROM narrative_extraction_attempts WHERE id = ?1",
                params![retryable.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(retry_metadata.0, "NEX_MAINTENANCE_TRANSIENT");
            assert_eq!(retry_metadata.1, "retryable");
            assert_eq!(retry_metadata.2, "v1");
            assert!(retry_metadata.3.is_some());

            let manual = create(conn, "dependency-verify")?;
            fail_maintenance_run_in_tx(
                conn,
                &manual,
                MaintenanceFailureKind::Manual,
                "contract violation",
            )?;
            let manual_metadata: (String, String, String, Option<String>) = conn.query_row(
                "SELECT failure_code, retry_disposition, policy_version, next_attempt_at
                   FROM narrative_extraction_attempts WHERE id = ?1",
                params![manual.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(
                manual_metadata.0,
                "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION"
            );
            assert_eq!(manual_metadata.1, "manual");
            assert_eq!(manual_metadata.2, "v1");
            assert_eq!(manual_metadata.3, None);
            Ok(())
        })
        .expect("failure metadata");
    }

    #[test]
    fn foreground_hold_keeps_all_rows_running_until_exact_release() {
        let db = open_db();
        db.with_conn(|conn| {
            let handle = create(conn, "semantic-index-rebuild")?;
            hold_maintenance_run_in_tx(conn, &handle)?;
            let statuses: (String, String, String) = conn.query_row(
                "SELECT r.status, t.status, a.status
                   FROM narrative_extraction_runs r
                   JOIN narrative_extraction_tasks t ON t.run_id = r.id
                   JOIN narrative_extraction_attempts a ON a.task_id = t.id
                  WHERE r.id = ?1",
                params![handle.run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(
                statuses,
                ("running".into(), "running".into(), "running".into())
            );
            release_foreground_maintenance_run_in_tx(conn, &handle)?;
            Ok(())
        })
        .expect("foreground hold/release");
    }

    #[test]
    fn interruption_fails_old_lifecycle_then_new_run_reuses_sealed_work_distinctly() {
        let db = open_db();
        db.with_conn(|conn| {
            let old = create(conn, "dependency-verify")?;
            fail_maintenance_run_in_tx(
                conn,
                &old,
                MaintenanceFailureKind::Interrupted,
                "process interruption",
            )?;
            let replacement = create(conn, "dependency-verify")?;
            assert!(!replacement.reused);
            assert_ne!(replacement.run_id, old.run_id);
            assert_ne!(replacement.task_id, old.task_id);
            assert_ne!(replacement.attempt_id, old.attempt_id);

            let old_metadata: (String, String, String, Option<String>) = conn.query_row(
                "SELECT failure_code, retry_disposition, policy_version, next_attempt_at
                   FROM narrative_extraction_attempts WHERE id = ?1",
                params![old.attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(old_metadata.0, "NEX_MAINTENANCE_INTERRUPTED");
            assert_eq!(old_metadata.1, "retryable");
            assert_eq!(old_metadata.2, "v1");
            assert!(old_metadata.3.is_some());
            Ok(())
        })
        .expect("interruption recovery");
    }
}
