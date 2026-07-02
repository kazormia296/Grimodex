//! Tracked Snippet create — mirrors in-app agent_snippet_create.

use anyhow::Context;
use rusqlite::{params, Connection};
use serde_json::json;

use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::undo_journal::{
    insert_undo_journal_in_tx, snippet_create_after_snapshot, UndoJournalInsert,
};
use crate::writes::codex::AuthorshipSpanInput;
use crate::writes::codex::WriteResult;

pub struct TrackedSnippetCreateInput<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub surface: &'a str,
    pub snippet_id: &'a str,
    pub title: &'a str,
    pub content: &'a str,
    pub scene_id: Option<&'a str>,
    pub source_chat_message_id: Option<&'a str>,
    pub authorship_spans: &'a [AuthorshipSpanInput],
}

fn replace_snippet_spans(
    conn: &Connection,
    snippet_id: &str,
    spans: &[AuthorshipSpanInput],
) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM authorship_spans WHERE snippet_id = ?1",
        params![snippet_id],
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    for span in spans {
        let span_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO authorship_spans
             (id, snippet_id, from_pos, to_pos, source, model, chat_msg_id, trace_id, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                span_id,
                snippet_id,
                span.from_pos,
                span.to_pos,
                span.source,
                span.model,
                span.chat_msg_id,
                span.trace_id,
                now,
            ],
        )?;
    }
    Ok(())
}

pub fn tracked_snippet_create(
    conn: &Connection,
    input: TrackedSnippetCreateInput<'_>,
) -> anyhow::Result<WriteResult> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    let after_base = json!({
        "id": input.snippet_id,
        "projectId": input.project_id,
        "title": input.title,
        "content": input.content,
        "sceneId": input.scene_id,
        "contentSource": "ai",
        "version": 1,
    })
    .to_string();

    let change_payload = json!({
        "title": input.title,
        "sceneId": input.scene_id,
    })
    .to_string();

    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = (|| -> anyhow::Result<WriteResult> {
        conn.execute(
            "INSERT INTO snippets
             (id, project_id, title, content, scene_id, content_source,
              source_chat_message_id, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'ai', ?6, 1, ?7, ?7)",
            params![
                input.snippet_id,
                input.project_id,
                input.title,
                input.content,
                input.scene_id,
                input.source_chat_message_id,
                now,
            ],
        )?;

        replace_snippet_spans(conn, input.snippet_id, input.authorship_spans)?;

        let after_snapshot = snippet_create_after_snapshot(conn, input.snippet_id, &after_base)?;

        insert_undo_journal_in_tx(
            conn,
            UndoJournalInsert {
                id: &undo_id,
                project_id: input.project_id,
                surface: input.surface,
                entity_kind: "snippet",
                entity_id: input.snippet_id,
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
            input.project_id,
            input.session_id,
            &[AppendChangeEvent {
                event_uid: event_uid.clone(),
                scene_id: input.scene_id.map(str::to_string),
                domain: "snippet".to_string(),
                op_type: "snippet.create".to_string(),
                entity_type: Some("snippet".to_string()),
                entity_id: Some(input.snippet_id.to_string()),
                payload: change_payload,
                timestamp,
            }],
        )?;

        Ok(WriteResult {
            entity_id: input.snippet_id.to_string(),
            version: 1,
            change_event_uid: event_uid,
            undo_journal_id: undo_id,
        })
    })();

    match result {
        Ok(res) => {
            crate::commit_or_rollback(conn)?;
            Ok(res)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
    .context("tracked_snippet_create")
}
