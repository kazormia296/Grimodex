//! Canonical Native writers for human-initiated Snippet CRUD.
//!
//! The accepted-AI Snippet writer deliberately remains in `agent_writes` with
//! its AI authorship semantics. This module owns the renderer/manual contract:
//! domain row, Undo Journal, canonical Change Event, Narrative Change Feed,
//! and durable request receipt are committed by one SQLite transaction.

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::change_events::AppendChangeEvent;
use crate::idempotency::{
    canonical_write_payload_fingerprint, insert_idempotent_response, load_idempotent_response,
    IdempotencyRequest,
};
use crate::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_snapshot_digest,
    AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind, NarrativeChangeEventInput,
    NarrativeChangeOrigin,
};
use crate::undo_journal::{insert_undo_journal_in_tx, UndoJournalInsert};
use crate::Database;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetCreatePayload {
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    pub project_id: String,
    pub snippet_id: String,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags_cache: Option<String>,
    #[serde(default)]
    pub content_source: Option<String>,
    #[serde(default)]
    pub scene_id: Option<String>,
    #[serde(default)]
    pub source_chat_message_id: Option<String>,
    #[serde(default)]
    pub canonical_payload: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetUpdatePayload {
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    pub project_id: String,
    pub snippet_id: String,
    pub base_version: i64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    /// An empty string is the typed wire sentinel for SQL NULL.
    #[serde(default)]
    pub tags_cache: Option<String>,
    /// An empty string is the typed wire sentinel for SQL NULL.
    #[serde(default)]
    pub scene_id: Option<String>,
    #[serde(default)]
    pub canonical_payload: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnippetDeletePayload {
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    pub project_id: String,
    pub snippet_id: String,
    pub base_version: i64,
    #[serde(default)]
    pub canonical_payload: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnippetWriteResult {
    entity_id: String,
    version: i64,
    change_event_uid: String,
    undo_journal_id: String,
    maintenance_transaction_id: String,
}

trait SnippetCanonicalIdentity {
    fn request_id(&self) -> &str;
    fn session_id(&self) -> &str;
    fn event_uid(&self) -> &str;
    fn origin(&self) -> NarrativeChangeOrigin;
    fn original_transaction_id(&self) -> Option<&str>;
    fn undo_journal_id(&self) -> Option<&str>;
    fn project_id(&self) -> &str;
}

macro_rules! impl_snippet_identity {
    ($payload:ty) => {
        impl SnippetCanonicalIdentity for $payload {
            fn request_id(&self) -> &str {
                &self.request_id
            }
            fn session_id(&self) -> &str {
                &self.session_id
            }
            fn event_uid(&self) -> &str {
                &self.event_uid
            }
            fn origin(&self) -> NarrativeChangeOrigin {
                self.origin
            }
            fn original_transaction_id(&self) -> Option<&str> {
                self.original_transaction_id.as_deref()
            }
            fn undo_journal_id(&self) -> Option<&str> {
                self.undo_journal_id.as_deref()
            }
            fn project_id(&self) -> &str {
                &self.project_id
            }
        }
    };
}

impl_snippet_identity!(SnippetCreatePayload);
impl_snippet_identity!(SnippetUpdatePayload);
impl_snippet_identity!(SnippetDeletePayload);

fn validate_identity(payload: &impl SnippetCanonicalIdentity) -> anyhow::Result<()> {
    for (name, value) in [
        ("projectId", payload.project_id()),
        ("requestId", payload.request_id()),
        ("sessionId", payload.session_id()),
        ("eventUid", payload.event_uid()),
    ] {
        anyhow::ensure!(!value.trim().is_empty(), "{name} must not be empty");
    }
    anyhow::ensure!(
        !matches!(
            payload.origin(),
            NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
        ),
        "Snippet Undo/Redo must replay its Native Undo Journal"
    );
    anyhow::ensure!(
        payload.original_transaction_id().is_none() && payload.undo_journal_id().is_none(),
        "forward Snippet writes cannot carry Undo/Redo lineage"
    );
    Ok(())
}

fn surface_for_origin(origin: NarrativeChangeOrigin) -> &'static str {
    match origin {
        NarrativeChangeOrigin::Human => "manual",
        NarrativeChangeOrigin::AiApply => "ai-apply",
        NarrativeChangeOrigin::Import => "import",
        NarrativeChangeOrigin::Restore => "restore",
        NarrativeChangeOrigin::Migration => "migration",
        NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo => "history",
    }
}

fn occurred_at(timestamp: i64) -> anyhow::Result<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp)
        .map(|value| value.to_rfc3339())
        .ok_or_else(|| anyhow::anyhow!("Snippet canonical timestamp is out of range"))
}

