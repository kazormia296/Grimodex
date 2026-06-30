//! Atomic AI write primitives for in-app agent tools.
//!
//! Each write bundles entity mutation + authorship_spans + undo_journal +
//! change_events in a single BEGIN IMMEDIATE transaction.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::database::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::database::undo_journal::{insert_undo_journal_in_tx, UndoJournalInsert};
use crate::database::{BatchStatement, Database};

use super::{with_db, AppError, WorkspaceState};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AuthorshipSpanInput {
    from_pos: i64,
    to_pos: i64,
    source: String,
    model: Option<String>,
    chat_msg_id: Option<String>,
    trace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCodexCreatePayload {
    project_id: String,
    session_id: String,
    type_slug: String,
    name: String,
    summary: Option<String>,
    content: Option<String>,
    aliases: Option<String>,
    parent_id: Option<String>,
    source_chat_message_id: Option<String>,
    model: Option<String>,
    chat_message_id: Option<String>,
    trace_id: Option<String>,
    authorship_spans: Vec<AuthorshipSpanInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentCodexUpdatePayload {
    project_id: String,
    session_id: String,
    entry_id: String,
    /// Client-observed version before this write (optimistic lock).
    base_version: i64,
    name: Option<String>,
    summary: Option<String>,
    content: Option<String>,
    aliases: Option<String>,
    model: Option<String>,
    chat_message_id: Option<String>,
    trace_id: Option<String>,
    authorship_spans: Option<Vec<AuthorshipSpanInput>>,
    /// Per-span lane for partial updates: "summary" | "content".
    authorship_span_lanes: Option<Vec<Option<String>>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentWriteResult {
    entity_id: String,
    version: i64,
    change_event_uid: String,
    undo_journal_id: String,
}

const LANE_SUMMARY_MODEL: &str = "__lane_summary__";
const LANE_CONTENT_MODEL: &str = "__lane_content__";

fn lane_model(lane: Option<&str>, span_model: Option<&str>) -> Option<String> {
    match lane {
        Some("summary") => Some(LANE_SUMMARY_MODEL.to_string()),
        Some("content") => Some(LANE_CONTENT_MODEL.to_string()),
        _ => span_model.map(str::to_string),
    }
}

struct CodexSpanMerge<'a> {
    spans: &'a [AuthorshipSpanInput],
    lanes: Option<&'a [Option<String>]>,
    update_summary: bool,
    update_content: bool,
    model: Option<&'a str>,
    chat_msg_id: Option<&'a str>,
    trace_id: Option<&'a str>,
}

fn merge_codex_authorship_spans(
    conn: &rusqlite::Connection,
    entry_id: &str,
    merge: CodexSpanMerge<'_>,
) -> anyhow::Result<()> {
    let CodexSpanMerge {
        spans,
        lanes,
        update_summary,
        update_content,
        model,
        chat_msg_id,
        trace_id,
    } = merge;
    if update_summary && update_content {
        conn.execute(
            "DELETE FROM authorship_spans WHERE codex_entry_id = ?1",
            rusqlite::params![entry_id],
        )?;
    } else if update_summary {
        conn.execute(
            "DELETE FROM authorship_spans WHERE codex_entry_id = ?1 AND model = ?2",
            rusqlite::params![entry_id, LANE_SUMMARY_MODEL],
        )?;
    } else if update_content {
        conn.execute(
            "DELETE FROM authorship_spans WHERE codex_entry_id = ?1 AND model = ?2",
            rusqlite::params![entry_id, LANE_CONTENT_MODEL],
        )?;
    }
    let now = chrono::Utc::now().to_rfc3339();
    for (i, span) in spans.iter().enumerate() {
        let span_lane = lanes.and_then(|l| l.get(i)).and_then(|x| x.as_deref());
        let span_id = uuid::Uuid::new_v4().to_string();
        let resolved_model =
            lane_model(span_lane, span.model.as_deref()).or_else(|| model.map(str::to_string));
        conn.execute(
            "INSERT INTO authorship_spans
             (id, codex_entry_id, from_pos, to_pos, source, model, chat_msg_id, trace_id, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                span_id,
                entry_id,
                span.from_pos,
                span.to_pos,
                span.source,
                resolved_model,
                span.chat_msg_id.as_deref().or(chat_msg_id),
                span.trace_id.as_deref().or(trace_id),
                now,
            ],
        )?;
    }
    Ok(())
}

fn agent_codex_create_impl(
    db: &Database,
    payload: AgentCodexCreatePayload,
) -> anyhow::Result<Value> {
    let entry_id = uuid::Uuid::new_v4().to_string();
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let content = payload.content.unwrap_or_else(|| "{}".to_string());
    let summary = payload.summary.unwrap_or_default();
    let aliases = payload.aliases;
    let parent_id = payload.parent_id;
    let source_chat_message_id = payload.source_chat_message_id;
    let timestamp = chrono::Utc::now().timestamp_millis();

    let change_payload = json!({
        "type": payload.type_slug,
        "name": payload.name,
        "parentId": parent_id,
    });

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            conn.execute(
                "INSERT INTO codex_entries
                 (id, project_id, type, name, aliases, summary, content, parent_id,
                  source_chat_message_id, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)",
                rusqlite::params![
                    entry_id,
                    payload.project_id,
                    payload.type_slug,
                    payload.name,
                    aliases,
                    summary,
                    content,
                    parent_id,
                    source_chat_message_id,
                    now,
                ],
            )?;

            merge_codex_authorship_spans(
                conn,
                &entry_id,
                CodexSpanMerge {
                    spans: &payload.authorship_spans,
                    lanes: None,
                    update_summary: true,
                    update_content: true,
                    model: payload.model.as_deref(),
                    chat_msg_id: payload
                        .chat_message_id
                        .as_deref()
                        .or(source_chat_message_id.as_deref()),
                    trace_id: payload.trace_id.as_deref(),
                },
            )?;

            let after_base: String = conn.query_row(
                "SELECT json_object(
                    'id', id, 'projectId', project_id, 'type', type, 'name', name,
                    'summary', summary, 'content', content, 'aliases', aliases,
                    'parentId', parent_id, 'version', version
                 ) FROM codex_entries WHERE id = ?1",
                rusqlite::params![entry_id],
                |row| row.get(0),
            )?;
            let after_snapshot = grimodex_core::undo_journal::codex_update_after_snapshot(
                conn,
                &entry_id,
                &after_base,
            )?;

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: "in-app-agent",
                    entity_kind: "codex_entry",
                    entity_id: &entry_id,
                    op_kind: "create",
                    before_json: None,
                    after_json: Some(&after_snapshot),
                    base_version: 0,
                    result_version: 1,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "codex".to_string(),
                    op_type: "entry.create".to_string(),
                    entity_type: Some("codex_entry".to_string()),
                    entity_id: Some(entry_id.clone()),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: entry_id.clone(),
                version: 1,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

fn agent_codex_update_impl(
    db: &Database,
    payload: AgentCodexUpdatePayload,
) -> anyhow::Result<Value> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;

        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let (db_version, before_base): (i64, String) = conn.query_row(
                "SELECT version, json_object(
                    'id', id, 'projectId', project_id, 'type', type, 'name', name,
                    'summary', summary, 'content', content, 'aliases', aliases,
                    'parentId', parent_id, 'version', version
                 ) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.entry_id, payload.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let before_row = grimodex_core::undo_journal::codex_update_before_snapshot(
                conn,
                &payload.entry_id,
                &before_base,
            )?;
            if db_version != payload.base_version {
                anyhow::bail!(
                    "Codex entry '{}' version conflict: expected {} but database has {}",
                    payload.entry_id,
                    payload.base_version,
                    db_version
                );
            }
            let base_version = payload.base_version;

            let mut sets = vec!["updated_at = ?1".to_string(), "version = version + 1".to_string()];
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now.clone())];
            let mut param_idx = 2;

            if let Some(ref name) = payload.name {
                sets.push(format!("name = ?{param_idx}"));
                params.push(Box::new(name.clone()));
                param_idx += 1;
            }
            if let Some(ref summary) = payload.summary {
                sets.push(format!("summary = ?{param_idx}"));
                params.push(Box::new(summary.clone()));
                param_idx += 1;
            }
            if let Some(ref content) = payload.content {
                sets.push(format!("content = ?{param_idx}"));
                params.push(Box::new(content.clone()));
                param_idx += 1;
            }
            if let Some(ref aliases) = payload.aliases {
                sets.push(format!("aliases = ?{param_idx}"));
                params.push(Box::new(aliases.clone()));
                param_idx += 1;
            }

            let sql = format!(
                "UPDATE codex_entries SET {} WHERE id = ?{param_idx} AND project_id = ?{} AND version = ?{}",
                sets.join(", "),
                param_idx + 1,
                param_idx + 2
            );
            params.push(Box::new(payload.entry_id.clone()));
            params.push(Box::new(payload.project_id.clone()));
            params.push(Box::new(base_version));

            let updated = conn.execute(
                &sql,
                rusqlite::params_from_iter(params.iter().map(|p| p as &dyn rusqlite::types::ToSql)),
            )?;
            if updated == 0 {
                anyhow::bail!(
                    "Codex entry '{}' version conflict or not found in project '{}'",
                    payload.entry_id,
                    payload.project_id
                );
            }

            let result_version = base_version + 1;

            if let Some(ref spans) = payload.authorship_spans {
                merge_codex_authorship_spans(
                    conn,
                    &payload.entry_id,
                    CodexSpanMerge {
                        spans,
                        lanes: payload.authorship_span_lanes.as_deref(),
                        update_summary: payload.summary.is_some(),
                        update_content: payload.content.is_some(),
                        model: payload.model.as_deref(),
                        chat_msg_id: payload.chat_message_id.as_deref(),
                        trace_id: payload.trace_id.as_deref(),
                    },
                )?;
            }

            let after_base: String = conn.query_row(
                "SELECT json_object(
                    'id', id, 'projectId', project_id, 'type', type, 'name', name,
                    'summary', summary, 'content', content, 'aliases', aliases,
                    'parentId', parent_id, 'version', version
                 ) FROM codex_entries WHERE id = ?1",
                rusqlite::params![payload.entry_id],
                |row| row.get(0),
            )?;
            let after_row = grimodex_core::undo_journal::codex_update_after_snapshot(
                conn,
                &payload.entry_id,
                &after_base,
            )?;

            let fields: Vec<&str> = [
                payload.name.as_ref().map(|_| "name"),
                payload.summary.as_ref().map(|_| "summary"),
                payload.content.as_ref().map(|_| "content"),
                payload.aliases.as_ref().map(|_| "aliases"),
            ]
            .into_iter()
            .flatten()
            .collect();

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: "in-app-agent",
                    entity_kind: "codex_entry",
                    entity_id: &payload.entry_id,
                    op_kind: "update",
                    before_json: Some(&before_row),
                    after_json: Some(&after_row),
                    base_version,
                    result_version,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "codex".to_string(),
                    op_type: "entry.update".to_string(),
                    entity_type: Some("codex_entry".to_string()),
                    entity_id: Some(payload.entry_id.clone()),
                    payload: json!({ "fields": fields }).to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.entry_id.clone(),
                version: result_version,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UndoJournalPayload {
    pub entity_kind: String,
    pub entity_id: String,
    pub op_kind: String,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
    pub base_version: i64,
    pub result_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangeEventPayload {
    pub event_uid: String,
    pub scene_id: Option<String>,
    pub domain: String,
    pub op_type: String,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub payload: String,
    pub timestamp: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentWriteBundlePayload {
    pub project_id: String,
    pub session_id: String,
    pub surface: String,
    pub statements: Vec<BatchStatement>,
    pub undo_journal: UndoJournalPayload,
    pub change_event: ChangeEventPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSnippetCreatePayload {
    pub project_id: String,
    pub session_id: String,
    pub title: String,
    pub content: Option<String>,
    pub scene_id: Option<String>,
    pub source_chat_message_id: Option<String>,
    pub model: Option<String>,
    pub chat_message_id: Option<String>,
    pub trace_id: Option<String>,
    pub authorship_spans: Vec<AuthorshipSpanInput>,
}

fn run_statements_in_tx(
    conn: &rusqlite::Connection,
    statements: &[BatchStatement],
) -> anyhow::Result<()> {
    for stmt in statements {
        Database::execute_with_conn(conn, &stmt.sql, &stmt.params, &stmt.method)?;
    }
    Ok(())
}

fn replace_snippet_authorship_spans(
    conn: &rusqlite::Connection,
    snippet_id: &str,
    spans: &[AuthorshipSpanInput],
    model: Option<&str>,
    chat_msg_id: Option<&str>,
    trace_id: Option<&str>,
) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM authorship_spans WHERE snippet_id = ?1",
        rusqlite::params![snippet_id],
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    for span in spans {
        let span_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO authorship_spans
             (id, snippet_id, from_pos, to_pos, source, model, chat_msg_id, trace_id, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                span_id,
                snippet_id,
                span.from_pos,
                span.to_pos,
                span.source,
                span.model.as_deref().or(model),
                span.chat_msg_id.as_deref().or(chat_msg_id),
                span.trace_id.as_deref().or(trace_id),
                now,
            ],
        )?;
    }
    Ok(())
}

fn agent_write_bundle_impl(
    db: &Database,
    payload: AgentWriteBundlePayload,
) -> anyhow::Result<Value> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            run_statements_in_tx(conn, &payload.statements)?;

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: &payload.surface,
                    entity_kind: &payload.undo_journal.entity_kind,
                    entity_id: &payload.undo_journal.entity_id,
                    op_kind: &payload.undo_journal.op_kind,
                    before_json: payload.undo_journal.before_json.as_deref(),
                    after_json: payload.undo_journal.after_json.as_deref(),
                    base_version: payload.undo_journal.base_version,
                    result_version: payload.undo_journal.result_version,
                    change_event_uid: Some(&payload.change_event.event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: payload.change_event.event_uid.clone(),
                    scene_id: payload.change_event.scene_id.clone(),
                    domain: payload.change_event.domain.clone(),
                    op_type: payload.change_event.op_type.clone(),
                    entity_type: payload.change_event.entity_type.clone(),
                    entity_id: payload.change_event.entity_id.clone(),
                    payload: payload.change_event.payload.clone(),
                    timestamp: payload.change_event.timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.undo_journal.entity_id.clone(),
                version: payload.undo_journal.result_version,
                change_event_uid: payload.change_event.event_uid.clone(),
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

fn agent_snippet_create_impl(
    db: &Database,
    payload: AgentSnippetCreatePayload,
) -> anyhow::Result<Value> {
    let snippet_id = uuid::Uuid::new_v4().to_string();
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let content = payload.content.unwrap_or_else(|| "{}".to_string());
    let timestamp = chrono::Utc::now().timestamp_millis();

    let after_base = json!({
        "id": snippet_id,
        "projectId": payload.project_id,
        "title": payload.title,
        "content": content,
        "sceneId": payload.scene_id,
        "contentSource": "ai",
        "version": 1,
    })
    .to_string();

    let change_payload = json!({
        "title": payload.title,
        "sceneId": payload.scene_id,
    });

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            conn.execute(
                "INSERT INTO snippets
                 (id, project_id, title, content, scene_id, content_source,
                  source_chat_message_id, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'ai', ?6, 1, ?7, ?7)",
                rusqlite::params![
                    snippet_id,
                    payload.project_id,
                    payload.title,
                    content,
                    payload.scene_id,
                    payload.source_chat_message_id,
                    now,
                ],
            )?;

            replace_snippet_authorship_spans(
                conn,
                &snippet_id,
                &payload.authorship_spans,
                payload.model.as_deref(),
                payload
                    .chat_message_id
                    .as_deref()
                    .or(payload.source_chat_message_id.as_deref()),
                payload.trace_id.as_deref(),
            )?;

            let after_snapshot = grimodex_core::undo_journal::snippet_create_after_snapshot(
                conn,
                &snippet_id,
                &after_base,
            )?;

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: "in-app-agent",
                    entity_kind: "snippet",
                    entity_id: &snippet_id,
                    op_kind: "create",
                    before_json: None,
                    after_json: Some(&after_snapshot),
                    base_version: 0,
                    result_version: 1,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: payload.scene_id.clone(),
                    domain: "snippet".to_string(),
                    op_type: "snippet.create".to_string(),
                    entity_type: Some("snippet".to_string()),
                    entity_id: Some(snippet_id.clone()),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: snippet_id.clone(),
                version: 1,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

#[tauri::command]
pub(crate) fn agent_codex_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentCodexCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_codex_create_impl(db, payload))
}

#[tauri::command]
pub(crate) fn agent_codex_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentCodexUpdatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_codex_update_impl(db, payload))
}

