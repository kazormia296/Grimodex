//! Tracked Codex writes: entity + authorship + undo_journal + change_events in one tx.

use anyhow::Context;
use rusqlite::{params, Connection};
use serde_json::json;

use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::undo_journal::{insert_undo_journal_in_tx, UndoJournalInsert};
use crate::writes::{LANE_CONTENT_MODEL, LANE_SUMMARY_MODEL};

#[derive(Debug, Clone)]
pub struct AuthorshipSpanInput {
    pub from_pos: i64,
    pub to_pos: i64,
    pub source: String,
    pub model: Option<String>,
    pub chat_msg_id: Option<String>,
    pub trace_id: Option<String>,
    /// "summary" | "content" — used for partial-update span merge.
    pub lane: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TrackedCodexCreateInput<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub surface: &'a str,
    pub entry_id: &'a str,
    pub type_slug: &'a str,
    pub name: &'a str,
    pub summary: &'a str,
    pub content: &'a str,
    pub aliases: Option<&'a str>,
    pub parent_id: Option<&'a str>,
    pub source_chat_message_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub chat_message_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
    pub authorship_spans: &'a [AuthorshipSpanInput],
    pub tags: &'a [String],
}

#[derive(Debug, Clone)]
pub struct TrackedCodexUpdateInput<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub surface: &'a str,
    pub entry_id: &'a str,
    /// Client-observed version before this write (optimistic lock authority).
    pub expected_base_version: i64,
    pub name: Option<&'a str>,
    pub summary: Option<&'a str>,
    pub content: Option<&'a str>,
    pub aliases: Option<&'a str>,
    pub model: Option<&'a str>,
    pub chat_message_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
    pub authorship_spans: Option<&'a [AuthorshipSpanInput]>,
    pub tags: Option<&'a [String]>,
}

#[derive(Debug, Clone)]
pub struct WriteResult {
    pub entity_id: String,
    pub version: i64,
    pub change_event_uid: String,
    pub undo_journal_id: String,
}

fn link_codex_tags(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
    tags: &[String],
) -> anyhow::Result<()> {
    for tag_name in tags {
        let tag_id: String = conn
            .query_row(
                "SELECT id FROM codex_tags WHERE project_id = ?1 AND name = ?2",
                params![project_id, tag_name],
                |row| row.get(0),
            )
            .unwrap_or_else(|_| uuid::Uuid::new_v4().to_string());
        if conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM codex_tags WHERE id = ?1)",
            params![tag_id],
            |row| row.get::<_, i64>(0),
        )? == 0
        {
            conn.execute(
                "INSERT INTO codex_tags (id, project_id, name) VALUES (?1, ?2, ?3)",
                params![tag_id, project_id, tag_name],
            )?;
        }
        conn.execute(
            "INSERT OR IGNORE INTO codex_entry_tags (entry_id, tag_id) VALUES (?1, ?2)",
            params![entry_id, tag_id],
        )?;
    }
    // Refresh tags_cache
    let cache: String = conn.query_row(
        "SELECT COALESCE(json_group_array(json_object('name', t.name, 'color', t.color)), '[]')
         FROM codex_entry_tags et
         JOIN codex_tags t ON t.id = et.tag_id
         WHERE et.entry_id = ?1",
        params![entry_id],
        |row| row.get(0),
    )?;
    conn.execute(
        "UPDATE codex_entries SET tags_cache = ?1 WHERE id = ?2",
        params![cache, entry_id],
    )?;
    Ok(())
}

fn span_lane_model(span: &AuthorshipSpanInput) -> Option<&str> {
    span.lane.as_deref().map(|l| match l {
        "summary" => LANE_SUMMARY_MODEL,
        "content" => LANE_CONTENT_MODEL,
        _ => span.model.as_deref().unwrap_or(LANE_CONTENT_MODEL),
    })
}

