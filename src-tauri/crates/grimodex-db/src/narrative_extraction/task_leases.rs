//! Task lease acquisition under `BEGIN IMMEDIATE`.

use chrono::{Duration, Utc};
use grimodex_core::canonical_json_digest;
use rusqlite::{params, Connection, OptionalExtension};
use std::panic::{catch_unwind, resume_unwind, AssertUnwindSafe};
use uuid::Uuid;

use crate::workspace_lifecycle::RunCreationTransactionOutcome;

use super::execution_state::next_run_lifecycle_timestamp_in_tx;
use super::models::{ArtifactInput, ClaimTaskPayload};
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
    // The task heartbeat uses wall time, but a pending Run's first start is a
    // project-scoped lifecycle authority. Allocate it before mutating the
    // Task/Attempt so malformed or exhausted imported Run instants fail closed
    // without leaving a partial claim behind.
    let existing_run_started_at: Option<String> = conn.query_row(
        "SELECT started_at FROM narrative_extraction_runs WHERE id = ?1",
        params![payload.run_id],
        |row| row.get(0),
    )?;
    let run_started_at = if existing_run_started_at.is_none() {
        Some(next_run_lifecycle_timestamp_in_tx(
            conn,
            &payload.project_id,
        )?)
    } else {
        None
    };

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
        params![payload.run_id, run_started_at],
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

#[allow(clippy::too_many_arguments)]
pub(crate) fn persist_task_artifacts(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    attempt_id: &str,
    output_json: &serde_json::Value,
    chronicle_stage_bundle: Option<&super::models::ChronicleStageC1ExecutionBinding>,
    chronicle_stage_receipts: &[super::models::ChronicleStageTerminalReceipt],
    historical_scope_authority_basis: Option<
        &grimodex_core::narrative_scope_authority_basis::NarrativeScopeAuthorityBasisV2,
    >,
    artifacts: &[super::models::ArtifactInput],
) -> anyhow::Result<()> {
    // Inline JSON is a Native-owned value boundary.  Callers may omit its
    // digest for ergonomics, but they may never choose a different digest:
    // every durable inline payload gets the canonical Native recomputation.
    // This is especially important for source.snapshot@1, whose payload
    // digest is later used as a historical Scope Authority basis coordinate.
    let normalized_artifacts = normalize_inline_json_artifact_digests(artifacts)?;
    if let Some(basis) = historical_scope_authority_basis {
        validate_snapshot_finish_output_cas(
            conn,
            project_id,
            run_id,
            task_id,
            output_json,
            &normalized_artifacts,
            basis,
        )?;
    }
    // source.snapshot@2 is never accepted through the generic artifact list,
    // including when the typed sidecar is also present.
    super::scope_authority_runtime::reject_reserved_historical_scope_authority_artifacts(
        &normalized_artifacts,
    )?;
    // Persist each model-stage terminal receipt at the Task boundary where it
    // was actually produced.  The aggregate C1 closure may be supplied by a
    // later synthesis Task, but it is process-local transport proof and is
    // therefore not an acceptable durability boundary for Observation.
    super::stage_provenance::persist_chronicle_stage_receipts(
        conn,
        project_id,
        run_id,
        task_id,
        attempt_id,
        chronicle_stage_receipts,
    )?;
    if let Some(binding) = chronicle_stage_bundle {
        super::stage_provenance::persist_chronicle_stage_bundle(
            conn,
            project_id,
            run_id,
            task_id,
            attempt_id,
            binding,
            output_json,
            &normalized_artifacts,
        )?;
    } else {
        // Generic/V1 finishes deliberately retain their pre-C2A behavior, but
        // reserved Chronicle C2A kinds may not bypass the explicit typed
        // binding by smuggling stage JSON through the generic path.
        super::stage_provenance::reject_reserved_chronicle_stage_bundle(
            output_json,
            &normalized_artifacts,
        )?;
    }
    let typed_scope_artifact = historical_scope_authority_basis
        .map(|basis| {
            super::scope_authority_runtime::persist_historical_scope_authority_basis_in_tx(
                conn,
                project_id,
                run_id,
                task_id,
                attempt_id,
                basis,
                &normalized_artifacts,
            )
        })
        .transpose()?;
    let mut durable_artifacts = Vec::with_capacity(
        normalized_artifacts.len() + usize::from(typed_scope_artifact.is_some()),
    );
    durable_artifacts.extend(normalized_artifacts);
    durable_artifacts.extend(typed_scope_artifact);
    insert_artifacts_for_attempt(conn, run_id, task_id, attempt_id, &durable_artifacts)
}

