//! SQL persistence for narrative extraction runs, tasks, and proposals.

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use uuid::Uuid;

use super::models::{
    AppendDecisionPayload, AppendRevisionPayload, ArtifactInput, CreateRunPayload,
    CreateTaskSeed, FailTaskPayload, FinishTaskPayload, ProposalSeed, SaveProposalSetPayload,
    default_object_json,
};
use super::task_leases::{
    claim_next_task, claimed_task_to_value, load_task_row, persist_task_artifacts,
    verify_task_lease, with_immediate_transaction,
};
use crate::Database;

pub(crate) fn ensure_run_project(
    conn: &Connection,
    run_id: &str,
    project_id: &str,
) -> anyhow::Result<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM narrative_extraction_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => anyhow::bail!("narrative extraction run project mismatch"),
        None => anyhow::bail!("narrative extraction run not found"),
    }
}

pub(crate) fn insert_attempt(
    conn: &Connection,
    attempt_id: &str,
    task_id: &str,
    attempt_number: i64,
    status: &str,
    started_at: &str,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO narrative_extraction_attempts
            (id, task_id, attempt_number, status, started_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![attempt_id, task_id, attempt_number, status, started_at],
    )?;
    Ok(())
}

pub(crate) fn insert_artifacts_for_attempt(
    conn: &Connection,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    artifacts: &[ArtifactInput],
) -> anyhow::Result<()> {
    for artifact in artifacts {
        let artifact_id = artifact
            .artifact_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let payload_storage = artifact
            .payload_storage
            .clone()
            .unwrap_or_else(|| "inline-json".to_string());
        let payload_json = artifact
            .payload_json
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?
            .unwrap_or_else(|| "{}".to_string());
        conn.execute(
            "INSERT INTO narrative_extraction_artifacts
                (id, run_id, task_id, attempt_id, artifact_kind,
                 payload_storage, payload_json, payload_ref, payload_digest, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))",
            params![
                artifact_id,
                run_id,
                task_id,
                attempt_id,
                artifact.artifact_kind,
                payload_storage,
                payload_json,
                artifact.payload_ref,
                artifact.payload_digest,
            ],
        )?;
    }
    Ok(())
}

pub fn create_run(db: &Database, payload: CreateRunPayload) -> anyhow::Result<Value> {
    let run_id = payload
        .run_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let coverage_json = serde_json::to_string(
        payload
            .coverage_json
            .as_ref()
            .unwrap_or(&default_object_json()),
    )?;
    let scope_json = serde_json::to_string(&payload.scope_json)?;
    let spec_json = serde_json::to_string(&payload.spec_json)?;
    let status = if payload.tasks.is_empty() {
        "pending"
    } else {
        "running"
    };

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     snapshot_digest, catalog_digest, registry_digest, status, coverage_json,
                     created_at, started_at, version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                         datetime('now'), CASE WHEN ?10 = 'running' THEN datetime('now') ELSE NULL END, 0)",
                params![
                    run_id,
                    payload.project_id,
                    payload.surface_path_id,
                    scope_json,
                    spec_json,
                    payload.spec_digest,
                    payload.snapshot_digest,
                    payload.catalog_digest,
                    payload.registry_digest,
                    status,
                    coverage_json,
                ],
            )?;

            let mut task_ids = Vec::new();
            for seed in &payload.tasks {
                let task_id = insert_task_seed(conn, &run_id, seed)?;
                task_ids.push(task_id);
            }

            Ok(json!({
                "runId": run_id,
                "status": status,
                "taskIds": task_ids,
            }))
        })
    })
}

