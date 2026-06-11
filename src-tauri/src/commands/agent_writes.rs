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
        other => anyhow::bail!("undo_journal_change_event: unsupported entity_kind '{other}'"),
    };
    let op_type = match (direction, row.op_kind.as_str()) {
        ("undo", "create") => delete_op,
        ("redo", "create") => create_op,
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
            let owner: Option<String> =
                conn.query_row(&format!("SELECT {owner_lane} FROM authorship_spans"), [], |r| {
                    r.get(0)
                })?;
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
}
