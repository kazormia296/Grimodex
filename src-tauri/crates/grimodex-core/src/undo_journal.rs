use rusqlite::{params, Connection};

use crate::snapshots::{
    attach_codex_spans, attach_snippet_spans, restore_codex_authorship_spans,
    restore_snippet_authorship_spans,
};

#[derive(Debug, Clone)]
pub struct UndoJournalInsert<'a> {
    pub id: &'a str,
    pub project_id: &'a str,
    pub surface: &'a str,
    pub entity_kind: &'a str,
    pub entity_id: &'a str,
    pub op_kind: &'a str,
    pub before_json: Option<&'a str>,
    pub after_json: Option<&'a str>,
    pub base_version: i64,
    pub result_version: i64,
    pub change_event_uid: Option<&'a str>,
}

pub fn insert_undo_journal_in_tx(
    conn: &Connection,
    row: UndoJournalInsert<'_>,
) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO undo_journal
         (id, project_id, surface, entity_kind, entity_id, op_kind,
          before_json, after_json, base_version, result_version, change_event_uid)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            row.id,
            row.project_id,
            row.surface,
            row.entity_kind,
            row.entity_id,
            row.op_kind,
            row.before_json,
            row.after_json,
            row.base_version,
            row.result_version,
            row.change_event_uid,
        ],
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct UndoJournalRow {
    pub id: String,
    pub project_id: String,
    pub entity_kind: String,
    pub entity_id: String,
    pub op_kind: String,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
    pub base_version: i64,
    pub result_version: i64,
}

pub fn load_undo_journal(
    conn: &Connection,
    project_id: &str,
    journal_id: &str,
) -> anyhow::Result<UndoJournalRow> {
    conn.query_row(
        "SELECT id, project_id, entity_kind, entity_id, op_kind,
                before_json, after_json, base_version, result_version
         FROM undo_journal WHERE id = ?1 AND project_id = ?2",
        params![journal_id, project_id],
        |row| {
            Ok(UndoJournalRow {
                id: row.get(0)?,
                project_id: row.get(1)?,
                entity_kind: row.get(2)?,
                entity_id: row.get(3)?,
                op_kind: row.get(4)?,
                before_json: row.get(5)?,
                after_json: row.get(6)?,
                base_version: row.get(7)?,
                result_version: row.get(8)?,
            })
        },
    )
    .map_err(Into::into)
}

fn restore_codex_entry_fields(
    conn: &Connection,
    snap: &serde_json::Value,
    entity_id: &str,
    project_id: &str,
    target_version: i64,
    expected_current_version: i64,
) -> anyhow::Result<()> {
    let name = snap["name"].as_str().unwrap_or("");
    let summary = snap["summary"].as_str().unwrap_or("");
    let content = snap["content"].as_str().unwrap_or("{}");
    let aliases = snap["aliases"].as_str();
    let parent_id = snap["parentId"].as_str();
    let updated = conn.execute(
        "UPDATE codex_entries SET name = ?1, summary = ?2, content = ?3,
         aliases = ?4, parent_id = ?5, version = ?6, updated_at = datetime('now')
         WHERE id = ?7 AND project_id = ?8 AND version = ?9",
        params![
            name,
            summary,
            content,
            aliases,
            parent_id,
            target_version,
            entity_id,
            project_id,
            expected_current_version,
        ],
    )?;
    if updated == 0 {
        anyhow::bail!(
            "codex entry '{}' version {} conflict during journal restore",
            entity_id,
            expected_current_version
        );
    }
    restore_codex_authorship_spans(conn, entity_id, snap)?;
    Ok(())
}

fn insert_codex_from_snap(conn: &Connection, snap: &serde_json::Value) -> anyhow::Result<()> {
    let id = snap["id"].as_str().unwrap_or("");
    let project = snap["projectId"].as_str().unwrap_or("");
    let entry_type = snap["type"].as_str().unwrap_or("lore");
    let name = snap["name"].as_str().unwrap_or("Untitled");
    let summary = snap["summary"].as_str().unwrap_or("");
    let content = snap["content"].as_str().unwrap_or("{}");
    let aliases = snap["aliases"].as_str();
    let parent_id = snap["parentId"].as_str();
    let version = snap["version"].as_i64().unwrap_or(1);
    conn.execute(
        "INSERT INTO codex_entries
         (id, project_id, type, name, aliases, summary, content, parent_id, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), datetime('now'))",
        params![
            id,
            project,
            entry_type,
            name,
            aliases,
            summary,
            content,
            parent_id,
            version,
        ],
    )?;
    restore_codex_authorship_spans(conn, id, snap)?;
    Ok(())
}

