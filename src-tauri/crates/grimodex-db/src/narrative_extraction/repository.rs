//! SQL persistence for narrative extraction runs, tasks, and proposals.

use anyhow::Context;
use chrono::{DateTime, Datelike, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};
use uuid::Uuid;

use super::dependency_edges::{
    canonical_source_object_identity, record_dependency_edge_in_tx, validate_run_id,
    PROPOSAL_REVISION_CONSUMER_KIND,
};
use super::legacy_backfill::parse_maintenance_instant;

/// Generation of the current Proposal Revision dependency declaration writer.
/// This is paired with the bundled producer registry; bump both when the
/// writer's declaration semantics change.
pub(crate) const PROPOSAL_REVISION_DEPENDENCY_GENERATION: &str = "proposal-revision-dependency/v1";
use super::field_authority::{derive_decision_authority, TrustedDecisionActor};
use super::models::{
    default_object_json, AppendDecisionPayload, AppendRevisionPayload, ArtifactInput,
    CreateRunPayload, CreateTaskSeed, FailTaskPayload, FinishTaskPayload, ListResumableRunsPayload,
    ProposalSeed, ReviseAndDecidePayload, SaveProposalSetPayload,
};
use super::reconciliation_envelope::{
    validate_envelope_source_tokens, validate_reconciliation_envelope, SourceBasisRow,
    ORIGIN_ENVELOPED, ORIGIN_LEGACY_UNBOUND,
};
use super::task_leases::{
    claim_next_task, claimed_task_to_value, load_task_row, persist_task_artifacts,
    verify_task_lease, with_immediate_transaction,
};
use super::INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID;
use crate::narrative_runtime_policy::require_narrative_extraction_allowed;
use crate::Database;

pub(crate) fn ensure_proposal_not_applied(
    conn: &Connection,
    proposal_id: &str,
) -> anyhow::Result<()> {
    let applied: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_proposal_applications WHERE proposal_id = ?1",
        params![proposal_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        applied == 0,
        "NEX_PROPOSAL_ALREADY_APPLIED: proposal '{proposal_id}'"
    );
    Ok(())
}

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

fn ensure_generic_task_api_allowed(conn: &Connection, run_id: &str) -> anyhow::Result<()> {
    let (has_run_kind, has_consumer_id): (bool, bool) = conn.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM pragma_table_info('narrative_extraction_runs')
              WHERE name = 'run_kind'
           ),
           EXISTS(
             SELECT 1 FROM pragma_table_info('narrative_extraction_runs')
              WHERE name = 'consumer_id'
           )",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    match (has_run_kind, has_consumer_id) {
        // Pre-C2 compatibility schemas cannot represent a system-owned
        // incremental Freshness Run, so their generic task APIs retain the
        // legacy behavior. A half-upgraded schema is ambiguous and must not
        // silently bypass the ownership guard.
        (false, false) => return Ok(()),
        (true, true) => {}
        _ => anyhow::bail!(
            "NEX_SYSTEM_RUN_SCHEMA_INVALID: run_kind and consumer_id must be upgraded together"
        ),
    }

    let system_owned: bool = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM narrative_extraction_runs
            WHERE id = ?1
              AND (
                (run_kind = 'freshness-evaluation' AND consumer_id = ?2)
                OR run_kind IN (
                  'backfill',
                  'dependency-verify',
                  'semantic-index-rebuild'
                )
              )
         )",
        params![run_id, INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        !system_owned,
        "NEX_SYSTEM_RUN_API_FORBIDDEN: automatic maintenance Run lifecycle is owned by its runtime"
    );
    Ok(())
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
    validate_run_id(&run_id)?;
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
    let run_timestamp = grimodex_core::now_rfc3339_millis();

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     snapshot_digest, catalog_digest, registry_digest, status, coverage_json,
                     created_at, started_at, version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                         ?12, CASE WHEN ?10 = 'running' THEN ?12 ELSE NULL END, 0)",
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
                    run_timestamp,
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

/// Work-key reuse policy for [`create_system_run`], per each Run Kind's
/// `sameWorkKeyReuse` in `policies/narrative/narrative-run-kind-policy.json`.
pub(crate) enum SystemRunWorkKeyReuse {
    /// `dependency-backfill`: an automatic-once trigger firing again while a
    /// prior attempt is still running, or after one already completed, must
    /// not create a second Run.
    #[allow(dead_code)]
    RunningAndCompleted,
    /// `dependency-verify` / `dependency-rebuild-derived`: a second trigger
    /// while one is already running reuses it; a completed Run does not
    /// short-circuit a fresh request on its own — Verify's `skipReRunWhen`
    /// and Rebuild's `completedRunReuseNote` are the caller's decision to
    /// make before calling this, not this dedup's.
    RunningOnly,
    /// `dependency-repair`: `sameWorkKeyReuse: "no-automatic-reuse-decision"`
    /// — exclusivity is the Repair lease's job, not work-key dedup here.
    /// The automatic phase owner cannot request this variant; the manual
    /// Repair planner claims its lease directly.
    #[allow(dead_code)]
    None,
}

/// Create a system-triggered (Backfill/Verify/Rebuild-Derived/Repair) Run.
///
/// Distinct from [`create_run`]: system Run Kinds are infrastructure the
/// system runs on itself, not AI extraction, so this does not gate on
/// [`require_narrative_extraction_allowed`] — the "narrative extraction
/// disabled" runtime policy toggle is about AI reading text, and per the
/// Run Kind Policy's `duringBackfillProductBehavior`, editing (and by the
/// same principle, the system's own maintenance of the Dependency Graph)
/// is never blocked by it.
///
/// `work_key` scopes reuse: passing the same `work_key` for the same
/// `run_kind`/`project_id` while a prior Run is still eligible per `reuse`
/// returns that Run instead of creating a duplicate, so an idempotent
/// trigger (e.g. the post-open Backfill bootstrap) can fire repeatedly
/// without racing itself.
///
/// The standalone wrapper is retained for callers that start outside an
/// ambient transaction. The Rust phase owner uses the `_in_tx` helper so Run
/// creation can share the same live Database transaction as the phase writes.
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_system_run(
    db: &Database,
    project_id: &str,
    run_kind: &str,
    semantic_epoch_id: &str,
    work_key: &str,
    spec_json: &Value,
    spec_digest: &str,
    reuse: SystemRunWorkKeyReuse,
    request: Option<&RunRequestIdentity<'_>>,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            create_system_run_in_tx(
                conn,
                project_id,
                run_kind,
                semantic_epoch_id,
                work_key,
                spec_json,
                spec_digest,
                reuse,
                request,
            )
        })
    })
}

/// Core of [`create_system_run`], as an ambient-transaction helper: callers
/// that need to compose Run creation atomically with other writes in the
/// same transaction (e.g. the Backfill bootstrap trigger creating the Run
/// and then immediately running the transform under it) call this directly
/// instead of going through the `Database`-level wrapper, which would
/// nest a second `BEGIN IMMEDIATE` on the same connection.
#[allow(clippy::too_many_arguments)]
pub(crate) fn create_system_run_in_tx(
    conn: &Connection,
    project_id: &str,
    run_kind: &str,
    semantic_epoch_id: &str,
    work_key: &str,
    spec_json: &Value,
    spec_digest: &str,
    reuse: SystemRunWorkKeyReuse,
    request: Option<&RunRequestIdentity<'_>>,
) -> anyhow::Result<Value> {
    // Request replay is resolved before work-key equivalence, because they
    // answer different questions: "did this exact request already run?"
    // versus "is some other Run already doing this work?". A retry of an
    // approved `dependency-repair` must replay its own Run rather than be
    // judged by a work-key policy that deliberately says
    // `no-automatic-reuse-decision`.
    if let Some(request) = request {
        anyhow::ensure!(
            !request.request_id.trim().is_empty(),
            "NEX_RUN_REQUEST_INVALID: requestId must not be empty"
        );
        anyhow::ensure!(
            !request.idempotency_domain.trim().is_empty(),
            "NEX_RUN_REQUEST_INVALID: idempotencyDomain must not be empty"
        );
        anyhow::ensure!(
            !request.actor_id.trim().is_empty(),
            "NEX_RUN_REQUEST_INVALID: actorId must not be empty"
        );
        if let Some(replayed) = find_run_by_request_identity(conn, project_id, request)? {
            return Ok(replayed);
        }
    }

    if let Some(reused) = find_reusable_system_run(conn, project_id, run_kind, work_key, &reuse)? {
        return Ok(reused);
    }
    let spec_json_text = serde_json::to_string(spec_json)?;
    let scope_json_text = serde_json::to_string(&default_object_json())?;
    let coverage_json_text = serde_json::to_string(&default_object_json())?;
    let run_id = Uuid::new_v4().to_string();
    // Run authority is a lifecycle instant, not UUID insertion order. Keep
    // automatic/system rows strictly monotonic at the persisted millisecond
    // precision so a Verify -> Rebuild -> confirmation Verify chain created
    // in one transaction window remains unambiguous after restart/import.
    let run_timestamp = next_system_run_timestamp(conn, project_id)?;
    conn.execute(
        "INSERT INTO narrative_extraction_runs
            (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
             status, coverage_json, created_at, started_at, version,
             run_kind, semantic_epoch_id, work_key,
             request_id, idempotency_domain, request_payload_digest, actor_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6,
                 'running', ?7, ?8, ?8, 0,
                 ?3, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            run_id,
            project_id,
            run_kind,
            scope_json_text,
            spec_json_text,
            spec_digest,
            coverage_json_text,
            run_timestamp,
            semantic_epoch_id,
            work_key,
            request.map(|request| request.request_id),
            request.map(|request| request.idempotency_domain),
            request.map(|request| request.payload_digest),
            request.map(|request| request.actor_id),
        ],
    )?;
    Ok(json!({
        "runId": run_id,
        "status": "running",
        "reused": false,
        "replayed": false,
    }))
}

