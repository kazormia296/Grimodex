//! Tracked foreshadow create/update — closes the last untracked AI write.
//!
//! Mirrors `writes::codex` / `writes::snippet`: one BEGIN IMMEDIATE tx writes
//! the entity row + undo_journal + change_events (domain "foreshadow"). Two
//! deliberate differences from codex:
//!
//! - **No authorship_spans**: `authorship_spans` only has codex_entry_id /
//!   snippet_id FKs; foreshadow rows are metadata, not prose. Snapshots carry
//!   the plain row fields only.
//! - **Versionless optimistic guard**: `foreshadows` has no `version` column
//!   and its many writers (in-app panel, save_anchors, MCP) all bump
//!   `updated_at` (millis). The undo journal therefore stores the *before*
//!   `updated_at` in `base_version` and the *after* `updated_at` in
//!   `result_version`, and revert/apply guard on `updated_at` equality the
//!   same way codex guards on `version`. Two writes inside one millisecond
//!   are indistinguishable — acceptable for low-frequency metadata edits.

use anyhow::Context;

use rusqlite::{params, Connection};
use serde_json::json;

use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::undo_journal::{insert_undo_journal_in_tx, UndoJournalInsert};
use crate::writes::WriteResult;

pub struct TrackedForeshadowCreateInput<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub surface: &'a str,
    /// Caller-supplied UUID (like snippet_id in tracked_snippet_create).
    pub foreshadow_id: &'a str,
    pub title: &'a str,
    pub intent: Option<&'a str>,
    pub notes: Option<&'a str>,
    pub load_bearing: Option<&'a str>,
    pub secret: bool,
}

/// Only `Some` fields are written (same contract as the raw dynamic-SET
/// updater this replaces).
#[derive(Default)]
pub struct ForeshadowPatch<'a> {
    pub title: Option<&'a str>,
    pub intent: Option<&'a str>,
    pub notes: Option<&'a str>,
    pub load_bearing: Option<&'a str>,
    pub payoff_confirmed: Option<bool>,
    pub abandoned: Option<bool>,
    pub secret: Option<bool>,
}

pub struct TrackedForeshadowUpdateInput<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub surface: &'a str,
    pub foreshadow_id: &'a str,
    pub patch: ForeshadowPatch<'a>,
}

pub fn tracked_foreshadow_create(
    _conn: &Connection,
    _input: TrackedForeshadowCreateInput<'_>,
) -> anyhow::Result<WriteResult> {
    anyhow::bail!("unimplemented")
}

/// Returns `Ok(None)` when the foreshadow does not exist **in this project**
/// (cross-project ids are indistinguishable from missing — XPROJ defense).
/// Nothing is written in that case.
pub fn tracked_foreshadow_update(
    _conn: &Connection,
    _input: TrackedForeshadowUpdateInput<'_>,
) -> anyhow::Result<Option<WriteResult>> {
    anyhow::bail!("unimplemented")
}