fn insert_snippet_from_snap(conn: &Connection, snap: &serde_json::Value) -> anyhow::Result<()> {
    let id = snap["id"].as_str().unwrap_or("");
    let project = snap["projectId"].as_str().unwrap_or("");
    let title = snap["title"].as_str().unwrap_or("");
    let content = snap["content"].as_str().unwrap_or("{}");
    let scene_id = snap["sceneId"].as_str();
    let content_source = snap["contentSource"].as_str().unwrap_or("ai");
    let version = snap["version"].as_i64().unwrap_or(1);
    conn.execute(
        "INSERT INTO snippets
         (id, project_id, title, content, scene_id, content_source, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'), datetime('now'))",
        params![
            id,
            project,
            title,
            content,
            scene_id,
            content_source,
            version
        ],
    )?;
    restore_snippet_authorship_spans(conn, id, snap)?;
    Ok(())
}

/// Revert an undo-journal entry (global-history undo path).
pub fn revert_undo_journal_in_tx(
    conn: &Connection,
    project_id: &str,
    journal_id: &str,
) -> anyhow::Result<()> {
    let row = load_undo_journal(conn, project_id, journal_id)?;
    match row.entity_kind.as_str() {
        "codex_entry" => match row.op_kind.as_str() {
            "create" => {
                let deleted = conn.execute(
                    "DELETE FROM codex_entries WHERE id = ?1 AND project_id = ?2 AND version = ?3",
                    params![row.entity_id, project_id, row.result_version],
                )?;
                if deleted == 0 {
                    anyhow::bail!(
                        "revert create: codex entry '{}' version {} not found",
                        row.entity_id,
                        row.result_version
                    );
                }
            }
            "update" => {
                let before = row
                    .before_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("revert update: missing before_json"))?;
                let snap: serde_json::Value = serde_json::from_str(before)?;
                restore_codex_entry_fields(
                    conn,
                    &snap,
                    &row.entity_id,
                    project_id,
                    row.base_version,
                    row.result_version,
                )?;
            }
            other => anyhow::bail!("revert_undo_journal: unsupported codex op_kind '{other}'"),
        },
        "snippet" => match row.op_kind.as_str() {
            "create" => {
                let deleted = conn.execute(
                    "DELETE FROM snippets WHERE id = ?1 AND project_id = ?2 AND version = ?3",
                    params![row.entity_id, project_id, row.result_version],
                )?;
                if deleted == 0 {
                    anyhow::bail!(
                        "revert create: snippet '{}' version {} not found",
                        row.entity_id,
                        row.result_version
                    );
                }
            }
            other => anyhow::bail!("revert_undo_journal: unsupported snippet op_kind '{other}'"),
        },
        other => anyhow::bail!("revert_undo_journal: unsupported entity_kind '{other}'"),
    }
    Ok(())
}

/// Re-apply an undo-journal entry (global-history redo path).
pub fn apply_undo_journal_in_tx(
    conn: &Connection,
    project_id: &str,
    journal_id: &str,
) -> anyhow::Result<()> {
    let row = load_undo_journal(conn, project_id, journal_id)?;
    match row.entity_kind.as_str() {
        "codex_entry" => match row.op_kind.as_str() {
            "create" => {
                let after = row
                    .after_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("apply create: missing after_json"))?;
                let snap: serde_json::Value = serde_json::from_str(after)?;
                insert_codex_from_snap(conn, &snap)?;
            }
            "update" => {
                let after = row
                    .after_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("apply update: missing after_json"))?;
                let snap: serde_json::Value = serde_json::from_str(after)?;
                restore_codex_entry_fields(
                    conn,
                    &snap,
                    &row.entity_id,
                    project_id,
                    row.result_version,
                    row.base_version,
                )?;
            }
            other => anyhow::bail!("apply_undo_journal: unsupported codex op_kind '{other}'"),
        },
        "snippet" => match row.op_kind.as_str() {
            "create" => {
                let after = row
                    .after_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("apply create: missing after_json"))?;
                let snap: serde_json::Value = serde_json::from_str(after)?;
                insert_snippet_from_snap(conn, &snap)?;
            }
            other => anyhow::bail!("apply_undo_journal: unsupported snippet op_kind '{other}'"),
        },
        other => anyhow::bail!("apply_undo_journal: unsupported entity_kind '{other}'"),
    }
    Ok(())
}