fn nullable_wire(value: Option<&str>) -> Option<Option<&str>> {
    value.map(|value| if value.is_empty() { None } else { Some(value) })
}

fn validate_project_exists(conn: &rusqlite::Connection, project_id: &str) -> anyhow::Result<()> {
    let exists = conn
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1",
            [project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(exists, "Snippet project '{project_id}' does not exist");
    Ok(())
}

fn validate_scene(
    conn: &rusqlite::Connection,
    project_id: &str,
    scene_id: Option<&str>,
) -> anyhow::Result<()> {
    let Some(scene_id) = scene_id.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let owned = conn
        .query_row(
            "SELECT 1 FROM tree_nodes
              WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            rusqlite::params![scene_id, project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(owned, "Snippet scene is not in project '{project_id}'");
    Ok(())
}

fn validate_source_message(
    conn: &rusqlite::Connection,
    project_id: &str,
    message_id: Option<&str>,
) -> anyhow::Result<()> {
    let Some(message_id) = message_id.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let owned = conn
        .query_row(
            "SELECT 1
               FROM chat_messages message
               JOIN chat_sessions session ON session.id = message.session_id
              WHERE message.id = ?1 AND session.project_id = ?2",
            rusqlite::params![message_id, project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(
        owned,
        "Snippet source chat message is not in project '{project_id}'"
    );
    Ok(())
}

fn validate_content_source(content_source: Option<&str>) -> anyhow::Result<()> {
    anyhow::ensure!(
        content_source.is_none_or(|value| matches!(value, "human" | "ai")),
        "Snippet contentSource must be human, ai, or null"
    );
    Ok(())
}

pub(crate) fn collect_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    snippet_id: &str,
) -> anyhow::Result<Value> {
    crate::canonical_feed_snapshots::canonical_snippet_snapshot(conn, project_id, snippet_id)
}

fn changed_paths(fields: &[&str]) -> Vec<String> {
    let mut paths = fields
        .iter()
        .map(|field| format!("/{field}"))
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths
}

struct AppendSnippetChange<'a> {
    identity: &'a dyn SnippetCanonicalIdentity,
    op_type: &'a str,
    scene_id: Option<String>,
    snippet_id: &'a str,
    undo_journal_id: &'a str,
    canonical_payload: Value,
    before: Option<&'a Value>,
    after: Option<&'a Value>,
    before_version: Option<i64>,
    after_version: Option<i64>,
    mutation_kind: &'a str,
    paths: Vec<String>,
    timestamp: i64,
}

fn append_change(
    conn: &rusqlite::Connection,
    input: AppendSnippetChange<'_>,
) -> anyhow::Result<String> {
    let canonical = AppendChangeEvent {
        event_uid: input.identity.event_uid().to_string(),
        scene_id: input.scene_id,
        domain: "snippet".to_string(),
        op_type: input.op_type.to_string(),
        entity_type: Some("snippet".to_string()),
        entity_id: Some(input.snippet_id.to_string()),
        payload: input.canonical_payload.to_string(),
        timestamp: input.timestamp,
    };
    let has_text_impact = input.paths.iter().any(|path| path == "/content");
    let append = append_canonical_and_narrative_change_in_tx(
        conn,
        input.identity.project_id(),
        input.identity.session_id(),
        &canonical,
        &AppendNarrativeChangeTransactionInput {
            project_id: input.identity.project_id().to_string(),
            request_id: input.identity.request_id().to_string(),
            source_domain: input.op_type.to_string(),
            source_change_event_uid: input.identity.event_uid().to_string(),
            cause_kind: NarrativeChangeCauseKind::Forward,
            origin: input.identity.origin(),
            original_transaction_id: None,
            commit_id: None,
            journal_id: None,
            undo_journal_id: Some(input.undo_journal_id.to_string()),
            application_ids: vec![],
            occurred_at: occurred_at(input.timestamp)?,
            events: vec![NarrativeChangeEventInput {
                object_key: json!({
                    "kind": "component",
                    "componentId": format!("snippet:{}", input.snippet_id),
                }),
                change_kind: if has_text_impact {
                    "content".to_string()
                } else {
                    "metadata".to_string()
                },
                mutation_kind: input.mutation_kind.to_string(),
                before_version: input.before_version,
                before_digest: input.before.map(narrative_snapshot_digest).transpose()?,
                after_version: input.after_version,
                after_digest: input.after.map(narrative_snapshot_digest).transpose()?,
                changed_paths: input.paths.clone(),
                text_impact: has_text_impact.then(|| json!({ "changedPaths": input.paths })),
                structural_impact: Some(json!({ "changedPaths": input.paths })),
            }],
        },
    )?;
    Ok(append.narrative.transaction_id)
}

fn finish_transaction<T>(
    conn: &rusqlite::Connection,
    result: anyhow::Result<T>,
) -> anyhow::Result<T> {
    match result {
        Ok(value) => match conn.execute_batch("COMMIT") {
            Ok(()) => Ok(value),
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error.into())
            }
        },
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

pub fn create(db: &Database, payload: SnippetCreatePayload) -> anyhow::Result<Value> {
    validate_identity(&payload)?;
    anyhow::ensure!(
        !payload.snippet_id.trim().is_empty(),
        "snippetId must not be empty"
    );
    validate_content_source(payload.content_source.as_deref())?;
    let request_hash = canonical_write_payload_fingerprint("snippet_create", &payload)?;
    let request = IdempotencyRequest {
        domain: "snippet_create",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "SNIPPET_CREATE_IDEMPOTENCY_CONFLICT",
    };
    let timestamp = chrono::Utc::now().timestamp_millis();
    let now = occurred_at(timestamp)?;

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            if let Some(existing) = load_idempotent_response(conn, &request)? {
                return Ok(existing);
            }
            validate_project_exists(conn, &payload.project_id)?;
            validate_scene(conn, &payload.project_id, payload.scene_id.as_deref())?;
            validate_source_message(
                conn,
                &payload.project_id,
                payload.source_chat_message_id.as_deref(),
            )?;
            let content_source = payload.content_source.as_deref().unwrap_or("human");
            let inserted = conn.execute(
                "INSERT INTO snippets
                 (id, project_id, title, content, tags_cache, content_source,
                  scene_id, source_chat_message_id, usage_count, version,
                  created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, 1, ?9, ?9)",
                rusqlite::params![
                    payload.snippet_id,
                    payload.project_id,
                    payload.title,
                    payload.content,
                    payload.tags_cache,
                    content_source,
                    payload.scene_id,
                    payload.source_chat_message_id,
                    now,
                ],
            )?;
            anyhow::ensure!(inserted == 1, "Snippet create did not insert its row");
            let after = collect_snapshot(conn, &payload.project_id, &payload.snippet_id)?;
            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &payload.request_id,
                    project_id: &payload.project_id,
                    surface: surface_for_origin(payload.origin),
                    entity_kind: "snippet",
                    entity_id: &payload.snippet_id,
                    op_kind: "create",
                    before_json: None,
                    after_json: Some(&after.to_string()),
                    base_version: 0,
                    result_version: 1,
                    change_event_uid: Some(&payload.event_uid),
                },
            )?;
            let maintenance_transaction_id = append_change(
                conn,
                AppendSnippetChange {
                    identity: &payload,
                    op_type: "snippet.create",
                    scene_id: payload.scene_id.clone(),
                    snippet_id: &payload.snippet_id,
                    undo_journal_id: &payload.request_id,
                    canonical_payload: payload.canonical_payload.clone().unwrap_or_else(
                        || json!({ "title": payload.title, "sceneId": payload.scene_id }),
                    ),
                    before: None,
                    after: Some(&after),
                    before_version: None,
                    after_version: Some(1),
                    mutation_kind: "create",
                    paths: vec!["/".to_string()],
                    timestamp,
                },
            )?;
            let response = serde_json::to_value(SnippetWriteResult {
                entity_id: payload.snippet_id.clone(),
                version: 1,
                change_event_uid: payload.event_uid.clone(),
                undo_journal_id: payload.request_id.clone(),
                maintenance_transaction_id,
            })?;
            insert_idempotent_response(conn, &request, &payload.project_id, &response)?;
            Ok(response)
        })();
        finish_transaction(conn, result)
    })
}

