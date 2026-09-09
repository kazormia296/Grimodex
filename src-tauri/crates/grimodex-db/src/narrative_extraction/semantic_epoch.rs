//! Semantic Epoch persistence (Gate C2-01 `narrative_semantic_epochs`).
//!
//! A Semantic Epoch is the generation boundary a project advances through
//! whenever a restore, migration, or full rebuild invalidates prior Semantic
//! Build Graph state. `docs/adr/006-narrative-mutation-authority-routes.md`'s
//! `semantic-epoch-event` control is the authority boundary that is allowed
//! to mint one; this module is only the storage those callers write through.
//! `reason` is a closed, five-value vocabulary — anything else fails closed
//! rather than silently minting an epoch with drifted semantics.

use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

const VALID_REASONS: [&str; 5] = [
    "initial",
    "restore",
    "migration",
    "integrity-repair",
    "manual-rebuild",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentEpoch {
    pub id: String,
    pub epoch_number: i64,
    pub reason: String,
    pub created_at: String,
}

/// Mint the next Semantic Epoch for `project_id`. `epoch_number` is assigned
/// as one past the project's current maximum (starting at 0), so callers do
/// not need to know the current epoch before calling. Fails closed on an
/// unrecognized `reason`.
pub(crate) fn create_epoch_in_tx(
    conn: &Connection,
    project_id: &str,
    reason: &str,
    triggered_by_change_event_uid: Option<&str>,
) -> anyhow::Result<String> {
    anyhow::ensure!(
        VALID_REASONS.contains(&reason),
        "NEX_SEMANTIC_EPOCH_REASON_INVALID: reason '{reason}' is not a recognized semantic epoch reason"
    );

    super::nir1_chronicle_index::invalidate::suspend_project_in_tx(conn, project_id)?;
    let epoch_number: i64 = conn.query_row(
        "SELECT COALESCE(MAX(epoch_number), -1) + 1
           FROM narrative_semantic_epochs
          WHERE project_id = ?1",
        params![project_id],
        |row| row.get(0),
    )?;

    let id = Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();

    conn.execute(
        "INSERT INTO narrative_semantic_epochs
            (id, project_id, epoch_number, reason, triggered_by_change_event_uid, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            id,
            project_id,
            epoch_number,
            reason,
            triggered_by_change_event_uid,
            created_at,
        ],
    )?;

    Ok(id)
}

/// The most recently minted Semantic Epoch for `project_id`, if any.
pub fn get_current_epoch(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Option<CurrentEpoch>> {
    conn.query_row(
        "SELECT id, epoch_number, reason, created_at
           FROM narrative_semantic_epochs
          WHERE project_id = ?1
          ORDER BY epoch_number DESC
          LIMIT 1",
        params![project_id],
        |row| {
            Ok(CurrentEpoch {
                id: row.get(0)?,
                epoch_number: row.get(1)?,
                reason: row.get(2)?,
                created_at: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

/// All Semantic Epochs for `project_id`, oldest first.
///
/// No production caller yet -- diagnostic/history read surface for a
/// future IPC command.
#[allow(dead_code)]
pub(crate) fn list_epochs(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Vec<CurrentEpoch>> {
    let mut statement = conn.prepare(
        "SELECT id, epoch_number, reason, created_at
           FROM narrative_semantic_epochs
          WHERE project_id = ?1
          ORDER BY epoch_number ASC",
    )?;
    let rows = statement
        .query_map(params![project_id], |row| {
            Ok(CurrentEpoch {
                id: row.get(0)?,
                epoch_number: row.get(1)?,
                reason: row.get(2)?,
                created_at: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;

    fn test_db() -> Database {
        let db = Database::new(std::path::Path::new(":memory:")).expect("open database");
        db.migrate().expect("create current schema");
        db
    }

    #[test]
    fn first_epoch_starts_at_zero() {
        let db = test_db();
        let epoch_id = db
            .with_conn(|conn| create_epoch_in_tx(conn, "default-project", "initial", None))
            .expect("create first epoch");

        let current = db
            .with_conn(|conn| get_current_epoch(conn, "default-project"))
            .expect("load current epoch")
            .expect("epoch must exist");

        assert_eq!(current.id, epoch_id);
        assert_eq!(current.epoch_number, 0);
        assert_eq!(current.reason, "initial");

        let stored_uid: Option<String> = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT triggered_by_change_event_uid FROM narrative_semantic_epochs WHERE id = ?1",
                    rusqlite::params![epoch_id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read triggered_by_change_event_uid");
        assert_eq!(stored_uid, None, "initial epoch has no triggering event");
    }

    #[test]
    fn second_epoch_advances_the_number_and_becomes_current() {
        let db = test_db();
        db.with_conn(|conn| create_epoch_in_tx(conn, "default-project", "initial", None))
            .expect("create first epoch");
        let second_id = db
            .with_conn(|conn| {
                create_epoch_in_tx(conn, "default-project", "restore", Some("change-event-1"))
            })
            .expect("create second epoch");

        let current = db
            .with_conn(|conn| get_current_epoch(conn, "default-project"))
            .expect("load current epoch")
            .expect("epoch must exist");
        assert_eq!(current.id, second_id);
        assert_eq!(current.epoch_number, 1);
        assert_eq!(current.reason, "restore");

        let stored_uid: Option<String> = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT triggered_by_change_event_uid FROM narrative_semantic_epochs WHERE id = ?1",
                    rusqlite::params![second_id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("read triggered_by_change_event_uid");
        assert_eq!(stored_uid.as_deref(), Some("change-event-1"));

        let all = db
            .with_conn(|conn| list_epochs(conn, "default-project"))
            .expect("list epochs");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].epoch_number, 0);
        assert_eq!(all[1].epoch_number, 1);
    }

    #[test]
    fn invalid_reason_fails_closed() {
        let db = test_db();
        let error = db
            .with_conn(|conn| {
                create_epoch_in_tx(conn, "default-project", "not-a-real-reason", None)
            })
            .expect_err("unrecognized reason must be rejected");
        assert!(error
            .to_string()
            .starts_with("NEX_SEMANTIC_EPOCH_REASON_INVALID"));

        let all = db
            .with_conn(|conn| list_epochs(conn, "default-project"))
            .expect("list epochs");
        assert!(all.is_empty(), "no epoch row should have been inserted");
    }

    #[test]
    fn get_current_epoch_is_none_before_any_epoch_exists() {
        let db = test_db();
        let current = db
            .with_conn(|conn| get_current_epoch(conn, "default-project"))
            .expect("load current epoch");
        assert!(current.is_none());
    }
}
