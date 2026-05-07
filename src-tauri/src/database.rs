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
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

mod execute;
mod fts;
mod integrity;
mod migrate;

#[cfg(test)]
mod tests;