pub fn update(db: &Database, payload: SnippetUpdatePayload) -> anyhow::Result<Value> {
    validate_identity(&payload)?;
    anyhow::ensure!(
        !payload.snippet_id.trim().is_empty(),
        "snippetId must not be empty"
    );
    anyhow::ensure!(
        payload.base_version >= 0,
        "baseVersion must be non-negative"
    );
    let fields = [
        payload.title.as_ref().map(|_| "title"),
        payload.content.as_ref().map(|_| "content"),
        payload.tags_cache.as_ref().map(|_| "tagsCache"),
        payload.scene_id.as_ref().map(|_| "sceneId"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    anyhow::ensure!(
        !fields.is_empty(),
        "Snippet update requires a changed field"
    );
    let request_hash = canonical_write_payload_fingerprint("snippet_update", &payload)?;
    let request = IdempotencyRequest {
        domain: "snippet_update",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "SNIPPET_UPDATE_IDEMPOTENCY_CONFLICT",
    };
    let timestamp = chrono::Utc::now().timestamp_millis();
    let now = occurred_at(timestamp)?;

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            if let Some(existing) = load_idempotent_response(conn, &request)? {
                return Ok(existing);
            }
            validate_scene(
                conn,
                &payload.project_id,
                nullable_wire(payload.scene_id.as_deref()).flatten(),
            )?;
            let before = collect_snapshot(conn, &payload.project_id, &payload.snippet_id).map_err(
                |error| {
                    anyhow::anyhow!(
                        "Snippet '{}' is not in project '{}': {error}",
                        payload.snippet_id,
                        payload.project_id
                    )
                },
            )?;
            let stored_version = before
                .get("version")
                .and_then(Value::as_i64)
                .ok_or_else(|| anyhow::anyhow!("Snippet snapshot has no version"))?;
            anyhow::ensure!(
                stored_version == payload.base_version,
                "Snippet '{}' version conflict: expected {} but database has {}",
                payload.snippet_id,
                payload.base_version,
                stored_version
            );
            let result_version = payload
                .base_version
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Snippet version overflow"))?;
            let updated = conn.execute(
                "UPDATE snippets SET
                    title = CASE WHEN ?1 THEN ?2 ELSE title END,
                    content = CASE WHEN ?3 THEN ?4 ELSE content END,
                    tags_cache = CASE WHEN ?5 THEN ?6 ELSE tags_cache END,
                    scene_id = CASE WHEN ?7 THEN ?8 ELSE scene_id END,
                    version = ?9,
                    updated_at = ?10
                  WHERE id = ?11 AND project_id = ?12 AND version = ?13",
                rusqlite::params![
                    payload.title.is_some(),
                    payload.title,
                    payload.content.is_some(),
                    payload.content,
                    payload.tags_cache.is_some(),
                    nullable_wire(payload.tags_cache.as_deref()).flatten(),
                    payload.scene_id.is_some(),
                    nullable_wire(payload.scene_id.as_deref()).flatten(),
                    result_version,
                    now,
                    payload.snippet_id,
                    payload.project_id,
                    payload.base_version,
                ],
            )?;
            anyhow::ensure!(updated == 1, "Snippet version conflict during update");
            let after = collect_snapshot(conn, &payload.project_id, &payload.snippet_id)?;
            let before_json = before.to_string();
            let after_json = after.to_string();
            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &payload.request_id,
                    project_id: &payload.project_id,
                    surface: surface_for_origin(payload.origin),
                    entity_kind: "snippet",
                    entity_id: &payload.snippet_id,
                    op_kind: "update",
                    before_json: Some(&before_json),
                    after_json: Some(&after_json),
                    base_version: payload.base_version,
                    result_version,
                    change_event_uid: Some(&payload.event_uid),
                },
            )?;
            let paths = changed_paths(&fields);
            let maintenance_transaction_id = append_change(
                conn,
                AppendSnippetChange {
                    identity: &payload,
                    op_type: "snippet.update",
                    scene_id: after
                        .get("sceneId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    snippet_id: &payload.snippet_id,
                    undo_journal_id: &payload.request_id,
                    canonical_payload: payload
                        .canonical_payload
                        .clone()
                        .unwrap_or_else(|| json!({ "fields": fields })),
                    before: Some(&before),
                    after: Some(&after),
                    before_version: Some(payload.base_version),
                    after_version: Some(result_version),
                    mutation_kind: "update",
                    paths,
                    timestamp,
                },
            )?;
            let response = serde_json::to_value(SnippetWriteResult {
                entity_id: payload.snippet_id.clone(),
                version: result_version,
                change_event_uid: payload.event_uid.clone(),
                undo_journal_id: payload.request_id.clone(),
                maintenance_transaction_id,
            })?;
            insert_idempotent_response(conn, &request, &payload.project_id, &response)?;
            Ok(response)
        })();
        finish_transaction(conn, result)
    })
}

