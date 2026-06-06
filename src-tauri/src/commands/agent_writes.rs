//! Atomic AI write primitives for in-app agent tools.
//!
//! Each write bundles entity mutation + authorship_spans + undo_journal +
//! change_events in a single BEGIN IMMEDIATE transaction.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::database::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::database::undo_journal::{insert_undo_journal_in_tx, UndoJournalInsert};
use crate::database::Database;

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
    name: Option<String>,
    summary: Option<String>,
    content: Option<String>,
    aliases: Option<String>,
    model: Option<String>,
    chat_message_id: Option<String>,
    trace_id: Option<String>,
    authorship_spans: Option<Vec<AuthorshipSpanInput>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentWriteResult {
    entity_id: String,
    version: i64,
    change_event_uid: String,
    undo_journal_id: String,
}

fn replace_codex_authorship_spans(
    conn: &rusqlite::Connection,
    entry_id: &str,
    spans: &[AuthorshipSpanInput],
    model: Option<&str>,
    chat_msg_id: Option<&str>,
    trace_id: Option<&str>,
) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM authorship_spans WHERE codex_entry_id = ?1",
        rusqlite::params![entry_id],
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    for span in spans {
        let span_id = uuid::Uuid::new_v4().to_string();
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
                span.model.as_deref().or(model),
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

    let after_snapshot = json!({
        "id": entry_id,
        "projectId": payload.project_id,
        "type": payload.type_slug,
        "name": payload.name,
        "summary": summary,
        "content": content,
        "aliases": aliases,
        "parentId": parent_id,
        "version": 1,
    });

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

            replace_codex_authorship_spans(
                conn,
                &entry_id,
                &payload.authorship_spans,
                payload.model.as_deref(),
                payload
                    .chat_message_id
                    .as_deref()
                    .or(source_chat_message_id.as_deref()),
                payload.trace_id.as_deref(),
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
                    after_json: Some(&after_snapshot.to_string()),
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
            let (base_version, before_row): (i64, String) = conn.query_row(
                "SELECT version, json_object(
                    'id', id, 'projectId', project_id, 'type', type, 'name', name,
                    'summary', summary, 'content', content, 'aliases', aliases,
                    'parentId', parent_id, 'version', version
                 ) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.entry_id, payload.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;

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
                replace_codex_authorship_spans(
                    conn,
                    &payload.entry_id,
                    spans,
                    payload.model.as_deref(),
                    payload.chat_message_id.as_deref(),
                    payload.trace_id.as_deref(),
                )?;
            }

            let after_row: String = conn.query_row(
                "SELECT json_object(
                    'id', id, 'projectId', project_id, 'type', type, 'name', name,
                    'summary', summary, 'content', content, 'aliases', aliases,
                    'parentId', parent_id, 'version', version
                 ) FROM codex_entries WHERE id = ?1",
                rusqlite::params![payload.entry_id],
                |row| row.get(0),
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