fn merge_codex_authorship_spans(
    conn: &Connection,
    entry_id: &str,
    spans: &[AuthorshipSpanInput],
    update_summary: bool,
    update_content: bool,
    default_model: Option<&str>,
    default_chat_msg_id: Option<&str>,
    default_trace_id: Option<&str>,
) -> anyhow::Result<()> {
    if update_summary && update_content {
        conn.execute(
            "DELETE FROM authorship_spans WHERE codex_entry_id = ?1",
            params![entry_id],
        )?;
    } else if update_summary {
        conn.execute(
            "DELETE FROM authorship_spans WHERE codex_entry_id = ?1 AND model = ?2",
            params![entry_id, LANE_SUMMARY_MODEL],
        )?;
    } else if update_content {
        conn.execute(
            "DELETE FROM authorship_spans WHERE codex_entry_id = ?1 AND (model IS NULL OR model != ?2)",
            params![entry_id, LANE_SUMMARY_MODEL],
        )?;
    }

    let now = chrono::Utc::now().to_rfc3339();
    for span in spans {
        let span_id = uuid::Uuid::new_v4().to_string();
        let model = span_lane_model(span)
            .map(str::to_string)
            .or_else(|| span.model.clone())
            .or_else(|| default_model.map(str::to_string));
        conn.execute(
            "INSERT INTO authorship_spans
             (id, codex_entry_id, from_pos, to_pos, source, model, chat_msg_id, trace_id, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                span_id,
                entry_id,
                span.from_pos,
                span.to_pos,
                span.source,
                model,
                span.chat_msg_id.as_deref().or(default_chat_msg_id),
                span.trace_id.as_deref().or(default_trace_id),
                now,
            ],
        )?;
    }
    Ok(())
}

fn codex_snapshot_json(conn: &Connection, entry_id: &str) -> anyhow::Result<String> {
    conn.query_row(
        "SELECT json_object(
            'id', id, 'projectId', project_id, 'type', type, 'name', name,
            'summary', summary, 'content', content, 'aliases', aliases,
            'parentId', parent_id, 'version', version
         ) FROM codex_entries WHERE id = ?1",
        params![entry_id],
        |row| row.get(0),
    )
    .context("codex snapshot")
}

/// Tracked codex create inside an open BEGIN IMMEDIATE transaction.
pub fn tracked_codex_create_in_tx(
    conn: &Connection,
    input: TrackedCodexCreateInput<'_>,
    undo_id: &str,
    event_uid: &str,
    timestamp: i64,
    now: &str,
) -> anyhow::Result<WriteResult> {
    conn.execute(
        "INSERT INTO codex_entries
         (id, project_id, type, name, aliases, summary, content, parent_id,
          source_chat_message_id, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)",
        params![
            input.entry_id,
            input.project_id,
            input.type_slug,
            input.name,
            input.aliases,
            input.summary,
            input.content,
            input.parent_id,
            input.source_chat_message_id,
            now,
        ],
    )?;

    if !input.tags.is_empty() {
        link_codex_tags(conn, input.project_id, input.entry_id, input.tags)?;
    }

    merge_codex_authorship_spans(
        conn,
        input.entry_id,
        input.authorship_spans,
        true,
        true,
        input.model,
        input.chat_message_id.or(input.source_chat_message_id),
        input.trace_id,
    )?;

    let after_snapshot = codex_snapshot_json(conn, input.entry_id)?;
    let change_payload = json!({
        "type": input.type_slug,
        "name": input.name,
        "parentId": input.parent_id,
    });

    insert_undo_journal_in_tx(
        conn,
        UndoJournalInsert {
            id: undo_id,
            project_id: input.project_id,
            surface: input.surface,
            entity_kind: "codex_entry",
            entity_id: input.entry_id,
            op_kind: "create",
            before_json: None,
            after_json: Some(&after_snapshot),
            base_version: 0,
            result_version: 1,
            change_event_uid: Some(event_uid),
        },
    )?;

    append_change_events_in_tx(
        conn,
        input.project_id,
        input.session_id,
        &[AppendChangeEvent {
            event_uid: event_uid.to_string(),
            scene_id: None,
            domain: "codex".to_string(),
            op_type: "entry.create".to_string(),
            entity_type: Some("codex_entry".to_string()),
            entity_id: Some(input.entry_id.to_string()),
            payload: change_payload.to_string(),
            timestamp,
        }],
    )?;

    Ok(WriteResult {
        entity_id: input.entry_id.to_string(),
        version: 1,
        change_event_uid: event_uid.to_string(),
        undo_journal_id: undo_id.to_string(),
    })
}