pub fn delete(db: &Database, payload: SnippetDeletePayload) -> anyhow::Result<Value> {
    validate_identity(&payload)?;
    anyhow::ensure!(
        !payload.snippet_id.trim().is_empty(),
        "snippetId must not be empty"
    );
    anyhow::ensure!(
        payload.base_version >= 0,
        "baseVersion must be non-negative"
    );
    let request_hash = canonical_write_payload_fingerprint("snippet_delete", &payload)?;
    let request = IdempotencyRequest {
        domain: "snippet_delete",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "SNIPPET_DELETE_IDEMPOTENCY_CONFLICT",
    };
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            if let Some(existing) = load_idempotent_response(conn, &request)? {
                return Ok(existing);
            }
            let before = collect_snapshot(conn, &payload.project_id, &payload.snippet_id).map_err(
                |error| {
                    anyhow::anyhow!(
                        "Snippet '{}' is not in project '{}': {error}",
                        payload.snippet_id,
                        payload.project_id
                    )
                },
            )?;
            let stored_version = before
                .get("version")
                .and_then(Value::as_i64)
                .ok_or_else(|| anyhow::anyhow!("Snippet snapshot has no version"))?;
            anyhow::ensure!(
                stored_version == payload.base_version,
                "Snippet '{}' version conflict: expected {} but database has {}",
                payload.snippet_id,
                payload.base_version,
                stored_version
            );
            let deleted = conn.execute(
                "DELETE FROM snippets WHERE id = ?1 AND project_id = ?2 AND version = ?3",
                rusqlite::params![payload.snippet_id, payload.project_id, payload.base_version],
            )?;
            anyhow::ensure!(deleted == 1, "Snippet version conflict during delete");
            let before_json = before.to_string();
            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &payload.request_id,
                    project_id: &payload.project_id,
                    surface: surface_for_origin(payload.origin),
                    entity_kind: "snippet",
                    entity_id: &payload.snippet_id,
                    op_kind: "delete",
                    before_json: Some(&before_json),
                    after_json: None,
                    base_version: payload.base_version,
                    result_version: payload.base_version,
                    change_event_uid: Some(&payload.event_uid),
                },
            )?;
            let maintenance_transaction_id = append_change(
                conn,
                AppendSnippetChange {
                    identity: &payload,
                    op_type: "snippet.delete",
                    scene_id: before
                        .get("sceneId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    snippet_id: &payload.snippet_id,
                    undo_journal_id: &payload.request_id,
                    canonical_payload: payload.canonical_payload.clone().unwrap_or_else(
                        || json!({ "title": before.get("title").cloned().unwrap_or(Value::Null) }),
                    ),
                    before: Some(&before),
                    after: None,
                    before_version: Some(payload.base_version),
                    after_version: None,
                    mutation_kind: "delete",
                    paths: vec!["/".to_string()],
                    timestamp,
                },
            )?;
            let response = serde_json::to_value(SnippetWriteResult {
                entity_id: payload.snippet_id.clone(),
                version: payload.base_version,
                change_event_uid: payload.event_uid.clone(),
                undo_journal_id: payload.request_id.clone(),
                maintenance_transaction_id,
            })?;
            insert_idempotent_response(conn, &request, &payload.project_id, &response)?;
            Ok(response)
        })();
        finish_transaction(conn, result)
    })
}