fn insert_task_seed(conn: &Connection, run_id: &str, seed: &CreateTaskSeed) -> anyhow::Result<String> {
    let task_id = seed
        .task_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let input_json = serde_json::to_string(
        seed.input_json
            .as_ref()
            .unwrap_or(&default_object_json()),
    )?;
    let priority = seed.priority.unwrap_or(0);
    conn.execute(
        "INSERT INTO narrative_extraction_tasks
            (id, run_id, task_kind, status, input_json, priority, attempt_count, created_at, version)
         VALUES (?1, ?2, ?3, 'queued', ?4, ?5, 0, datetime('now'), 0)",
        params![task_id, run_id, seed.task_kind, input_json, priority],
    )?;
    Ok(task_id)
}

pub fn get_run(db: &Database, run_id: String, project_id: String) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        ensure_run_project(conn, &run_id, &project_id)?;
        let run = conn.query_row(
            "SELECT id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                    snapshot_digest, catalog_digest, registry_digest, status, coverage_json,
                    outcome_summary_json, created_at, started_at, completed_at, version
               FROM narrative_extraction_runs
              WHERE id = ?1",
            params![run_id],
            row_to_run_value,
        )?;

        let mut stmt = conn.prepare(
            "SELECT id, run_id, task_kind, status, input_json, output_json, priority,
                    attempt_count, lease_owner, lease_expires_at, heartbeat_at,
                    error_message, created_at, started_at, completed_at, version
               FROM narrative_extraction_tasks
              WHERE run_id = ?1
              ORDER BY priority DESC, created_at ASC",
        )?;
        let tasks: Vec<Value> = stmt
            .query_map(params![run_id], row_to_task_value)?
            .collect::<Result<_, _>>()?;

        let mut counts = json!({
            "queued": 0,
            "running": 0,
            "completed": 0,
            "failed": 0,
            "cancelled": 0,
        });
        for task in &tasks {
            if let Some(status) = task.get("status").and_then(Value::as_str) {
                if let Some(count) = counts.get_mut(status) {
                    *count = json!(count.as_i64().unwrap_or(0) + 1);
                }
            }
        }

        Ok(json!({
            "run": run,
            "tasks": tasks,
            "taskCounts": counts,
        }))
    })
}

pub fn cancel_run(db: &Database, run_id: String, project_id: String) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            ensure_run_project(conn, &run_id, &project_id)?;
            let updated = conn.execute(
                "UPDATE narrative_extraction_runs
                    SET status = 'cancelled',
                        completed_at = datetime('now'),
                        version = version + 1
                  WHERE id = ?1
                    AND status IN ('pending', 'running')",
                params![run_id],
            )?;
            anyhow::ensure!(updated == 1, "run is not cancellable");

            conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'cancelled',
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        heartbeat_at = NULL,
                        completed_at = datetime('now'),
                        version = version + 1
                  WHERE run_id = ?1
                    AND status IN ('queued', 'running')",
                params![run_id],
            )?;

            Ok(json!({ "runId": run_id, "status": "cancelled" }))
        })
    })
}

pub fn claim_task(
    db: &Database,
    payload: super::models::ClaimTaskPayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            let claimed = claim_next_task(conn, &payload)?;
            Ok(match claimed {
                Some(task) => json!({
                    "claimed": true,
                    "task": claimed_task_to_value(&task),
                }),
                None => json!({ "claimed": false }),
            })
        })
    })
}

pub fn finish_task(db: &Database, payload: FinishTaskPayload) -> anyhow::Result<Value> {
    let output_json = serde_json::to_string(
        payload
            .output_json
            .as_ref()
            .unwrap_or(&default_object_json()),
    )?;

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            ensure_run_project(conn, &payload.run_id, &payload.project_id)?;
            verify_task_lease(conn, &payload.task_id, &payload.run_id, &payload.lease_owner)?;

            let updated = conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'completed',
                        output_json = ?1,
                        error_message = NULL,
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        heartbeat_at = NULL,
                        completed_at = datetime('now'),
                        version = version + 1
                  WHERE id = ?2 AND run_id = ?3 AND status = 'running'",
                params![output_json, payload.task_id, payload.run_id],
            )?;
            anyhow::ensure!(updated == 1, "task is not running");

            conn.execute(
                "UPDATE narrative_extraction_attempts
                    SET status = 'completed',
                        completed_at = datetime('now'),
                        output_json = ?1
                  WHERE id = ?2 AND task_id = ?3",
                params![output_json, payload.attempt_id, payload.task_id],
            )?;

            persist_task_artifacts(
                conn,
                &payload.run_id,
                &payload.task_id,
                &payload.attempt_id,
                &payload.artifacts,
            )?;

            maybe_complete_run(conn, &payload.run_id)?;

            Ok(json!({
                "taskId": payload.task_id,
                "attemptId": payload.attempt_id,
                "status": "completed",
                "task": load_task_row(conn, &payload.task_id, &payload.run_id)?,
            }))
        })
    })
}

