//! Undo helpers for aggregate foreshadow roots. Child rows cascade with roots.

use rusqlite::{params, Connection};
use serde_json::Value;

pub(crate) fn ensure_unchanged(conn: &Connection, project_id: &str, id: &str, version: i64) -> anyhow::Result<()> {
    let live: i64 = conn.query_row(
        "SELECT version FROM foreshadows WHERE id = ?1 AND project_id = ?2",
        params![id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(live == version, "NEX_COMMIT_FORESHADOW_EDITED: foreshadow '{id}' was modified after commit");
    Ok(())
}

pub(crate) fn undo_created(conn: &Connection, project_id: &str, id: &str, version: i64) -> anyhow::Result<()> {
    ensure_unchanged(conn, project_id, id, version)?;
    let deleted = conn.execute(
        "DELETE FROM foreshadows WHERE id = ?1 AND project_id = ?2 AND version = ?3",
        params![id, project_id, version],
    )?;
    anyhow::ensure!(deleted == 1, "NEX_COMMIT_FORESHADOW_EDITED: foreshadow '{id}' delete conflict");
    Ok(())
}

pub(crate) fn restore_patch(conn: &Connection, id: &str, before: &Value, after_version: i64, now: &str) -> anyhow::Result<i64> {
    let intent = before.get("intent").and_then(Value::as_str);
    let mechanism = before.get("mechanism").and_then(Value::as_str);
    let next = after_version.checked_add(1).ok_or_else(|| anyhow::anyhow!("foreshadow version overflow during undo"))?;
    let updated = conn.execute(
        "UPDATE foreshadows SET intent = ?1, mechanism = ?2, version = ?3, updated_at = ?4 WHERE id = ?5 AND version = ?6",
        params![intent, mechanism, next, now, id, after_version],
    )?;
    anyhow::ensure!(updated == 1, "NEX_COMMIT_FORESHADOW_EDITED: foreshadow '{id}' patch restore conflict");
    Ok(next)
}
