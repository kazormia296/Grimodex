//! Typed Chronicle aggregate persistence used by the desktop renderer.
//!
//! Event participant replacement is one optimistic-concurrency transaction:
//! the event version, participant set, and updated timestamp either advance
//! together or remain untouched. Project ownership is checked for both the
//! event and every Codex participant.

use rusqlite::{params, OptionalExtension};
use serde::Deserialize;

use super::Database;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetParticipantsPayload {
    pub project_id: String,
    pub event_id: String,
    pub codex_entry_ids: Vec<String>,
    pub base_version: i64,
    pub updated_at: String,
}

fn require_non_empty(value: &str, field: &str) -> anyhow::Result<()> {
    if value.is_empty() {
        anyhow::bail!("chronicle {field} must not be empty");
    }
    Ok(())
}

fn ensure_codex_in_project(
    conn: &rusqlite::Connection,
    project_id: &str,
    codex_entry_id: &str,
) -> anyhow::Result<()> {
    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM codex_entries WHERE id = ?1 AND project_id = ?2",
            params![codex_entry_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    if exists.is_none() {
        anyhow::bail!("chronicle participant '{codex_entry_id}' is not in project '{project_id}'");
    }
    Ok(())
}

pub fn get_event_version(
    db: &Database,
    project_id: String,
    event_id: String,
) -> anyhow::Result<Option<i64>> {
    require_non_empty(&project_id, "projectId")?;
    require_non_empty(&event_id, "eventId")?;
    db.with_conn(|conn| {
        Ok(conn
            .query_row(
                "SELECT version FROM events WHERE id = ?1 AND project_id = ?2",
                params![event_id, project_id],
                |row| row.get(0),
            )
            .optional()?)
    })
}

pub fn set_event_participants(
    db: &Database,
    payload: SetParticipantsPayload,
) -> anyhow::Result<Option<i64>> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.event_id, "eventId")?;
    require_non_empty(&payload.updated_at, "updatedAt")?;
    for codex_entry_id in &payload.codex_entry_ids {
        require_non_empty(codex_entry_id, "codexEntryIds[]")?;
    }
    let result_version = payload
        .base_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("chronicle event version overflow"))?;

    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        let current_version: Option<i64> = transaction
            .query_row(
                "SELECT version FROM events WHERE id = ?1 AND project_id = ?2",
                params![payload.event_id, payload.project_id],
                |row| row.get(0),
            )
            .optional()?;
        if current_version != Some(payload.base_version) {
            return Ok(None);
        }

        for codex_entry_id in &payload.codex_entry_ids {
            ensure_codex_in_project(&transaction, &payload.project_id, codex_entry_id)?;
        }

        let updated = transaction.execute(
            "UPDATE events
                SET version = ?1, updated_at = ?2
              WHERE id = ?3 AND project_id = ?4 AND version = ?5",
            params![
                result_version,
                payload.updated_at,
                payload.event_id,
                payload.project_id,
                payload.base_version,
            ],
        )?;
        if updated == 0 {
            return Ok(None);
        }

        transaction.execute(
            "DELETE FROM event_participants WHERE event_id = ?1",
            params![payload.event_id],
        )?;
        for codex_entry_id in &payload.codex_entry_ids {
            transaction.execute(
                "INSERT INTO event_participants (event_id, codex_entry_id, role)
                 VALUES (?1, ?2, NULL)",
                params![payload.event_id, codex_entry_id],
            )?;
        }
        transaction.commit()?;
        Ok(Some(result_version))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn fixture() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO projects (id, title) VALUES ('p1', 'Project 1'), ('p2', 'Project 2')",
                [],
            )?;
            conn.execute(
                "INSERT OR IGNORE INTO codex_types (id, project_id, slug, label)
                 VALUES ('type-1', 'p1', 'character', 'Character'),
                        ('type-2', 'p2', 'character', 'Character')",
                [],
            )?;
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, type, name)
                 VALUES ('c1', 'p1', 'character', 'One'),
                        ('c2', 'p1', 'character', 'Two'),
                        ('cx', 'p2', 'character', 'Foreign')",
                [],
            )?;
            conn.execute(
                "INSERT INTO events (id, project_id, title, updated_at, version)
                 VALUES ('e1', 'p1', 'Event 1', 'old', 0),
                        ('ex', 'p2', 'Foreign event', 'old', 0)",
                [],
            )?;
            conn.execute(
                "INSERT INTO event_participants (event_id, codex_entry_id, role)
                 VALUES ('e1', 'c1', 'lead')",
                [],
            )?;
            Ok(())
        })
        .expect("seed database");
        db
    }

    fn payload(base_version: i64, codex_entry_ids: &[&str]) -> SetParticipantsPayload {
        SetParticipantsPayload {
            project_id: "p1".to_string(),
            event_id: "e1".to_string(),
            codex_entry_ids: codex_entry_ids
                .iter()
                .map(|value| (*value).to_string())
                .collect(),
            base_version,
            updated_at: "2026-07-30T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn event_version_is_project_scoped() {
        let db = fixture();
        assert_eq!(
            get_event_version(&db, "p1".to_string(), "e1".to_string()).expect("version"),
            Some(0)
        );
        assert_eq!(
            get_event_version(&db, "p2".to_string(), "e1".to_string()).expect("version"),
            None
        );
    }

    #[test]
    fn participant_replacement_advances_version_and_rejects_stale_base() {
        let db = fixture();
        assert_eq!(
            set_event_participants(&db, payload(0, &["c2"])).expect("replace"),
            Some(1)
        );
        assert_eq!(
            set_event_participants(&db, payload(0, &["c1"])).expect("stale"),
            None
        );
        db.with_conn(|conn| {
            let participants: Vec<String> = conn
                .prepare(
                    "SELECT codex_entry_id FROM event_participants
                     WHERE event_id = 'e1' ORDER BY codex_entry_id",
                )?
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(participants, vec!["c2"]);
            Ok(())
        })
        .expect("read participants");
    }

    #[test]
    fn foreign_participant_rolls_back_the_whole_aggregate() {
        let db = fixture();
        assert!(set_event_participants(&db, payload(0, &["cx"])).is_err());
        assert_eq!(
            get_event_version(&db, "p1".to_string(), "e1".to_string()).expect("version"),
            Some(0)
        );
        db.with_conn(|conn| {
            let role: String = conn.query_row(
                "SELECT role FROM event_participants
                 WHERE event_id = 'e1' AND codex_entry_id = 'c1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(role, "lead");
            Ok(())
        })
        .expect("read participant");
    }
}