pub fn fail_task(db: &Database, payload: FailTaskPayload) -> anyhow::Result<Value> {
    let output_json = payload
        .output_json
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let requeue = payload.requeue.unwrap_or(false);
    let next_status = if requeue { "queued" } else { "failed" };

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            ensure_run_project(conn, &payload.run_id, &payload.project_id)?;
            verify_task_lease(conn, &payload.task_id, &payload.run_id, &payload.lease_owner)?;

            let updated = conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = ?1,
                        output_json = COALESCE(?2, output_json),
                        error_message = ?3,
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        heartbeat_at = NULL,
                        completed_at = CASE WHEN ?1 = 'failed' THEN datetime('now') ELSE NULL END,
                        version = version + 1
                  WHERE id = ?4 AND run_id = ?5 AND status = 'running'",
                params![
                    next_status,
                    output_json,
                    payload.error_message,
                    payload.task_id,
                    payload.run_id,
                ],
            )?;
            anyhow::ensure!(updated == 1, "task is not running");

            conn.execute(
                "UPDATE narrative_extraction_attempts
                    SET status = 'failed',
                        completed_at = datetime('now'),
                        error_message = ?1,
                        output_json = COALESCE(?2, output_json)
                  WHERE id = ?3 AND task_id = ?4",
                params![
                    payload.error_message,
                    output_json,
                    payload.attempt_id,
                    payload.task_id,
                ],
            )?;

            if requeue {
                maybe_complete_run(conn, &payload.run_id)?;
            } else {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET status = 'failed',
                            completed_at = datetime('now'),
                            outcome_summary_json = ?1,
                            version = version + 1
                      WHERE id = ?2 AND status = 'running'",
                    params![
                        json!({ "failedTaskId": payload.task_id }).to_string(),
                        payload.run_id,
                    ],
                )?;
            }

            Ok(json!({
                "taskId": payload.task_id,
                "attemptId": payload.attempt_id,
                "status": next_status,
                "task": load_task_row(conn, &payload.task_id, &payload.run_id)?,
            }))
        })
    })
}

fn maybe_complete_run(conn: &Connection, run_id: &str) -> anyhow::Result<()> {
    let remaining: i64 = conn.query_row(
        "SELECT COUNT(*)
           FROM narrative_extraction_tasks
          WHERE run_id = ?1
            AND status IN ('queued', 'running')",
        params![run_id],
        |row| row.get(0),
    )?;
    if remaining == 0 {
        conn.execute(
            "UPDATE narrative_extraction_runs
                SET status = 'completed',
                    completed_at = datetime('now'),
                    version = version + 1
              WHERE id = ?1 AND status = 'running'",
            params![run_id],
        )?;
    }
    Ok(())
}