fn next_system_run_timestamp(conn: &Connection, project_id: &str) -> anyhow::Result<String> {
    let now = Utc::now();
    let now_millis = DateTime::<Utc>::from_timestamp_millis(now.timestamp_millis())
        .ok_or_else(|| anyhow::anyhow!("NEX_MAINTENANCE_RUN_TIMESTAMP_INVALID: current clock"))?;
    let mut statement = conn.prepare(
        "SELECT COALESCE(completed_at, started_at, created_at)
           FROM narrative_extraction_runs
          WHERE project_id = ?1
            AND run_kind IN ('backfill', 'dependency-verify', 'semantic-index-rebuild')",
    )?;
    let rows = statement.query_map(params![project_id], |row| row.get::<_, String>(0))?;
    let mut latest = None;
    for row in rows {
        let value = row?;
        // A malformed terminal row cannot be a reusable marker and must not
        // prevent a fresh system Run from being created. Discovery performs
        // the strict maximal-candidate check after trusted coordinates are
        // filtered; this monotonic timestamp helper only needs valid rows.
        let Ok(parsed) = parse_maintenance_instant(&value) else {
            continue;
        };
        latest = Some(latest.map_or(parsed, |current: DateTime<Utc>| current.max(parsed)));
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

/// Who asked for a system Run, and which request it was.
///
/// Deliberately separate from `work_key`: `work_key` is work equivalence
/// (`sameWorkKeyReuse`), this is request identity
/// (`sameRequestIdReuse: idempotent-replay`). `payload_digest` is what makes
/// a replay distinguishable from a different request that happens to reuse
/// an id.
#[derive(Debug, Clone, Copy)]
pub(crate) struct RunRequestIdentity<'a> {
    pub request_id: &'a str,
    /// Scopes `request_id` so two unrelated surfaces cannot collide on one.
    pub idempotency_domain: &'a str,
    pub payload_digest: &'a str,
    pub actor_id: &'a str,
}

/// An existing Run for exactly this request, if any.
///
/// Fails closed on two different kinds of reuse: the same
/// `(domain, requestId)` carrying a different payload, and the same
/// `(domain, requestId)` presented by a different actor. Both are a caller
/// reusing an id rather than retrying, and replaying someone else's
/// approved operation is exactly the confusion request identity exists to
/// prevent.
///
/// Reports the Run's `status` and stored `outcome` verbatim. Callers must
/// branch on that status — a replayed Run that is `failed`, `running`, or
/// `cancelled` is emphatically not a success, and treating "this request
/// was seen before" as "this request succeeded" would report a repair that
/// never ran as done.
pub(crate) fn find_run_by_request_identity(
    conn: &Connection,
    project_id: &str,
    request: &RunRequestIdentity<'_>,
) -> anyhow::Result<Option<Value>> {
    let existing: Option<(String, String, String, String, Option<String>)> = conn
        .query_row(
            "SELECT id, status, COALESCE(request_payload_digest, ''), COALESCE(actor_id, ''),
                    outcome_summary_json
               FROM narrative_extraction_runs
              WHERE project_id = ?1
                AND idempotency_domain = ?2
                AND request_id = ?3",
            params![project_id, request.idempotency_domain, request.request_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()?;
    let Some((run_id, status, payload_digest, actor_id, outcome_json)) = existing else {
        return Ok(None);
    };
    anyhow::ensure!(
        payload_digest == request.payload_digest,
        "NEX_RUN_REQUEST_CONFLICT: requestId '{}' in domain '{}' already ran for project \
         '{project_id}' with a different payload; reusing a requestId for different work is not \
         an idempotent replay",
        request.request_id,
        request.idempotency_domain
    );
    anyhow::ensure!(
        actor_id == request.actor_id,
        "NEX_RUN_REQUEST_CONFLICT: requestId '{}' in domain '{}' was issued by actor \
         '{actor_id}' for project '{project_id}'; actor '{}' may not replay it",
        request.request_id,
        request.idempotency_domain,
        request.actor_id
    );
    // A stored outcome that will not parse is corruption, and this is a
    // replay path: the caller is about to hand this value back as the
    // authoritative answer for a request it believes already ran. Coercing
    // unreadable JSON to `null` would turn that corruption into a
    // confident-looking empty result, so it fails closed instead. A Run
    // with *no* outcome recorded at all is different and stays `null` —
    // that is the normal shape of a Run still in flight.
    let outcome = match outcome_json.as_deref().map(str::trim) {
        None | Some("") => Value::Null,
        Some(text) => serde_json::from_str::<Value>(text).map_err(|error| {
            anyhow::anyhow!(
                "NEX_RUN_OUTCOME_MALFORMED: Run '{run_id}' (requestId '{}' in domain '{}') has \
                 an unreadable outcome_summary_json: {error}",
                request.request_id,
                request.idempotency_domain
            )
        })?,
    };
    Ok(Some(json!({
        "runId": run_id,
        "status": status,
        "reused": true,
        "replayed": true,
        "outcome": outcome,
    })))
}

/// Record a Run's terminal outcome so a later replay of the same request
/// can reproduce the original response instead of inventing a new one.
pub(crate) fn record_run_outcome_in_tx(
    conn: &Connection,
    run_id: &str,
    outcome: &Value,
) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE narrative_extraction_runs SET outcome_summary_json = ?1 WHERE id = ?2",
        params![serde_json::to_string(outcome)?, run_id],
    )?;
    Ok(())
}

fn find_reusable_system_run(
    conn: &Connection,
    project_id: &str,
    run_kind: &str,
    work_key: &str,
    reuse: &SystemRunWorkKeyReuse,
) -> anyhow::Result<Option<Value>> {
    let status_clause = match reuse {
        SystemRunWorkKeyReuse::RunningAndCompleted => "status IN ('pending','running','completed')",
        SystemRunWorkKeyReuse::RunningOnly => "status IN ('pending','running')",
        SystemRunWorkKeyReuse::None => return Ok(None),
    };
    let sql = format!(
        "SELECT id, status FROM narrative_extraction_runs
          WHERE project_id = ?1 AND run_kind = ?2 AND work_key = ?3 AND {status_clause}
          ORDER BY created_at DESC LIMIT 1"
    );
    conn.query_row(&sql, params![project_id, run_kind, work_key], |row| {
        Ok(json!({
            "runId": row.get::<_, String>(0)?,
            "status": row.get::<_, String>(1)?,
            "reused": true,
        }))
    })
    .optional()
    .map_err(Into::into)
}

fn insert_task_seed(
    conn: &Connection,
    run_id: &str,
    seed: &CreateTaskSeed,
) -> anyhow::Result<String> {
    let task_id = seed
        .task_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let input_json =
        serde_json::to_string(seed.input_json.as_ref().unwrap_or(&default_object_json()))?;
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

/// List runs that still have a durable, unapplied ProposalSet for review restore.
/// In-progress runs without a ProposalSet are intentionally excluded — those are
/// task-resume candidates, not Review-resume candidates.
pub fn list_resumable_runs(
    db: &Database,
    payload: ListResumableRunsPayload,
) -> anyhow::Result<Value> {
    let limit = payload.limit.unwrap_or(20).clamp(1, 100);
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT r.id, r.project_id, r.surface_path_id, r.status, r.snapshot_digest,
                    r.created_at, r.started_at, r.completed_at
               FROM narrative_extraction_runs r
              WHERE r.project_id = ?1
                AND (?2 IS NULL OR r.surface_path_id = ?2)
                AND r.status IN ('pending', 'running', 'completed')
                AND EXISTS (
                    SELECT 1
                      FROM narrative_proposal_sets ps
                      JOIN narrative_proposals p ON p.proposal_set_id = ps.id
                     WHERE ps.run_id = r.id
                       AND ps.project_id = r.project_id
                       AND (
                            p.status IN ('unreviewed', 'approved', 'held')
                            OR (
                                p.status = 'deferred'
                                AND NOT EXISTS (
                                  SELECT 1
                                    FROM narrative_proposal_decisions d
                                   WHERE d.proposal_id = p.id
                                     AND d.revision_id = p.current_revision_id
                                     AND json_extract(d.decision_json, '$.reason')
                                         = 'already-satisfied'
                                )
                            )
                       )
                       AND NOT EXISTS (
                         SELECT 1
                           FROM narrative_proposal_applications a
                          WHERE a.proposal_id = p.id
                       )
                  )
              ORDER BY julianday(COALESCE(r.completed_at, r.started_at, r.created_at)) DESC,
                       COALESCE(r.completed_at, r.started_at, r.created_at) DESC,
                       r.id DESC
              LIMIT ?3",
        )?;
        let surface = payload.surface_path_id.as_deref();
        let rows = stmt.query_map(params![payload.project_id, surface, limit], |row| {
            Ok(json!({
                "runId": row.get::<_, String>(0)?,
                "projectId": row.get::<_, String>(1)?,
                "surfacePathId": row.get::<_, String>(2)?,
                "status": row.get::<_, String>(3)?,
                "snapshotDigest": row.get::<_, Option<String>>(4)?,
                "createdAt": row.get::<_, String>(5)?,
                "startedAt": row.get::<_, Option<String>>(6)?,
                "completedAt": row.get::<_, Option<String>>(7)?,
            }))
        })?;
        let summaries: Vec<Value> = rows.collect::<Result<_, _>>()?;
        Ok(json!(summaries))
    })
}

