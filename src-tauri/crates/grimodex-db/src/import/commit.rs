use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{require_generic_import_apply_allowed, Database};

const STATE_SOURCE_SAVED: &str = "source-saved";
const STATE_COMMITTED: &str = "committed";
const COMMIT_APPLIED: &str = "committed";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPrepareCommitPayload {
    pub session_id: String,
    pub plan_digest: String,
    pub reserved_project_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportApplyCommitPayload {
    pub session_id: String,
    pub request_id: String,
    pub plan_digest: String,
    pub reserved_project_id: String,
}

pub fn prepare_commit(
    db: &Database,
    payload: ImportPrepareCommitPayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        require_generic_import_apply_allowed(conn)?;
        let target = validate_session_for_commit(
            conn,
            &payload.session_id,
            &payload.plan_digest,
            &payload.reserved_project_id,
        )?;
        Ok(json!({
            "ok": true,
            "sessionId": payload.session_id,
            "planDigest": payload.plan_digest,
            "projectId": target.project_id,
        }))
    })
}

pub fn apply_commit(db: &Database, payload: ImportApplyCommitPayload) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        with_immediate_transaction(conn, |conn| {
            require_generic_import_apply_allowed(conn)?;
            if let Some(existing) = load_commit_by_request(conn, &payload.request_id)? {
                return replay_or_conflict(existing, &payload.plan_digest);
            }

            let target = validate_session_for_commit(
                conn,
                &payload.session_id,
                &payload.plan_digest,
                &payload.reserved_project_id,
            )?;
            let project_exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                [&target.project_id],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                !project_exists,
                "reserved project id '{}' already exists",
                target.project_id
            );

            let now = now();
            let commit_id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO projects (id, title, language, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![target.project_id, target.title, target.language, now],
            )?;
            let receipt = json!({
                "commitId": commit_id,
                "sessionId": payload.session_id,
                "requestId": payload.request_id,
                "planDigest": payload.plan_digest,
                "projectId": target.project_id,
                "status": COMMIT_APPLIED,
            });
            conn.execute(
                "INSERT INTO import_commits (
                    id, session_id, request_id, plan_digest, project_id, status,
                    receipt_json, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    commit_id,
                    payload.session_id,
                    payload.request_id,
                    payload.plan_digest,
                    target.project_id,
                    COMMIT_APPLIED,
                    receipt.to_string(),
                    now,
                ],
            )?;
            conn.execute(
                "UPDATE import_sessions
                    SET state = ?1, updated_at = ?2, version = version + 1
                  WHERE id = ?3",
                params![STATE_COMMITTED, now, payload.session_id],
            )?;
            Ok(receipt)
        })
    })
}

struct ImportTarget {
    project_id: String,
    title: String,
    language: String,
}

fn validate_session_for_commit(
    conn: &Connection,
    session_id: &str,
    plan_digest: &str,
    reserved_project_id: &str,
) -> anyhow::Result<ImportTarget> {
    let (state, source_digest, target_json): (String, Option<String>, String) = conn
        .query_row(
            "SELECT state, source_package_digest, target_json
               FROM import_sessions WHERE id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("import session '{session_id}' not found"))?;
    anyhow::ensure!(
        state == STATE_SOURCE_SAVED,
        "import session '{session_id}' is not ready to commit (state: {state})"
    );
    anyhow::ensure!(
        source_digest.as_deref() == Some(plan_digest),
        "import plan digest does not match the saved source package"
    );

    let target: Value = serde_json::from_str(&target_json)
        .map_err(|error| anyhow::anyhow!("import session target_json is invalid: {error}"))?;
    anyhow::ensure!(
        target.get("kind").and_then(Value::as_str) == Some("new-project"),
        "native import commit currently supports only a new-project target"
    );
    let project_id = target
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow::anyhow!("new-project target requires projectId"))?;
    anyhow::ensure!(
        project_id == reserved_project_id,
        "reserved project id does not match the import target"
    );
    Ok(ImportTarget {
        project_id: project_id.to_string(),
        title: target
            .get("title")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("Untitled Project")
            .to_string(),
        language: target
            .get("language")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("ja")
            .to_string(),
    })
}

struct ExistingCommit {
    plan_digest: String,
    receipt_json: Option<String>,
}

fn load_commit_by_request(
    conn: &Connection,
    request_id: &str,
) -> anyhow::Result<Option<ExistingCommit>> {
    conn.query_row(
        "SELECT plan_digest, receipt_json FROM import_commits WHERE request_id = ?1",
        [request_id],
        |row| {
            Ok(ExistingCommit {
                plan_digest: row.get(0)?,
                receipt_json: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn replay_or_conflict(existing: ExistingCommit, plan_digest: &str) -> anyhow::Result<Value> {
    anyhow::ensure!(
        existing.plan_digest == plan_digest,
        "IMPORT_COMMIT_IDEMPOTENCY_CONFLICT: request id reused with different planDigest"
    );
    let mut receipt = existing
        .receipt_json
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?
        .unwrap_or_else(|| json!({ "planDigest": existing.plan_digest, "status": COMMIT_APPLIED }));
    receipt["idempotentReplay"] = Value::Bool(true);
    Ok(receipt)
}

fn with_immediate_transaction<T>(
    conn: &Connection,
    operation: impl FnOnce(&Connection) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    conn.execute_batch("BEGIN IMMEDIATE")?;
    match operation(conn) {
        Ok(value) => {
            if let Err(error) = conn.execute_batch("COMMIT") {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error.into())
            } else {
                Ok(value)
            }
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn now() -> String {
    Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}