/// Cold-start review restore: inline-json artifacts + proposal set + proposals
/// (current revision / payload / status) + latest decision per proposal.
pub fn get_run_review_bundle(
    db: &Database,
    run_id: String,
    project_id: String,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        ensure_run_project(conn, &run_id, &project_id)?;

        let mut artifact_stmt = conn.prepare(
            "SELECT id, run_id, task_id, attempt_id, artifact_kind,
                    payload_storage, payload_json, payload_ref, payload_digest, created_at
               FROM narrative_extraction_artifacts
              WHERE run_id = ?1
              ORDER BY created_at ASC, id ASC",
        )?;
        let artifacts: Vec<Value> = artifact_stmt
            .query_map(params![run_id], row_to_artifact_value)?
            .collect::<Result<_, _>>()?;

        let proposal_set: Option<Value> = conn
            .query_row(
                "SELECT id, run_id, project_id, set_kind, status, summary_json,
                        created_at, updated_at, version
                   FROM narrative_proposal_sets
                  WHERE run_id = ?1 AND project_id = ?2
                  ORDER BY created_at DESC, id DESC
                  LIMIT 1",
                params![run_id, project_id],
                row_to_proposal_set_value,
            )
            .optional()?;

        let mut proposals = Vec::new();
        if let Some(set) = proposal_set.as_ref() {
            let proposal_set_id = set
                .get("proposalSetId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("proposal set missing id"))?;
            let mut proposal_stmt = conn.prepare(
                "SELECT id, proposal_set_id, proposal_key, kind, status, payload_json,
                        current_revision_id, created_at, updated_at
                   FROM narrative_proposals
                  WHERE proposal_set_id = ?1
                  ORDER BY created_at ASC, id ASC",
            )?;
            let rows: Vec<Value> = proposal_stmt
                .query_map(params![proposal_set_id], row_to_proposal_value)?
                .collect::<Result<_, _>>()?;

            for mut proposal in rows {
                let proposal_id = proposal
                    .get("proposalId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("proposal missing id"))?
                    .to_string();
                let latest_decision = conn
                    .query_row(
                        "SELECT id, proposal_id, revision_id, decision, decision_json,
                                created_at, created_by
                           FROM narrative_proposal_decisions
                          WHERE proposal_id = ?1
                          ORDER BY created_at DESC, id DESC
                          LIMIT 1",
                        params![proposal_id],
                        row_to_decision_value,
                    )
                    .optional()?;
                if let Some(obj) = proposal.as_object_mut() {
                    obj.insert("latestDecision".to_string(), json!(latest_decision));
                }
                proposals.push(proposal);
            }
        }

        Ok(json!({
            "runId": run_id,
            "projectId": project_id,
            "artifacts": artifacts,
            "proposalSet": proposal_set,
            "proposals": proposals,
        }))
    })
}

pub fn save_proposal_set(db: &Database, payload: SaveProposalSetPayload) -> anyhow::Result<Value> {
    let proposal_set_id = payload
        .proposal_set_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let summary_json = serde_json::to_string(
        payload
            .summary_json
            .as_ref()
            .unwrap_or(&default_object_json()),
    )?;

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            ensure_run_project(conn, &payload.run_id, &payload.project_id)?;

            conn.execute(
                "INSERT INTO narrative_proposal_sets
                    (id, run_id, project_id, set_kind, status, summary_json,
                     created_at, updated_at, version)
                 VALUES (?1, ?2, ?3, ?4, 'draft', ?5, datetime('now'), datetime('now'), 0)",
                params![
                    proposal_set_id,
                    payload.run_id,
                    payload.project_id,
                    payload.set_kind,
                    summary_json,
                ],
            )?;

            let mut saved = Vec::new();
            for proposal in &payload.proposals {
                saved.push(insert_proposal_seed(conn, &proposal_set_id, proposal)?);
            }

            Ok(json!({
                "proposalSetId": proposal_set_id,
                "proposals": saved,
            }))
        })
    })
}