pub fn cancel_run(db: &Database, run_id: String, project_id: String) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            ensure_run_project(conn, &run_id, &project_id)?;
            ensure_generic_task_api_allowed(conn, &run_id)?;
            let lifecycle_at = grimodex_core::now_rfc3339_millis();
            let updated = conn.execute(
                "UPDATE narrative_extraction_runs
                    SET status = 'cancelled',
                        completed_at = ?2,
                        version = version + 1
                  WHERE id = ?1
                    AND status IN ('pending', 'running')",
                params![run_id, lifecycle_at],
            )?;
            anyhow::ensure!(updated == 1, "run is not cancellable");

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
                params![run_id, lifecycle_at],
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
            require_narrative_extraction_allowed(conn)?;
            ensure_run_project(conn, &payload.run_id, &payload.project_id)?;
            ensure_generic_task_api_allowed(conn, &payload.run_id)?;
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
            ensure_generic_task_api_allowed(conn, &payload.run_id)?;
            verify_task_lease(
                conn,
                &payload.task_id,
                &payload.run_id,
                &payload.lease_owner,
            )?;
            let lifecycle_at = grimodex_core::now_rfc3339_millis();

            let updated = conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = 'completed',
                        output_json = ?1,
                        error_message = NULL,
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        heartbeat_at = NULL,
                        completed_at = ?4,
                        version = version + 1
                  WHERE id = ?2 AND run_id = ?3 AND status = 'running'",
                params![output_json, payload.task_id, payload.run_id, lifecycle_at],
            )?;
            anyhow::ensure!(updated == 1, "task is not running");

            conn.execute(
                "UPDATE narrative_extraction_attempts
                    SET status = 'completed',
                        completed_at = ?4,
                        output_json = ?1
                  WHERE id = ?2 AND task_id = ?3",
                params![
                    output_json,
                    payload.attempt_id,
                    payload.task_id,
                    lifecycle_at
                ],
            )?;

            persist_task_artifacts(
                conn,
                &payload.run_id,
                &payload.task_id,
                &payload.attempt_id,
                &payload.artifacts,
            )?;

            maybe_complete_run(conn, &payload.run_id, &lifecycle_at)?;

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
            ensure_generic_task_api_allowed(conn, &payload.run_id)?;
            verify_task_lease(
                conn,
                &payload.task_id,
                &payload.run_id,
                &payload.lease_owner,
            )?;
            let lifecycle_at = grimodex_core::now_rfc3339_millis();

            let updated = conn.execute(
                "UPDATE narrative_extraction_tasks
                    SET status = ?1,
                        output_json = COALESCE(?2, output_json),
                        error_message = ?3,
                        lease_owner = NULL,
                        lease_expires_at = NULL,
                        heartbeat_at = NULL,
                        completed_at = CASE WHEN ?1 = 'failed' THEN ?6 ELSE NULL END,
                        version = version + 1
                  WHERE id = ?4 AND run_id = ?5 AND status = 'running'",
                params![
                    next_status,
                    output_json,
                    payload.error_message,
                    payload.task_id,
                    payload.run_id,
                    lifecycle_at,
                ],
            )?;
            anyhow::ensure!(updated == 1, "task is not running");

            conn.execute(
                "UPDATE narrative_extraction_attempts
                    SET status = 'failed',
                        completed_at = ?3,
                        error_message = ?1,
                        output_json = COALESCE(?2, output_json)
                  WHERE id = ?4 AND task_id = ?5",
                params![
                    payload.error_message,
                    output_json,
                    lifecycle_at,
                    payload.attempt_id,
                    payload.task_id,
                ],
            )?;

            if requeue {
                maybe_complete_run(conn, &payload.run_id, &lifecycle_at)?;
            } else {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET status = 'failed',
                            completed_at = ?2,
                            outcome_summary_json = ?1,
                            version = version + 1
                      WHERE id = ?3 AND status = 'running'",
                    params![
                        json!({ "failedTaskId": payload.task_id }).to_string(),
                        lifecycle_at,
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

fn maybe_complete_run(conn: &Connection, run_id: &str, lifecycle_at: &str) -> anyhow::Result<()> {
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
                    completed_at = ?2,
                    version = version + 1
              WHERE id = ?1 AND status = 'running'",
            params![run_id, lifecycle_at],
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
                "SELECT p.id, p.proposal_set_id, p.proposal_key, p.kind, p.status, p.payload_json,
                        p.current_revision_id, p.created_at, p.updated_at,
                        r.origin_kind, r.reconciliation_envelope_digest
                   FROM narrative_proposals p
                   LEFT JOIN narrative_proposal_revisions r ON r.id = p.current_revision_id
                  WHERE p.proposal_set_id = ?1
                  ORDER BY p.created_at ASC, p.id ASC",
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
                                created_at, created_by, actor_kind, actor_id,
                                authority_scope, override_field_paths_json
                           FROM narrative_proposal_decisions
                          WHERE proposal_id = ?1
                          ORDER BY created_at DESC, id DESC
                          LIMIT 1",
                        params![proposal_id],
                        row_to_decision_value,
                    )
                    .optional()?;
                let application = conn
                    .query_row(
                        "SELECT commit_id, revision_id, applied_entity_kind,
                                applied_entity_id, created_at, application_kind,
                                compensates_application_id
                           FROM narrative_proposal_applications
                          WHERE proposal_id = ?1
                          ORDER BY created_at DESC, id DESC
                          LIMIT 1",
                        params![proposal_id],
                        |row| {
                            Ok(json!({
                                "commitId": row.get::<_, String>(0)?,
                                "revisionId": row.get::<_, String>(1)?,
                                "appliedEntityKind": row.get::<_, String>(2)?,
                                "appliedEntityId": row.get::<_, String>(3)?,
                                "createdAt": row.get::<_, String>(4)?,
                                "applicationKind": row.get::<_, String>(5)?,
                                "compensatesApplicationId": row.get::<_, Option<String>>(6)?,
                            }))
                        },
                    )
                    .optional()?;
                if let Some(obj) = proposal.as_object_mut() {
                    obj.insert("latestDecision".to_string(), json!(latest_decision));
                    obj.insert("application".to_string(), json!(application));
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
            require_narrative_extraction_allowed(conn)?;
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
                saved.push(insert_proposal_seed(
                    conn,
                    &proposal_set_id,
                    &payload.run_id,
                    &payload.project_id,
                    proposal,
                )?);
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
    run_id: &str,
    project_id: &str,
    seed: &ProposalSeed,
) -> anyhow::Result<Value> {
    let proposal_id = seed
        .proposal_id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let payload_json = serde_json::to_string(&seed.payload_json)?;
    let revision_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let validated_envelope = validate_reconciliation_envelope(
        conn,
        project_id,
        run_id,
        seed.reconciliation_envelope.as_ref(),
    )?;
    if let Some(envelope) = seed.reconciliation_envelope.as_ref() {
        validate_envelope_source_tokens(conn, project_id, run_id, envelope)?;
    }
    let origin_kind = if validated_envelope.is_some() {
        ORIGIN_ENVELOPED
    } else {
        ORIGIN_LEGACY_UNBOUND
    };
    let envelope_json = validated_envelope
        .as_ref()
        .map(|envelope| envelope.canonical_json.clone());
    let envelope_digest = validated_envelope
        .as_ref()
        .map(|envelope| envelope.digest.clone());

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
            (id, proposal_id, revision_number, payload_json, origin_kind,
             reconciliation_envelope_json, reconciliation_envelope_digest,
             created_at, created_by)
         VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, 'system')",
        params![
            revision_id,
            proposal_id,
            payload_json.clone(),
            origin_kind,
            envelope_json,
            envelope_digest,
            created_at,
        ],
    )?;
    if let Some(envelope) = validated_envelope.as_ref() {
        insert_source_basis_rows(conn, &revision_id, &envelope.source_basis)?;
    }
    record_revision_dependency_edges_in_tx(
        conn,
        project_id,
        run_id,
        &revision_id,
        validated_envelope
            .as_ref()
            .map(|envelope| envelope.source_basis.as_slice())
            .unwrap_or(&[]),
        &created_at,
    )?;

    Ok(json!({
        "proposalId": proposal_id,
        "proposalKey": seed.proposal_key,
        "revisionId": revision_id,
        "originKind": origin_kind,
        "reconciliationEnvelopeDigest": envelope_digest,
        "status": "unreviewed",
    }))
}