// Referenced by the implementation (kept so the red skeleton compiles).
#[allow(unused_imports)]
use append_change_events_in_tx as _a;
#[allow(unused_imports)]
use insert_undo_journal_in_tx as _b;

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::undo_journal::{apply_undo_journal_in_tx, revert_undo_journal_in_tx};

    fn setup_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL);
             CREATE TABLE foreshadows (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                intent TEXT,
                notes TEXT,
                payoff_scene_id TEXT,
                payoff_from_pos INTEGER,
                payoff_to_pos INTEGER,
                payoff_confirmed INTEGER NOT NULL DEFAULT 0,
                abandoned INTEGER NOT NULL DEFAULT 0,
                secret INTEGER NOT NULL DEFAULT 1,
                load_bearing TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE TABLE undo_journal (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                surface TEXT NOT NULL,
                entity_kind TEXT NOT NULL,
                entity_id TEXT NOT NULL,
                op_kind TEXT NOT NULL,
                before_json TEXT,
                after_json TEXT,
                base_version INTEGER NOT NULL,
                result_version INTEGER NOT NULL,
                change_event_uid TEXT
             );
             CREATE TABLE change_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_uid TEXT,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                scene_id TEXT,
                domain TEXT NOT NULL,
                op_type TEXT NOT NULL,
                entity_type TEXT,
                entity_id TEXT,
                payload TEXT NOT NULL,
                session_id TEXT NOT NULL,
                sequence INTEGER NOT NULL,
                timestamp INTEGER NOT NULL,
                prev_hash TEXT NOT NULL,
                hash TEXT NOT NULL
             );
             CREATE UNIQUE INDEX uq_change_events_project_seq
                ON change_events(project_id, sequence);
             CREATE UNIQUE INDEX uq_change_events_project_uid
                ON change_events(project_id, event_uid);",
        )
        .unwrap();
        conn.execute("INSERT INTO projects (id, title) VALUES ('p1', 'Test')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('p2', 'Other')",
            [],
        )
        .unwrap();
        conn
    }

    fn create_input<'a>(id: &'a str, title: &'a str) -> TrackedForeshadowCreateInput<'a> {
        TrackedForeshadowCreateInput {
            project_id: "p1",
            session_id: "sess",
            surface: "test",
            foreshadow_id: id,
            title,
            intent: Some("the intent"),
            notes: None,
            load_bearing: Some("critical"),
            secret: false,
        }
    }

    /// Insert a raw row with a fixed past updated_at so base_version
    /// assertions are deterministic.
    fn seed_raw_row(conn: &Connection, id: &str, project_id: &str, title: &str, millis: i64) {
        conn.execute(
            "INSERT INTO foreshadows
             (id, project_id, title, intent, secret, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'orig intent', 1, ?4, ?4)",
            params![id, project_id, title, millis],
        )
        .unwrap();
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    fn row_updated_at(conn: &Connection, id: &str) -> i64 {
        conn.query_row(
            "SELECT updated_at FROM foreshadows WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    // ---------------- create ----------------

    #[test]
    fn create_writes_row_undo_journal_and_change_event() {
        let conn = setup_conn();
        let res = tracked_foreshadow_create(&conn, create_input("f1", "Planted clue")).unwrap();
        assert_eq!(res.entity_id, "f1");

        // Entity row with the exact raw-writer column behavior.
        let (title, intent, secret, payoff_confirmed, lb): (String, String, i64, i64, String) =
            conn.query_row(
                "SELECT title, intent, secret, payoff_confirmed, load_bearing
                 FROM foreshadows WHERE id = 'f1' AND project_id = 'p1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(title, "Planted clue");
        assert_eq!(intent, "the intent");
        assert_eq!(secret, 0);
        assert_eq!(payoff_confirmed, 0);
        assert_eq!(lb, "critical");

        // Change event: domain/op_type/entity/session.
        let (domain, op_type, entity_type, entity_id, session_id, payload): (
            String,
            String,
            String,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT domain, op_type, entity_type, entity_id, session_id, payload
                 FROM change_events",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(domain, "foreshadow");
        assert_eq!(op_type, "foreshadow.create");
        assert_eq!(entity_type, "foreshadow");
        assert_eq!(entity_id, "f1");
        assert_eq!(session_id, "sess");
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["title"], "Planted clue");

        // Undo journal: create op, before=None, after snapshot with full row,
        // result_version = row updated_at (versionless guard contract).
        let (entity_kind, op_kind, surface, before, after, base_v, result_v): (
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT entity_kind, op_kind, surface, before_json, after_json,
                        base_version, result_version
                 FROM undo_journal",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(entity_kind, "foreshadow");
        assert_eq!(op_kind, "create");
        assert_eq!(surface, "test");
        assert!(before.is_none());
        let after: serde_json::Value = serde_json::from_str(&after.unwrap()).unwrap();
        assert_eq!(after["title"], "Planted clue");
        assert_eq!(after["secret"], 0);
        assert_eq!(base_v, 0);
        assert_eq!(result_v, row_updated_at(&conn, "f1"));
        assert_eq!(res.undo_journal_id.is_empty(), false);
        assert_eq!(res.change_event_uid.is_empty(), false);
    }

    #[test]
    fn create_rolls_back_atomically_on_failure() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p1", "Existing", 1000);
        // Duplicate primary key → the whole tx must roll back: no journal row,
        // no change event, no half-written state.
        let res = tracked_foreshadow_create(&conn, create_input("f1", "Dup"));
        assert!(res.is_err());
        assert_eq!(count(&conn, "undo_journal"), 0);
        assert_eq!(count(&conn, "change_events"), 0);
        assert_eq!(
            conn.query_row("SELECT title FROM foreshadows WHERE id = 'f1'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "Existing"
        );
    }

    // ---------------- update ----------------

    #[test]
    fn update_patches_only_provided_fields() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p1", "Original", 1000);

        let res = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "f1",
                patch: ForeshadowPatch {
                    title: Some("Renamed"),
                    load_bearing: Some("supporting"),
                    ..Default::default()
                },
            },
        )
        .unwrap()
        .expect("row exists in p1");
        assert_eq!(res.entity_id, "f1");

        let (title, intent, secret, lb): (String, String, i64, String) = conn
            .query_row(
                "SELECT title, intent, secret, load_bearing FROM foreshadows WHERE id = 'f1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(title, "Renamed");
        assert_eq!(intent, "orig intent", "untouched field must survive");
        assert_eq!(secret, 1, "untouched field must survive");
        assert_eq!(lb, "supporting");

        // Change event payload lists the patched fields.
        let payload: String = conn
            .query_row(
                "SELECT payload FROM change_events WHERE op_type = 'foreshadow.update'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
        let fields: Vec<&str> = payload["fields"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(fields.contains(&"title"), "fields: {fields:?}");
        assert!(fields.contains(&"loadBearing"), "fields: {fields:?}");
        assert!(!fields.contains(&"secret"), "fields: {fields:?}");

        // Journal: before/after snapshots + updated_at-based versions.
        let (op_kind, before, after, base_v, result_v): (
            String,
            Option<String>,
            Option<String>,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT op_kind, before_json, after_json, base_version, result_version
                 FROM undo_journal",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(op_kind, "update");
        let before: serde_json::Value = serde_json::from_str(&before.unwrap()).unwrap();
        let after: serde_json::Value = serde_json::from_str(&after.unwrap()).unwrap();
        assert_eq!(before["title"], "Original");
        assert_eq!(after["title"], "Renamed");
        assert_eq!(base_v, 1000, "base_version = before updated_at");
        assert_eq!(result_v, row_updated_at(&conn, "f1"));
    }

    #[test]
    fn update_not_found_returns_none_and_writes_nothing() {
        let conn = setup_conn();
        let res = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "ghost",
                patch: ForeshadowPatch {
                    title: Some("X"),
                    ..Default::default()
                },
            },
        )
        .unwrap();
        assert!(res.is_none());
        assert_eq!(count(&conn, "undo_journal"), 0);
        assert_eq!(count(&conn, "change_events"), 0);
    }

    #[test]
    fn update_cross_project_returns_none_and_leaves_row() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p2", "Owned by p2", 1000);
        // XPROJ: scoped to p1, a p2 row must look missing and stay untouched.
        let res = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "f1",
                patch: ForeshadowPatch {
                    title: Some("hijacked"),
                    ..Default::default()
                },
            },
        )
        .unwrap();
        assert!(res.is_none());
        assert_eq!(
            conn.query_row("SELECT title FROM foreshadows WHERE id = 'f1'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "Owned by p2"
        );
        assert_eq!(count(&conn, "undo_journal"), 0);
        assert_eq!(count(&conn, "change_events"), 0);
    }

    // ---------------- undo / redo ----------------

    #[test]
    fn undo_redo_roundtrip_for_create() {
        let conn = setup_conn();
        let res = tracked_foreshadow_create(&conn, create_input("f1", "Plant")).unwrap();

        revert_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id).unwrap();
        assert_eq!(count(&conn, "foreshadows"), 0, "undo create = delete");

        apply_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id).unwrap();
        let (title, secret, lb): (String, i64, String) = conn
            .query_row(
                "SELECT title, secret, load_bearing FROM foreshadows WHERE id = 'f1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(title, "Plant");
        assert_eq!(secret, 0);
        assert_eq!(lb, "critical");
    }

    #[test]
    fn undo_create_conflicts_when_row_modified_after() {
        let conn = setup_conn();
        let res = tracked_foreshadow_create(&conn, create_input("f1", "Plant")).unwrap();
        // External edit after the tracked write (updated_at moves on) — undo
        // must refuse to delete instead of silently destroying the edit.
        conn.execute(
            "UPDATE foreshadows SET title = 'edited later', updated_at = updated_at + 5000
             WHERE id = 'f1'",
            [],
        )
        .unwrap();
        let result = revert_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id);
        assert!(result.is_err(), "conflict must bail, not clobber");
        assert_eq!(count(&conn, "foreshadows"), 1, "row must survive");
    }

    #[test]
    fn undo_redo_roundtrip_for_update() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p1", "Original", 1000);
        let res = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "f1",
                patch: ForeshadowPatch {
                    title: Some("Renamed"),
                    abandoned: Some(true),
                    ..Default::default()
                },
            },
        )
        .unwrap()
        .unwrap();

        revert_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id).unwrap();
        let (title, abandoned): (String, i64) = conn
            .query_row(
                "SELECT title, abandoned FROM foreshadows WHERE id = 'f1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Original");
        assert_eq!(abandoned, 0);
        assert_eq!(
            row_updated_at(&conn, "f1"),
            1000,
            "undo restores the before updated_at so redo's guard lines up"
        );

        apply_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id).unwrap();
        let (title, abandoned): (String, i64) = conn
            .query_row(
                "SELECT title, abandoned FROM foreshadows WHERE id = 'f1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Renamed");
        assert_eq!(abandoned, 1);
    }

    #[test]
    fn undo_update_conflicts_when_row_modified_after() {
        let conn = setup_conn();
        seed_raw_row(&conn, "f1", "p1", "Original", 1000);
        let res = tracked_foreshadow_update(
            &conn,
            TrackedForeshadowUpdateInput {
                project_id: "p1",
                session_id: "sess",
                surface: "test",
                foreshadow_id: "f1",
                patch: ForeshadowPatch {
                    title: Some("Renamed"),
                    ..Default::default()
                },
            },
        )
        .unwrap()
        .unwrap();
        conn.execute(
            "UPDATE foreshadows SET title = 'edited later', updated_at = updated_at + 5000
             WHERE id = 'f1'",
            [],
        )
        .unwrap();
        let result = revert_undo_journal_in_tx(&conn, "p1", &res.undo_journal_id);
        assert!(result.is_err(), "conflict must bail, not clobber");
        assert_eq!(
            conn.query_row("SELECT title FROM foreshadows WHERE id = 'f1'", [], |r| {
                r.get::<_, String>(0)
            })
            .unwrap(),
            "edited later"
        );
    }
}