/// Canonicalize every inline JSON artifact at the only durable writer.  A
/// renderer-side digest is merely a checked assertion; Native supplies the
/// persisted value so independently built windows/processes cannot produce a
/// null or stale payloadDigest for the same inline artifact.
fn normalize_inline_json_artifact_digests(
    artifacts: &[ArtifactInput],
) -> anyhow::Result<Vec<ArtifactInput>> {
    artifacts
        .iter()
        .cloned()
        .map(|mut artifact| {
            let storage = artifact.payload_storage.as_deref().unwrap_or("inline-json");
            if storage != "inline-json" {
                return Ok(artifact);
            }
            let payload = artifact.payload_json.as_ref().ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_INLINE_ARTIFACT_PAYLOAD_REQUIRED: inline-json artifact '{}' requires payloadJson",
                    artifact.artifact_kind
                )
            })?;
            let canonical_digest = canonical_json_digest(payload)?;
            if let Some(supplied) = artifact.payload_digest.as_deref() {
                anyhow::ensure!(
                    supplied == canonical_digest,
                    "NEX_INLINE_ARTIFACT_DIGEST_MISMATCH: artifact '{}' payloadDigest differs from Native recomputation",
                    artifact.artifact_kind
                );
            }
            artifact.payload_digest = Some(canonical_digest);
            Ok(artifact)
        })
        .collect()
}