fn insert_proposal_seed(
    conn: &Connection,
    proposal_set_id: &str,
    seed: &ProposalSeed,
) -> anyhow::Result<Value> {
    let proposal_id = seed
        .proposal_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let payload_json = serde_json::to_string(&seed.payload_json)?;
    let revision_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();

    conn.execute(
        "INSERT INTO narrative_proposals
            (id, proposal_set_id, proposal_key, kind, status, payload_json,
             current_revision_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'unreviewed', ?5, ?6, datetime('now'), datetime('now'))",
        params![
            proposal_id,
            proposal_set_id,
            seed.proposal_key,
            seed.kind,
            payload_json,
            revision_id,
        ],
    )?;

    conn.execute(
        "INSERT INTO narrative_proposal_revisions
            (id, proposal_id, revision_number, payload_json, created_at, created_by)
         VALUES (?1, ?2, 1, ?3, ?4, 'system')",
        params![revision_id, proposal_id, payload_json.clone(), created_at],
    )?;

    Ok(json!({
        "proposalId": proposal_id,
        "proposalKey": seed.proposal_key,
        "revisionId": revision_id,
        "status": "unreviewed",
    }))
}

pub fn append_revision(db: &Database, payload: AppendRevisionPayload) -> anyhow::Result<Value> {
    let payload_json = serde_json::to_string(&payload.payload_json)?;
    let revision_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let created_by = payload.created_by.unwrap_or_else(|| "user".to_string());

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            ensure_run_project(conn, &payload.run_id, &payload.project_id)?;
            let (proposal_set_id, current_revision_id): (String, String) = conn.query_row(
                "SELECT p.proposal_set_id, p.current_revision_id
                   FROM narrative_proposals p
                   INNER JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                  WHERE p.id = ?1
                    AND s.run_id = ?2
                    AND s.project_id = ?3",
                params![payload.proposal_id, payload.run_id, payload.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let _ = proposal_set_id;
            anyhow::ensure!(
                current_revision_id == payload.expected_current_revision_id,
                "NEX_PROPOSAL_REVISION_CONFLICT: expected current revision '{}', found '{}'",
                payload.expected_current_revision_id,
                current_revision_id
            );

            let next_revision: i64 = conn.query_row(
                "SELECT COALESCE(MAX(revision_number), 0) + 1
                   FROM narrative_proposal_revisions
                  WHERE proposal_id = ?1",
                params![payload.proposal_id],
                |row| row.get(0),
            )?;

            conn.execute(
                "INSERT INTO narrative_proposal_revisions
                    (id, proposal_id, revision_number, payload_json, created_at, created_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    revision_id,
                    payload.proposal_id,
                    next_revision,
                    payload_json,
                    created_at,
                    created_by,
                ],
            )?;

            let updated = conn.execute(
                "UPDATE narrative_proposals
                    SET payload_json = ?1,
                        current_revision_id = ?2,
                        status = 'unreviewed',
                        updated_at = datetime('now')
                  WHERE id = ?3
                    AND current_revision_id = ?4",
                params![
                    payload_json.clone(),
                    revision_id,
                    payload.proposal_id,
                    payload.expected_current_revision_id
                ],
            )?;
            anyhow::ensure!(
                updated == 1,
                "NEX_PROPOSAL_REVISION_CONFLICT: current revision changed concurrently"
            );

            Ok(json!({
                "proposalId": payload.proposal_id,
                "revisionId": revision_id,
                "revisionNumber": next_revision,
                "status": "unreviewed",
            }))
        })
    })
}