fn insert_source_basis_rows(
    conn: &Connection,
    revision_id: &str,
    rows: &[SourceBasisRow],
) -> anyhow::Result<()> {
    for row in rows {
        conn.execute(
            "INSERT INTO narrative_revision_source_basis
                (revision_id, ordinal, source_kind, source_key, revision_token, observed_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                revision_id,
                row.ordinal,
                row.source_kind,
                row.source_key,
                row.revision_token,
                row.observed_at,
            ],
        )?;
    }
    Ok(())
}

/// Producer-time Dependency Edge declaration (ADR 005 Amendment /
/// `dependency_edges.rs`): for every `SourceBasisRow` a Proposal's validated
/// Reconciliation Envelope carries, declares that *this Revision* read that
/// Source.
///
/// Consumer identity is `(PROPOSAL_REVISION_CONSUMER_KIND, revision_id)`
/// (Gate C2-2). It used to be `(RUN_CONSUMER_KIND, run_id)`, which is the
/// grain C2-2 exists to replace: every Proposal a Run produced shared one
/// Consumer, so editing one Scene staled all of them. A Revision is the
/// smallest durable unit that already exists here -- the row is immutable
/// once written and carries this same Source Basis in
/// `narrative_revision_source_basis`, so nothing has to be invented to key
/// an Edge to it.
///
/// The Run is still recorded, as `owning_run_id` (SCHEMA 30): it is what a
/// `snapshot:<runId>` Source of this Revision must name, and it stays true
/// after the Proposal is gone.
///
/// One Revision's Edges are its own, so unlike the Run-grained version this
/// no longer accumulates across siblings. It is still an upsert per Source
/// rather than a delete-then-redeclare: a Revision is immutable, so its
/// declared set does not shrink, and re-running the same Producer for the
/// same Revision must stay idempotent. `rows` empty (a legacy-unbound
/// Proposal/Revision with no envelope) is a no-op.
///
/// `read_set_json` per Edge is a one-element JSON array holding the
/// `SourceBasisRow`'s own `revision_token` -- the Reconciliation Envelope
/// has no field-path-level read-set below the whole-Source granularity
/// `sourceBasis` already validates, so this is the most specific true claim
/// available rather than a fabricated field list.
///
/// `row.source_key` is used directly as the Edge's `source_object_identity`
/// -- it is *not* run back through [`source_object_identity_for`]. By the
/// time this runs, `insert_proposal_seed` has already called
/// `validate_reconciliation_envelope` (which requires every `sourceBasis[].
/// sourceKey` to equal some `readSet[].inputRef`) and
/// `validate_envelope_source_tokens` (whose `resolve_source_revision` call
/// strips each source kind's own identity prefix, e.g. `project:scene:`,
/// off that same `inputRef`). So `row.source_key` already *is* the
/// fully-qualified identity `source_object_identity_for` would build --
/// re-deriving it here would prepend the prefix a second time and produce
/// an Edge no later resolver could ever match back to its real Source.
// NARRATIVE_DEPENDENCY_PRODUCER: proposal-revision-source-basis
fn record_revision_dependency_edges_in_tx(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    revision_id: &str,
    rows: &[SourceBasisRow],
    created_at: &str,
) -> anyhow::Result<()> {
    for row in rows {
        let source_object_identity =
            canonical_source_object_identity(&row.source_kind, &row.source_key)?;
        let read_set_json = serde_json::to_string(&[row.revision_token.as_str()])?;
        record_dependency_edge_in_tx(
            conn,
            project_id,
            PROPOSAL_REVISION_CONSUMER_KIND,
            revision_id,
            &source_object_identity,
            &read_set_json,
            None,
            // SCHEMA 30: the declaring Run, recorded rather than left to be
            // re-derived from `consumer_key` at read time.
            Some(run_id),
            created_at,
        )?;
    }
    Ok(())
}

pub fn append_revision(db: &Database, payload: AppendRevisionPayload) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            append_revision_on_conn(conn, &payload)
        })
    })
}

/// Append a new revision on an existing connection/transaction.
/// Callers own the surrounding `with_immediate_transaction` so this can be
/// composed atomically with other writes (see `revise_and_decide`).
fn append_revision_on_conn(
    conn: &Connection,
    payload: &AppendRevisionPayload,
) -> anyhow::Result<Value> {
    ensure_proposal_not_applied(conn, &payload.proposal_id)?;
    let payload_json = serde_json::to_string(&payload.payload_json)?;
    let revision_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let created_by = payload
        .created_by
        .clone()
        .unwrap_or_else(|| "user".to_string());

    ensure_run_project(conn, &payload.run_id, &payload.project_id)?;
    let (
        proposal_set_id,
        current_revision_id,
        current_origin_kind,
        current_envelope_json,
        current_envelope_digest,
    ): (String, String, String, Option<String>, Option<String>) = conn.query_row(
        "SELECT p.proposal_set_id, p.current_revision_id,
                r.origin_kind, r.reconciliation_envelope_json,
                r.reconciliation_envelope_digest
           FROM narrative_proposals p
           INNER JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
           LEFT JOIN narrative_proposal_revisions r ON r.id = p.current_revision_id
          WHERE p.id = ?1
            AND s.run_id = ?2
            AND s.project_id = ?3",
        params![payload.proposal_id, payload.run_id, payload.project_id],
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
    let _ = proposal_set_id;
    anyhow::ensure!(
        current_revision_id == payload.expected_current_revision_id,
        "NEX_PROPOSAL_REVISION_CONFLICT: expected current revision '{}', found '{}'",
        payload.expected_current_revision_id,
        current_revision_id
    );

    anyhow::ensure!(
        !(payload.reconciliation_envelope.is_some()
            && payload.inherit_reconciliation_envelope.is_some()),
        "NEX_REVISION_ENVELOPE_MODE_CONFLICT: supply an envelope or explicit inheritance, not both"
    );
    let inherited_envelope = if let Some(inherit) = payload.inherit_reconciliation_envelope.as_ref()
    {
        anyhow::ensure!(
            inherit.parent_revision_id == current_revision_id,
            "NEX_REVISION_ENVELOPE_PARENT_CONFLICT: inherit parent revision does not match current revision"
        );
        anyhow::ensure!(
            current_origin_kind == ORIGIN_ENVELOPED,
            "NEX_REVISION_ENVELOPE_INHERIT_UNAVAILABLE: current revision is not enveloped"
        );
        anyhow::ensure!(
            current_envelope_digest.as_deref() == Some(inherit.expected_envelope_digest.as_str()),
            "NEX_REVISION_ENVELOPE_INHERIT_CONFLICT: current envelope digest does not match expected digest"
        );
        Some(
            current_envelope_json
                .as_deref()
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "NEX_REVISION_ENVELOPE_INHERIT_MISSING: current envelope JSON is missing"
                    )
                })
                .and_then(|json| {
                    serde_json::from_str(json).context(
                        "NEX_REVISION_ENVELOPE_INHERIT_INVALID: current envelope JSON is invalid",
                    )
                })?,
        )
    } else {
        None
    };
    let envelope_input = payload
        .reconciliation_envelope
        .as_ref()
        .or(inherited_envelope.as_ref());
    let validated_envelope = validate_reconciliation_envelope(
        conn,
        &payload.project_id,
        &payload.run_id,
        envelope_input,
    )?;
    if let Some(envelope) = envelope_input {
        validate_envelope_source_tokens(conn, &payload.project_id, &payload.run_id, envelope)?;
    }
    let origin_kind = if validated_envelope.is_some() {
        ORIGIN_ENVELOPED
    } else {
        ORIGIN_LEGACY_UNBOUND
    };
    let envelope_json = validated_envelope
        .as_ref()
        .map(|envelope| envelope.canonical_json.clone());
    let envelope_digest = validated_envelope
        .as_ref()
        .map(|envelope| envelope.digest.clone());

    let next_revision: i64 = conn.query_row(
        "SELECT COALESCE(MAX(revision_number), 0) + 1
           FROM narrative_proposal_revisions
          WHERE proposal_id = ?1",
        params![payload.proposal_id],
        |row| row.get(0),
    )?;

    conn.execute(
        "INSERT INTO narrative_proposal_revisions
            (id, proposal_id, revision_number, payload_json, origin_kind,
             reconciliation_envelope_json, reconciliation_envelope_digest,
             created_at, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            revision_id,
            payload.proposal_id,
            next_revision,
            payload_json,
            origin_kind,
            envelope_json,
            envelope_digest,
            created_at,
            created_by,
        ],
    )?;
    if let Some(envelope) = validated_envelope.as_ref() {
        insert_source_basis_rows(conn, &revision_id, &envelope.source_basis)?;
    }
    record_revision_dependency_edges_in_tx(
        conn,
        &payload.project_id,
        &payload.run_id,
        &revision_id,
        validated_envelope
            .as_ref()
            .map(|envelope| envelope.source_basis.as_slice())
            .unwrap_or(&[]),
        &created_at,
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
        "originKind": origin_kind,
        "reconciliationEnvelopeDigest": envelope_digest,
        "status": "unreviewed",
    }))
}

