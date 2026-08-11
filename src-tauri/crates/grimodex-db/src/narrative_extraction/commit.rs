//! Atomic narrative apply commit engine (prepare / apply / status).

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::chronicle_operations::{
    apply_chronicle_event_create, ChronicleEventCreateContext, ensure_event_id_available,
    ensure_operation_kind,
    ensure_order_neighbor, ensure_scene_versions, generate_append_ordinals,
    parse_event_create_payload,
};
use super::models::{
    ApplyCommitPayload, CommitApplicationRef, CommitOperation, GetCommitStatusPayload,
    PrepareCommitPayload,
};
use super::repository::ensure_run_project;
use super::task_leases::with_immediate_transaction;
use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::Database;

const STATUS_APPLIED: &str = "applied";
const STATUS_UNDONE: &str = "undone";
const STATUS_REDONE: &str = "redone";
const STATUS_FAILED: &str = "failed";

pub fn narrative_extraction_prepare_commit(
    db: &Database,
    payload: PrepareCommitPayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            validate_commit_plan(
                conn,
                &payload.project_id,
                &payload.run_id,
                &payload.proposal_set_id,
                &payload.operations,
                &payload.applications,
                payload.expected_tail_ordinal.as_deref(),
            )?;
            Ok(json!({
                "ok": true,
                "requestId": payload.request_id,
                "planDigest": payload.plan_digest,
                "operationCount": payload.operations.len(),
            }))
        })
    })
}

pub fn narrative_extraction_apply_commit(
    db: &Database,
    payload: ApplyCommitPayload,
) -> anyhow::Result<Value> {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let timestamp = Utc::now().timestamp_millis();
    let commit_id = Uuid::new_v4().to_string();

    let apply_result = db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        with_immediate_transaction(conn, |conn| {
            if let Some(existing) = load_commit_by_request(
                conn,
                &payload.project_id,
                &payload.request_id,
            )? {
                return replay_or_conflict(existing, &payload.plan_digest);
            }

            validate_commit_plan(
                conn,
                &payload.project_id,
                &payload.run_id,
                &payload.proposal_set_id,
                &payload.operations,
                &payload.applications,
                payload.expected_tail_ordinal.as_deref(),
            )?;

            conn.execute(
                "INSERT INTO narrative_apply_commits
                    (id, project_id, run_id, proposal_set_id, request_id, plan_digest,
                     status, created_at, version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, 0)",
                params![
                    commit_id,
                    payload.project_id,
                    payload.run_id,
                    payload.proposal_set_id,
                    payload.request_id,
                    payload.plan_digest,
                    now,
                ],
            )?;

            let parsed: Vec<_> = payload
                .operations
                .iter()
                .map(|op| {
                    ensure_operation_kind(&op.kind)?;
                    parse_event_create_payload(&op.payload)
                })
                .collect::<anyhow::Result<_>>()?;

            let ordinals = generate_append_ordinals(
                payload.expected_tail_ordinal.as_deref(),
                parsed.len(),
            )?;

            let mut created = Vec::new();
            let mut after_snapshots = Vec::new();
            for (index, (op, event_payload)) in
                payload.operations.iter().zip(parsed.iter()).enumerate()
            {
                let ordinal = &ordinals[index];
                let result = apply_chronicle_event_create(ChronicleEventCreateContext {
                    conn,
                    project_id: &payload.project_id,
                    session_id: &payload.session_id,
                    surface: payload.surface.as_deref(),
                    payload: event_payload,
                    ordinal,
                    now: &now,
                    timestamp,
                })?;

                conn.execute(
                    "INSERT INTO narrative_apply_operations
                        (id, commit_id, operation_index, operation_kind, payload_json,
                         result_entity_kind, result_entity_id, status, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'event', ?6, 'applied', ?7)",
                    params![
                        Uuid::new_v4().to_string(),
                        commit_id,
                        index as i64,
                        op.kind,
                        serde_json::to_string(&op.payload)?,
                        result.entity_id,
                        now,
                    ],
                )?;

                after_snapshots.push(json!({
                    "entityKind": "event",
                    "entityId": result.entity_id,
                    "version": result.version,
                    "snapshot": result.after_snapshot,
                }));
                created.push(json!({
                    "operationIndex": index,
                    "entityKind": "event",
                    "entityId": result.entity_id,
                    "version": result.version,
                    "proposalId": op.proposal_id,
                    "revisionId": op.revision_id,
                }));
            }

            for (index, application) in payload.applications.iter().enumerate() {
                let entity_id = created
                    .get(index)
                    .and_then(|row| row.get("entityId"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        anyhow::anyhow!("application[{index}] has no matching created entity")
                    })?;
                conn.execute(
                    "INSERT INTO narrative_proposal_applications
                        (id, commit_id, proposal_id, revision_id,
                         applied_entity_kind, applied_entity_id, created_at)
                     VALUES (?1, ?2, ?3, ?4, 'event', ?5, ?6)",
                    params![
                        Uuid::new_v4().to_string(),
                        commit_id,
                        application.proposal_id,
                        application.revision_id,
                        entity_id,
                        now,
                    ],
                )?;
            }

            let after_json = json!({
                "entities": after_snapshots,
            });
            let journal_id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO narrative_commit_journals
                    (id, commit_id, project_id, before_json, after_json, created_at)
                 VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
                params![
                    journal_id,
                    commit_id,
                    payload.project_id,
                    after_json.to_string(),
                    now,
                ],
            )?;

            let change_uid = Uuid::new_v4().to_string();
            let change_payload = json!({
                "commitId": commit_id,
                "requestId": payload.request_id,
                "planDigest": payload.plan_digest,
                "entityIds": created.iter().map(|row| row["entityId"].clone()).collect::<Vec<_>>(),
            });
            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: change_uid.clone(),
                    scene_id: None,
                    domain: "narrative".to_string(),
                    op_type: "narrative.commit.apply".to_string(),
                    entity_type: Some("narrative_apply_commit".to_string()),
                    entity_id: Some(commit_id.clone()),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;

            let receipt = json!({
                "commitId": commit_id,
                "requestId": payload.request_id,
                "planDigest": payload.plan_digest,
                "status": STATUS_APPLIED,
                "journalId": journal_id,
                "changeEventUid": change_uid,
                "created": created,
            });

            conn.execute(
                "UPDATE narrative_apply_commits
                    SET status = ?1,
                        receipt_json = ?2,
                        completed_at = ?3,
                        version = version + 1
                  WHERE id = ?4",
                params![STATUS_APPLIED, receipt.to_string(), now, commit_id],
            )?;

            Ok(receipt)
        })
    });

    match apply_result {
        Ok(receipt) => Ok(receipt),
        Err(err) => {
            // Apply TX rolled back domain writes. Persist failed audit separately so
            // STATUS_FAILED idempotent replay remains available.
            let message = err.to_string();
            let _ = persist_failed_commit_audit(db, &payload, &commit_id, &message, &now);
            Err(err)
        }
    }
}