/// Tracked codex update inside an open BEGIN IMMEDIATE transaction.
pub fn tracked_codex_update_in_tx(
    conn: &Connection,
    input: TrackedCodexUpdateInput<'_>,
    undo_id: &str,
    event_uid: &str,
    timestamp: i64,
    now: &str,
) -> anyhow::Result<WriteResult> {
    let (db_version, before_row): (i64, String) = conn
        .query_row(
            "SELECT version, json_object(
                'id', id, 'projectId', project_id, 'type', type, 'name', name,
                'summary', summary, 'content', content, 'aliases', aliases,
                'parentId', parent_id, 'version', version
             ) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
            params![input.entry_id, input.project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .context("codex entry not found")?;

    if db_version != input.expected_base_version {
        anyhow::bail!(
            "Codex entry '{}' version conflict: expected {} but database has {}",
            input.entry_id,
            input.expected_base_version,
            db_version
        );
    }

    let mut sets = vec![
        "updated_at = ?1".to_string(),
        "version = version + 1".to_string(),
    ];
    let mut sql_params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now.to_string())];
    let mut param_idx = 2;

    if let Some(name) = input.name {
        sets.push(format!("name = ?{param_idx}"));
        sql_params.push(Box::new(name.to_string()));
        param_idx += 1;
    }
    if let Some(summary) = input.summary {
        sets.push(format!("summary = ?{param_idx}"));
        sql_params.push(Box::new(summary.to_string()));
        param_idx += 1;
    }
    if let Some(content) = input.content {
        sets.push(format!("content = ?{param_idx}"));
        sql_params.push(Box::new(content.to_string()));
        param_idx += 1;
    }
    if let Some(aliases) = input.aliases {
        sets.push(format!("aliases = ?{param_idx}"));
        sql_params.push(Box::new(aliases.to_string()));
        param_idx += 1;
    }

    let sql = format!(
        "UPDATE codex_entries SET {} WHERE id = ?{param_idx} AND project_id = ?{} AND version = ?{}",
        sets.join(", "),
        param_idx + 1,
        param_idx + 2
    );
    sql_params.push(Box::new(input.entry_id.to_string()));
    sql_params.push(Box::new(input.project_id.to_string()));
    sql_params.push(Box::new(input.expected_base_version));

    let updated = conn.execute(
        &sql,
        rusqlite::params_from_iter(sql_params.iter().map(|p| p as &dyn rusqlite::types::ToSql)),
    )?;
    if updated == 0 {
        anyhow::bail!(
            "Codex entry '{}' version conflict or not found in project '{}'",
            input.entry_id,
            input.project_id
        );
    }

    let result_version = input.expected_base_version + 1;

    if let Some(tags) = input.tags {
        conn.execute(
            "DELETE FROM codex_entry_tags WHERE entry_id = ?1",
            params![input.entry_id],
        )?;
        link_codex_tags(conn, input.project_id, input.entry_id, tags)?;
    }

    if let Some(spans) = input.authorship_spans {
        merge_codex_authorship_spans(
            conn,
            input.entry_id,
            spans,
            input.summary.is_some(),
            input.content.is_some(),
            input.model,
            input.chat_message_id,
            input.trace_id,
        )?;
    }

    let after_row = codex_snapshot_json(conn, input.entry_id)?;
    let fields: Vec<&str> = [
        input.name.map(|_| "name"),
        input.summary.map(|_| "summary"),
        input.content.map(|_| "content"),
        input.aliases.map(|_| "aliases"),
    ]
    .into_iter()
    .flatten()
    .collect();

    insert_undo_journal_in_tx(
        conn,
        UndoJournalInsert {
            id: undo_id,
            project_id: input.project_id,
            surface: input.surface,
            entity_kind: "codex_entry",
            entity_id: input.entry_id,
            op_kind: "update",
            before_json: Some(&before_row),
            after_json: Some(&after_row),
            base_version: input.expected_base_version,
            result_version,
            change_event_uid: Some(event_uid),
        },
    )?;

    append_change_events_in_tx(
        conn,
        input.project_id,
        input.session_id,
        &[AppendChangeEvent {
            event_uid: event_uid.to_string(),
            scene_id: None,
            domain: "codex".to_string(),
            op_type: "entry.update".to_string(),
            entity_type: Some("codex_entry".to_string()),
            entity_id: Some(input.entry_id.to_string()),
            payload: json!({ "fields": fields }).to_string(),
            timestamp,
        }],
    )?;

    Ok(WriteResult {
        entity_id: input.entry_id.to_string(),
        version: result_version,
        change_event_uid: event_uid.to_string(),
        undo_journal_id: undo_id.to_string(),
    })
}

/// Run tracked create in BEGIN IMMEDIATE … COMMIT.
pub fn tracked_codex_create(
    conn: &Connection,
    input: TrackedCodexCreateInput<'_>,
) -> anyhow::Result<WriteResult> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = tracked_codex_create_in_tx(conn, input, &undo_id, &event_uid, timestamp, &now);
    match result {
        Ok(res) => {
            conn.execute_batch("COMMIT")?;
            Ok(res)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/// Run tracked update in BEGIN IMMEDIATE … COMMIT.
pub fn tracked_codex_update(
    conn: &Connection,
    input: TrackedCodexUpdateInput<'_>,
) -> anyhow::Result<WriteResult> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch("BEGIN IMMEDIATE")?;
    let result = tracked_codex_update_in_tx(conn, input, &undo_id, &event_uid, timestamp, &now);
    match result {
        Ok(res) => {
            conn.execute_batch("COMMIT")?;
            Ok(res)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}
