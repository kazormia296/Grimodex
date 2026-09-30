use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::change_events::AppendChangeEvent;
use crate::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_snapshot_digest,
    AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind, NarrativeChangeEventInput,
    NarrativeChangeOrigin,
};
use crate::narrative_extraction::mint_c2zc_import_project_birth_epoch_in_tx;
use crate::{require_generic_import_apply_allowed, Database};

const STATE_SOURCE_SAVED: &str = "source-saved";
const STATE_COMMITTED: &str = "committed";
const COMMIT_APPLIED: &str = "committed";
const BUILTIN_CODEX_TYPE_SLUGS: [&str; 4] = ["character", "location", "item", "lore"];

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

fn imported_builtin_type_snapshots(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<Value>> {
    let mut statement = conn.prepare(
        "SELECT json_object(
                    'id', id,
                    'projectId', project_id,
                    'slug', slug,
                    'label', label,
                    'color', color,
                    'paletteIndex', palette_index,
                    'isBuiltin', is_builtin,
                    'sortOrder', sort_order,
                    'createdAt', created_at
                )
           FROM codex_types
          WHERE project_id = ?1
            AND is_builtin = 1
            AND slug IN ('character', 'location', 'item', 'lore')
          ORDER BY CASE slug
                     WHEN 'character' THEN 0
                     WHEN 'location' THEN 1
                     WHEN 'item' THEN 2
                     WHEN 'lore' THEN 3
                     ELSE 4
                   END",
    )?;
    let snapshots = statement
        .query_map([project_id], |row| row.get::<_, String>(0))?
        .map(|raw| Ok(serde_json::from_str::<Value>(&raw?)?))
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(
        snapshots.len() == BUILTIN_CODEX_TYPE_SLUGS.len()
            && snapshots
                .iter()
                .zip(BUILTIN_CODEX_TYPE_SLUGS)
                .all(|(snapshot, slug)| snapshot.get("slug").and_then(Value::as_str) == Some(slug)),
        "imported project '{project_id}' did not seed the canonical builtin Codex catalog"
    );
    Ok(snapshots)
}

fn imported_builtin_type_feed_events(
    snapshots: &[Value],
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    snapshots
        .iter()
        .map(|snapshot| {
            let type_id = snapshot
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("imported builtin Codex type id is missing"))?;
            Ok(NarrativeChangeEventInput {
                object_key: json!({
                    "kind": "component",
                    "componentId": format!("codex-type:{type_id}"),
                }),
                change_kind: "catalog".to_string(),
                mutation_kind: "create".to_string(),
                before_version: None,
                before_digest: None,
                after_version: None,
                after_digest: Some(narrative_snapshot_digest(snapshot)?),
                changed_paths: vec!["/".to_string()],
                text_impact: None,
                structural_impact: Some(json!({ "changedPaths": ["/"] })),
            })
        })
        .collect()
}

pub fn prepare_commit(db: &Database, payload: ImportPrepareCommitPayload) -> anyhow::Result<Value> {
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
                return replay_or_conflict(
                    existing,
                    &payload.session_id,
                    &payload.plan_digest,
                    &payload.reserved_project_id,
                );
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
            let timestamp = Utc::now().timestamp_millis();
            let commit_id = Uuid::new_v4().to_string();
            let change_event_uid = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO projects (id, title, language, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                params![target.project_id, target.title, target.language, now],
            )?;
            let builtin_types = imported_builtin_type_snapshots(conn, &target.project_id)?;
            conn.execute(
                "UPDATE import_sessions
                    SET state = ?1, updated_at = ?2, version = version + 1
                  WHERE id = ?3",
                params![STATE_COMMITTED, now, payload.session_id],
            )?;
            let imported_state = json!({
                "commitId": commit_id,
                "sessionId": payload.session_id,
                "planDigest": payload.plan_digest,
                "projectId": target.project_id,
                "title": target.title,
                "language": target.language,
            });
            let canonical_payload = json!({
                "commitId": commit_id,
                "sessionId": payload.session_id,
                "requestId": payload.request_id,
                "planDigest": payload.plan_digest,
                "projectId": target.project_id,
            });
            let mut feed_events = vec![NarrativeChangeEventInput {
                object_key: json!({
                    "kind": "import-source",
                    "sourceSetId": payload.session_id,
                    "objectKey": target.project_id,
                }),
                change_kind: "metadata".to_string(),
                mutation_kind: "create".to_string(),
                before_version: None,
                before_digest: None,
                after_version: None,
                after_digest: Some(narrative_snapshot_digest(&imported_state)?),
                changed_paths: vec!["/".to_string()],
                text_impact: None,
                structural_impact: Some(json!({ "changedPaths": ["/"] })),
            }];
            feed_events.extend(imported_builtin_type_feed_events(&builtin_types)?);
            let tracked = append_canonical_and_narrative_change_in_tx(
                conn,
                &target.project_id,
                &payload.session_id,
                &AppendChangeEvent {
                    event_uid: change_event_uid.clone(),
                    scene_id: None,
                    domain: "import".to_string(),
                    op_type: "import.session.apply".to_string(),
                    entity_type: Some("import_session".to_string()),
                    entity_id: Some(payload.session_id.clone()),
                    payload: canonical_payload.to_string(),
                    timestamp,
                },
                &AppendNarrativeChangeTransactionInput {
                    project_id: target.project_id.clone(),
                    request_id: payload.request_id.clone(),
                    source_domain: "import.session.apply".to_string(),
                    source_change_event_uid: change_event_uid.clone(),
                    cause_kind: NarrativeChangeCauseKind::Forward,
                    origin: NarrativeChangeOrigin::Import,
                    original_transaction_id: None,
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: None,
                    application_ids: vec![],
                    occurred_at: now.clone(),
                    events: feed_events,
                },
            )?;
            // Import creates a Project through a distinct canonical authority
            // event. Bootstrap its initial Epoch only after that exact event
            // has been persisted, so marker incompatibility or lineage
            // failure rolls the Project, session transition, Feed, and receipt
            // back together.
            mint_c2zc_import_project_birth_epoch_in_tx(
                conn,
                &target.project_id,
                &payload.session_id,
                &change_event_uid,
            )?;
            let receipt = json!({
                "commitId": commit_id,
                "sessionId": payload.session_id,
                "requestId": payload.request_id,
                "planDigest": payload.plan_digest,
                "projectId": target.project_id,
                "status": COMMIT_APPLIED,
                "changeEventUid": change_event_uid,
                "maintenanceTransactionId": tracked.narrative.transaction_id,
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
    session_id: String,
    plan_digest: String,
    project_id: String,
    receipt_json: Option<String>,
}

fn load_commit_by_request(
    conn: &Connection,
    request_id: &str,
) -> anyhow::Result<Option<ExistingCommit>> {
    conn.query_row(
        "SELECT session_id, plan_digest, project_id, receipt_json
           FROM import_commits WHERE request_id = ?1",
        [request_id],
        |row| {
            Ok(ExistingCommit {
                session_id: row.get(0)?,
                plan_digest: row.get(1)?,
                project_id: row.get(2)?,
                receipt_json: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn replay_or_conflict(
    existing: ExistingCommit,
    session_id: &str,
    plan_digest: &str,
    project_id: &str,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        existing.session_id == session_id
            && existing.plan_digest == plan_digest
            && existing.project_id == project_id,
        "IMPORT_COMMIT_IDEMPOTENCY_CONFLICT: request id reused with a different import authority"
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