/// Build codex update before_json with authorship spans (call before mutation).
pub fn codex_update_before_snapshot(
    conn: &Connection,
    entry_id: &str,
    base_json: &str,
) -> anyhow::Result<String> {
    attach_codex_spans(conn, entry_id, base_json)
}

/// Build codex update after_json with authorship spans (call after mutation).
pub fn codex_update_after_snapshot(
    conn: &Connection,
    entry_id: &str,
    base_json: &str,
) -> anyhow::Result<String> {
    attach_codex_spans(conn, entry_id, base_json)
}

/// Build snippet create after_json with authorship spans.
pub fn snippet_create_after_snapshot(
    conn: &Connection,
    snippet_id: &str,
    base_json: &str,
) -> anyhow::Result<String> {
    attach_snippet_spans(conn, snippet_id, base_json)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use rusqlite::{params, Connection};
    use serde_json::json;

    use crate::snapshots::load_codex_authorship_spans;
    use crate::writes::LANE_SUMMARY_MODEL;

    use super::*;

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL);
             CREATE TABLE codex_entries (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                type TEXT NOT NULL,
                name TEXT NOT NULL,
                aliases TEXT,
                summary TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL DEFAULT '{}',
                parent_id TEXT,
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             CREATE TABLE snippets (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '{}',
                scene_id TEXT,
                content_source TEXT NOT NULL DEFAULT 'human',
                version INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
             );
             CREATE TABLE authorship_spans (
                id TEXT PRIMARY KEY,
                codex_entry_id TEXT REFERENCES codex_entries(id) ON DELETE CASCADE,
                snippet_id TEXT REFERENCES snippets(id) ON DELETE CASCADE,
                from_pos INTEGER NOT NULL,
                to_pos INTEGER NOT NULL,
                source TEXT NOT NULL,
                model TEXT,
                chat_msg_id TEXT,
                trace_id TEXT,
                timestamp TEXT NOT NULL DEFAULT (datetime('now'))
             );
             CREATE TABLE undo_journal (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                surface TEXT NOT NULL,
                entity_kind TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                op_kind TEXT NOT NULL,
                before_json TEXT,
                after_json TEXT,
                base_version INTEGER NOT NULL,
                result_version INTEGER NOT NULL,
                change_event_uid TEXT
             );",
        )
        .unwrap();
        conn.execute("INSERT INTO projects (id, title) VALUES ('p1', 'Test')", [])
            .unwrap();
        conn
    }

    fn insert_span(
        conn: &Connection,
        entry_id: &str,
        from_pos: i64,
        to_pos: i64,
        model: Option<&str>,
    ) {
        conn.execute(
            "INSERT INTO authorship_spans
             (id, codex_entry_id, from_pos, to_pos, source, model)
             VALUES (?1, ?2, ?3, ?4, 'human', ?5)",
            params![
                uuid::Uuid::new_v4().to_string(),
                entry_id,
                from_pos,
                to_pos,
                model
            ],
        )
        .unwrap();
    }

    #[test]
    fn codex_update_undo_restores_authorship_spans() {
        let conn = setup_conn();
        let entry_id = "e1";
        conn.execute(
            "INSERT INTO codex_entries
             (id, project_id, type, name, summary, content, version)
             VALUES (?1, 'p1', 'lore', 'Old', 'old sum', '{}', 1)",
            params![entry_id],
        )
        .unwrap();
        insert_span(&conn, entry_id, 0, 5, None);
        insert_span(&conn, entry_id, 0, 8, Some(LANE_SUMMARY_MODEL));

        let before_base = conn
            .query_row(
                "SELECT json_object(
                    'id', id, 'projectId', project_id, 'type', type, 'name', name,
                    'summary', summary, 'content', content, 'aliases', aliases,
                    'parentId', parent_id, 'version', version
                 ) FROM codex_entries WHERE id = ?1",
                params![entry_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let before_json = codex_update_before_snapshot(&conn, entry_id, &before_base).unwrap();

        conn.execute(
            "UPDATE codex_entries SET name = 'New', summary = 'new sum', version = 2 WHERE id = ?1",
            params![entry_id],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM authorship_spans WHERE codex_entry_id = ?1 AND model = ?2",
            params![entry_id, LANE_SUMMARY_MODEL],
        )
        .unwrap();
        insert_span(&conn, entry_id, 0, 7, Some(LANE_SUMMARY_MODEL));

        let after_base = conn
            .query_row(
                "SELECT json_object(
                    'id', id, 'projectId', project_id, 'type', type, 'name', name,
                    'summary', summary, 'content', content, 'aliases', aliases,
                    'parentId', parent_id, 'version', version
                 ) FROM codex_entries WHERE id = ?1",
                params![entry_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap();
        let after_json = codex_update_after_snapshot(&conn, entry_id, &after_base).unwrap();

        insert_undo_journal_in_tx(
            &conn,
            UndoJournalInsert {
                id: "j1",
                project_id: "p1",
                surface: "test",
                entity_kind: "codex_entry",
                entity_id: entry_id,
                op_kind: "update",
                before_json: Some(&before_json),
                after_json: Some(&after_json),
                base_version: 1,
                result_version: 2,
                change_event_uid: None,
            },
        )
        .unwrap();

        revert_undo_journal_in_tx(&conn, "p1", "j1").unwrap();

        let name: String = conn
            .query_row(
                "SELECT name FROM codex_entries WHERE id = ?1",
                params![entry_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "Old");

        let spans = load_codex_authorship_spans(&conn, entry_id).unwrap();
        assert_eq!(spans.len(), 2);
        assert!(spans.iter().any(|s| s.model.is_none()));
        assert!(spans
            .iter()
            .any(|s| s.model.as_deref() == Some(LANE_SUMMARY_MODEL) && s.to_pos == 8));

        apply_undo_journal_in_tx(&conn, "p1", "j1").unwrap();
        let name: String = conn
            .query_row(
                "SELECT name FROM codex_entries WHERE id = ?1",
                params![entry_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(name, "New");
        let spans = load_codex_authorship_spans(&conn, entry_id).unwrap();
        assert_eq!(spans.len(), 2);
        assert!(spans
            .iter()
            .any(|s| s.model.as_deref() == Some(LANE_SUMMARY_MODEL) && s.to_pos == 7));
    }

    #[test]
    fn snippet_create_undo_redo_preserves_entity_id() {
        let conn = setup_conn();
        let snippet_id = "s1";
        let after_base = json!({
            "id": snippet_id,
            "projectId": "p1",
            "title": "Title",
            "content": "{}",
            "sceneId": null,
            "contentSource": "ai",
            "version": 1,
        })
        .to_string();

        conn.execute(
            "INSERT INTO snippets
             (id, project_id, title, content, content_source, version)
             VALUES (?1, 'p1', 'Title', '{}', 'ai', 1)",
            params![snippet_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO authorship_spans
             (id, snippet_id, from_pos, to_pos, source, model)
             VALUES ('span1', ?1, 0, 3, 'ai', '__lane_content__')",
            params![snippet_id],
        )
        .unwrap();

        let after_json = snippet_create_after_snapshot(&conn, snippet_id, &after_base).unwrap();
        insert_undo_journal_in_tx(
            &conn,
            UndoJournalInsert {
                id: "j2",
                project_id: "p1",
                surface: "test",
                entity_kind: "snippet",
                entity_id: snippet_id,
                op_kind: "create",
                before_json: None,
                after_json: Some(&after_json),
                base_version: 0,
                result_version: 1,
                change_event_uid: None,
            },
        )
        .unwrap();

        revert_undo_journal_in_tx(&conn, "p1", "j2").unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM snippets WHERE id = ?1",
                params![snippet_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);

        apply_undo_journal_in_tx(&conn, "p1", "j2").unwrap();
        let title: String = conn
            .query_row(
                "SELECT title FROM snippets WHERE id = ?1",
                params![snippet_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(title, "Title");
        let span_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM authorship_spans WHERE snippet_id = ?1",
                params![snippet_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(span_count, 1);
    }
}
