use rusqlite::Connection;
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

#[derive(Debug, serde::Deserialize)]
pub struct BatchStatement {
    pub sql: String,
    pub params: Vec<Value>,
    pub method: String,
}

pub struct Database {
    conn: Mutex<Connection>,
}

impl Database {
    pub fn new(path: &Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        // synchronous=NORMAL is safe with WAL (committed txns survive crash;
        // only the very last group commit can be lost on power loss). The
        // SQLite default `FULL` issues an extra fsync per write — on WSL2 and
        // some SSDs that adds 100s of ms per UPDATE, which dominated D&D
        // commit latency in grid perf logs.
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;
             PRAGMA foreign_keys=ON;
             -- Perf/maintenance (DB health audit 2026-07). All safe defaults:
             -- 16 MiB page cache, 256 MiB mmap reads, temp b-trees in RAM.
             PRAGMA cache_size=-16000;
             PRAGMA mmap_size=268435456;
             PRAGMA temp_store=MEMORY;
             -- Bound WAL growth on this long-lived connection: checkpoint every
             -- ~1000 pages and truncate the WAL file back to 64 MiB afterwards
             -- so it can't grow without bound during a long session.
             PRAGMA wal_autocheckpoint=1000;
             PRAGMA journal_size_limit=67108864;
             -- Cap the work `PRAGMA optimize` (run post-migrate / on close) does.
             PRAGMA analysis_limit=400;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Update the query planner's statistics (`sqlite_stat1`). Cheap because
    /// `analysis_limit` is set at open; safe to call any time. Run after
    /// migrate and periodically — without it SQLite never gathers stats and the
    /// planner can pick poor plans as tables grow (DB health audit 2026-07).
    pub fn optimize(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        conn.execute_batch("PRAGMA optimize;")?;
        Ok(())
    }

    /// Write a consistent, compacted copy of the whole database to `dest` using
    /// `VACUUM INTO`. This is the automatic-backup primitive — it runs against
    /// the live connection and produces a standalone .db the user can restore by
    /// copying it back over grimodex.db (DB health audit 2026-07).
    pub fn backup_to(&self, dest: &Path) -> anyhow::Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let dest_str = dest
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("backup path is not valid UTF-8"))?;
        conn.execute("VACUUM INTO ?1", rusqlite::params![dest_str])?;
        Ok(())
    }

    /// Age out append-only audit/debug logs that otherwise grow without bound
    /// (DB health audit 2026-07). `change_events` is intentionally excluded —
    /// its append-only hash chain can't be partially pruned without a dedicated
    /// compaction pass. undo_journal / chat_message_prompts / generation_logs
    /// past the retention window are safe to drop. Returns rows deleted.
    pub fn prune_old_logs(&self, retain_days: i64) -> anyhow::Result<usize> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let cutoff = format!("-{retain_days} days");
        let mut total = 0usize;
        // Table names are fixed literals (no injection); created_at is stored in
        // datetime('now') text form, so lexical comparison is chronological.
        for table in ["undo_journal", "chat_message_prompts", "generation_logs"] {
            let sql = format!("DELETE FROM {table} WHERE created_at < datetime('now', ?1)");
            total += conn.execute(&sql, rusqlite::params![cutoff])?;
        }
        Ok(total)
    }

    /// Lightweight structural integrity probe (`PRAGMA quick_check`). Returns
    /// `Ok(None)` when the database reports `ok`, otherwise `Ok(Some(report))`
    /// with the first errors. Cheaper than `integrity_check`; used by the
    /// backup path to refuse snapshotting a corrupt DB (DB health audit 2026-07).
    pub fn quick_check(&self) -> anyhow::Result<Option<String>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let first: String = conn.query_row("PRAGMA quick_check(1)", [], |r| r.get(0))?;
        if first == "ok" {
            Ok(None)
        } else {
            Ok(Some(first))
        }
    }

    /// Execute a closure with direct access to the underlying `rusqlite::Connection`.
    /// Use this only when `execute` / `execute_batch_tx` are insufficient
    /// (e.g. `prepare` / `query_map` / `query_row` with native params).
    pub fn with_conn<T, F>(&self, f: F) -> anyhow::Result<T>
    where
        F: FnOnce(&Connection) -> anyhow::Result<T>,
    {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        f(&conn)
    }
}

pub(crate) mod change_events;
mod execute;
mod fts;
mod integrity;
mod migrate;
pub(crate) mod undo_journal;

#[cfg(test)]
mod tests;