/// Bind the snapshot Task's visible output to the exact sealed corpus and the
/// historical Scope authority basis produced in this transaction.  This is a
/// second, durable-output CAS in addition to the full payload/basis parser in
/// `scope_authority_runtime`: it keeps a recovered Task row independently
/// useful as evidence and prevents a renderer from reporting one corpus while
/// submitting a different inline artifact.
fn validate_snapshot_finish_output_cas(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    task_id: &str,
    output_json: &serde_json::Value,
    artifacts: &[ArtifactInput],
    basis: &grimodex_core::narrative_scope_authority_basis::NarrativeScopeAuthorityBasisV2,
) -> anyhow::Result<()> {
    const SNAPSHOT_TASK_KIND: &str = "source.snapshot@1";
    const SNAPSHOT_ARTIFACT_KIND: &str = "source.snapshot@1";

    let task_kind: String = conn.query_row(
        "SELECT task_kind
           FROM narrative_extraction_tasks
          WHERE id = ?1 AND run_id = ?2",
        params![task_id, run_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        task_kind == SNAPSHOT_TASK_KIND,
        "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: typed historical basis can only finish source.snapshot@1"
    );
    let run_snapshot_digest: Option<String> = conn.query_row(
        "SELECT snapshot_digest
           FROM narrative_extraction_runs
          WHERE id = ?1 AND project_id = ?2",
        params![run_id, project_id],
        |row| row.get(0),
    )?;
    let run_snapshot_digest = run_snapshot_digest.ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: Run snapshotDigest is required"
        )
    })?;
    let output = output_json.as_object().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: snapshot task output must be an object"
        )
    })?;
    let snapshot_digest = output
        .get("snapshotDigest")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: snapshotDigest is required"
            )
        })?;
    anyhow::ensure!(
        snapshot_digest == run_snapshot_digest,
        "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: output snapshotDigest differs from Run snapshotDigest"
    );
    let mut corpora = artifacts
        .iter()
        .filter(|artifact| artifact.artifact_kind == SNAPSHOT_ARTIFACT_KIND);
    let corpus = corpora.next().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: snapshot finish requires exactly one source.snapshot@1 corpus artifact"
        )
    })?;
    anyhow::ensure!(
        corpora.next().is_none(),
        "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: snapshot finish requires exactly one source.snapshot@1 corpus artifact"
    );
    let payload = corpus.payload_json.as_ref().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: source.snapshot@1 corpus payloadJson is required"
        )
    })?;
    let validation = super::scope_authority_runtime::validate_snapshot_authority_finish(
        payload,
        project_id,
        run_id,
        &run_snapshot_digest,
        Some(basis),
    )?;
    let corpus_digest = corpus.payload_digest.as_deref().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: source.snapshot@1 corpus payloadDigest is required"
        )
    })?;
    anyhow::ensure!(
        corpus_digest == validation.corpus_payload_digest,
        "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: source.snapshot@1 payloadDigest differs from Native canonical corpus payload"
    );
    let document_count = output
        .get("documentCount")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: documentCount is required"
            )
        })?;
    anyhow::ensure!(
        document_count == validation.document_count as u64,
        "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: documentCount differs from Native sealed snapshot corpus"
    );
    let composite_digest = output
        .get("scopeAuthorityCompositeDigest")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: scopeAuthorityCompositeDigest is required"
            )
        })?;
    anyhow::ensure!(
        validation.scope_authority_composite_digest.as_deref() == Some(composite_digest),
        "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: scopeAuthorityCompositeDigest differs from Native sealed historical basis"
    );
    let output_corpus_digest = output
        .get("corpusPayloadDigest")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: corpusPayloadDigest is required"
            )
        })?;
    anyhow::ensure!(
        output_corpus_digest == corpus_digest,
        "NEX_SCOPE_AUTHORITY_SNAPSHOT_OUTPUT_INVALID: corpusPayloadDigest differs from Native canonical corpus payload"
    );
    Ok(())
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
            grimodex_core::commit_or_rollback(conn)?;
            Ok(value)
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Transaction wrapper for the controlled maintenance Run-creation boundary.
/// It reports confirmed rollback separately from an ambiguous commit/cleanup
/// failure so the lifecycle core can retain the exact reservation correctly.
pub(crate) fn with_immediate_transaction_with_creation_outcome<T>(
    conn: &Connection,
    operation: impl FnOnce(&Connection) -> anyhow::Result<T>,
    outcome: impl FnOnce(RunCreationTransactionOutcome) -> anyhow::Result<()>,
) -> anyhow::Result<T> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let operation_result = catch_unwind(AssertUnwindSafe(|| operation(conn)));
    match operation_result {
        Ok(Ok(value)) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(value),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                if let Err(outcome_error) = outcome(RunCreationTransactionOutcome::Unknown) {
                    return Err(anyhow::Error::new(error).context(outcome_error.to_string()));
                }
                Err(error.into())
            }
        },
        Ok(Err(error)) => {
            let rollback = conn.execute_batch("ROLLBACK");
            let transaction_outcome = if rollback.is_ok() && conn.is_autocommit() {
                RunCreationTransactionOutcome::ConfirmedRollback
            } else {
                RunCreationTransactionOutcome::Unknown
            };
            if let Err(outcome_error) = outcome(transaction_outcome) {
                return Err(error.context(outcome_error.to_string()));
            }
            Err(error)
        }
        Err(panic) => {
            let rollback = conn.execute_batch("ROLLBACK");
            let transaction_outcome = if rollback.is_ok() && conn.is_autocommit() {
                RunCreationTransactionOutcome::ConfirmedRollback
            } else {
                RunCreationTransactionOutcome::Unknown
            };
            if let Err(outcome_error) = outcome(transaction_outcome) {
                resume_unwind(Box::new(format!(
                    "maintenance creation outcome callback failed while unwinding: {outcome_error}"
                )));
            }
            resume_unwind(panic);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn creation_outcome_reports_confirmed_rollback_after_partial_dml() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        let mut observed = None;
        let error = with_immediate_transaction_with_creation_outcome(
            &conn,
            |conn| {
                conn.execute_batch(
                    "CREATE TABLE creation_probe (id INTEGER PRIMARY KEY);\n                     INSERT INTO creation_probe (id) VALUES (1);",
                )?;
                Err::<(), _>(anyhow::anyhow!("synthetic creation failure"))
            },
            |outcome| {
                observed = Some(outcome);
                Ok(())
            },
        )
        .expect_err("the synthetic creation failure must be returned");

        assert!(error.to_string().contains("synthetic creation failure"));
        assert_eq!(
            observed,
            Some(RunCreationTransactionOutcome::ConfirmedRollback)
        );
        assert!(conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'creation_probe'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .expect("sqlite query")
            .is_none());
    }

    #[test]
    fn creation_outcome_is_unknown_when_rollback_cannot_be_confirmed() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        let mut observed = None;
        let error = with_immediate_transaction_with_creation_outcome(
            &conn,
            |conn| {
                conn.execute_batch(
                    "CREATE TABLE creation_probe (id INTEGER PRIMARY KEY);\n                     INSERT INTO creation_probe (id) VALUES (1);\n                     ROLLBACK;",
                )?;
                Err::<(), _>(anyhow::anyhow!("synthetic ambiguous failure"))
            },
            |outcome| {
                observed = Some(outcome);
                Ok(())
            },
        )
        .expect_err("the synthetic ambiguous failure must be returned");

        assert!(error.to_string().contains("synthetic ambiguous failure"));
        assert_eq!(observed, Some(RunCreationTransactionOutcome::Unknown));
        assert!(conn.is_autocommit());
    }
}