pub fn append_decision(db: &Database, payload: AppendDecisionPayload) -> anyhow::Result<Value> {
    let decision_json = serde_json::to_string(
        payload
            .decision_json
            .as_ref()
            .unwrap_or(&default_object_json()),
    )?;
    let decision_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let created_by = payload.created_by.unwrap_or_else(|| "user".to_string());
    let proposal_status = map_decision_to_status(&payload.decision)?;

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            ensure_run_project(conn, &payload.run_id, &payload.project_id)?;

            let (revision_owner, current_revision_id): (Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT p.id, p.current_revision_id
                       FROM narrative_proposals p
                       INNER JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                       INNER JOIN narrative_proposal_revisions r ON r.id = ?1
                      WHERE p.id = ?2
                        AND r.proposal_id = p.id
                        AND s.run_id = ?3
                        AND s.project_id = ?4",
                    params![
                        payload.revision_id,
                        payload.proposal_id,
                        payload.run_id,
                        payload.project_id
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?
                .unwrap_or((None, None));
            anyhow::ensure!(
                revision_owner.as_deref() == Some(payload.proposal_id.as_str()),
                "proposal revision mismatch for run/project"
            );
            anyhow::ensure!(
                current_revision_id.as_deref() == Some(payload.revision_id.as_str()),
                "NEX_PROPOSAL_REVISION_MISMATCH: decision revision '{}' is not current",
                payload.revision_id
            );

            conn.execute(
                "INSERT INTO narrative_proposal_decisions
                    (id, proposal_id, revision_id, decision, decision_json, created_at, created_by)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    decision_id,
                    payload.proposal_id,
                    payload.revision_id,
                    payload.decision,
                    decision_json,
                    created_at,
                    created_by,
                ],
            )?;

            let updated = conn.execute(
                "UPDATE narrative_proposals
                    SET status = ?1,
                        updated_at = datetime('now')
                  WHERE id = ?2
                    AND current_revision_id = ?3",
                params![proposal_status, payload.proposal_id, payload.revision_id],
            )?;
            anyhow::ensure!(
                updated == 1,
                "NEX_PROPOSAL_REVISION_MISMATCH: current revision changed concurrently"
            );

            Ok(json!({
                "decisionId": decision_id,
                "proposalId": payload.proposal_id,
                "revisionId": payload.revision_id,
                "decision": payload.decision,
                "status": proposal_status,
            }))
        })
    })
}

fn map_decision_to_status(decision: &str) -> anyhow::Result<&'static str> {
    match decision {
        "approved" => Ok("approved"),
        "rejected" => Ok("rejected"),
        "deferred" => Ok("deferred"),
        "held" => Ok("held"),
        other => anyhow::bail!("unsupported proposal decision: {other}"),
    }
}

pub(crate) fn row_to_run_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    let outcome_summary_json = row
        .get::<_, Option<String>>("outcome_summary_json")?
        .map(parse_json_column)
        .transpose()?;
    Ok(json!({
        "runId": row.get::<_, String>("id")?,
        "projectId": row.get::<_, String>("project_id")?,
        "surfacePathId": row.get::<_, String>("surface_path_id")?,
        "scopeJson": parse_json_column(row.get::<_, String>("scope_json")?)?,
        "specJson": parse_json_column(row.get::<_, String>("spec_json")?)?,
        "specDigest": row.get::<_, String>("spec_digest")?,
        "snapshotDigest": row.get::<_, Option<String>>("snapshot_digest")?,
        "catalogDigest": row.get::<_, Option<String>>("catalog_digest")?,
        "registryDigest": row.get::<_, Option<String>>("registry_digest")?,
        "status": row.get::<_, String>("status")?,
        "coverageJson": parse_json_column(row.get::<_, String>("coverage_json")?)?,
        "outcomeSummaryJson": outcome_summary_json,
        "createdAt": row.get::<_, String>("created_at")?,
        "startedAt": row.get::<_, Option<String>>("started_at")?,
        "completedAt": row.get::<_, Option<String>>("completed_at")?,
        "version": row.get::<_, i64>("version")?,
    }))
}

pub(crate) fn row_to_task_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    let output_json = row
        .get::<_, Option<String>>("output_json")?
        .map(parse_json_column)
        .transpose()?;
    Ok(json!({
        "taskId": row.get::<_, String>("id")?,
        "runId": row.get::<_, String>("run_id")?,
        "taskKind": row.get::<_, String>("task_kind")?,
        "status": row.get::<_, String>("status")?,
        "inputJson": parse_json_column(row.get::<_, String>("input_json")?)?,
        "outputJson": output_json,
        "priority": row.get::<_, i64>("priority")?,
        "attemptCount": row.get::<_, i64>("attempt_count")?,
        "leaseOwner": row.get::<_, Option<String>>("lease_owner")?,
        "leaseExpiresAt": row.get::<_, Option<String>>("lease_expires_at")?,
        "heartbeatAt": row.get::<_, Option<String>>("heartbeat_at")?,
        "errorMessage": row.get::<_, Option<String>>("error_message")?,
        "createdAt": row.get::<_, String>("created_at")?,
        "startedAt": row.get::<_, Option<String>>("started_at")?,
        "completedAt": row.get::<_, Option<String>>("completed_at")?,
        "version": row.get::<_, i64>("version")?,
    }))
}

