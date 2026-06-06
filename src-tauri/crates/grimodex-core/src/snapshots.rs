//! Entity snapshots for undo-journal (entry fields + authorship spans).

use anyhow::Context;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorshipSpanSnap {
    pub from_pos: i64,
    pub to_pos: i64,
    pub source: String,
    pub model: Option<String>,
    pub chat_msg_id: Option<String>,
    pub trace_id: Option<String>,
}

pub fn load_codex_authorship_spans(
    conn: &Connection,
    entry_id: &str,
) -> anyhow::Result<Vec<AuthorshipSpanSnap>> {
    let mut stmt = conn.prepare(
        "SELECT from_pos, to_pos, source, model, chat_msg_id, trace_id
         FROM authorship_spans WHERE codex_entry_id = ?1",
    )?;
    let rows = stmt.query_map(params![entry_id], |row| {
        Ok(AuthorshipSpanSnap {
            from_pos: row.get(0)?,
            to_pos: row.get(1)?,
            source: row.get(2)?,
            model: row.get(3)?,
            chat_msg_id: row.get(4)?,
            trace_id: row.get(5)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("load codex authorship spans")
}

pub fn load_snippet_authorship_spans(
    conn: &Connection,
    snippet_id: &str,
) -> anyhow::Result<Vec<AuthorshipSpanSnap>> {
    let mut stmt = conn.prepare(
        "SELECT from_pos, to_pos, source, model, chat_msg_id, trace_id
         FROM authorship_spans WHERE snippet_id = ?1",
    )?;
    let rows = stmt.query_map(params![snippet_id], |row| {
        Ok(AuthorshipSpanSnap {
            from_pos: row.get(0)?,
            to_pos: row.get(1)?,
            source: row.get(2)?,
            model: row.get(3)?,
            chat_msg_id: row.get(4)?,
            trace_id: row.get(5)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .context("load snippet authorship spans")
}

/// Merge `authorshipSpans` array into an entry-only snapshot JSON string.
pub fn attach_codex_spans(
    conn: &Connection,
    entry_id: &str,
    base_json: &str,
) -> anyhow::Result<String> {
    let mut snap: Value = serde_json::from_str(base_json).context("parse codex snapshot")?;
    let spans = load_codex_authorship_spans(conn, entry_id)?;
    snap["authorshipSpans"] = json!(spans);
    Ok(serde_json::to_string(&snap)?)
}

pub fn attach_snippet_spans(
    conn: &Connection,
    snippet_id: &str,
    base_json: &str,
) -> anyhow::Result<String> {
    let mut snap: Value = serde_json::from_str(base_json).context("parse snippet snapshot")?;
    let spans = load_snippet_authorship_spans(conn, snippet_id)?;
    snap["authorshipSpans"] = json!(spans);
    Ok(serde_json::to_string(&snap)?)
}

pub fn restore_codex_authorship_spans(
    conn: &Connection,
    entry_id: &str,
    snap: &Value,
) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM authorship_spans WHERE codex_entry_id = ?1",
        params![entry_id],
    )?;
    let Some(spans_val) = snap.get("authorshipSpans") else {
        return Ok(());
    };
    let spans: Vec<AuthorshipSpanSnap> =
        serde_json::from_value(spans_val.clone()).unwrap_or_default();
    let now = chrono::Utc::now().to_rfc3339();
    for span in spans {
        let span_id = uuid::Uuid::new_v4().to_string();
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
                span.model,
                span.chat_msg_id,
                span.trace_id,
                now,
            ],
        )?;
    }
    Ok(())
}

pub fn restore_snippet_authorship_spans(
    conn: &Connection,
    snippet_id: &str,
    snap: &Value,
) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM authorship_spans WHERE snippet_id = ?1",
        params![snippet_id],
    )?;
    let Some(spans_val) = snap.get("authorshipSpans") else {
        return Ok(());
    };
    let spans: Vec<AuthorshipSpanSnap> =
        serde_json::from_value(spans_val.clone()).unwrap_or_default();
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