fn persist_failed_commit_audit(
    db: &Database,
    payload: &ApplyCommitPayload,
    commit_id: &str,
    message: &str,
    now: &str,
) -> anyhow::Result<()> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            if load_commit_by_request(conn, &payload.project_id, &payload.request_id)?.is_some() {
                return Ok(());
            }
            conn.execute(
                "INSERT INTO narrative_apply_commits
                    (id, project_id, run_id, proposal_set_id, request_id, plan_digest,
                     status, error_message, created_at, completed_at, version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1)",
                params![
                    commit_id,
                    payload.project_id,
                    payload.run_id,
                    payload.proposal_set_id,
                    payload.request_id,
                    payload.plan_digest,
                    STATUS_FAILED,
                    message,
                    now,
                    now,
                ],
            )?;
            Ok(())
        })
    })
}

pub fn narrative_extraction_get_commit_status(
    db: &Database,
    payload: GetCommitStatusPayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        let row = if let Some(commit_id) = payload.commit_id.as_deref() {
            load_commit_by_id(conn, &payload.project_id, commit_id)?
        } else if let Some(request_id) = payload.request_id.as_deref() {
            load_commit_by_request(conn, &payload.project_id, request_id)?
        } else {
            anyhow::bail!("commitId or requestId is required");
        };
        let Some(row) = row else {
            return Ok(json!({
                "found": false,
            }));
        };
        Ok(json!({
            "found": true,
            "commitId": row.commit_id,
            "requestId": row.request_id,
            "planDigest": row.plan_digest,
            "status": row.status,
            "receipt": row.receipt_json.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok()),
            "errorMessage": row.error_message,
            "createdAt": row.created_at,
            "completedAt": row.completed_at,
            "version": row.version,
        }))
    })
}

pub(crate) struct CommitRow {
    pub commit_id: String,
    #[allow(dead_code)]
    pub project_id: String,
    pub request_id: String,
    pub plan_digest: String,
    pub status: String,
    pub receipt_json: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub version: i64,
}

