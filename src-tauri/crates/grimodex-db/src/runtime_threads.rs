//! External AI runtime thread bindings.
//!
//! The binding is deliberately separate from `chat_sessions`: more than one
//! runtime can be attached to the same Grimodex session, and the external ID
//! must never be accepted without checking the local project/session owner.

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::Database;

pub const CODEX_APP_SERVER_RUNTIME: &str = "codex-app-server";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeThreadBinding {
    pub session_id: String,
    pub runtime: String,
    pub external_thread_id: String,
    pub project_id: String,
    pub history_revision: Option<String>,
    pub last_turn_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn ensure_session_project(
    conn: &rusqlite::Connection,
    project_id: &str,
    session_id: &str,
) -> anyhow::Result<()> {
    let owner: Option<String> = conn
        .query_row(
            "SELECT project_id FROM chat_sessions WHERE id = ?1",
            params![session_id],
            |row| row.get(0),
        )
        .optional()?;
    match owner {
        Some(owner) if owner == project_id => Ok(()),
        Some(_) => anyhow::bail!("chat session project mismatch"),
        None => anyhow::bail!("chat session not found"),
    }
}

impl Database {
    /// Get a binding only after proving that the session belongs to project_id.
    pub fn get_chat_runtime_thread_binding(
        &self,
        project_id: &str,
        session_id: &str,
        runtime: &str,
    ) -> anyhow::Result<Option<RuntimeThreadBinding>> {
        self.with_conn(|conn| {
            ensure_session_project(conn, project_id, session_id)?;
            conn.query_row(
                "SELECT session_id, runtime, external_thread_id, project_id,
                        history_revision, last_turn_id, created_at, updated_at
                 FROM chat_runtime_threads
                 WHERE session_id = ?1 AND runtime = ?2 AND project_id = ?3",
                params![session_id, runtime, project_id],
                |row| {
                    Ok(RuntimeThreadBinding {
                        session_id: row.get(0)?,
                        runtime: row.get(1)?,
                        external_thread_id: row.get(2)?,
                        project_id: row.get(3)?,
                        history_revision: row.get(4)?,
                        last_turn_id: row.get(5)?,
                        created_at: row.get(6)?,
                        updated_at: row.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
        })
    }

    /// Insert or replace a binding, while preserving the local ownership check.
    pub fn upsert_chat_runtime_thread_binding(
        &self,
        binding: &RuntimeThreadBinding,
    ) -> anyhow::Result<()> {
        self.with_conn(|conn| {
            ensure_session_project(conn, &binding.project_id, &binding.session_id)?;
            conn.execute(
                "INSERT INTO chat_runtime_threads
                   (session_id, runtime, external_thread_id, project_id,
                    history_revision, last_turn_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(session_id, runtime) DO UPDATE SET
                   external_thread_id = excluded.external_thread_id,
                   project_id = excluded.project_id,
                   history_revision = excluded.history_revision,
                   last_turn_id = excluded.last_turn_id,
                   updated_at = excluded.updated_at",
                params![
                    binding.session_id,
                    binding.runtime,
                    binding.external_thread_id,
                    binding.project_id,
                    binding.history_revision,
                    binding.last_turn_id,
                    binding.created_at,
                    binding.updated_at,
                ],
            )?;
            Ok(())
        })
    }

    /// Delete only the binding owned by project_id/session_id.
    pub fn delete_chat_runtime_thread_binding(
        &self,
        project_id: &str,
        session_id: &str,
        runtime: &str,
    ) -> anyhow::Result<()> {
        self.with_conn(|conn| {
            ensure_session_project(conn, project_id, session_id)?;
            conn.execute(
                "DELETE FROM chat_runtime_threads
                 WHERE session_id = ?1 AND runtime = ?2 AND project_id = ?3",
                params![session_id, runtime, project_id],
            )?;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use std::path::Path;

    fn fixture() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("db");
        db.migrate().expect("migrate");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('p1', 'Project')",
                [],
            )?;
            conn.execute(
                "INSERT INTO chat_sessions (id, project_id, title) VALUES ('s1', 'p1', 'Session')",
                [],
            )?;
            Ok(())
        })
        .expect("fixture");
        db
    }

    fn binding() -> RuntimeThreadBinding {
        RuntimeThreadBinding {
            session_id: "s1".to_string(),
            runtime: CODEX_APP_SERVER_RUNTIME.to_string(),
            external_thread_id: "thread-1".to_string(),
            project_id: "p1".to_string(),
            history_revision: Some("rev-1".to_string()),
            last_turn_id: None,
            created_at: "2026-07-14T00:00:00.000Z".to_string(),
            updated_at: "2026-07-14T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn binding_round_trip_and_replace_is_scoped() {
        let db = fixture();
        let original = binding();
        db.upsert_chat_runtime_thread_binding(&original)
            .expect("insert");
        let mut updated = original.clone();
        updated.external_thread_id = "thread-2".to_string();
        updated.last_turn_id = Some("turn-1".to_string());
        db.upsert_chat_runtime_thread_binding(&updated)
            .expect("replace");
        assert_eq!(
            db.get_chat_runtime_thread_binding("p1", "s1", CODEX_APP_SERVER_RUNTIME)
                .expect("get"),
            Some(updated),
        );
    }

    #[test]
    fn cross_project_access_is_rejected() {
        let db = fixture();
        let error = db
            .get_chat_runtime_thread_binding("p2", "s1", CODEX_APP_SERVER_RUNTIME)
            .expect_err("project mismatch");
        assert!(error.to_string().contains("project mismatch"));
    }
}
