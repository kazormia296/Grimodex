use rusqlite::Connection;
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;

#[derive(serde::Deserialize)]
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
             PRAGMA foreign_keys=ON;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
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
