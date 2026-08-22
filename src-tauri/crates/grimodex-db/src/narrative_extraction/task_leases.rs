//! Task lease acquisition under `BEGIN IMMEDIATE`.

use chrono::{Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use super::models::ClaimTaskPayload;
use super::repository::{
    ensure_run_project, insert_artifacts_for_attempt, insert_attempt, row_to_task_value,
};

const DEFAULT_LEASE_SECS: i64 = 300;

pub(crate) struct ClaimedTask {
    pub task_id: String,
    pub attempt_id: String,
    pub task_kind: String,
    pub input_json: String,
    pub attempt_number: i64,
    pub lease_expires_at: String,
}

pub(crate) fn claim_next_task(
    conn: &Connection,
    payload: &ClaimTaskPayload,
) -> anyhow::Result<Option<ClaimedTask>> {
    ensure_run_project(conn, &payload.run_id, &payload.project_id)?;

    let lease_secs = payload.lease_duration_secs.unwrap_or(DEFAULT_LEASE_SECS);
    anyhow::ensure!(lease_secs > 0, "leaseDurationSecs must be positive");

    let now = Utc::now();
    let lease_expires_at = (now + Duration::seconds(lease_secs))
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let heartbeat_at = now.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    let candidate = if let Some(kinds) = payload.task_kinds.as_ref().filter(|k| !k.is_empty()) {
        // run_id is ?1; kind filters must start at ?2 so rusqlite parameter
        // indices match [runId, kind1, kind2, ...].
        let placeholders = (2..=kinds.len() + 1)
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT id, task_kind, input_json, attempt_count
               FROM narrative_extraction_tasks
              WHERE run_id = ?1
                AND task_kind IN ({placeholders})
                AND (
                  status = 'queued'
                  OR (
                    status = 'running'
                    AND lease_expires_at IS NOT NULL
                    AND julianday(lease_expires_at) < julianday('now')
                  )
                )
              ORDER BY priority DESC, created_at ASC
              LIMIT 1"
        );
        let mut query_params: Vec<rusqlite::types::Value> = vec![payload.run_id.clone().into()];
        query_params.extend(kinds.iter().cloned().map(Into::into));
        conn.query_row(
            &sql,
            rusqlite::params_from_iter(query_params.iter()),
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?
    } else {
        conn.query_row(
            "SELECT id, task_kind, input_json, attempt_count
               FROM narrative_extraction_tasks
              WHERE run_id = ?1
                AND (
                  status = 'queued'
                  OR (
                    status = 'running'
                    AND lease_expires_at IS NOT NULL
                    AND julianday(lease_expires_at) < julianday('now')
                  )
                )
              ORDER BY priority DESC, created_at ASC
              LIMIT 1",
            params![payload.run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?
    };

    let Some((task_id, task_kind, input_json, attempt_count)) = candidate else {
        return Ok(None);
    };

    let attempt_number = attempt_count + 1;
    let attempt_id = Uuid::new_v4().to_string();
    let started_at = heartbeat_at.clone();

    let updated = conn.execute(
        "UPDATE narrative_extraction_tasks
            SET status = 'running',
                lease_owner = ?1,
                lease_expires_at = ?2,
                heartbeat_at = ?3,
                attempt_count = ?4,
                started_at = COALESCE(started_at, ?5)
          WHERE id = ?6
            AND run_id = ?7
            AND (
              status = 'queued'
              OR (
                status = 'running'
                AND lease_expires_at IS NOT NULL
                AND julianday(lease_expires_at) < julianday('now')
              )
            )",
        params![
            payload.lease_owner,
            lease_expires_at,
            heartbeat_at,
            attempt_number,
            started_at,
            task_id,
            payload.run_id,
        ],
    )?;
    anyhow::ensure!(updated == 1, "task claim lost race");

    insert_attempt(
        conn,
        &attempt_id,
        &task_id,
        attempt_number,
        "running",
        &started_at,
    )?;

    conn.execute(
        "UPDATE narrative_extraction_runs
            SET status = CASE WHEN status = 'pending' THEN 'running' ELSE status END,
                started_at = COALESCE(started_at, ?2)
          WHERE id = ?1",
        params![payload.run_id, started_at],
    )?;

    Ok(Some(ClaimedTask {
        task_id,
        attempt_id,
        task_kind,
        input_json,
        attempt_number,
        lease_expires_at,
    }))
}

pub(crate) fn verify_task_lease(
    conn: &Connection,
    task_id: &str,
    run_id: &str,
    lease_owner: &str,
) -> anyhow::Result<()> {
    let (owner, expires_at): (Option<String>, Option<String>) = conn.query_row(
        "SELECT lease_owner, lease_expires_at
           FROM narrative_extraction_tasks
          WHERE id = ?1 AND run_id = ?2",
        params![task_id, run_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    anyhow::ensure!(
        owner.as_deref() == Some(lease_owner),
        "task lease owner mismatch"
    );
    if let Some(expires_at) = expires_at {
        let expired: bool = conn.query_row(
            "SELECT CASE WHEN julianday(?1) < julianday('now') THEN 1 ELSE 0 END",
            params![expires_at],
            |row| row.get(0),
        )?;
        anyhow::ensure!(!expired, "task lease expired");
    }
    Ok(())
}

pub(crate) fn persist_task_artifacts(
    conn: &Connection,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    artifacts: &[super::models::ArtifactInput],
) -> anyhow::Result<()> {
    insert_artifacts_for_attempt(conn, run_id, task_id, attempt_id, artifacts)
}

pub(crate) fn claimed_task_to_value(claimed: &ClaimedTask) -> serde_json::Value {
    serde_json::json!({
        "taskId": claimed.task_id,
        "attemptId": claimed.attempt_id,
        "taskKind": claimed.task_kind,
        "inputJson": serde_json::from_str::<serde_json::Value>(&claimed.input_json)
            .unwrap_or(serde_json::Value::Object(Default::default())),
        "attemptNumber": claimed.attempt_number,
        "leaseExpiresAt": claimed.lease_expires_at,
    })
}

pub(crate) fn load_task_row(
    conn: &Connection,
    task_id: &str,
    run_id: &str,
) -> anyhow::Result<serde_json::Value> {
    conn.query_row(
        "SELECT id, run_id, task_kind, status, input_json, output_json, priority,
                attempt_count, lease_owner, lease_expires_at, heartbeat_at,
                error_message, created_at, started_at, completed_at, version
           FROM narrative_extraction_tasks
          WHERE id = ?1 AND run_id = ?2",
        params![task_id, run_id],
        row_to_task_value,
    )
    .map_err(Into::into)
}

pub(crate) fn with_immediate_transaction<T>(
    conn: &Connection,
    operation: impl FnOnce(&Connection) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    match operation(conn) {
        Ok(value) => {
            conn.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}