pub fn append_decision(db: &Database, payload: AppendDecisionPayload) -> anyhow::Result<Value> {
    append_decision_with_actor(
        db,
        payload,
        TrustedDecisionActor::Automated {
            actor_id: "electron:automated-review".to_string(),
        },
    )
}

pub fn append_human_decision(
    db: &Database,
    payload: AppendDecisionPayload,
) -> anyhow::Result<Value> {
    append_decision_with_actor(
        db,
        payload,
        TrustedDecisionActor::Human {
            actor_id: "electron:human-review".to_string(),
        },
    )
}

fn append_decision_with_actor(
    db: &Database,
    payload: AppendDecisionPayload,
    actor: TrustedDecisionActor,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            append_decision_on_conn(conn, &payload, &actor)
        })
    })
}

/// Append a decision on an existing connection/transaction.
/// Callers own the surrounding `with_immediate_transaction` so this can be
/// composed atomically with a preceding revision (see `revise_and_decide`).
fn append_decision_on_conn(
    conn: &Connection,
    payload: &AppendDecisionPayload,
    actor: &TrustedDecisionActor,
) -> anyhow::Result<Value> {
    ensure_proposal_not_applied(conn, &payload.proposal_id)?;
    let decision_value = payload
        .decision_json
        .clone()
        .unwrap_or_else(default_object_json);
    let decision_json = serde_json::to_string(&decision_value)?;
    let decision_id = Uuid::new_v4().to_string();
    let created_at = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let created_by = payload
        .created_by
        .clone()
        .unwrap_or_else(|| "user".to_string());
    let proposal_status = map_decision_to_status(&payload.decision)?;

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
    let authority = derive_decision_authority(
        actor,
        &payload.project_id,
        &payload.proposal_id,
        &payload.revision_id,
        &decision_value,
    )?;

    conn.execute(
        "INSERT INTO narrative_proposal_decisions
            (id, proposal_id, revision_id, decision, decision_json, created_at, created_by,
             actor_kind, actor_id, authority_scope, override_field_paths_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            decision_id,
            payload.proposal_id,
            payload.revision_id,
            payload.decision,
            decision_json,
            created_at,
            created_by,
            authority.actor_kind,
            authority.actor_id,
            authority.authority_scope,
            serde_json::to_string(&authority.override_field_paths)?,
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
}

/// Atomically append a revision then a decision that references the new revision.
/// One `with_immediate_transaction` guards both writes, so an approve can never
/// leave a fresh revision without its decision (or vice versa).
pub fn revise_and_decide(db: &Database, payload: ReviseAndDecidePayload) -> anyhow::Result<Value> {
    revise_and_decide_with_actor(
        db,
        payload,
        TrustedDecisionActor::Automated {
            actor_id: "electron:automated-review".to_string(),
        },
    )
}

pub fn revise_and_decide_as_human(
    db: &Database,
    payload: ReviseAndDecidePayload,
) -> anyhow::Result<Value> {
    revise_and_decide_with_actor(
        db,
        payload,
        TrustedDecisionActor::Human {
            actor_id: "electron:human-review".to_string(),
        },
    )
}

fn revise_and_decide_with_actor(
    db: &Database,
    payload: ReviseAndDecidePayload,
    actor: TrustedDecisionActor,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            require_narrative_extraction_allowed(conn)?;
            let revision_payload = AppendRevisionPayload {
                run_id: payload.run_id.clone(),
                project_id: payload.project_id.clone(),
                proposal_id: payload.proposal_id.clone(),
                payload_json: payload.payload_json.clone(),
                expected_current_revision_id: payload.expected_current_revision_id.clone(),
                created_by: payload.created_by.clone(),
                reconciliation_envelope: payload.reconciliation_envelope.clone(),
                inherit_reconciliation_envelope: payload.inherit_reconciliation_envelope.clone(),
            };
            let revision = append_revision_on_conn(conn, &revision_payload)?;
            let revision_id = revision["revisionId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("revise_and_decide: missing revisionId"))?
                .to_string();
            let revision_number = revision["revisionNumber"].clone();

            let decision_payload = AppendDecisionPayload {
                run_id: payload.run_id.clone(),
                project_id: payload.project_id.clone(),
                proposal_id: payload.proposal_id.clone(),
                revision_id: revision_id.clone(),
                decision: payload.decision.clone(),
                decision_json: payload.decision_json.clone(),
                created_by: payload.created_by.clone(),
            };
            let decision = append_decision_on_conn(conn, &decision_payload, &actor)?;
            let decision_id = decision["decisionId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("revise_and_decide: missing decisionId"))?
                .to_string();

            Ok(json!({
                "proposalId": payload.proposal_id,
                "revisionId": revision_id,
                "revisionNumber": revision_number,
                "decisionId": decision_id,
                "decision": payload.decision,
                "status": decision["status"].clone(),
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
        "originKind": row.get::<_, Option<String>>("origin_kind")?,
        "reconciliationEnvelopeDigest": row.get::<_, Option<String>>("reconciliation_envelope_digest")?,
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
        "actorKind": row.get::<_, String>("actor_kind")?,
        "actorId": row.get::<_, String>("actor_id")?,
        "authorityScope": row.get::<_, String>("authority_scope")?,
        "overrideFieldPaths": parse_json_column(row.get::<_, String>("override_field_paths_json")?)?,
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
            plan_fragment_json TEXT,
            plan_fragment_digest TEXT,
            origin_kind TEXT NOT NULL DEFAULT 'legacy-unbound',
            reconciliation_envelope_json TEXT,
            reconciliation_envelope_digest TEXT,
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_revision_source_basis (
            revision_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            source_kind TEXT NOT NULL,
            source_key TEXT NOT NULL,
            revision_token TEXT NOT NULL,
            observed_at TEXT,
            PRIMARY KEY (revision_id, ordinal),
            UNIQUE (revision_id, source_key)
        );
        CREATE TABLE IF NOT EXISTS narrative_projection_freshness (
            application_id TEXT PRIMARY KEY,
            status TEXT NOT NULL
                CHECK(status IN ('fresh','stale','source-missing','anchor-mismatch','read-set-drift')),
            reason_json TEXT,
            version INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS narrative_projection_dependencies (
            application_id TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            source_key TEXT NOT NULL,
            observed_revision_token TEXT NOT NULL,
            propagation TEXT NOT NULL CHECK(propagation = 'freshness-only'),
            PRIMARY KEY (application_id, source_kind, source_key)
        );
        CREATE TABLE IF NOT EXISTS narrative_field_authority (
            project_id TEXT NOT NULL,
            entity_kind TEXT NOT NULL,
            entity_id TEXT NOT NULL,
            field_path TEXT NOT NULL,
            owner_kind TEXT NOT NULL
                CHECK(owner_kind IN ('human','ai','system','unknown')),
            explicit_lock INTEGER NOT NULL DEFAULT 0
                CHECK(explicit_lock IN (0,1)),
            version INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (project_id, entity_kind, entity_id, field_path)
        );
        CREATE INDEX IF NOT EXISTS idx_narrative_field_authority_entity
            ON narrative_field_authority(project_id, entity_kind, entity_id);
        CREATE TABLE IF NOT EXISTS narrative_proposal_decisions (
            id TEXT PRIMARY KEY,
            proposal_id TEXT NOT NULL,
            revision_id TEXT NOT NULL,
            decision TEXT NOT NULL,
            decision_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            actor_kind TEXT NOT NULL DEFAULT 'human',
            actor_id TEXT NOT NULL DEFAULT 'legacy-review',
            authority_scope TEXT NOT NULL DEFAULT 'legacy-review',
            override_field_paths_json TEXT NOT NULL DEFAULT '[]'
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
            prepared_plan_json TEXT,
            prepared_policy_version INTEGER,
            prepared_at TEXT,
            authority_digest TEXT,
            session_id TEXT,
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
            created_at TEXT NOT NULL,
            application_kind TEXT NOT NULL DEFAULT 'normal'
                CHECK(application_kind IN ('normal','compensation')),
            compensates_application_id TEXT,
            CHECK (
                (application_kind = 'normal' AND compensates_application_id IS NULL)
                OR
                (application_kind = 'compensation' AND compensates_application_id IS NOT NULL)
            )
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_narrative_compensation_target
            ON narrative_proposal_applications(compensates_application_id)
            WHERE application_kind = 'compensation'
              AND compensates_application_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS narrative_commit_journals (
            id TEXT PRIMARY KEY,
            commit_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            before_json TEXT,
            after_json TEXT,
            created_at TEXT NOT NULL
        );",
    )?;
    conn.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS narrative_revision_immutable_after_apply_update
            BEFORE UPDATE ON narrative_proposal_revisions
            WHEN EXISTS(
                SELECT 1 FROM narrative_proposal_applications WHERE revision_id = OLD.id
            )
            BEGIN SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLIED_REVISION'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_revision_envelope_immutable_update
            BEFORE UPDATE ON narrative_proposal_revisions
            WHEN OLD.origin_kind IS NOT NEW.origin_kind
              OR OLD.reconciliation_envelope_json IS NOT NEW.reconciliation_envelope_json
              OR OLD.reconciliation_envelope_digest IS NOT NEW.reconciliation_envelope_digest
            BEGIN SELECT RAISE(ABORT, 'NEX_REVISION_ENVELOPE_IMMUTABLE'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_source_basis_immutable_update
            BEFORE UPDATE ON narrative_revision_source_basis
            BEGIN SELECT RAISE(ABORT, 'NEX_REVISION_SOURCE_BASIS_IMMUTABLE'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_source_basis_immutable_delete
            BEFORE DELETE ON narrative_revision_source_basis
            WHEN EXISTS(
                SELECT 1 FROM narrative_proposal_applications
                 WHERE revision_id = OLD.revision_id
            )
            BEGIN SELECT RAISE(ABORT, 'NEX_REVISION_SOURCE_BASIS_IMMUTABLE'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_revision_immutable_after_apply_delete
            BEFORE DELETE ON narrative_proposal_revisions
            WHEN EXISTS(
                SELECT 1 FROM narrative_proposal_applications WHERE revision_id = OLD.id
            )
            BEGIN SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLIED_REVISION'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_decision_immutable_after_apply_update
            BEFORE UPDATE ON narrative_proposal_decisions
            WHEN EXISTS(
                SELECT 1 FROM narrative_proposal_applications
                 WHERE proposal_id = OLD.proposal_id AND revision_id = OLD.revision_id
            )
            BEGIN SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLIED_DECISION'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_decision_immutable_after_apply_delete
            BEFORE DELETE ON narrative_proposal_decisions
            WHEN EXISTS(
                SELECT 1 FROM narrative_proposal_applications
                 WHERE proposal_id = OLD.proposal_id AND revision_id = OLD.revision_id
            )
            BEGIN SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLIED_DECISION'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_application_immutable_update
            BEFORE UPDATE ON narrative_proposal_applications
            BEGIN SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLICATION'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_application_immutable_delete
            BEFORE DELETE ON narrative_proposal_applications
            BEGIN SELECT RAISE(ABORT, 'NEX_IMMUTABLE_APPLICATION'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_application_kind_guard
            BEFORE INSERT ON narrative_proposal_applications
            WHEN NEW.application_kind NOT IN ('normal','compensation')
            BEGIN SELECT RAISE(ABORT, 'NEX_APPLICATION_KIND_INVALID'); END;
        CREATE TRIGGER IF NOT EXISTS narrative_application_compensation_guard
            BEFORE INSERT ON narrative_proposal_applications
            WHEN (NEW.application_kind = 'normal' AND NEW.compensates_application_id IS NOT NULL)
              OR (NEW.application_kind = 'compensation' AND NEW.compensates_application_id IS NULL)
            BEGIN SELECT RAISE(ABORT, 'NEX_APPLICATION_COMPENSATION_SHAPE_INVALID'); END;",
    )?;
    Ok(())
}

#[cfg(test)]
mod unit_tests {
    use super::super::{transition_run_status_in_tx, ClaimTaskPayload, NarrativeRunStatus};
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

    /// `ensure_test_schema` above is a hand-rolled, deliberately narrow
    /// schema subset for fast isolated tests -- it has no `tree_nodes` and
    /// no Gate C2 tables (`narrative_dependency_edges`, ...). Tests that
    /// exercise a real Reconciliation Envelope's `sourceBasis` (which
    /// re-resolves Source revisions against real domain tables, e.g.
    /// `scene-body` against `tree_nodes`) or Dependency Edge recording need
    /// the full real migration instead, matching every `tests/*.rs`
    /// integration test's own `migrated_db()` helper.
    fn full_migrated_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate");
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

    fn insert_automatic_run_for_api_test(db: &Database, run_id: &str, run_kind: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_extraction_runs
                    (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                     status, coverage_json, created_at, started_at, run_kind,
                     semantic_epoch_id, work_key, version)
                 VALUES (?1, 'project-1', ?2, '{}', '{}', 'digest', 'running', '{}',
                         '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z', ?2,
                         NULL, ?1, 0)",
                params![run_id, run_kind],
            )?;
            if run_kind == "freshness-evaluation" {
                conn.execute(
                    "UPDATE narrative_extraction_runs
                        SET consumer_id = ?2 WHERE id = ?1",
                    params![run_id, INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID],
                )?;
            }
            Ok(())
        })
        .expect("insert automatic Run");
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

    #[test]
    fn create_run_rejects_noncanonical_run_ids_before_persisting() {
        let db = test_db();
        for run_id in ["", "   ", " run-1", "run-1 ", "snapshot:run-1"] {
            let error = create_run(
                &db,
                CreateRunPayload {
                    run_id: Some(run_id.to_string()),
                    project_id: "project-1".to_string(),
                    surface_path_id: "chronicle.extract".to_string(),
                    scope_json: json!({}),
                    spec_json: json!({}),
                    spec_digest: "digest-1".to_string(),
                    snapshot_digest: None,
                    catalog_digest: None,
                    registry_digest: None,
                    coverage_json: None,
                    tasks: vec![],
                },
            )
            .expect_err("a noncanonical runId must fail closed");
            assert!(
                error.to_string().contains("NEX_RUN_ID_INVALID"),
                "unexpected error for {run_id:?}: {error}"
            );
        }

        let persisted: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_extraction_runs",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count persisted Runs");
        assert_eq!(persisted, 0);
    }

    #[test]
    fn generic_task_api_rejects_every_runtime_owned_automatic_run_kind() {
        let db = full_migrated_db();
        for (index, run_kind) in [
            "freshness-evaluation",
            "backfill",
            "dependency-verify",
            "semantic-index-rebuild",
        ]
        .into_iter()
        .enumerate()
        {
            let run_id = format!("automatic-run-{index}");
            db.with_conn(|conn| {
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, created_at, started_at, run_kind,
                         semantic_epoch_id, work_key, version)
                     VALUES (?1, 'project-1', ?2, '{}', '{}', 'digest', 'running', '{}',
                             '2026-08-23T10:00:00.000Z', '2026-08-23T10:00:00.000Z', ?2,
                             NULL, ?1, 0)",
                    params![run_id, run_kind],
                )?;
                if run_kind == "freshness-evaluation" {
                    conn.execute(
                        "UPDATE narrative_extraction_runs
                            SET consumer_id = ?2 WHERE id = ?1",
                        params![run_id, INCREMENTAL_FRESHNESS_CURSOR_CONSUMER_ID],
                    )?;
                }
                let error = ensure_generic_task_api_allowed(conn, &run_id)
                    .expect_err("generic lifecycle APIs must not own automatic Runs");
                assert!(
                    error.to_string().contains("NEX_SYSTEM_RUN_API_FORBIDDEN"),
                    "unexpected error for {run_kind}: {error}"
                );
                Ok(())
            })
            .expect("automatic Run authority guard");
        }
    }

    #[test]
    fn every_generic_public_task_api_rejects_runtime_owned_automatic_runs() {
        let db = full_migrated_db();
        let assert_forbidden = |result: anyhow::Result<Value>| {
            let error = result.expect_err("automatic Run must be owned by its runtime");
            assert!(
                error.to_string().contains("NEX_SYSTEM_RUN_API_FORBIDDEN"),
                "unexpected generic API error: {error}"
            );
        };

        for (index, run_kind) in [
            "freshness-evaluation",
            "backfill",
            "dependency-verify",
            "semantic-index-rebuild",
        ]
        .into_iter()
        .enumerate()
        {
            let run_id = format!("automatic-public-api-{index}");
            insert_automatic_run_for_api_test(&db, &run_id, run_kind);

            assert_forbidden(cancel_run(&db, run_id.clone(), "project-1".to_string()));
            assert_forbidden(claim_task(
                &db,
                ClaimTaskPayload {
                    run_id: run_id.clone(),
                    project_id: "project-1".to_string(),
                    lease_owner: "generic-api-test".to_string(),
                    lease_duration_secs: None,
                    task_kinds: None,
                },
            ));
            assert_forbidden(finish_task(
                &db,
                FinishTaskPayload {
                    run_id: run_id.clone(),
                    project_id: "project-1".to_string(),
                    task_id: "not-owned-task".to_string(),
                    attempt_id: "not-owned-attempt".to_string(),
                    lease_owner: "generic-api-test".to_string(),
                    output_json: None,
                    artifacts: vec![],
                },
            ));
            assert_forbidden(fail_task(
                &db,
                FailTaskPayload {
                    run_id: run_id.clone(),
                    project_id: "project-1".to_string(),
                    task_id: "not-owned-task".to_string(),
                    attempt_id: "not-owned-attempt".to_string(),
                    lease_owner: "generic-api-test".to_string(),
                    error_message: "generic API must not own this Run".to_string(),
                    output_json: None,
                    requeue: Some(false),
                },
            ));

            let (status, completed_at): (String, Option<String>) = db
                .with_conn(|conn| {
                    conn.query_row(
                        "SELECT status, completed_at
                           FROM narrative_extraction_runs WHERE id = ?1",
                        params![run_id],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .map_err(Into::into)
                })
                .expect("read guarded automatic Run");
            assert_eq!(status, "running");
            assert_eq!(completed_at, None);
        }
    }

    #[test]
    fn automatic_owner_finalizer_wins_backfill_and_rebuild_interleaving() {
        let db = full_migrated_db();
        let epoch_id = seed_epoch(&db, "project-1");
        for (index, (run_kind, work_key)) in [
            ("backfill", "backfill-phase-gap"),
            ("semantic-index-rebuild", "rebuild-phase-gap"),
        ]
        .into_iter()
        .enumerate()
        {
            let created = create_system_run(
                &db,
                "project-1",
                run_kind,
                &epoch_id,
                work_key,
                &json!({ "phase": "committed-before-finalize" }),
                "system-spec-digest",
                if run_kind == "backfill" {
                    SystemRunWorkKeyReuse::RunningAndCompleted
                } else {
                    SystemRunWorkKeyReuse::RunningOnly
                },
                None,
            )
            .expect("create owner Run");
            let run_id = created["runId"].as_str().expect("owner Run id").to_string();

            let generic_error = cancel_run(&db, run_id.clone(), "project-1".to_string())
                .expect_err("generic cancellation must lose the phase-gap race");
            assert!(generic_error
                .to_string()
                .contains("NEX_SYSTEM_RUN_API_FORBIDDEN"));

            db.with_conn(|conn| {
                with_immediate_transaction(conn, |conn| {
                    transition_run_status_in_tx(conn, &run_id, NarrativeRunStatus::Completed)?;
                    record_run_outcome_in_tx(
                        conn,
                        &run_id,
                        &json!({ "phase": "committed-before-finalize", "owner": true }),
                    )?;
                    Ok(())
                })
            })
            .expect("owner finalizer completes atomically");

            let (status, completed_at, outcome): (String, String, String) = db
                .with_conn(|conn| {
                    conn.query_row(
                        "SELECT status, completed_at, outcome_summary_json
                           FROM narrative_extraction_runs WHERE id = ?1",
                        params![run_id],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    )
                    .map_err(Into::into)
                })
                .expect("read owner-finalized Run");
            assert_eq!(
                status, "completed",
                "owner Run {index} must remain authoritative"
            );
            assert!(completed_at.ends_with('Z'));
            assert!(outcome.contains("committed-before-finalize"));
        }
    }

    #[test]
    fn generic_cancel_persists_millisecond_timestamp_for_resumable_ordering() {
        let db = full_migrated_db();
        create_run(
            &db,
            CreateRunPayload {
                run_id: Some("manual-run-1".to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: "chronicle.extract".to_string(),
                scope_json: json!({}),
                spec_json: json!({}),
                spec_digest: "digest-1".to_string(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![],
            },
        )
        .expect("create pending manual Run");

        cancel_run(&db, "manual-run-1".to_string(), "project-1".to_string())
            .expect("cancel pending manual Run");

        let completed_at: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT completed_at FROM narrative_extraction_runs WHERE id = 'manual-run-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read cancelled Run timestamp");
        assert!(
            completed_at.ends_with('Z') && completed_at.contains('.'),
            "Run lifecycle timestamps must be RFC3339 with milliseconds: {completed_at}"
        );
    }

    #[test]
    fn list_resumable_runs_orders_mixed_legacy_and_rfc3339_instants() {
        let db = full_migrated_db();
        db.with_conn(|conn| {
            for (run_id, status, created_at, started_at, completed_at) in [
                (
                    "run-legacy-space",
                    "running",
                    "2026-08-23 09:59:00",
                    Some("2026-08-23 10:00:00"),
                    None,
                ),
                (
                    "run-rfc3339-millis",
                    "completed",
                    "2026-08-23T09:58:00.000Z",
                    Some("2026-08-23T09:58:00.000Z"),
                    Some("2026-08-23T09:59:59.900Z"),
                ),
            ] {
                conn.execute(
                    "INSERT INTO narrative_extraction_runs
                        (id, project_id, surface_path_id, scope_json, spec_json, spec_digest,
                         status, coverage_json, created_at, started_at, completed_at, version)
                     VALUES (?1, 'project-1', 'chronicle.extract', '{}', '{}', 'digest',
                             ?2, '{}', ?3, ?4, ?5, 0)",
                    params![run_id, status, created_at, started_at, completed_at],
                )?;
            }
            Ok(())
        })
        .expect("insert mixed timestamp Runs");

        for run_id in ["run-legacy-space", "run-rfc3339-millis"] {
            save_proposal_set(
                &db,
                SaveProposalSetPayload {
                    run_id: run_id.to_string(),
                    project_id: "project-1".to_string(),
                    proposal_set_id: Some(format!("set-{run_id}")),
                    set_kind: "chronicle.extract.review@1".to_string(),
                    summary_json: None,
                    proposals: vec![ProposalSeed {
                        proposal_id: Some(format!("proposal-{run_id}")),
                        proposal_key: format!("key-{run_id}"),
                        kind: "chronicle.event.create@1".to_string(),
                        payload_json: json!({ "title": run_id }),
                        reconciliation_envelope: None,
                    }],
                },
            )
            .expect("insert resumable ProposalSet");
        }

        let listed = list_resumable_runs(
            &db,
            ListResumableRunsPayload {
                project_id: "project-1".to_string(),
                surface_path_id: None,
                limit: Some(10),
            },
        )
        .expect("list mixed timestamp Runs");
        let run_ids: Vec<&str> = listed
            .as_array()
            .expect("resumable list")
            .iter()
            .map(|run| run["runId"].as_str().expect("runId"))
            .collect();
        assert_eq!(
            run_ids,
            vec!["run-legacy-space", "run-rfc3339-millis"],
            "ordering must compare instants, not the legacy space versus RFC3339 separator"
        );
    }

    /// Inserts a minimal `tree_nodes` scene row so `scene_body_envelope`
    /// below can build an envelope whose `sourceBasis`/`readSet`
    /// `revisionToken` actually matches what
    /// `source_revision::resolve_source_revision`'s `scene-body` resolver
    /// (`format!("v{version}@{updated_at}")`) will independently compute --
    /// `validate_envelope_source_tokens` re-resolves and compares against
    /// this live row, so a fabricated token would fail closed.
    fn seed_scene(db: &Database, scene_id: &str) {
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes (id, project_id, node_type, title, version)
                 VALUES (?1, 'project-1', 'scene', 'Scene', 0)",
                params![scene_id],
            )?;
            Ok(())
        })
        .expect("seed scene");
    }

    fn scene_body_envelope(db: &Database, run_id: &str, task_id: &str, scene_id: &str) -> Value {
        use super::super::commit::digest_plan;
        let (version, updated_at): (i64, String) = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT version, updated_at FROM tree_nodes
                      WHERE id = ?1 AND project_id = 'project-1'",
                    params![scene_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(Into::into)
            })
            .expect("scene source revision");
        // `sourceBasis[].sourceKey` must equal this same Source's
        // `readSet[].inputRef` (`validate_reconciliation_envelope`'s
        // NEX_ENVELOPE_SOURCE_BASIS_NOT_READ check), and `resolve_scene_body`
        // requires that shared value to already carry the `project:scene:`
        // prefix -- `record_revision_dependency_edges_in_tx` uses it verbatim as
        // the Edge's `source_object_identity`, so one prefixed value serves
        // both fields.
        let source_key = format!("project:scene:{scene_id}");
        let revision_token = format!("v{version}@{updated_at}");
        let read_set = json!([{
            "kind": "snapshot-document",
            "inputRef": source_key.clone(),
            "sourceKind": "scene-body",
            "revisionToken": revision_token.clone()
        }]);
        json!({
            "changeKind": "revise",
            "readSetDigest": format!("sha256:{}", digest_plan(&read_set)),
            "readSet": read_set,
            "evidenceSet": [],
            "sourceBasis": [{
                "revisionToken": revision_token,
                "sourceKey": source_key,
                "sourceKind": "scene-body"
            }],
            "proposalSchemaVersion": "1",
            "proposalSchemaId": "chronicle.event",
            "reconcilerVersion": "1.0.0",
            "reconcilerId": "test.reconciler",
            "taskId": task_id,
            "runId": run_id,
            "schemaVersion": 1
        })
    }

    /// Gate C2-2's exit criterion, as a test. This deliberately replaces
    /// `saving_proposals_declares_dependency_edges_under_the_owning_run`,
    /// which asserted the opposite -- that two sibling Proposals' Edges land
    /// under one Run Consumer -- and so pinned the very grain C2-2 exists to
    /// replace.
    #[test]
    fn saving_proposals_declares_dependency_edges_per_revision_not_per_run() {
        use super::super::dependency_edges::{
            find_edges_by_consumer, PROPOSAL_REVISION_CONSUMER_KIND,
        };

        let db = full_migrated_db();
        create_run(
            &db,
            CreateRunPayload {
                run_id: Some("run-1".to_string()),
                project_id: "project-1".to_string(),
                surface_path_id: "chronicle.extract".to_string(),
                scope_json: json!({}),
                spec_json: json!({ "domain": "chronicle" }),
                spec_digest: "digest-1".to_string(),
                snapshot_digest: None,
                catalog_digest: None,
                registry_digest: None,
                coverage_json: None,
                tasks: vec![CreateTaskSeed {
                    task_id: Some("task-1".to_string()),
                    task_kind: "plan_windows".to_string(),
                    input_json: None,
                    priority: None,
                }],
            },
        )
        .expect("create run");
        seed_scene(&db, "scene-1");
        seed_scene(&db, "scene-2");

        // Two sibling Proposals in one Proposal Set, each reading a
        // different Source.
        let envelope_1 = scene_body_envelope(&db, "run-1", "task-1", "scene-1");
        let envelope_2 = scene_body_envelope(&db, "run-1", "task-1", "scene-2");
        save_proposal_set(
            &db,
            SaveProposalSetPayload {
                run_id: "run-1".to_string(),
                project_id: "project-1".to_string(),
                proposal_set_id: Some("set-1".to_string()),
                set_kind: "chronicle.extract.review@1".to_string(),
                summary_json: None,
                proposals: vec![
                    ProposalSeed {
                        proposal_id: Some("proposal-1".to_string()),
                        proposal_key: "key-1".to_string(),
                        kind: "chronicle.event.create@1".to_string(),
                        payload_json: json!({ "title": "A" }),
                        reconciliation_envelope: Some(envelope_1),
                    },
                    ProposalSeed {
                        proposal_id: Some("proposal-2".to_string()),
                        proposal_key: "key-2".to_string(),
                        kind: "chronicle.event.create@1".to_string(),
                        payload_json: json!({ "title": "B" }),
                        reconciliation_envelope: Some(envelope_2),
                    },
                ],
            },
        )
        .expect("save proposal set");

        // Nothing is declared under the Run any more.
        let run_edges = db
            .with_conn(|conn| {
                find_edges_by_consumer(conn, "project-1", "narrative-extraction-run", "run-1")
            })
            .expect("find edges by run consumer");
        assert!(
            run_edges.is_empty(),
            "the Run is no longer the Consumer of its Proposals' reads"
        );

        // Each sibling's read belongs to its own Revision, so staling one
        // cannot reach the other -- the whole point of the re-key.
        let revisions = db
            .with_conn(|conn| {
                let mut statement = conn.prepare(
                    "SELECT p.id, r.id FROM narrative_proposals p
                       JOIN narrative_proposal_revisions r ON r.id = p.current_revision_id
                      WHERE p.proposal_set_id = 'set-1'
                      ORDER BY p.id ASC",
                )?;
                let rows = statement
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .expect("read the two Revisions");
        assert_eq!(revisions.len(), 2);

        let mut seen = Vec::new();
        for (proposal_id, revision_id) in &revisions {
            let edges = db
                .with_conn(|conn| {
                    find_edges_by_consumer(
                        conn,
                        "project-1",
                        PROPOSAL_REVISION_CONSUMER_KIND,
                        revision_id,
                    )
                })
                .expect("find edges by revision consumer");
            assert_eq!(
                edges.len(),
                1,
                "{proposal_id}'s Revision must declare exactly its own read"
            );
            assert_eq!(
                edges[0].owning_run_id.as_deref(),
                Some("run-1"),
                "the declaring Run is still recorded, as provenance"
            );
            assert!(edges[0].read_set_json.starts_with(r#"["v0@"#));
            seen.push(edges[0].source_object_identity.clone());
        }
        seen.sort();
        assert_eq!(
            seen,
            vec![
                "project:scene:scene-1".to_string(),
                "project:scene:scene-2".to_string()
            ],
            "between them the two Revisions still cover both Sources"
        );

        // A legacy-unbound Proposal (no envelope) in the same Run must not
        // fail or declare any Edge.
        save_proposal_set(
            &db,
            SaveProposalSetPayload {
                run_id: "run-1".to_string(),
                project_id: "project-1".to_string(),
                proposal_set_id: Some("set-2".to_string()),
                set_kind: "chronicle.extract.review@1".to_string(),
                summary_json: None,
                proposals: vec![ProposalSeed {
                    proposal_id: Some("proposal-3".to_string()),
                    proposal_key: "key-3".to_string(),
                    kind: "chronicle.event.create@1".to_string(),
                    payload_json: json!({ "title": "C" }),
                    reconciliation_envelope: None,
                }],
            },
        )
        .expect("save legacy-unbound proposal set");

        let total_after: i64 = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM narrative_dependency_edges WHERE project_id = 'project-1'",
                    [],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("count edges after the legacy-unbound proposal");
        assert_eq!(
            total_after, 2,
            "a legacy-unbound Proposal has no envelope, so it declares nothing and \
             disturbs no sibling Revision's Edges"
        );
    }

    fn seed_epoch(db: &Database, project_id: &str) -> String {
        db.with_conn(|conn| super::super::create_epoch_in_tx(conn, project_id, "initial", None))
            .expect("create epoch")
    }

    #[test]
    fn create_system_run_writes_kind_epoch_and_work_key() {
        let db = full_migrated_db();
        let epoch_id = seed_epoch(&db, "project-1");

        let created = create_system_run(
            &db,
            "project-1",
            "dependency-verify",
            &epoch_id,
            "verify-work-key",
            &json!({ "graphContractDigest": "digest-graph-1" }),
            "spec-digest-1",
            SystemRunWorkKeyReuse::RunningOnly,
            None,
        )
        .expect("create system run");
        assert_eq!(created["status"], "running");
        assert_eq!(created["reused"], false);
        let run_id = created["runId"].as_str().expect("runId").to_string();

        let (run_kind, semantic_epoch_id, work_key, spec_digest): (String, String, String, String) =
            db.with_conn(|conn| {
                conn.query_row(
                    "SELECT run_kind, semantic_epoch_id, work_key, spec_digest
                       FROM narrative_extraction_runs WHERE id = ?1",
                    params![run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .map_err(Into::into)
            })
            .expect("read created run");
        assert_eq!(run_kind, "dependency-verify");
        assert_eq!(semantic_epoch_id, epoch_id);
        assert_eq!(work_key, "verify-work-key");
        assert_eq!(spec_digest, "spec-digest-1");
    }

    #[test]
    fn create_system_run_running_only_reuses_running_but_not_completed() {
        let db = full_migrated_db();
        let epoch_id = seed_epoch(&db, "project-1");
        let spec = json!({});

        let first = create_system_run(
            &db,
            "project-1",
            "semantic-index-rebuild",
            &epoch_id,
            "rebuild-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::RunningOnly,
            None,
        )
        .expect("create first run");
        assert_eq!(first["reused"], false);

        // A second request against the same work_key while the first is
        // still 'running' must reuse it, not create a duplicate.
        let second = create_system_run(
            &db,
            "project-1",
            "semantic-index-rebuild",
            &epoch_id,
            "rebuild-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::RunningOnly,
            None,
        )
        .expect("create second run");
        assert_eq!(second["reused"], true);
        assert_eq!(second["runId"], first["runId"]);

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs SET status = 'completed' WHERE id = ?1",
                params![first["runId"].as_str().expect("runId")],
            )?;
            Ok(())
        })
        .expect("mark first run completed");

        // RunningOnly must not reuse a completed Run: a fresh rebuild
        // request after the prior one finished must be able to run again.
        let third = create_system_run(
            &db,
            "project-1",
            "semantic-index-rebuild",
            &epoch_id,
            "rebuild-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::RunningOnly,
            None,
        )
        .expect("create third run");
        assert_eq!(third["reused"], false);
        assert_ne!(third["runId"], first["runId"]);
    }

    #[test]
    fn create_system_run_running_and_completed_reuses_a_completed_run() {
        let db = full_migrated_db();
        let epoch_id = seed_epoch(&db, "project-1");
        let spec = json!({});

        let first = create_system_run(
            &db,
            "project-1",
            "backfill",
            &epoch_id,
            "backfill-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::RunningAndCompleted,
            None,
        )
        .expect("create first run");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE narrative_extraction_runs SET status = 'completed' WHERE id = ?1",
                params![first["runId"].as_str().expect("runId")],
            )?;
            Ok(())
        })
        .expect("mark first run completed");

        // dependency-backfill's automatic-once trigger firing again after
        // the prior attempt already completed must not create a second Run.
        let second = create_system_run(
            &db,
            "project-1",
            "backfill",
            &epoch_id,
            "backfill-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::RunningAndCompleted,
            None,
        )
        .expect("create second run");
        assert_eq!(second["reused"], true);
        assert_eq!(second["runId"], first["runId"]);
    }

    #[test]
    fn create_system_run_none_reuse_never_dedups() {
        let db = full_migrated_db();
        let epoch_id = seed_epoch(&db, "project-1");
        let spec = json!({});

        let first = create_system_run(
            &db,
            "project-1",
            "dependency-repair",
            &epoch_id,
            "repair-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::None,
            None,
        )
        .expect("create first run");
        let second = create_system_run(
            &db,
            "project-1",
            "dependency-repair",
            &epoch_id,
            "repair-work-key",
            &spec,
            "d1",
            SystemRunWorkKeyReuse::None,
            None,
        )
        .expect("create second run");
        assert_eq!(first["reused"], false);
        assert_eq!(second["reused"], false);
        assert_ne!(first["runId"], second["runId"]);
    }
}