#[tauri::command]
pub(crate) fn agent_write_bundle(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentWriteBundlePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_write_bundle_impl(db, payload))
}

#[tauri::command]
pub(crate) fn agent_snippet_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentSnippetCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_snippet_create_impl(db, payload))
}

// ---------------------------------------------------------------------------
// Prose staging (Phase 5 — accept/reject body writes)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProposeSceneBodyPayload {
    pub project_id: String,
    pub session_id: String,
    pub scene_id: String,
    pub proposed_content: String,
    /// "append" | "insert" | "replace"
    pub mode: String,
    pub source_surface: String,
    pub replace_from: Option<i64>,
    pub replace_to: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProseStageIdPayload {
    pub project_id: String,
    pub session_id: String,
    pub staging_id: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProseStageResult {
    staging_id: String,
    scene_id: String,
    status: String,
}

fn is_file_backed_scene(source_uri: Option<&str>) -> bool {
    match source_uri {
        None => false,
        Some(uri) if uri.ends_with("/.mount") => false,
        Some(_) => true,
    }
}

fn agent_propose_scene_body_impl(
    db: &Database,
    payload: AgentProposeSceneBodyPayload,
) -> anyhow::Result<Value> {
    let staging_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();
    let now = chrono::Utc::now().to_rfc3339();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<ProseStageResult> {
            let (base_version, source_uri): (i64, Option<String>) = conn.query_row(
                "SELECT version, source_uri FROM tree_nodes
                 WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
                rusqlite::params![payload.scene_id, payload.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;

            if is_file_backed_scene(source_uri.as_deref()) {
                anyhow::bail!("file-backed scenes are excluded from headless prose staging (v1)");
            }

            let content_json = json!({
                "mode": payload.mode,
                "text": payload.proposed_content,
                "replaceFrom": payload.replace_from,
                "replaceTo": payload.replace_to,
            });

            conn.execute(
                "INSERT INTO prose_staging
                 (id, project_id, scene_id, proposed_content, base_version, status,
                  source_surface, source_session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'proposed', ?6, ?7, ?8, ?8)",
                rusqlite::params![
                    staging_id,
                    payload.project_id,
                    payload.scene_id,
                    content_json.to_string(),
                    base_version,
                    payload.source_surface,
                    payload.session_id,
                    now,
                ],
            )?;

            let change_payload = json!({
                "stagingId": staging_id,
                "sceneId": payload.scene_id,
                "mode": payload.mode,
                "preview": payload.proposed_content.chars().take(200).collect::<String>(),
            });

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: Some(payload.scene_id.clone()),
                    domain: "prose".to_string(),
                    op_type: "prose.propose".to_string(),
                    entity_type: Some("prose_staging".to_string()),
                    entity_id: Some(staging_id.clone()),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;

            Ok(ProseStageResult {
                staging_id: staging_id.clone(),
                scene_id: payload.scene_id.clone(),
                status: "proposed".to_string(),
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

fn agent_accept_prose_stage_impl(
    db: &Database,
    payload: AgentProseStageIdPayload,
) -> anyhow::Result<Value> {
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();
    let now = chrono::Utc::now().to_rfc3339();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<ProseStageResult> {
            let (scene_id, status): (String, String) = conn.query_row(
                "SELECT scene_id, status FROM prose_staging
                 WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.staging_id, payload.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;

            if status != "proposed" {
                anyhow::bail!("staging entry is not in proposed status");
            }

            conn.execute(
                "UPDATE prose_staging SET status = 'accepted', updated_at = ?1
                 WHERE id = ?2 AND project_id = ?3",
                rusqlite::params![now, payload.staging_id, payload.project_id],
            )?;

            let change_payload = json!({
                "stagingId": payload.staging_id,
                "sceneId": scene_id,
            });

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: Some(scene_id.clone()),
                    domain: "prose".to_string(),
                    op_type: "prose.accept".to_string(),
                    entity_type: Some("prose_staging".to_string()),
                    entity_id: Some(payload.staging_id.clone()),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;

            Ok(ProseStageResult {
                staging_id: payload.staging_id.clone(),
                scene_id,
                status: "accepted".to_string(),
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

fn agent_discard_prose_stage_impl(
    db: &Database,
    payload: AgentProseStageIdPayload,
) -> anyhow::Result<Value> {
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();
    let now = chrono::Utc::now().to_rfc3339();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<ProseStageResult> {
            let (scene_id, status): (String, String) = conn.query_row(
                "SELECT scene_id, status FROM prose_staging
                 WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.staging_id, payload.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;

            if status != "proposed" {
                anyhow::bail!("staging entry is not in proposed status");
            }

            conn.execute(
                "UPDATE prose_staging SET status = 'discarded', updated_at = ?1
                 WHERE id = ?2 AND project_id = ?3",
                rusqlite::params![now, payload.staging_id, payload.project_id],
            )?;

            let change_payload = json!({
                "stagingId": payload.staging_id,
                "sceneId": scene_id,
            });

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: Some(scene_id.clone()),
                    domain: "prose".to_string(),
                    op_type: "prose.discard".to_string(),
                    entity_type: Some("prose_staging".to_string()),
                    entity_id: Some(payload.staging_id.clone()),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;

            Ok(ProseStageResult {
                staging_id: payload.staging_id.clone(),
                scene_id,
                status: "discarded".to_string(),
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

#[tauri::command]
pub(crate) fn agent_propose_scene_body(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentProposeSceneBodyPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_propose_scene_body_impl(db, payload))
}

#[tauri::command]
pub(crate) fn agent_accept_prose_stage(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentProseStageIdPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_accept_prose_stage_impl(db, payload))
}

#[tauri::command]
pub(crate) fn agent_discard_prose_stage(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentProseStageIdPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_discard_prose_stage_impl(db, payload))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentUndoJournalPayload {
    pub project_id: String,
    pub session_id: String,
    pub journal_id: String,
    /// "undo" | "redo"
    pub direction: String,
}

fn undo_journal_change_event(
    row: &grimodex_core::undo_journal::UndoJournalRow,
    direction: &str,
) -> anyhow::Result<(String, String, String, String)> {
    let (domain, entity_type, create_op, delete_op, update_op) = match row.entity_kind.as_str() {
        "codex_entry" => (
            "codex",
            "codex_entry",
            "entry.create",
            "entry.delete",
            "entry.update",
        ),
        "snippet" => (
            "snippet",
            "snippet",
            "snippet.create",
            "snippet.delete",
            "snippet.update",
        ),
        "foreshadow" => (
            "foreshadow",
            "foreshadow",
            "foreshadow.create",
            "foreshadow.delete",
            "foreshadow.update",
        ),
        "event" => (
            "event",
            "event",
            "event.create",
            "event.delete",
            "event.update",
        ),
        other => anyhow::bail!("undo_journal_change_event: unsupported entity_kind '{other}'"),
    };
    let op_type = match (direction, row.op_kind.as_str()) {
        ("undo", "create") => delete_op,
        ("redo", "create") => create_op,
        // Tracked deletes (currently only `event`): undoing a delete re-creates,
        // redoing it deletes again.
        ("undo", "delete") => create_op,
        ("redo", "delete") => delete_op,
        ("undo", "update") | ("redo", "update") => update_op,
        (dir, op) => anyhow::bail!("undo_journal_change_event: unsupported {dir}/{op}"),
    };
    Ok((
        domain.to_string(),
        entity_type.to_string(),
        op_type.to_string(),
        row.entity_id.clone(),
    ))
}

fn agent_undo_journal_impl(
    db: &Database,
    payload: AgentUndoJournalPayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<()> {
            let row = grimodex_core::undo_journal::load_undo_journal(
                conn,
                &payload.project_id,
                &payload.journal_id,
            )?;
            // Chronicle events carry a composite snapshot (eventData +
            // participants + sceneLinks + relations) that the single-table
            // grimodex-core restorers don't understand, so they're handled by
            // the local event restorers; everything else delegates to core.
            if row.entity_kind == "event" {
                match payload.direction.as_str() {
                    "undo" => revert_event_undo_in_tx(conn, &payload.project_id, &row)?,
                    "redo" => apply_event_redo_in_tx(conn, &payload.project_id, &row)?,
                    other => anyhow::bail!("invalid undo direction: {other}"),
                }
            } else {
                match payload.direction.as_str() {
                    "undo" => grimodex_core::undo_journal::revert_undo_journal_in_tx(
                        conn,
                        &payload.project_id,
                        &payload.journal_id,
                    )?,
                    "redo" => grimodex_core::undo_journal::apply_undo_journal_in_tx(
                        conn,
                        &payload.project_id,
                        &payload.journal_id,
                    )?,
                    other => anyhow::bail!("invalid undo direction: {other}"),
                }
            }
            let (domain, entity_type, op_type, entity_id) =
                undo_journal_change_event(&row, &payload.direction)?;
            let event_uid = uuid::Uuid::new_v4().to_string();
            let timestamp = chrono::Utc::now().timestamp_millis();
            let change_payload = json!({
                "direction": payload.direction,
                "opKind": row.op_kind,
                "journalId": payload.journal_id,
            });
            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid,
                    scene_id: None,
                    domain,
                    op_type,
                    entity_type: Some(entity_type),
                    entity_id: Some(entity_id),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                conn.execute_batch("COMMIT")?;
                Ok(json!({ "ok": true }))
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

#[tauri::command]
pub(crate) fn agent_apply_undo_journal(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentUndoJournalPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_undo_journal_impl(db, payload))
}

// ---------------------------------------------------------------------------
// Foreshadow writes — thin adapters over grimodex-core's tracked writers
// (the same path the MCP foreshadow tools use, surface differs).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentForeshadowCreatePayload {
    project_id: String,
    session_id: String,
    title: String,
    intent: Option<String>,
    notes: Option<String>,
    load_bearing: Option<String>,
    secret: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentForeshadowUpdatePayload {
    project_id: String,
    session_id: String,
    foreshadow_id: String,
    title: Option<String>,
    intent: Option<String>,
    notes: Option<String>,
    load_bearing: Option<String>,
    payoff_confirmed: Option<bool>,
    abandoned: Option<bool>,
    secret: Option<bool>,
}

fn agent_write_result_json(res: grimodex_core::writes::WriteResult) -> anyhow::Result<Value> {
    Ok(serde_json::to_value(AgentWriteResult {
        entity_id: res.entity_id,
        version: res.version,
        change_event_uid: res.change_event_uid,
        undo_journal_id: res.undo_journal_id,
    })?)
}

fn agent_foreshadow_create_impl(
    db: &Database,
    payload: AgentForeshadowCreatePayload,
) -> anyhow::Result<Value> {
    let foreshadow_id = uuid::Uuid::new_v4().to_string();
    db.with_conn(|conn| {
        let res = grimodex_core::writes::foreshadow::tracked_foreshadow_create(
            conn,
            grimodex_core::writes::foreshadow::TrackedForeshadowCreateInput {
                project_id: &payload.project_id,
                session_id: &payload.session_id,
                surface: "in-app-agent",
                foreshadow_id: &foreshadow_id,
                title: &payload.title,
                intent: payload.intent.as_deref(),
                notes: payload.notes.as_deref(),
                load_bearing: payload.load_bearing.as_deref(),
                secret: payload.secret,
            },
        )?;
        agent_write_result_json(res)
    })
}

fn agent_foreshadow_update_impl(
    db: &Database,
    payload: AgentForeshadowUpdatePayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        grimodex_core::writes::foreshadow::tracked_foreshadow_update(
            conn,
            grimodex_core::writes::foreshadow::TrackedForeshadowUpdateInput {
                project_id: &payload.project_id,
                session_id: &payload.session_id,
                surface: "in-app-agent",
                foreshadow_id: &payload.foreshadow_id,
                patch: grimodex_core::writes::foreshadow::ForeshadowPatch {
                    title: payload.title.as_deref(),
                    intent: payload.intent.as_deref(),
                    notes: payload.notes.as_deref(),
                    load_bearing: payload.load_bearing.as_deref(),
                    payoff_confirmed: payload.payoff_confirmed,
                    abandoned: payload.abandoned,
                    secret: payload.secret,
                },
            },
        )?
        .ok_or_else(|| anyhow::anyhow!("foreshadow not found in project"))
        .and_then(agent_write_result_json)
    })
}

#[tauri::command]
pub(crate) fn agent_foreshadow_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentForeshadowCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_foreshadow_create_impl(db, payload))
}

#[tauri::command]
pub(crate) fn agent_foreshadow_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentForeshadowUpdatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_foreshadow_update_impl(db, payload))
}

// ---------------------------------------------------------------------------
// Chronicle (作中年表) writes — events + participants + scene links + relations.
// Mirrors the codex create/update/delete transaction shape. `events` has no
// version column, so undo_journal versions are fixed: create=0/1, update=1/1,
// delete=1/0. Association mutations (participants / scene links / relations)
// are modelled as op_kind="update" on the host event (base=1, result=1).
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentEventCreatePayload {
    project_id: String,
    session_id: String,
    /// 書き込み元の表面: "in-app-agent"(AI) / "mcp" / "manual"(UI手動編集)。
    /// 省略時(既存JS経路)は in-app-agent 互換。undo_journal の provenance に使う。
    surface: Option<String>,
    title: Option<String>,
    note: Option<String>,
    /// 出来事の詳細（リッチテキスト = ProseMirror JSON 文字列）。
    detail: Option<String>,
    ordinal: Option<String>,
    primary_codex_id: Option<String>,
    /// 未割当の整理用サブレーン id。
    lane_group: Option<String>,
    location_codex_id: Option<String>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    start_minute: Option<i64>,
    end_minute: Option<i64>,
    start_granularity: Option<String>,
    end_granularity: Option<String>,
    precision: Option<String>,
    kind: Option<String>,
    /// AI 秘匿（reveal アンカー方式）。省略時 false=表示。
    secret: Option<bool>,
    /// 読む順の開示アンカー（明示上書き・空/None=自動導出 or 恒久秘匿）。
    reveal_scene_id: Option<String>,
    participant_codex_ids: Option<Vec<String>>,
    scene_ids: Option<Vec<String>>,
}

/// Patch-style update. Each field is set-if-present (a missing field is left
/// untouched). Clearing a nullable column to NULL is not expressible here —
/// matches the codex update contract.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentEventUpdatePayload {
    project_id: String,
    session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    surface: Option<String>,
    event_id: String,
    title: Option<String>,
    note: Option<String>,
    /// 出来事の詳細（リッチテキスト = ProseMirror JSON 文字列）。set-if-present。
    detail: Option<String>,
    ordinal: Option<String>,
    primary_codex_id: Option<String>,
    /// 未割当の整理用サブレーン id（空文字は NULL=既定の未割当レーンへ）。
    lane_group: Option<String>,
    location_codex_id: Option<String>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    start_minute: Option<i64>,
    end_minute: Option<i64>,
    start_granularity: Option<String>,
    end_granularity: Option<String>,
    precision: Option<String>,
    kind: Option<String>,
    /// AI 秘匿（reveal アンカー方式）。set-if-present。
    secret: Option<bool>,
    /// 読む順の開示アンカー（set-if-present・空文字は NULL=自動導出へ戻す）。
    reveal_scene_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentEventIdPayload {
    project_id: String,
    session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    surface: Option<String>,
    event_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentEventParticipantsPayload {
    project_id: String,
    session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    surface: Option<String>,
    event_id: String,
    codex_entry_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSceneEventPayload {
    project_id: String,
    session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    surface: Option<String>,
    scene_id: String,
    event_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentEventRelationPayload {
    project_id: String,
    session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    surface: Option<String>,
    cause_event_id: String,
    effect_event_id: String,
}

/// Full self-contained snapshot of an event row + its participants, scene
/// links, and causal relations (both directions). Used as the undo `before`
/// for delete (cascade-restorable) and before/after for create/update.
fn collect_event_snapshot(conn: &rusqlite::Connection, event_id: &str) -> anyhow::Result<Value> {
    let event_json: String = conn.query_row(
        "SELECT json_object(
            'id', id, 'projectId', project_id, 'title', title, 'note', note,
            'detail', detail,
            'ordinal', ordinal, 'primaryCodexId', primary_codex_id,
            'laneGroup', lane_group,
            'locationCodexId', location_codex_id, 'startTime', start_time,
            'endTime', end_time, 'startMinute', start_minute,
            'endMinute', end_minute, 'startGranularity', start_granularity,
            'endGranularity', end_granularity, 'precision', precision, 'kind', kind,
            'secret', secret, 'revealSceneId', reveal_scene_id,
            'createdAt', created_at, 'updatedAt', updated_at
         ) FROM events WHERE id = ?1",
        rusqlite::params![event_id],
        |row| row.get(0),
    )?;
    let event_data: Value = serde_json::from_str(&event_json)?;

    let participants = {
        let mut stmt = conn.prepare(
            "SELECT codex_entry_id, role FROM event_participants
             WHERE event_id = ?1 ORDER BY codex_entry_id",
        )?;
        let rows = stmt.query_map(rusqlite::params![event_id], |row| {
            let codex_entry_id: String = row.get(0)?;
            let role: Option<String> = row.get(1)?;
            Ok(json!({ "codexEntryId": codex_entry_id, "role": role }))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let scene_links = {
        let mut stmt = conn
            .prepare("SELECT scene_id FROM scene_events WHERE event_id = ?1 ORDER BY scene_id")?;
        let rows = stmt.query_map(rusqlite::params![event_id], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let relations_as_cause = {
        let mut stmt = conn.prepare(
            "SELECT project_id, effect_event_id FROM event_relations
             WHERE cause_event_id = ?1 ORDER BY effect_event_id",
        )?;
        let rows = stmt.query_map(rusqlite::params![event_id], |row| {
            let project_id: String = row.get(0)?;
            let effect_event_id: String = row.get(1)?;
            Ok(json!({ "projectId": project_id, "effectEventId": effect_event_id }))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let relations_as_effect = {
        let mut stmt = conn.prepare(
            "SELECT project_id, cause_event_id FROM event_relations
             WHERE effect_event_id = ?1 ORDER BY cause_event_id",
        )?;
        let rows = stmt.query_map(rusqlite::params![event_id], |row| {
            let project_id: String = row.get(0)?;
            let cause_event_id: String = row.get(1)?;
            Ok(json!({ "projectId": project_id, "causeEventId": cause_event_id }))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    Ok(json!({
        "eventData": event_data,
        "participants": participants,
        "sceneLinks": scene_links,
        "relations": {
            "asCause": relations_as_cause,
            "asEffect": relations_as_effect,
        },
    }))
}

fn collect_participants_json(conn: &rusqlite::Connection, event_id: &str) -> anyhow::Result<Value> {
    let mut stmt = conn.prepare(
        "SELECT codex_entry_id, role FROM event_participants
         WHERE event_id = ?1 ORDER BY codex_entry_id",
    )?;
    let rows = stmt.query_map(rusqlite::params![event_id], |row| {
        let codex_entry_id: String = row.get(0)?;
        let role: Option<String> = row.get(1)?;
        Ok(json!({ "codexEntryId": codex_entry_id, "role": role }))
    })?;
    let participants = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(json!({ "eventId": event_id, "participants": participants }))
}

// ---------------------------------------------------------------------------
// Chronicle undo/redo restorers. The forward writers store either a composite
// snapshot (`{eventData, participants, sceneLinks, relations}` for
// create/delete/event-update) or an association-only snapshot
// (set_participants / scene link / relation). Restore is idempotent
// (DELETE → INSERT OR IGNORE) and always scoped to `project_id` (XPROJ).
// ---------------------------------------------------------------------------

/// Make the DB match a composite event snapshot exactly: UPSERT the event row
/// and replace its participants, scene links, and relations (both directions).
fn apply_event_composite_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    snap: &Value,
) -> anyhow::Result<()> {
    let ed = &snap["eventData"];
    let id = ed["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("event snapshot missing eventData.id"))?;
    let now = chrono::Utc::now().to_rfc3339();

    // reveal_scene_id は tree_nodes(scene) 参照。undo/redo の間に reveal シーンが
    // 削除されていると、古いスナップショットの id を UPSERT すると FK 失敗で undo が
    // bail する。参照先が無ければ NULL へフォールバック（spec §2.1・ON DELETE SET
    // NULL と同じ「自動導出へ戻す」挙動）。
    let reveal_scene_id: Option<String> = match ed["revealSceneId"].as_str() {
        Some(sid) => {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![sid, project_id],
                |r| r.get(0),
            )?;
            if n > 0 {
                Some(sid.to_string())
            } else {
                None
            }
        }
        None => None,
    };

    conn.execute(
        "INSERT INTO events
         (id, project_id, title, note, ordinal, primary_codex_id, lane_group, location_codex_id,
          start_time, end_time, start_minute, end_minute, start_granularity,
          end_granularity, precision, kind, secret, reveal_scene_id,
          created_at, updated_at, detail)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title, note = excluded.note, detail = excluded.detail,
            ordinal = excluded.ordinal,
            primary_codex_id = excluded.primary_codex_id,
            lane_group = excluded.lane_group,
            location_codex_id = excluded.location_codex_id,
            start_time = excluded.start_time, end_time = excluded.end_time,
            start_minute = excluded.start_minute, end_minute = excluded.end_minute,
            start_granularity = excluded.start_granularity,
            end_granularity = excluded.end_granularity,
            precision = excluded.precision, kind = excluded.kind,
            secret = excluded.secret, reveal_scene_id = excluded.reveal_scene_id,
            updated_at = excluded.updated_at",
        rusqlite::params![
            id,
            project_id,
            ed["title"].as_str().unwrap_or(""),
            ed["note"].as_str(),
            ed["ordinal"].as_str().unwrap_or("a0"),
            ed["primaryCodexId"].as_str(),
            ed["laneGroup"].as_str(),
            ed["locationCodexId"].as_str(),
            ed["startTime"].as_i64(),
            ed["endTime"].as_i64(),
            ed["startMinute"].as_i64(),
            ed["endMinute"].as_i64(),
            ed["startGranularity"].as_str().unwrap_or("none"),
            ed["endGranularity"].as_str().unwrap_or("none"),
            ed["precision"].as_str().unwrap_or("exact"),
            ed["kind"].as_str().unwrap_or("generic"),
            ed["secret"].as_i64().unwrap_or(0),
            reveal_scene_id,
            ed["createdAt"].as_str().unwrap_or(&now),
            ed["updatedAt"].as_str().unwrap_or(&now),
            ed["detail"].as_str(),
        ],
    )?;

    conn.execute(
        "DELETE FROM event_participants WHERE event_id = ?1",
        rusqlite::params![id],
    )?;
    if let Some(arr) = snap["participants"].as_array() {
        for p in arr {
            if let Some(codex_id) = p["codexEntryId"].as_str() {
                conn.execute(
                    "INSERT OR IGNORE INTO event_participants (event_id, codex_entry_id, role)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![id, codex_id, p["role"].as_str()],
                )?;
            }
        }
    }

    conn.execute(
        "DELETE FROM scene_events WHERE event_id = ?1",
        rusqlite::params![id],
    )?;
    if let Some(arr) = snap["sceneLinks"].as_array() {
        for s in arr {
            if let Some(scene_id) = s.as_str() {
                conn.execute(
                    "INSERT OR IGNORE INTO scene_events (scene_id, event_id) VALUES (?1, ?2)",
                    rusqlite::params![scene_id, id],
                )?;
            }
        }
    }

    conn.execute(
        "DELETE FROM event_relations WHERE cause_event_id = ?1 OR effect_event_id = ?1",
        rusqlite::params![id],
    )?;
    if let Some(arr) = snap["relations"]["asCause"].as_array() {
        for r in arr {
            if let Some(effect) = r["effectEventId"].as_str() {
                let proj = r["projectId"].as_str().unwrap_or(project_id);
                conn.execute(
                    "INSERT OR IGNORE INTO event_relations
                     (project_id, cause_event_id, effect_event_id) VALUES (?1, ?2, ?3)",
                    rusqlite::params![proj, id, effect],
                )?;
            }
        }
    }
    if let Some(arr) = snap["relations"]["asEffect"].as_array() {
        for r in arr {
            if let Some(cause) = r["causeEventId"].as_str() {
                let proj = r["projectId"].as_str().unwrap_or(project_id);
                conn.execute(
                    "INSERT OR IGNORE INTO event_relations
                     (project_id, cause_event_id, effect_event_id) VALUES (?1, ?2, ?3)",
                    rusqlite::params![proj, cause, id],
                )?;
            }
        }
    }
    Ok(())
}

fn restore_event_participants_snapshot(
    conn: &rusqlite::Connection,
    snap: &Value,
) -> anyhow::Result<()> {
    let event_id = snap["eventId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("participants snapshot missing eventId"))?;
    conn.execute(
        "DELETE FROM event_participants WHERE event_id = ?1",
        rusqlite::params![event_id],
    )?;
    if let Some(arr) = snap["participants"].as_array() {
        for p in arr {
            if let Some(codex_id) = p["codexEntryId"].as_str() {
                conn.execute(
                    "INSERT OR IGNORE INTO event_participants (event_id, codex_entry_id, role)
                     VALUES (?1, ?2, ?3)",
                    rusqlite::params![event_id, codex_id, p["role"].as_str()],
                )?;
            }
        }
    }
    Ok(())
}

fn restore_event_scene_snapshot(conn: &rusqlite::Connection, snap: &Value) -> anyhow::Result<()> {
    let scene_id = snap["sceneId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("scene snapshot missing sceneId"))?;
    let event_id = snap["eventId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("scene snapshot missing eventId"))?;
    if snap["linked"].as_bool().unwrap_or(false) {
        conn.execute(
            "INSERT OR IGNORE INTO scene_events (scene_id, event_id) VALUES (?1, ?2)",
            rusqlite::params![scene_id, event_id],
        )?;
    } else {
        conn.execute(
            "DELETE FROM scene_events WHERE scene_id = ?1 AND event_id = ?2",
            rusqlite::params![scene_id, event_id],
        )?;
    }
    Ok(())
}

fn restore_event_relation_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    snap: &Value,
) -> anyhow::Result<()> {
    let cause = snap["causeEventId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("relation snapshot missing causeEventId"))?;
    let effect = snap["effectEventId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("relation snapshot missing effectEventId"))?;
    let proj = snap["projectId"].as_str().unwrap_or(project_id);
    if snap["linked"].as_bool().unwrap_or(false) {
        conn.execute(
            "INSERT OR IGNORE INTO event_relations
             (project_id, cause_event_id, effect_event_id) VALUES (?1, ?2, ?3)",
            rusqlite::params![proj, cause, effect],
        )?;
    } else {
        conn.execute(
            "DELETE FROM event_relations WHERE cause_event_id = ?1 AND effect_event_id = ?2",
            rusqlite::params![cause, effect],
        )?;
    }
    Ok(())
}

/// Restore an `update` op (event-update / participants / scene / relation) to a
/// target snapshot, discriminating by snapshot shape.
fn restore_event_update_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    snap: &Value,
) -> anyhow::Result<()> {
    if snap.get("eventData").is_some() {
        apply_event_composite_snapshot(conn, project_id, snap)
    } else if snap.get("causeEventId").is_some() {
        restore_event_relation_snapshot(conn, project_id, snap)
    } else if snap.get("sceneId").is_some() {
        restore_event_scene_snapshot(conn, snap)
    } else if snap.get("participants").is_some() {
        restore_event_participants_snapshot(conn, snap)
    } else {
        anyhow::bail!("restore_event_update_snapshot: unrecognized event snapshot shape")
    }
}

fn delete_event_cascade(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_id: &str,
) -> anyhow::Result<()> {
    let deleted = conn.execute(
        "DELETE FROM events WHERE id = ?1 AND project_id = ?2",
        rusqlite::params![event_id, project_id],
    )?;
    if deleted == 0 {
        anyhow::bail!("event '{event_id}' not found in project '{project_id}' during restore");
    }
    Ok(())
}

/// Undo path (global-history): invert the recorded op.
fn revert_event_undo_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    row: &grimodex_core::undo_journal::UndoJournalRow,
) -> anyhow::Result<()> {
    match row.op_kind.as_str() {
        "create" => delete_event_cascade(conn, project_id, &row.entity_id),
        "delete" => {
            let before = row
                .before_json
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("revert event delete: missing before_json"))?;
            let snap: Value = serde_json::from_str(before)?;
            apply_event_composite_snapshot(conn, project_id, &snap)
        }
        "update" => {
            let before = row
                .before_json
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("revert event update: missing before_json"))?;
            let snap: Value = serde_json::from_str(before)?;
            restore_event_update_snapshot(conn, project_id, &snap)
        }
        other => anyhow::bail!("revert event: unsupported op_kind '{other}'"),
    }
}

/// Redo path (global-history): re-apply the recorded op.
fn apply_event_redo_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    row: &grimodex_core::undo_journal::UndoJournalRow,
) -> anyhow::Result<()> {
    match row.op_kind.as_str() {
        "create" => {
            let after = row
                .after_json
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("apply event create: missing after_json"))?;
            let snap: Value = serde_json::from_str(after)?;
            apply_event_composite_snapshot(conn, project_id, &snap)
        }
        "delete" => delete_event_cascade(conn, project_id, &row.entity_id),
        "update" => {
            let after = row
                .after_json
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("apply event update: missing after_json"))?;
            let snap: Value = serde_json::from_str(after)?;
            restore_event_update_snapshot(conn, project_id, &snap)
        }
        other => anyhow::bail!("apply event: unsupported op_kind '{other}'"),
    }
}

fn agent_event_create_impl(
    db: &Database,
    payload: AgentEventCreatePayload,
) -> anyhow::Result<Value> {
    let event_id = uuid::Uuid::new_v4().to_string();
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    let title = payload.title.unwrap_or_default();
    let ordinal = payload.ordinal.unwrap_or_else(|| "a0".to_string());
    let precision = payload.precision.unwrap_or_else(|| "exact".to_string());
    let kind = payload.kind.unwrap_or_else(|| "generic".to_string());
    let start_granularity = payload
        .start_granularity
        .unwrap_or_else(|| "none".to_string());
    let end_granularity = payload
        .end_granularity
        .unwrap_or_else(|| "none".to_string());
    let participants = payload.participant_codex_ids.unwrap_or_default();
    let scene_ids = payload.scene_ids.unwrap_or_default();
    let secret = payload.secret.unwrap_or(false);
    // 空文字の reveal は NULL（自動導出/恒久秘匿）に正規化。
    let reveal_scene_id = payload.reveal_scene_id.filter(|s| !s.is_empty());

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            conn.execute(
                "INSERT INTO events
                 (id, project_id, title, note, detail, ordinal, primary_codex_id,
                  location_codex_id, start_time, end_time, start_minute, end_minute,
                  start_granularity, end_granularity, precision, kind,
                  secret, reveal_scene_id, lane_group, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20)",
                rusqlite::params![
                    event_id,
                    payload.project_id,
                    title,
                    payload.note,
                    payload.detail,
                    ordinal,
                    payload.primary_codex_id,
                    payload.location_codex_id,
                    payload.start_time,
                    payload.end_time,
                    payload.start_minute,
                    payload.end_minute,
                    start_granularity,
                    end_granularity,
                    precision,
                    kind,
                    secret,
                    reveal_scene_id,
                    payload.lane_group,
                    now,
                ],
            )?;

            for codex_id in &participants {
                conn.execute(
                    "INSERT OR IGNORE INTO event_participants (event_id, codex_entry_id, role)
                     VALUES (?1, ?2, NULL)",
                    rusqlite::params![event_id, codex_id],
                )?;
            }
            for scene_id in &scene_ids {
                conn.execute(
                    "INSERT OR IGNORE INTO scene_events (scene_id, event_id)
                     VALUES (?1, ?2)",
                    rusqlite::params![scene_id, event_id],
                )?;
            }

            let after = collect_event_snapshot(conn, &event_id)?.to_string();

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: payload.surface.as_deref().unwrap_or("in-app-agent"),
                    entity_kind: "event",
                    entity_id: &event_id,
                    op_kind: "create",
                    before_json: None,
                    after_json: Some(&after),
                    base_version: 0,
                    result_version: 1,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "event".to_string(),
                    op_type: "event.create".to_string(),
                    entity_type: Some("event".to_string()),
                    entity_id: Some(event_id.clone()),
                    payload: json!({ "title": title, "kind": kind }).to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: event_id.clone(),
                version: 1,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

fn agent_event_update_impl(
    db: &Database,
    payload: AgentEventUpdatePayload,
) -> anyhow::Result<Value> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.event_id, payload.project_id],
                |r| r.get(0),
            )?;
            if exists == 0 {
                anyhow::bail!(
                    "event '{}' not found in project '{}'",
                    payload.event_id,
                    payload.project_id
                );
            }

            let before = collect_event_snapshot(conn, &payload.event_id)?.to_string();

            let mut sets = vec!["updated_at = ?1".to_string()];
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now.clone())];
            let mut param_idx = 2;
            let mut fields: Vec<&str> = Vec::new();

            if let Some(ref v) = payload.title {
                sets.push(format!("title = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("title");
            }
            if let Some(ref v) = payload.note {
                sets.push(format!("note = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("note");
            }
            if let Some(ref v) = payload.detail {
                sets.push(format!("detail = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("detail");
            }
            if let Some(ref v) = payload.ordinal {
                sets.push(format!("ordinal = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("ordinal");
            }
            if let Some(ref v) = payload.primary_codex_id {
                // 空文字は NULL（未割当へ戻す）に正規化。Option<String> では null と
                // 未指定を区別できないため、UI は未割当化に "" を送る（reveal_scene_id と同流儀）。
                let val: Option<String> = if v.is_empty() { None } else { Some(v.clone()) };
                sets.push(format!("primary_codex_id = ?{param_idx}"));
                params.push(Box::new(val));
                param_idx += 1;
                fields.push("primaryCodexId");
            }
            if let Some(ref v) = payload.lane_group {
                // 空文字は NULL（既定の未割当レーンへ）に正規化。
                let val: Option<String> = if v.is_empty() { None } else { Some(v.clone()) };
                sets.push(format!("lane_group = ?{param_idx}"));
                params.push(Box::new(val));
                param_idx += 1;
                fields.push("laneGroup");
            }
            if let Some(ref v) = payload.location_codex_id {
                // 空文字は NULL（場所なし）に正規化。
                let val: Option<String> = if v.is_empty() { None } else { Some(v.clone()) };
                sets.push(format!("location_codex_id = ?{param_idx}"));
                params.push(Box::new(val));
                param_idx += 1;
                fields.push("locationCodexId");
            }
            if let Some(v) = payload.start_time {
                sets.push(format!("start_time = ?{param_idx}"));
                params.push(Box::new(v));
                param_idx += 1;
                fields.push("startTime");
            }
            if let Some(v) = payload.end_time {
                sets.push(format!("end_time = ?{param_idx}"));
                params.push(Box::new(v));
                param_idx += 1;
                fields.push("endTime");
            }
            if let Some(v) = payload.start_minute {
                sets.push(format!("start_minute = ?{param_idx}"));
                params.push(Box::new(v));
                param_idx += 1;
                fields.push("startMinute");
            }
            if let Some(v) = payload.end_minute {
                sets.push(format!("end_minute = ?{param_idx}"));
                params.push(Box::new(v));
                param_idx += 1;
                fields.push("endMinute");
            }
            if let Some(ref v) = payload.start_granularity {
                sets.push(format!("start_granularity = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("startGranularity");
            }
            if let Some(ref v) = payload.end_granularity {
                sets.push(format!("end_granularity = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("endGranularity");
            }
            if let Some(ref v) = payload.precision {
                sets.push(format!("precision = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("precision");
            }
            if let Some(ref v) = payload.kind {
                sets.push(format!("kind = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("kind");
            }
            if let Some(v) = payload.secret {
                sets.push(format!("secret = ?{param_idx}"));
                params.push(Box::new(v));
                param_idx += 1;
                fields.push("secret");
            }
            if let Some(ref v) = payload.reveal_scene_id {
                // 空文字は NULL（自動導出/恒久秘匿）に正規化。
                let val: Option<String> = if v.is_empty() { None } else { Some(v.clone()) };
                sets.push(format!("reveal_scene_id = ?{param_idx}"));
                params.push(Box::new(val));
                param_idx += 1;
                fields.push("revealSceneId");
            }

            // 粒度 "none" は「その端点の時刻が存在しない」を意味する。UI の「点にする」/
            // 粒度=none は endTime/startTime:null を送るが、Option<i64> では null と未指定を
            // 区別できず end_time が SET 句に乗らずクリアされない（点へ変更しても期間に戻る）。
            // 粒度をシグナルに、対応する time/minute を明示的に NULL へ落とす（時刻値が
            // 同時指定された場合はそちらを優先＝二重 SET しない）。
            if payload.end_granularity.as_deref() == Some("none") {
                if !fields.contains(&"endTime") {
                    sets.push("end_time = NULL".to_string());
                    fields.push("endTime");
                }
                if !fields.contains(&"endMinute") {
                    sets.push("end_minute = NULL".to_string());
                    fields.push("endMinute");
                }
            }
            if payload.start_granularity.as_deref() == Some("none") {
                if !fields.contains(&"startTime") {
                    sets.push("start_time = NULL".to_string());
                    fields.push("startTime");
                }
                if !fields.contains(&"startMinute") {
                    sets.push("start_minute = NULL".to_string());
                    fields.push("startMinute");
                }
            }

            let sql = format!(
                "UPDATE events SET {} WHERE id = ?{param_idx} AND project_id = ?{}",
                sets.join(", "),
                param_idx + 1
            );
            params.push(Box::new(payload.event_id.clone()));
            params.push(Box::new(payload.project_id.clone()));

            let updated = conn.execute(
                &sql,
                rusqlite::params_from_iter(params.iter().map(|p| p as &dyn rusqlite::types::ToSql)),
            )?;
            if updated == 0 {
                anyhow::bail!(
                    "event '{}' not found in project '{}'",
                    payload.event_id,
                    payload.project_id
                );
            }

            let after = collect_event_snapshot(conn, &payload.event_id)?.to_string();

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: payload.surface.as_deref().unwrap_or("in-app-agent"),
                    entity_kind: "event",
                    entity_id: &payload.event_id,
                    op_kind: "update",
                    before_json: Some(&before),
                    after_json: Some(&after),
                    base_version: 1,
                    result_version: 1,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "event".to_string(),
                    op_type: "event.update".to_string(),
                    entity_type: Some("event".to_string()),
                    entity_id: Some(payload.event_id.clone()),
                    payload: json!({ "fields": fields }).to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.event_id.clone(),
                version: 1,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

fn agent_event_delete_impl(db: &Database, payload: AgentEventIdPayload) -> anyhow::Result<Value> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.event_id, payload.project_id],
                |r| r.get(0),
            )?;
            if exists == 0 {
                anyhow::bail!(
                    "event '{}' not found in project '{}'",
                    payload.event_id,
                    payload.project_id
                );
            }

            // Capture the full cascade snapshot BEFORE the DELETE fires the
            // ON DELETE CASCADE on participants / scene_events / relations.
            let before_value = collect_event_snapshot(conn, &payload.event_id)?;
            let title = before_value["eventData"]["title"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let before = before_value.to_string();

            let deleted = conn.execute(
                "DELETE FROM events WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.event_id, payload.project_id],
            )?;
            if deleted == 0 {
                anyhow::bail!(
                    "event '{}' not found in project '{}'",
                    payload.event_id,
                    payload.project_id
                );
            }

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: payload.surface.as_deref().unwrap_or("in-app-agent"),
                    entity_kind: "event",
                    entity_id: &payload.event_id,
                    op_kind: "delete",
                    before_json: Some(&before),
                    after_json: None,
                    base_version: 1,
                    result_version: 0,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "event".to_string(),
                    op_type: "event.delete".to_string(),
                    entity_type: Some("event".to_string()),
                    entity_id: Some(payload.event_id.clone()),
                    payload: json!({ "title": title }).to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.event_id.clone(),
                version: 0,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

fn agent_event_set_participants_impl(
    db: &Database,
    payload: AgentEventParticipantsPayload,
) -> anyhow::Result<Value> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.event_id, payload.project_id],
                |r| r.get(0),
            )?;
            if exists == 0 {
                anyhow::bail!(
                    "event '{}' not found in project '{}'",
                    payload.event_id,
                    payload.project_id
                );
            }

            let before = collect_participants_json(conn, &payload.event_id)?.to_string();

            conn.execute(
                "DELETE FROM event_participants WHERE event_id = ?1",
                rusqlite::params![payload.event_id],
            )?;
            for codex_id in &payload.codex_entry_ids {
                conn.execute(
                    "INSERT OR IGNORE INTO event_participants (event_id, codex_entry_id, role)
                     VALUES (?1, ?2, NULL)",
                    rusqlite::params![payload.event_id, codex_id],
                )?;
            }

            let after = collect_participants_json(conn, &payload.event_id)?.to_string();

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: payload.surface.as_deref().unwrap_or("in-app-agent"),
                    entity_kind: "event",
                    entity_id: &payload.event_id,
                    op_kind: "update",
                    before_json: Some(&before),
                    after_json: Some(&after),
                    base_version: 1,
                    result_version: 1,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "event".to_string(),
                    op_type: "event.participants".to_string(),
                    entity_type: Some("event".to_string()),
                    entity_id: Some(payload.event_id.clone()),
                    payload: json!({
                        "eventId": payload.event_id,
                        "codexEntryIds": payload.codex_entry_ids,
                    })
                    .to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.event_id.clone(),
                version: 1,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

fn agent_scene_event_mutate_impl(
    db: &Database,
    payload: AgentSceneEventPayload,
    link: bool,
) -> anyhow::Result<Value> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let scene_ok: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.scene_id, payload.project_id],
                |r| r.get(0),
            )?;
            if scene_ok == 0 {
                anyhow::bail!(
                    "scene '{}' not found in project '{}'",
                    payload.scene_id,
                    payload.project_id
                );
            }
            let event_ok: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.event_id, payload.project_id],
                |r| r.get(0),
            )?;
            if event_ok == 0 {
                anyhow::bail!(
                    "event '{}' not found in project '{}'",
                    payload.event_id,
                    payload.project_id
                );
            }

            let existed: i64 = conn.query_row(
                "SELECT COUNT(*) FROM scene_events WHERE scene_id = ?1 AND event_id = ?2",
                rusqlite::params![payload.scene_id, payload.event_id],
                |r| r.get(0),
            )?;
            let before = json!({
                "sceneId": payload.scene_id,
                "eventId": payload.event_id,
                "linked": existed > 0,
            })
            .to_string();

            if link {
                conn.execute(
                    "INSERT OR IGNORE INTO scene_events (scene_id, event_id) VALUES (?1, ?2)",
                    rusqlite::params![payload.scene_id, payload.event_id],
                )?;
            } else {
                conn.execute(
                    "DELETE FROM scene_events WHERE scene_id = ?1 AND event_id = ?2",
                    rusqlite::params![payload.scene_id, payload.event_id],
                )?;
            }

            let after = json!({
                "sceneId": payload.scene_id,
                "eventId": payload.event_id,
                "linked": link,
            })
            .to_string();

            let op_type = if link { "event.stamp" } else { "event.unstamp" };

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: payload.surface.as_deref().unwrap_or("in-app-agent"),
                    entity_kind: "event",
                    entity_id: &payload.event_id,
                    op_kind: "update",
                    before_json: Some(&before),
                    after_json: Some(&after),
                    base_version: 1,
                    result_version: 1,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: Some(payload.scene_id.clone()),
                    domain: "event".to_string(),
                    op_type: op_type.to_string(),
                    entity_type: Some("event".to_string()),
                    entity_id: Some(payload.event_id.clone()),
                    payload: json!({
                        "sceneId": payload.scene_id,
                        "eventId": payload.event_id,
                    })
                    .to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.event_id.clone(),
                version: 1,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

fn agent_event_relation_mutate_impl(
    db: &Database,
    payload: AgentEventRelationPayload,
    add: bool,
) -> anyhow::Result<Value> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            if payload.cause_event_id == payload.effect_event_id {
                anyhow::bail!("self-loop event relation forbidden");
            }
            let cause_ok: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.cause_event_id, payload.project_id],
                |r| r.get(0),
            )?;
            if cause_ok == 0 {
                anyhow::bail!(
                    "cause event '{}' not found in project '{}'",
                    payload.cause_event_id,
                    payload.project_id
                );
            }
            let effect_ok: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.effect_event_id, payload.project_id],
                |r| r.get(0),
            )?;
            if effect_ok == 0 {
                anyhow::bail!(
                    "effect event '{}' not found in project '{}'",
                    payload.effect_event_id,
                    payload.project_id
                );
            }

            let existed: i64 = conn.query_row(
                "SELECT COUNT(*) FROM event_relations
                 WHERE cause_event_id = ?1 AND effect_event_id = ?2",
                rusqlite::params![payload.cause_event_id, payload.effect_event_id],
                |r| r.get(0),
            )?;
            let before = json!({
                "projectId": payload.project_id,
                "causeEventId": payload.cause_event_id,
                "effectEventId": payload.effect_event_id,
                "linked": existed > 0,
            })
            .to_string();

            if add {
                conn.execute(
                    "INSERT OR IGNORE INTO event_relations
                     (project_id, cause_event_id, effect_event_id) VALUES (?1, ?2, ?3)",
                    rusqlite::params![
                        payload.project_id,
                        payload.cause_event_id,
                        payload.effect_event_id
                    ],
                )?;
            } else {
                conn.execute(
                    "DELETE FROM event_relations
                     WHERE cause_event_id = ?1 AND effect_event_id = ?2",
                    rusqlite::params![payload.cause_event_id, payload.effect_event_id],
                )?;
            }

            let after = json!({
                "projectId": payload.project_id,
                "causeEventId": payload.cause_event_id,
                "effectEventId": payload.effect_event_id,
                "linked": add,
            })
            .to_string();

            let op_type = if add {
                "event.relation_add"
            } else {
                "event.relation_remove"
            };

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: payload.surface.as_deref().unwrap_or("in-app-agent"),
                    entity_kind: "event",
                    entity_id: &payload.cause_event_id,
                    op_kind: "update",
                    before_json: Some(&before),
                    after_json: Some(&after),
                    base_version: 1,
                    result_version: 1,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "event".to_string(),
                    op_type: op_type.to_string(),
                    entity_type: Some("event".to_string()),
                    entity_id: Some(payload.cause_event_id.clone()),
                    payload: json!({
                        "causeEventId": payload.cause_event_id,
                        "effectEventId": payload.effect_event_id,
                    })
                    .to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.cause_event_id.clone(),
                version: 1,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                conn.execute_batch("COMMIT")?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

#[tauri::command]
pub(crate) fn agent_event_create(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentEventCreatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_event_create_impl(db, payload))
}

#[tauri::command]
pub(crate) fn agent_event_update(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentEventUpdatePayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_event_update_impl(db, payload))
}

#[tauri::command]
pub(crate) fn agent_event_delete(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentEventIdPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| agent_event_delete_impl(db, payload))
}

#[tauri::command]
pub(crate) fn agent_event_set_participants(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentEventParticipantsPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_event_set_participants_impl(db, payload)
    })
}

#[tauri::command]
pub(crate) fn agent_scene_event_link(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentSceneEventPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_scene_event_mutate_impl(db, payload, true)
    })
}

#[tauri::command]
pub(crate) fn agent_scene_event_unlink(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentSceneEventPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_scene_event_mutate_impl(db, payload, false)
    })
}

#[tauri::command]
pub(crate) fn agent_event_relation_add(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentEventRelationPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_event_relation_mutate_impl(db, payload, true)
    })
}

#[tauri::command]
pub(crate) fn agent_event_relation_remove(
    ws_state: tauri::State<'_, WorkspaceState>,
    payload: AgentEventRelationPayload,
) -> Result<Value, AppError> {
    with_db(&ws_state, |db| {
        agent_event_relation_mutate_impl(db, payload, false)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use std::path::Path;

    /// Same contract snapshots the grimodex-core (MCP path) tests assert —
    /// this is the in-app mirror side of the parity gate.
    const CODEX_FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/features/agent-writes/parity/codexCreate.fixture.json"
    ));
    const PROSE_FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../src/features/agent-writes/parity/proseStaging.fixture.json"
    ));

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        db
    }

    fn insert_project(db: &Database) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO projects (id, title) VALUES (?, 'Test')",
            &[Value::String(id.clone())],
            "run",
        )
        .expect("insert project");
        id
    }

    fn insert_scene(db: &Database, project_id: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES (?, ?, 'scene', 'Scene', '{}', 'a0')",
            &[
                Value::String(id.clone()),
                Value::String(project_id.to_string()),
            ],
            "run",
        )
        .expect("insert scene");
        id
    }

    fn json_keys(v: &serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }

    fn fixture_keys(v: &serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap().to_string())
            .collect();
        keys.sort();
        keys
    }

    #[test]
    fn codex_create_matches_parity_fixture_in_app() {
        let fixture: serde_json::Value = serde_json::from_str(CODEX_FIXTURE).unwrap();
        let db = test_db();
        let project_id = insert_project(&db);

        agent_codex_create_impl(
            &db,
            AgentCodexCreatePayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                type_slug: "character".to_string(),
                name: "Alice".to_string(),
                summary: Some("summary".to_string()),
                content: None,
                aliases: None,
                parent_id: None,
                source_chat_message_id: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: vec![AuthorshipSpanInput {
                    from_pos: 0,
                    to_pos: 7,
                    source: fixture["authorshipSpan"]["source"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                    model: None,
                    chat_msg_id: None,
                    trace_id: None,
                }],
            },
        )
        .unwrap();

        db.with_conn(|conn| {
            // changeEvent contract
            let ce = &fixture["changeEvent"];
            let (domain, op_type, entity_type, payload): (String, String, String, String) = conn
                .query_row(
                    "SELECT domain, op_type, entity_type, payload FROM change_events",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;
            assert_eq!(domain, ce["domain"].as_str().unwrap());
            assert_eq!(op_type, ce["opType"].as_str().unwrap());
            assert_eq!(entity_type, ce["entityType"].as_str().unwrap());
            let payload: serde_json::Value = serde_json::from_str(&payload)?;
            assert_eq!(
                json_keys(&payload),
                fixture_keys(&ce["payloadKeys"]),
                "in-app change_event payload keys drifted from the parity fixture"
            );

            // undoJournal contract
            let uj = &fixture["undoJournal"];
            let (entity_kind, op_kind, before, after): (String, String, Option<String>, String) =
                conn.query_row(
                    "SELECT entity_kind, op_kind, before_json, after_json FROM undo_journal",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;
            assert_eq!(entity_kind, uj["entityKind"].as_str().unwrap());
            assert_eq!(op_kind, uj["opKind"].as_str().unwrap());
            assert!(uj["beforeJson"].is_null() == before.is_none());
            let after: serde_json::Value = serde_json::from_str(&after)?;
            for key in fixture_keys(&uj["afterJsonKeys"]) {
                assert!(
                    after.get(&key).is_some(),
                    "in-app after_json is missing fixture key '{key}'"
                );
            }

            // authorshipSpan contract
            let span_fixture = &fixture["authorshipSpan"];
            let owner_lane = span_fixture["ownerLane"].as_str().unwrap();
            let owner: Option<String> = conn.query_row(
                &format!("SELECT {owner_lane} FROM authorship_spans"),
                [],
                |r| r.get(0),
            )?;
            assert!(owner.is_some(), "in-app span owner lane drifted");
            let source: String =
                conn.query_row("SELECT source FROM authorship_spans", [], |r| r.get(0))?;
            assert_eq!(source, span_fixture["source"].as_str().unwrap());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn prose_propose_matches_parity_fixture_in_app() {
        let fixture: serde_json::Value = serde_json::from_str(PROSE_FIXTURE).unwrap();
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_id = insert_scene(&db, &project_id);

        let surface = "in-app-agent";
        assert!(
            fixture["sourceSurfaces"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s.as_str() == Some(surface)),
            "surface '{surface}' must be declared in the parity fixture"
        );

        agent_propose_scene_body_impl(
            &db,
            AgentProposeSceneBodyPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                scene_id: scene_id.clone(),
                proposed_content: "new prose".to_string(),
                mode: "append".to_string(),
                source_surface: surface.to_string(),
                replace_from: None,
                replace_to: None,
            },
        )
        .unwrap();

        db.with_conn(|conn| {
            let (status, source_surface, content): (String, String, String) = conn.query_row(
                "SELECT status, source_surface, proposed_content FROM prose_staging",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            assert_eq!(status, fixture["status"].as_str().unwrap());
            assert_eq!(source_surface, surface);

            // proposed_content keys: required keys present, every key known.
            let content: serde_json::Value = serde_json::from_str(&content)?;
            let keys = json_keys(&content);
            let required = fixture_keys(&fixture["proposedContent"]["requiredKeys"]);
            let optional = fixture_keys(&fixture["proposedContent"]["optionalKeys"]);
            for key in &required {
                assert!(keys.contains(key), "required key '{key}' missing: {keys:?}");
            }
            for key in &keys {
                assert!(
                    required.contains(key) || optional.contains(key),
                    "in-app proposed_content emits unknown key '{key}' — \
                     update the parity fixture AND the MCP consumer contract together"
                );
            }

            // changeEvent contract
            let ce = &fixture["changeEvent"];
            let (domain, op_type, entity_type, payload): (String, String, String, String) = conn
                .query_row(
                    "SELECT domain, op_type, entity_type, payload FROM change_events",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;
            assert_eq!(domain, ce["domain"].as_str().unwrap());
            assert_eq!(op_type, ce["opType"].as_str().unwrap());
            assert_eq!(entity_type, ce["entityType"].as_str().unwrap());
            let payload: serde_json::Value = serde_json::from_str(&payload)?;
            assert_eq!(json_keys(&payload), fixture_keys(&ce["payloadKeys"]));
            Ok(())
        })
        .unwrap();
    }

    fn journal_row(
        entity_kind: &str,
        op_kind: &str,
    ) -> grimodex_core::undo_journal::UndoJournalRow {
        grimodex_core::undo_journal::UndoJournalRow {
            id: "j1".to_string(),
            project_id: "p1".to_string(),
            entity_kind: entity_kind.to_string(),
            entity_id: "f1".to_string(),
            op_kind: op_kind.to_string(),
            before_json: None,
            after_json: None,
            base_version: 0,
            result_version: 1,
        }
    }

    #[test]
    fn undo_journal_change_event_supports_foreshadow() {
        // Undoing a create emits a delete-shaped event; redo re-emits create.
        let (domain, entity_type, op_type, entity_id) =
            undo_journal_change_event(&journal_row("foreshadow", "create"), "undo").unwrap();
        assert_eq!(domain, "foreshadow");
        assert_eq!(entity_type, "foreshadow");
        assert_eq!(op_type, "foreshadow.delete");
        assert_eq!(entity_id, "f1");

        let (_, _, op_type, _) =
            undo_journal_change_event(&journal_row("foreshadow", "create"), "redo").unwrap();
        assert_eq!(op_type, "foreshadow.create");

        let (_, _, op_type, _) =
            undo_journal_change_event(&journal_row("foreshadow", "update"), "undo").unwrap();
        assert_eq!(op_type, "foreshadow.update");
    }

    #[test]
    fn foreshadow_create_in_app_is_tracked() {
        let db = test_db();
        let project_id = insert_project(&db);

        let res = agent_foreshadow_create_impl(
            &db,
            AgentForeshadowCreatePayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                title: "刻印の謎".to_string(),
                intent: Some("後段で回収".to_string()),
                notes: None,
                load_bearing: Some("critical".to_string()),
                secret: true,
            },
        )
        .unwrap();
        // camelCase AgentWriteResult shape (same contract codex/snippet return).
        let entity_id = res["entityId"].as_str().expect("entityId").to_string();
        assert!(res["undoJournalId"].as_str().is_some());
        assert!(res["changeEventUid"].as_str().is_some());

        db.with_conn(|conn| {
            let (title, secret): (String, i64) = conn.query_row(
                "SELECT title, secret FROM foreshadows WHERE id = ?1",
                rusqlite::params![entity_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!(title, "刻印の謎");
            assert_eq!(secret, 1);
            let (domain, op_type, session): (String, String, String) = conn.query_row(
                "SELECT domain, op_type, session_id FROM change_events",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            assert_eq!(domain, "foreshadow");
            assert_eq!(op_type, "foreshadow.create");
            assert_eq!(session, "sess");
            let surface: String =
                conn.query_row("SELECT surface FROM undo_journal", [], |r| r.get(0))?;
            assert_eq!(surface, "in-app-agent");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn foreshadow_update_in_app_patches_and_tracks() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow_row(&db, &project_id);

        agent_foreshadow_update_impl(
            &db,
            AgentForeshadowUpdatePayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                foreshadow_id: foreshadow_id.clone(),
                title: None,
                intent: None,
                notes: None,
                load_bearing: None,
                payoff_confirmed: Some(true),
                abandoned: None,
                secret: None,
            },
        )
        .unwrap();

        db.with_conn(|conn| {
            let payoff: i64 = conn.query_row(
                "SELECT payoff_confirmed FROM foreshadows WHERE id = ?1",
                rusqlite::params![foreshadow_id],
                |r| r.get(0),
            )?;
            assert_eq!(payoff, 1);
            let op_type: String =
                conn.query_row("SELECT op_type FROM change_events", [], |r| r.get(0))?;
            assert_eq!(op_type, "foreshadow.update");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn foreshadow_update_in_app_not_found_errors_and_writes_nothing() {
        let db = test_db();
        let project_id = insert_project(&db);

        let res = agent_foreshadow_update_impl(
            &db,
            AgentForeshadowUpdatePayload {
                project_id,
                session_id: "sess".to_string(),
                foreshadow_id: "ghost".to_string(),
                title: Some("x".to_string()),
                intent: None,
                notes: None,
                load_bearing: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
            },
        );
        assert!(res.is_err());
        db.with_conn(|conn| {
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM change_events", [], |r| r.get(0))?;
            assert_eq!(n, 0);
            Ok(())
        })
        .unwrap();
    }

    fn insert_foreshadow_row(db: &Database, project_id: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        db.execute(
            "INSERT INTO foreshadows (id, project_id, title, payoff_confirmed, abandoned, secret, created_at, updated_at)
             VALUES (?, ?, 'Seed', 0, 0, 0, ?, ?)",
            &[
                Value::String(id.clone()),
                Value::String(project_id.to_string()),
                Value::Number(now.into()),
                Value::Number(now.into()),
            ],
            "run",
        )
        .expect("insert foreshadow");
        id
    }

    // ---- Chronicle (event) round-trip helpers -----------------------------

    fn insert_codex(db: &Database, project_id: &str, name: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO codex_entries
             (id, project_id, type, name, summary, content, version, created_at, updated_at)
             VALUES (?, ?, 'character', ?, '', '{}', 1, datetime('now'), datetime('now'))",
            &[
                Value::String(id.clone()),
                Value::String(project_id.to_string()),
                Value::String(name.to_string()),
            ],
            "run",
        )
        .expect("insert codex");
        id
    }

    fn undo_payload(
        project_id: &str,
        journal_id: &str,
        direction: &str,
    ) -> AgentUndoJournalPayload {
        AgentUndoJournalPayload {
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            journal_id: journal_id.to_string(),
            direction: direction.to_string(),
        }
    }

    fn relation_payload(project_id: &str, cause: &str, effect: &str) -> AgentEventRelationPayload {
        AgentEventRelationPayload {
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            surface: None,
            cause_event_id: cause.to_string(),
            effect_event_id: effect.to_string(),
        }
    }

    fn scene_payload(project_id: &str, scene_id: &str, event_id: &str) -> AgentSceneEventPayload {
        AgentSceneEventPayload {
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            surface: None,
            scene_id: scene_id.to_string(),
            event_id: event_id.to_string(),
        }
    }

    fn empty_update(project_id: &str, event_id: &str) -> AgentEventUpdatePayload {
        AgentEventUpdatePayload {
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            surface: None,
            event_id: event_id.to_string(),
            title: None,
            note: None,
            detail: None,
            ordinal: None,
            primary_codex_id: None,
            lane_group: None,
            location_codex_id: None,
            start_time: None,
            end_time: None,
            start_minute: None,
            end_minute: None,
            start_granularity: None,
            end_granularity: None,
            precision: None,
            kind: None,
            secret: None,
            reveal_scene_id: None,
        }
    }

    /// Create an event and return (event_id, undo_journal_id).
    fn create_event(
        db: &Database,
        project_id: &str,
        title: &str,
        participants: Vec<String>,
        scenes: Vec<String>,
    ) -> (String, String) {
        let res = agent_event_create_impl(
            db,
            AgentEventCreatePayload {
                project_id: project_id.to_string(),
                session_id: "sess".to_string(),
                surface: None,
                title: Some(title.to_string()),
                note: None,
                detail: None,
                ordinal: None,
                primary_codex_id: None,
                lane_group: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                precision: None,
                kind: None,
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: (!participants.is_empty()).then_some(participants),
                scene_ids: (!scenes.is_empty()).then_some(scenes),
            },
        )
        .expect("create event");
        (
            res["entityId"].as_str().expect("entityId").to_string(),
            res["undoJournalId"]
                .as_str()
                .expect("undoJournalId")
                .to_string(),
        )
    }

    fn journal_surface(db: &Database, journal_id: &str) -> String {
        db.with_conn(|conn| {
            let s: String = conn.query_row(
                "SELECT surface FROM undo_journal WHERE id = ?1",
                rusqlite::params![journal_id],
                |r| r.get(0),
            )?;
            Ok(s)
        })
        .expect("journal_surface")
    }

    #[test]
    fn event_write_records_surface_from_payload() {
        let db = test_db();
        let project_id = insert_project(&db);

        // surface 省略（既存 AI/JS 経路）→ in-app-agent 互換にフォールバック。
        let (_id, journal_default) = create_event(&db, &project_id, "auto", vec![], vec![]);
        assert_eq!(journal_surface(&db, &journal_default), "in-app-agent");

        // surface = "manual"（UI 手動編集）→ そのまま undo_journal へ記録される
        // （AI 書き込みと混同されない provenance）。
        let res = agent_event_create_impl(
            &db,
            AgentEventCreatePayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: Some("manual".to_string()),
                title: Some("手動作成".to_string()),
                note: None,
                detail: None,
                ordinal: None,
                primary_codex_id: None,
                lane_group: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                precision: None,
                kind: None,
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: None,
                scene_ids: None,
            },
        )
        .expect("create with manual surface");
        let journal_manual = res["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(journal_surface(&db, &journal_manual), "manual");
    }

    fn scalar_count(db: &Database, sql: &str, a: &str, b: Option<&str>) -> i64 {
        db.with_conn(|conn| {
            let n: i64 = match b {
                Some(b) => conn.query_row(sql, rusqlite::params![a, b], |r| r.get(0))?,
                None => conn.query_row(sql, rusqlite::params![a], |r| r.get(0))?,
            };
            Ok(n)
        })
        .expect("scalar_count")
    }

    fn event_count(db: &Database, event_id: &str) -> i64 {
        scalar_count(
            db,
            "SELECT COUNT(*) FROM events WHERE id = ?1",
            event_id,
            None,
        )
    }

    fn participant_count(db: &Database, event_id: &str) -> i64 {
        scalar_count(
            db,
            "SELECT COUNT(*) FROM event_participants WHERE event_id = ?1",
            event_id,
            None,
        )
    }

    fn scene_link_count(db: &Database, event_id: &str) -> i64 {
        scalar_count(
            db,
            "SELECT COUNT(*) FROM scene_events WHERE event_id = ?1",
            event_id,
            None,
        )
    }

    fn relation_count(db: &Database, cause: &str, effect: &str) -> i64 {
        scalar_count(
            db,
            "SELECT COUNT(*) FROM event_relations WHERE cause_event_id = ?1 AND effect_event_id = ?2",
            cause,
            Some(effect),
        )
    }

    fn participant_has(db: &Database, event_id: &str, codex_id: &str) -> bool {
        scalar_count(
            db,
            "SELECT COUNT(*) FROM event_participants WHERE event_id = ?1 AND codex_entry_id = ?2",
            event_id,
            Some(codex_id),
        ) > 0
    }

    fn participant_role(db: &Database, event_id: &str, codex_id: &str) -> Option<String> {
        db.with_conn(|conn| {
            let r: Option<String> = conn.query_row(
                "SELECT role FROM event_participants WHERE event_id = ?1 AND codex_entry_id = ?2",
                rusqlite::params![event_id, codex_id],
                |row| row.get(0),
            )?;
            Ok(r)
        })
        .expect("participant_role")
    }

    fn event_title(db: &Database, event_id: &str) -> Option<String> {
        db.with_conn(|conn| {
            match conn.query_row(
                "SELECT title FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get::<_, String>(0),
            ) {
                Ok(t) => Ok(Some(t)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.into()),
            }
        })
        .expect("event_title")
    }

    fn event_start(db: &Database, event_id: &str) -> Option<i64> {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT start_time FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get::<_, Option<i64>>(0),
            )?)
        })
        .expect("event_start")
    }

    fn event_end(db: &Database, event_id: &str) -> Option<i64> {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT end_time FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get::<_, Option<i64>>(0),
            )?)
        })
        .expect("event_end")
    }

    fn event_primary_codex(db: &Database, event_id: &str) -> Option<String> {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT primary_codex_id FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get::<_, Option<String>>(0),
            )?)
        })
        .expect("event_primary_codex")
    }

    fn event_detail(db: &Database, event_id: &str) -> Option<String> {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT detail FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get::<_, Option<String>>(0),
            )?)
        })
        .expect("event_detail")
    }

    #[test]
    fn event_detail_create_update_and_undo_round_trip() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "e", vec![], vec![]);
        // 新規作成時は detail 未指定 → NULL。
        assert_eq!(event_detail(&db, &event_id), None);

        // 詳細をセット（ProseMirror JSON 文字列）。
        let doc_a = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"詳細A"}]}]}"#;
        let mut p1 = empty_update(&project_id, &event_id);
        p1.detail = Some(doc_a.to_string());
        agent_event_update_impl(&db, p1).unwrap();
        assert_eq!(event_detail(&db, &event_id).as_deref(), Some(doc_a));

        // 別の詳細へ更新し、戻りスナップショットで undo すると detailA に戻る。
        let doc_b = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"詳細B"}]}]}"#;
        let mut p2 = empty_update(&project_id, &event_id);
        p2.detail = Some(doc_b.to_string());
        let res = agent_event_update_impl(&db, p2).unwrap();
        assert_eq!(event_detail(&db, &event_id).as_deref(), Some(doc_b));

        let journal_id = res["undoJournalId"].as_str().unwrap().to_string();
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        assert_eq!(event_detail(&db, &event_id).as_deref(), Some(doc_a));
    }

    #[test]
    fn event_update_empty_primary_codex_clears_to_null() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex = insert_codex(&db, &project_id, "Alice");
        let (event_id, _) = create_event(&db, &project_id, "e", vec![], vec![]);
        // レーン割当。
        let mut p1 = empty_update(&project_id, &event_id);
        p1.primary_codex_id = Some(codex.clone());
        agent_event_update_impl(&db, p1).unwrap();
        assert_eq!(event_primary_codex(&db, &event_id), Some(codex));
        // "" で未割当へ戻す（D&D で未割当レーンへ移動）。NULL クリアされる。
        let mut p2 = empty_update(&project_id, &event_id);
        p2.primary_codex_id = Some(String::new());
        agent_event_update_impl(&db, p2).unwrap();
        assert_eq!(event_primary_codex(&db, &event_id), None);
    }

    #[test]
    fn event_update_end_granularity_none_clears_end_time() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "interval", vec![], vec![]);
        // 期間化: start/end に値を入れる。
        let mut mk = empty_update(&project_id, &event_id);
        mk.start_time = Some(100);
        mk.start_granularity = Some("day".to_string());
        mk.end_time = Some(160);
        mk.end_granularity = Some("day".to_string());
        agent_event_update_impl(&db, mk).unwrap();
        assert_eq!(event_end(&db, &event_id), Some(160));
        // 「点にする」: UI と同じく end_time:null(=None) ＋ end_granularity:"none"。
        // Option<i64> では null と未指定を区別できないが、粒度 none をシグナルに end_time を
        // クリアする（期間→点が永続し、点へ変更後に期間へ戻らない）。
        let mut pt = empty_update(&project_id, &event_id);
        pt.end_time = None;
        pt.end_granularity = Some("none".to_string());
        agent_event_update_impl(&db, pt).unwrap();
        assert_eq!(event_end(&db, &event_id), None);
    }

    fn set_role(db: &Database, event_id: &str, codex_id: &str, role: &str) {
        db.execute(
            "UPDATE event_participants SET role = ? WHERE event_id = ? AND codex_entry_id = ?",
            &[
                Value::String(role.to_string()),
                Value::String(event_id.to_string()),
                Value::String(codex_id.to_string()),
            ],
            "run",
        )
        .expect("set role");
    }

    // ---- Round-trip tests -------------------------------------------------

    #[test]
    fn event_create_undo_redo_round_trip() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex_id = insert_codex(&db, &project_id, "Alice");
        let scene_id = insert_scene(&db, &project_id);

        let (event_id, journal_id) = create_event(
            &db,
            &project_id,
            "戦い",
            vec![codex_id.clone()],
            vec![scene_id.clone()],
        );
        assert_eq!(event_count(&db, &event_id), 1);
        assert_eq!(participant_count(&db, &event_id), 1);
        assert_eq!(scene_link_count(&db, &event_id), 1);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        assert_eq!(event_count(&db, &event_id), 0, "undo create deletes event");
        assert_eq!(
            participant_count(&db, &event_id),
            0,
            "cascade clears participants"
        );
        assert_eq!(
            scene_link_count(&db, &event_id),
            0,
            "cascade clears scene links"
        );

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo")).unwrap();
        assert_eq!(event_count(&db, &event_id), 1, "redo recreates event");
        assert_eq!(participant_count(&db, &event_id), 1);
        assert_eq!(scene_link_count(&db, &event_id), 1);
    }

    #[test]
    fn event_delete_undo_restores_full_cascade() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex_a = insert_codex(&db, &project_id, "A");
        let scene_id = insert_scene(&db, &project_id);

        let (main_id, _) = create_event(
            &db,
            &project_id,
            "main",
            vec![codex_a.clone()],
            vec![scene_id.clone()],
        );
        let (other_id, _) = create_event(&db, &project_id, "other", vec![], vec![]);
        set_role(&db, &main_id, &codex_a, "hero");

        agent_event_relation_mutate_impl(
            &db,
            relation_payload(&project_id, &main_id, &other_id),
            true,
        )
        .unwrap();
        agent_event_relation_mutate_impl(
            &db,
            relation_payload(&project_id, &other_id, &main_id),
            true,
        )
        .unwrap();
        assert_eq!(relation_count(&db, &main_id, &other_id), 1);
        assert_eq!(relation_count(&db, &other_id, &main_id), 1);

        let del = agent_event_delete_impl(
            &db,
            AgentEventIdPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: main_id.clone(),
            },
        )
        .unwrap();
        let journal_id = del["undoJournalId"].as_str().unwrap().to_string();

        assert_eq!(event_count(&db, &main_id), 0);
        assert_eq!(event_count(&db, &other_id), 1, "sibling event survives");
        assert_eq!(participant_count(&db, &main_id), 0);
        assert_eq!(scene_link_count(&db, &main_id), 0);
        assert_eq!(relation_count(&db, &main_id, &other_id), 0);
        assert_eq!(relation_count(&db, &other_id, &main_id), 0);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        assert_eq!(event_count(&db, &main_id), 1, "undo delete restores event");
        assert_eq!(participant_count(&db, &main_id), 1);
        assert_eq!(
            participant_role(&db, &main_id, &codex_a),
            Some("hero".to_string()),
            "participant role restored from cascade snapshot"
        );
        assert_eq!(scene_link_count(&db, &main_id), 1);
        assert_eq!(
            relation_count(&db, &main_id, &other_id),
            1,
            "asCause relation restored"
        );
        assert_eq!(
            relation_count(&db, &other_id, &main_id),
            1,
            "asEffect relation restored"
        );

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo")).unwrap();
        assert_eq!(event_count(&db, &main_id), 0, "redo delete removes again");
        assert_eq!(relation_count(&db, &main_id, &other_id), 0);
        assert_eq!(relation_count(&db, &other_id, &main_id), 0);
    }

    #[test]
    fn event_update_undo_restores_old_values() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "seed", vec![], vec![]);

        let mut p1 = empty_update(&project_id, &event_id);
        p1.title = Some("old".to_string());
        p1.start_time = Some(100);
        agent_event_update_impl(&db, p1).unwrap();

        let mut p2 = empty_update(&project_id, &event_id);
        p2.title = Some("new".to_string());
        p2.start_time = Some(200);
        let res = agent_event_update_impl(&db, p2).unwrap();
        let journal_id = res["undoJournalId"].as_str().unwrap().to_string();

        assert_eq!(event_title(&db, &event_id), Some("new".to_string()));
        assert_eq!(event_start(&db, &event_id), Some(200));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        assert_eq!(event_title(&db, &event_id), Some("old".to_string()));
        assert_eq!(event_start(&db, &event_id), Some(100));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo")).unwrap();
        assert_eq!(event_title(&db, &event_id), Some("new".to_string()));
        assert_eq!(event_start(&db, &event_id), Some(200));
    }

    #[test]
    fn event_set_participants_undo_restores_set_and_roles() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex_a = insert_codex(&db, &project_id, "A");
        let codex_b = insert_codex(&db, &project_id, "B");
        let codex_c = insert_codex(&db, &project_id, "C");
        let (event_id, _) = create_event(&db, &project_id, "e", vec![codex_a.clone()], vec![]);
        set_role(&db, &event_id, &codex_a, "hero");

        let res = agent_event_set_participants_impl(
            &db,
            AgentEventParticipantsPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: event_id.clone(),
                codex_entry_ids: vec![codex_b.clone(), codex_c.clone()],
            },
        )
        .unwrap();
        let journal_id = res["undoJournalId"].as_str().unwrap().to_string();

        assert_eq!(participant_count(&db, &event_id), 2);
        assert!(participant_has(&db, &event_id, &codex_b));
        assert!(participant_has(&db, &event_id, &codex_c));
        assert!(!participant_has(&db, &event_id, &codex_a));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        assert_eq!(participant_count(&db, &event_id), 1);
        assert!(participant_has(&db, &event_id, &codex_a));
        assert_eq!(
            participant_role(&db, &event_id, &codex_a),
            Some("hero".to_string()),
            "old role restored"
        );

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo")).unwrap();
        assert_eq!(participant_count(&db, &event_id), 2);
        assert!(participant_has(&db, &event_id, &codex_b));
        assert!(!participant_has(&db, &event_id, &codex_a));
    }

    #[test]
    fn scene_event_link_and_unlink_round_trip() {
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_id = insert_scene(&db, &project_id);
        let (event_id, _) = create_event(&db, &project_id, "e", vec![], vec![]);

        let res = agent_scene_event_mutate_impl(
            &db,
            scene_payload(&project_id, &scene_id, &event_id),
            true,
        )
        .unwrap();
        let link_journal = res["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(scene_link_count(&db, &event_id), 1);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &link_journal, "undo")).unwrap();
        assert_eq!(scene_link_count(&db, &event_id), 0, "undo link removes");
        agent_undo_journal_impl(&db, undo_payload(&project_id, &link_journal, "redo")).unwrap();
        assert_eq!(scene_link_count(&db, &event_id), 1, "redo link restores");

        // Now unlink and round-trip the unlink.
        let res2 = agent_scene_event_mutate_impl(
            &db,
            scene_payload(&project_id, &scene_id, &event_id),
            false,
        )
        .unwrap();
        let unlink_journal = res2["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(scene_link_count(&db, &event_id), 0);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &unlink_journal, "undo")).unwrap();
        assert_eq!(
            scene_link_count(&db, &event_id),
            1,
            "undo unlink restores link"
        );
        agent_undo_journal_impl(&db, undo_payload(&project_id, &unlink_journal, "redo")).unwrap();
        assert_eq!(
            scene_link_count(&db, &event_id),
            0,
            "redo unlink removes again"
        );
    }

    #[test]
    fn event_relation_add_and_remove_round_trip() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (e1, _) = create_event(&db, &project_id, "e1", vec![], vec![]);
        let (e2, _) = create_event(&db, &project_id, "e2", vec![], vec![]);

        let res =
            agent_event_relation_mutate_impl(&db, relation_payload(&project_id, &e1, &e2), true)
                .unwrap();
        let add_journal = res["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(relation_count(&db, &e1, &e2), 1);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &add_journal, "undo")).unwrap();
        assert_eq!(
            relation_count(&db, &e1, &e2),
            0,
            "undo add removes relation"
        );
        agent_undo_journal_impl(&db, undo_payload(&project_id, &add_journal, "redo")).unwrap();
        assert_eq!(
            relation_count(&db, &e1, &e2),
            1,
            "redo add restores relation"
        );

        let res2 =
            agent_event_relation_mutate_impl(&db, relation_payload(&project_id, &e1, &e2), false)
                .unwrap();
        let remove_journal = res2["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(relation_count(&db, &e1, &e2), 0);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &remove_journal, "undo")).unwrap();
        assert_eq!(
            relation_count(&db, &e1, &e2),
            1,
            "undo remove restores relation"
        );
        agent_undo_journal_impl(&db, undo_payload(&project_id, &remove_journal, "redo")).unwrap();
        assert_eq!(
            relation_count(&db, &e1, &e2),
            0,
            "redo remove removes again"
        );
    }

    #[test]
    fn event_writes_enforce_xproj_and_self_loop() {
        let db = test_db();
        let p1 = insert_project(&db);
        let p2 = insert_project(&db);
        let (event_p1, _) = create_event(&db, &p1, "p1-event", vec![], vec![]);
        let scene_p2 = insert_scene(&db, &p2);
        let (event_p2, _) = create_event(&db, &p2, "p2-event", vec![], vec![]);

        // Update claiming the wrong project: error, no mutation.
        let mut bad_update = empty_update(&p2, &event_p1);
        bad_update.title = Some("hacked".to_string());
        assert!(agent_event_update_impl(&db, bad_update).is_err());
        assert_eq!(event_title(&db, &event_p1), Some("p1-event".to_string()));

        // Scene link with a scene from another project: error, no link.
        let cross =
            agent_scene_event_mutate_impl(&db, scene_payload(&p1, &scene_p2, &event_p1), true);
        assert!(cross.is_err(), "cross-project scene link must fail");
        assert_eq!(scene_link_count(&db, &event_p1), 0);

        // Self-loop relation: forbidden.
        assert!(agent_event_relation_mutate_impl(
            &db,
            relation_payload(&p1, &event_p1, &event_p1),
            true
        )
        .is_err());

        // Relation whose effect lives in another project: error, no edge.
        assert!(agent_event_relation_mutate_impl(
            &db,
            relation_payload(&p1, &event_p1, &event_p2),
            true
        )
        .is_err());
        assert_eq!(relation_count(&db, &event_p1, &event_p2), 0);
    }
}