fn parse_json_column(raw: String) -> rusqlite::Result<Value> {
    serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    })
}

fn row_to_artifact_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    let payload_json = row
        .get::<_, Option<String>>("payload_json")?
        .map(parse_json_column)
        .transpose()?;
    Ok(json!({
        "artifactId": row.get::<_, String>("id")?,
        "runId": row.get::<_, String>("run_id")?,
        "taskId": row.get::<_, Option<String>>("task_id")?,
        "attemptId": row.get::<_, Option<String>>("attempt_id")?,
        "artifactKind": row.get::<_, String>("artifact_kind")?,
        "payloadStorage": row.get::<_, String>("payload_storage")?,
        "payloadJson": payload_json,
        "payloadRef": row.get::<_, Option<String>>("payload_ref")?,
        "payloadDigest": row.get::<_, Option<String>>("payload_digest")?,
        "createdAt": row.get::<_, String>("created_at")?,
    }))
}

fn row_to_proposal_set_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "proposalSetId": row.get::<_, String>("id")?,
        "runId": row.get::<_, String>("run_id")?,
        "projectId": row.get::<_, String>("project_id")?,
        "setKind": row.get::<_, String>("set_kind")?,
        "status": row.get::<_, String>("status")?,
        "summaryJson": parse_json_column(row.get::<_, String>("summary_json")?)?,
        "createdAt": row.get::<_, String>("created_at")?,
        "updatedAt": row.get::<_, String>("updated_at")?,
        "version": row.get::<_, i64>("version")?,
    }))
}

fn row_to_proposal_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "proposalId": row.get::<_, String>("id")?,
        "proposalSetId": row.get::<_, String>("proposal_set_id")?,
        "proposalKey": row.get::<_, String>("proposal_key")?,
        "kind": row.get::<_, String>("kind")?,
        "status": row.get::<_, String>("status")?,
        "payloadJson": parse_json_column(row.get::<_, String>("payload_json")?)?,
        "currentRevisionId": row.get::<_, Option<String>>("current_revision_id")?,
        "createdAt": row.get::<_, String>("created_at")?,
        "updatedAt": row.get::<_, String>("updated_at")?,
    }))
}

fn row_to_decision_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "decisionId": row.get::<_, String>("id")?,
        "proposalId": row.get::<_, String>("proposal_id")?,
        "revisionId": row.get::<_, String>("revision_id")?,
        "decision": row.get::<_, String>("decision")?,
        "decisionJson": parse_json_column(row.get::<_, String>("decision_json")?)?,
        "createdAt": row.get::<_, String>("created_at")?,
        "createdBy": row.get::<_, String>("created_by")?,
    }))
}

