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

    /// Atomically commit a completed runtime turn's history revision.
    ///
    /// `pending_history_revision` is the durable marker written before
    /// `turn/start`. Every ownership and runtime identity field is part of the
    /// compare-and-swap predicate, so only the matching completed turn can replace
    /// that marker with the renderer's committed local-history revision.
    #[allow(clippy::too_many_arguments)]
    pub fn advance_chat_runtime_thread_history_revision(
        &self,
        project_id: &str,
        session_id: &str,
        runtime: &str,
        external_thread_id: &str,
        last_turn_id: &str,
        pending_history_revision: &str,
        next_history_revision: &str,
        updated_at: &str,
    ) -> anyhow::Result<bool> {
        self.with_conn(|conn| {
            let updated = conn.execute(
                "UPDATE chat_runtime_threads
                 SET history_revision = ?1, updated_at = ?2
                 WHERE project_id = ?3
                   AND session_id = ?4
                   AND runtime = ?5
                   AND external_thread_id = ?6
                   AND last_turn_id = ?7
                   AND history_revision = ?8",
                params![
                    next_history_revision,
                    updated_at,
                    project_id,
                    session_id,
                    runtime,
                    external_thread_id,
                    last_turn_id,
                    pending_history_revision,
                ],
            )?;
            Ok(updated == 1)
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
    use std::sync::{Arc, Barrier};
    use std::thread;

    fn fixture() -> Database {
        let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
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

    #[test]
    fn history_revision_compare_and_swap_advances_matching_binding() {
        let db = fixture();
        let mut original = binding();
        original.history_revision = Some("__grimodex_pending_v1__:turn-local-1".to_string());
        original.last_turn_id = Some("turn-1".to_string());
        db.upsert_chat_runtime_thread_binding(&original)
            .expect("insert binding");

        let advanced = db
            .advance_chat_runtime_thread_history_revision(
                "p1",
                "s1",
                CODEX_APP_SERVER_RUNTIME,
                "thread-1",
                "turn-1",
                "__grimodex_pending_v1__:turn-local-1",
                "rev-2",
                "2026-07-14T00:01:00.000Z",
            )
            .expect("advance revision");

        assert!(advanced);
        let updated = db
            .get_chat_runtime_thread_binding("p1", "s1", CODEX_APP_SERVER_RUNTIME)
            .expect("get binding")
            .expect("binding exists");
        assert_eq!(updated.history_revision.as_deref(), Some("rev-2"));
        assert_eq!(updated.updated_at, "2026-07-14T00:01:00.000Z");
        assert_eq!(updated.external_thread_id, "thread-1");
        assert_eq!(updated.last_turn_id.as_deref(), Some("turn-1"));
    }

    #[test]
    fn history_revision_compare_and_swap_rejects_every_stale_identity_field() {
        let db = fixture();
        let mut original = binding();
        original.history_revision = Some("__grimodex_pending_v1__:turn-local-1".to_string());
        original.last_turn_id = Some("turn-1".to_string());
        db.upsert_chat_runtime_thread_binding(&original)
            .expect("insert binding");

        let stale_inputs = [
            (
                "wrong project",
                "p2",
                "s1",
                CODEX_APP_SERVER_RUNTIME,
                "thread-1",
                "turn-1",
                "__grimodex_pending_v1__:turn-local-1",
            ),
            (
                "wrong session",
                "p1",
                "s2",
                CODEX_APP_SERVER_RUNTIME,
                "thread-1",
                "turn-1",
                "__grimodex_pending_v1__:turn-local-1",
            ),
            (
                "wrong runtime",
                "p1",
                "s1",
                "another-runtime",
                "thread-1",
                "turn-1",
                "__grimodex_pending_v1__:turn-local-1",
            ),
            (
                "wrong thread",
                "p1",
                "s1",
                CODEX_APP_SERVER_RUNTIME,
                "thread-2",
                "turn-1",
                "__grimodex_pending_v1__:turn-local-1",
            ),
            (
                "wrong turn",
                "p1",
                "s1",
                CODEX_APP_SERVER_RUNTIME,
                "thread-1",
                "turn-2",
                "__grimodex_pending_v1__:turn-local-1",
            ),
            (
                "wrong revision",
                "p1",
                "s1",
                CODEX_APP_SERVER_RUNTIME,
                "thread-1",
                "turn-1",
                "__grimodex_pending_v1__:stale-turn",
            ),
        ];

        for (label, project_id, session_id, runtime, thread_id, turn_id, revision) in stale_inputs {
            let advanced = db
                .advance_chat_runtime_thread_history_revision(
                    project_id,
                    session_id,
                    runtime,
                    thread_id,
                    turn_id,
                    revision,
                    "rev-2",
                    "2026-07-14T00:01:00.000Z",
                )
                .expect(label);
            assert!(!advanced, "{label}");
        }

        let unchanged = db
            .get_chat_runtime_thread_binding("p1", "s1", CODEX_APP_SERVER_RUNTIME)
            .expect("get binding")
            .expect("binding exists");
        assert_eq!(
            unchanged.history_revision.as_deref(),
            Some("__grimodex_pending_v1__:turn-local-1")
        );
        assert_eq!(unchanged.updated_at, original.updated_at);
    }

    #[test]
    fn competing_history_revision_advances_have_exactly_one_winner() {
        let db = Arc::new(fixture());
        let mut original = binding();
        original.history_revision = Some("__grimodex_pending_v1__:turn-local-1".to_string());
        original.last_turn_id = Some("turn-1".to_string());
        db.upsert_chat_runtime_thread_binding(&original)
            .expect("insert binding");

        let barrier = Arc::new(Barrier::new(3));
        let handles = ["rev-2-window-a", "rev-2-window-b"].map(|next_revision| {
            let db = Arc::clone(&db);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                db.advance_chat_runtime_thread_history_revision(
                    "p1",
                    "s1",
                    CODEX_APP_SERVER_RUNTIME,
                    "thread-1",
                    "turn-1",
                    "__grimodex_pending_v1__:turn-local-1",
                    next_revision,
                    "2026-07-14T00:01:00.000Z",
                )
                .expect("advance revision")
            })
        });

        barrier.wait();
        let results = handles.map(|handle| handle.join().expect("worker completed"));
        assert_eq!(results.into_iter().filter(|advanced| *advanced).count(), 1);

        let winner = db
            .get_chat_runtime_thread_binding("p1", "s1", CODEX_APP_SERVER_RUNTIME)
            .expect("get binding")
            .expect("binding exists")
            .history_revision
            .expect("revision exists");
        assert!(winner == "rev-2-window-a" || winner == "rev-2-window-b");
    }
}
