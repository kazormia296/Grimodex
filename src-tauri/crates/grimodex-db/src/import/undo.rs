use serde_json::Value;

use crate::Database;

/// Import undo is intentionally unavailable until the full imported project
/// bootstrap has a complete genesis journal to verify against.
pub fn undo_commit(
    _db: &Database,
    _commit_id: String,
    _expected_project_version: Option<i64>,
) -> anyhow::Result<Value> {
    anyhow::bail!(
        "IMPORT_UNDO_NOT_IMPLEMENTED: native import undo requires a verified genesis project journal"
    )
}