pub(crate) fn load_commit_by_id(
    conn: &Connection,
    project_id: &str,
    commit_id: &str,
) -> anyhow::Result<Option<CommitRow>> {
    conn.query_row(
        "SELECT id, project_id, request_id, plan_digest, status, receipt_json,
                error_message, created_at, completed_at, version
           FROM narrative_apply_commits
          WHERE id = ?1 AND project_id = ?2",
        params![commit_id, project_id],
        map_commit_row,
    )
    .optional()
    .map_err(Into::into)
}

pub(crate) fn load_commit_by_request(
    conn: &Connection,
    project_id: &str,
    request_id: &str,
) -> anyhow::Result<Option<CommitRow>> {
    conn.query_row(
        "SELECT id, project_id, request_id, plan_digest, status, receipt_json,
                error_message, created_at, completed_at, version
           FROM narrative_apply_commits
          WHERE project_id = ?1 AND request_id = ?2
          ORDER BY created_at DESC
          LIMIT 1",
        params![project_id, request_id],
        map_commit_row,
    )
    .optional()
    .map_err(Into::into)
}

fn map_commit_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CommitRow> {
    Ok(CommitRow {
        commit_id: row.get(0)?,
        project_id: row.get(1)?,
        request_id: row.get(2)?,
        plan_digest: row.get(3)?,
        status: row.get(4)?,
        receipt_json: row.get(5)?,
        error_message: row.get(6)?,
        created_at: row.get(7)?,
        completed_at: row.get(8)?,
        version: row.get(9)?,
    })
}

fn replay_or_conflict(existing: CommitRow, plan_digest: &str) -> anyhow::Result<Value> {
    if existing.plan_digest != plan_digest {
        anyhow::bail!(
            "NEX_COMMIT_IDEMPOTENCY_CONFLICT: request id reused with different planDigest"
        );
    }
    match existing.status.as_str() {
        STATUS_APPLIED | STATUS_REDONE | STATUS_UNDONE => {
            if let Some(raw) = existing.receipt_json.as_deref() {
                let mut receipt: Value = serde_json::from_str(raw)?;
                if let Some(obj) = receipt.as_object_mut() {
                    obj.insert("idempotentReplay".to_string(), Value::Bool(true));
                    obj.insert("status".to_string(), Value::String(existing.status.clone()));
                }
                return Ok(receipt);
            }
            Ok(json!({
                "commitId": existing.commit_id,
                "requestId": existing.request_id,
                "planDigest": existing.plan_digest,
                "status": existing.status,
                "idempotentReplay": true,
            }))
        }
        STATUS_FAILED => anyhow::bail!(
            "NEX_COMMIT_PREVIOUSLY_FAILED: {}",
            existing
                .error_message
                .unwrap_or_else(|| "previous commit failed".to_string())
        ),
        other => anyhow::bail!("unexpected commit status '{other}' for idempotent replay"),
    }
}