/// Test-only DDL helper until migrate.rs adds the production tables.
pub fn ensure_test_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS narrative_extraction_runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            surface_path_id TEXT NOT NULL,
            scope_json TEXT NOT NULL,
            spec_json TEXT NOT NULL,
            spec_digest TEXT NOT NULL,
            snapshot_digest TEXT,
            catalog_digest TEXT,
            registry_digest TEXT,
            status TEXT NOT NULL,
            coverage_json TEXT NOT NULL DEFAULT '{}',
            outcome_summary_json TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS narrative_extraction_tasks (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            task_kind TEXT NOT NULL,
            status TEXT NOT NULL,
            input_json TEXT NOT NULL DEFAULT '{}',
            output_json TEXT,
            priority INTEGER NOT NULL DEFAULT 0,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            lease_owner TEXT,
            lease_expires_at TEXT,
            heartbeat_at TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS narrative_extraction_task_edges (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            from_task_id TEXT NOT NULL,
            to_task_id TEXT NOT NULL,
            edge_kind TEXT NOT NULL DEFAULT 'depends_on',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_extraction_attempts (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            attempt_number INTEGER NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            error_message TEXT,
            output_json TEXT
        );
        CREATE TABLE IF NOT EXISTS narrative_extraction_artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            task_id TEXT,
            attempt_id TEXT,
            artifact_kind TEXT NOT NULL,
            payload_storage TEXT NOT NULL DEFAULT 'inline-json',
            payload_json TEXT,
            payload_ref TEXT,
            payload_digest TEXT,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_proposal_sets (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            set_kind TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            summary_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS narrative_proposals (
            id TEXT PRIMARY KEY,
            proposal_set_id TEXT NOT NULL,
            proposal_key TEXT NOT NULL,
            kind TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'unreviewed',
            payload_json TEXT NOT NULL,
            current_revision_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_proposal_revisions (
            id TEXT PRIMARY KEY,
            proposal_id TEXT NOT NULL,
            revision_number INTEGER NOT NULL,
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_proposal_decisions (
            id TEXT PRIMARY KEY,
            proposal_id TEXT NOT NULL,
            revision_id TEXT NOT NULL,
            decision TEXT NOT NULL,
            decision_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_apply_commits (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            run_id TEXT,
            proposal_set_id TEXT,
            request_id TEXT NOT NULL,
            plan_digest TEXT NOT NULL,
            status TEXT NOT NULL,
            receipt_json TEXT,
            error_message TEXT,
            created_at TEXT NOT NULL,
            completed_at TEXT,
            version INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS narrative_apply_operations (
            id TEXT PRIMARY KEY,
            commit_id TEXT NOT NULL,
            operation_index INTEGER NOT NULL,
            operation_kind TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            result_entity_kind TEXT,
            result_entity_id TEXT,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_proposal_applications (
            id TEXT PRIMARY KEY,
            commit_id TEXT NOT NULL,
            proposal_id TEXT NOT NULL,
            revision_id TEXT NOT NULL,
            applied_entity_kind TEXT NOT NULL,
            applied_entity_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_commit_journals (
            id TEXT PRIMARY KEY,
            commit_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            before_json TEXT,
            after_json TEXT,
            created_at TEXT NOT NULL
        );",
    )?;
    Ok(())
}

#[cfg(test)]
mod unit_tests {
    use super::*;
    use crate::Database;
    use serde_json::json;

    fn test_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.with_conn(|conn| {
            conn.execute(
                "CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'p')",
                [],
            )?;
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('project-1', 'Project')",
                [],
            )?;
            ensure_test_schema(conn)
        })
        .expect("seed test schema");
        db
    }

    #[test]
    fn create_and_get_run_round_trip() {
        let db = test_db();
        let created = create_run(
            &db,
            CreateRunPayload {
                run_id: Some("run-1".to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: "chronicle.extract".to_string(),
                scope_json: json!({ "folderId": "folder-1" }),
                spec_json: json!({ "domain": "chronicle" }),
                spec_digest: "digest-1".to_string(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![CreateTaskSeed {
                    task_id: Some("task-1".to_string()),
                    task_kind: "plan_windows".to_string(),
                    input_json: Some(json!({ "windowCount": 1 })),
                    priority: Some(10),
                }],
            },
        )
        .expect("create run");

        assert_eq!(created["runId"], "run-1");
        assert_eq!(created["status"], "running");

        let loaded = get_run(&db, "run-1".to_string(), "project-1".to_string()).expect("get run");
        assert_eq!(loaded["run"]["status"], "running");
        assert_eq!(loaded["tasks"].as_array().map(|v| v.len()), Some(1));
        assert_eq!(loaded["taskCounts"]["queued"], 1);
    }
}
