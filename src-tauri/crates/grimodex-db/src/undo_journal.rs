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

/// Insert an undo-journal row inside an open transaction.
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