fn validate_commit_plan(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    proposal_set_id: &str,
    operations: &[CommitOperation],
    applications: &[CommitApplicationRef],
    expected_tail_ordinal: Option<&str>,
) -> anyhow::Result<()> {
    anyhow::ensure!(!operations.is_empty(), "commit requires at least one operation");
    ensure_run_project(conn, run_id, project_id)?;

    let set_ok: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_proposal_sets
          WHERE id = ?1 AND run_id = ?2 AND project_id = ?3",
        params![proposal_set_id, run_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(set_ok == 1, "proposal set not found for run/project");

    ensure_order_neighbor(conn, project_id, expected_tail_ordinal)?;

    anyhow::ensure!(
        applications.len() == operations.len(),
        "NEX_COMMIT_APPLICATIONS_MISMATCH: applications length {} != operations length {}",
        applications.len(),
        operations.len()
    );

    for (index, (operation, application)) in
        operations.iter().zip(applications.iter()).enumerate()
    {
        ensure_operation_kind(&operation.kind)?;
        let payload = parse_event_create_payload(&operation.payload)?;
        ensure_event_id_available(conn, project_id, &payload.event_id)?;
        ensure_scene_versions(conn, project_id, &payload.evidence_scene_links)?;

        anyhow::ensure!(
            operation.proposal_id == application.proposal_id
                && operation.revision_id == application.revision_id,
            "NEX_COMMIT_APPLICATIONS_MISMATCH: index {index} proposal/revision diverge"
        );
        ensure_proposal_approved(
            conn,
            proposal_set_id,
            &application.proposal_id,
            &application.revision_id,
        )?;
        ensure_proposal_not_applied(conn, &application.proposal_id)?;
        ensure_operation_matches_revision(
            conn,
            &application.proposal_id,
            &application.revision_id,
            operation,
        )?;
    }

    Ok(())
}

fn ensure_proposal_approved(
    conn: &Connection,
    proposal_set_id: &str,
    proposal_id: &str,
    revision_id: &str,
) -> anyhow::Result<()> {
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT status, current_revision_id
               FROM narrative_proposals
              WHERE id = ?1 AND proposal_set_id = ?2",
            params![proposal_id, proposal_set_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((status, current_revision_id)) = row else {
        anyhow::bail!("proposal '{proposal_id}' not found in set '{proposal_set_id}'");
    };
    anyhow::ensure!(
        status == "approved",
        "NEX_PROPOSAL_NOT_APPROVED: proposal '{proposal_id}' status is '{status}'"
    );
    anyhow::ensure!(
        current_revision_id.as_deref() == Some(revision_id),
        "NEX_PROPOSAL_REVISION_MISMATCH: proposal '{proposal_id}'"
    );
    Ok(())
}

/// Bind Apply Operation fields that compile must preserve from the approved
/// Revision payload. Evidence / scene mapping is derived at Apply time and is
/// not re-checked here.
fn ensure_operation_matches_revision(
    conn: &Connection,
    proposal_id: &str,
    revision_id: &str,
    operation: &CommitOperation,
) -> anyhow::Result<()> {
    let revision_payload_raw: String = conn.query_row(
        "SELECT payload_json
           FROM narrative_proposal_revisions
          WHERE id = ?1 AND proposal_id = ?2",
        params![revision_id, proposal_id],
        |row| row.get(0),
    )?;
    let revision: Value = serde_json::from_str(&revision_payload_raw)?;
    let op = &operation.payload;

    let revision_event_id = revision
        .get("eventId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_REVISION_PAYLOAD_MISMATCH: revision missing eventId")
        })?;
    let op_event_id = op.get("eventId").and_then(Value::as_str);
    anyhow::ensure!(
        op_event_id == Some(revision_event_id),
        "NEX_REVISION_PAYLOAD_MISMATCH: eventId diverges for proposal '{proposal_id}'"
    );

    let revision_title = revision
        .get("title")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!("NEX_REVISION_PAYLOAD_MISMATCH: revision missing title")
        })?;
    let op_title = op.get("title").and_then(Value::as_str);
    anyhow::ensure!(
        op_title == Some(revision_title),
        "NEX_REVISION_PAYLOAD_MISMATCH: title diverges for proposal '{proposal_id}'"
    );

    let revision_note = revision.get("note").cloned().unwrap_or(Value::Null);
    let op_note = op.get("note").cloned().unwrap_or(Value::Null);
    anyhow::ensure!(
        revision_note == op_note,
        "NEX_REVISION_PAYLOAD_MISMATCH: note diverges for proposal '{proposal_id}'"
    );

    let revision_secret = revision
        .pointer("/disclosure/secret")
        .and_then(Value::as_bool)
        .or_else(|| revision.get("secret").and_then(Value::as_bool))
        .unwrap_or(false);
    let op_secret = op.get("secret").and_then(Value::as_bool).unwrap_or(false);
    anyhow::ensure!(
        revision_secret == op_secret,
        "NEX_REVISION_PAYLOAD_MISMATCH: secret diverges for proposal '{proposal_id}'"
    );

    Ok(())
}

fn ensure_proposal_not_applied(conn: &Connection, proposal_id: &str) -> anyhow::Result<()> {
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

/// Stable digest helper for callers that want a canonical plan fingerprint.
#[allow(dead_code)]
pub fn digest_plan(value: &Value) -> String {
    let mut canonical = value.clone();
    canonicalize_json_value(&mut canonical);
    let body = serde_json::to_vec(&canonical).unwrap_or_default();
    hex::encode(Sha256::digest(body))
}

fn canonicalize_json_value(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                canonicalize_json_value(item);
            }
        }
        Value::Object(object) => {
            let mut entries: Vec<_> = std::mem::take(object).into_iter().collect();
            for (_, child) in &mut entries {
                canonicalize_json_value(child);
            }
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            object.extend(entries);
        }
        _ => {}
    }
}
