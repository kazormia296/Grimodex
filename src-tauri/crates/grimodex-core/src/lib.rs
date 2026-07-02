//! Lightweight shared primitives for Grimodex AI writes (no ort/lindera).

pub const SCHEMA_VERSION: i32 = 1;

/// Commit a manually-opened transaction, rolling back if the COMMIT itself
/// fails. On the shared single connection a failed COMMIT (deferred FK check,
/// SQLITE_BUSY, disk-full, ...) otherwise leaves the transaction open, so the
/// next caller inherits a zombie transaction and its writes silently ride on or
/// get rolled back with it. Always leaves the connection in autocommit state on
/// return.
pub fn commit_or_rollback(conn: &rusqlite::Connection) -> anyhow::Result<()> {
    if let Err(e) = conn.execute_batch("COMMIT") {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(e.into());
    }
    Ok(())
}

pub mod change_events;
pub mod license;
pub mod pm_text;
pub mod policy;
pub mod snapshots;
pub mod undo_journal;
pub mod writes;
