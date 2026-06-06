use rusqlite::{params, Connection};

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

/// Revert an undo-journal entry (global-history undo path).
pub fn revert_undo_journal_in_tx(
    conn: &Connection,
    project_id: &str,
    journal_id: &str,
) -> anyhow::Result<()> {
    let row = load_undo_journal(conn, project_id, journal_id)?;
    if row.entity_kind != "codex_entry" {
        anyhow::bail!(
            "revert_undo_journal: unsupported entity_kind '{}'",
            row.entity_kind
        );
    }
    match row.op_kind.as_str() {
        "create" => {
            let deleted = conn.execute(
                "DELETE FROM codex_entries WHERE id = ?1 AND project_id = ?2 AND version = ?3",
                params![row.entity_id, project_id, row.result_version],
            )?;
            if deleted == 0 {
                anyhow::bail!(
                    "revert create: codex entry '{}' version {} not found (external change?)",
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
                    row.base_version,
                    row.entity_id,
                    project_id,
                    row.result_version,
                ],
            )?;
            if updated == 0 {
                anyhow::bail!(
                    "revert update: codex entry '{}' version {} conflict",
                    row.entity_id,
                    row.result_version
                );
            }
            conn.execute(
                "DELETE FROM authorship_spans WHERE codex_entry_id = ?1",
                params![row.entity_id],
            )?;
        }
        other => anyhow::bail!("revert_undo_journal: unsupported op_kind '{other}'"),
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
    if row.entity_kind != "codex_entry" {
        anyhow::bail!(
            "apply_undo_journal: unsupported entity_kind '{}'",
            row.entity_kind
        );
    }
    match row.op_kind.as_str() {
        "create" => {
            let after = row
                .after_json
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("apply create: missing after_json"))?;
            let snap: serde_json::Value = serde_json::from_str(after)?;
            let id = snap["id"].as_str().unwrap_or(&row.entity_id);
            let entry_type = snap["type"].as_str().unwrap_or("lore");
            let name = snap["name"].as_str().unwrap_or("Untitled");
            let summary = snap["summary"].as_str().unwrap_or("");
            let content = snap["content"].as_str().unwrap_or("{}");
            let aliases = snap["aliases"].as_str();
            let parent_id = snap["parentId"].as_str();
            let version = snap["version"].as_i64().unwrap_or(row.result_version);
            let project = snap["projectId"].as_str().unwrap_or(project_id);
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
        }
        "update" => {
            let after = row
                .after_json
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("apply update: missing after_json"))?;
            let snap: serde_json::Value = serde_json::from_str(after)?;
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
                    row.result_version,
                    row.entity_id,
                    project_id,
                    row.base_version,
                ],
            )?;
            if updated == 0 {
                anyhow::bail!(
                    "apply update: codex entry '{}' version {} conflict",
                    row.entity_id,
                    row.base_version
                );
            }
        }
        other => anyhow::bail!("apply_undo_journal: unsupported op_kind '{other}'"),
    }
    Ok(())
}
