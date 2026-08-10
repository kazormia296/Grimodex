//! Typed Chronicle aggregate persistence used by the desktop renderer.
//!
//! Event participant replacement is one optimistic-concurrency transaction:
//! the event version, participant set, and updated timestamp either advance
//! together or remain untouched. Project ownership is checked for both the
//! event and every Codex participant.
//!
//! Project Calendar create/update is a second single-row aggregate with the
//! same OCC shape: `base_version == None` means "create" (fails if a row
//! already exists), `base_version == Some(_)` means "update" (fails if the
//! row is missing or the stored version has moved on). Both branches run
//! inside one `BEGIN IMMEDIATE` transaction so the existence check and the
//! write can never race with a concurrent writer.

use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProjectCalendarPayload {
    pub project_id: String,
    pub days_per_year: i64,
    pub season_boundaries: String,
    pub start_year: i64,
    pub months: String,
    pub weekday_names: String,
    pub weekday_start_index: i64,
    pub leap_rule: String,
    pub age_reckoning: String,
    pub eras: String,
    pub reform: String,
    pub timezone: String,
    pub lunar_tz_minutes: i64,
    /// `None` = create (fails if a row already exists); `Some(v)` = update
    /// (fails if the row is missing or its version has moved past `v`).
    pub base_version: Option<i64>,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCalendarRow {
    pub project_id: String,
    pub days_per_year: i64,
    pub season_boundaries: String,
    pub start_year: i64,
    pub months: String,
    pub weekday_names: String,
    pub weekday_start_index: i64,
    pub leap_rule: String,
    pub age_reckoning: String,
    pub eras: String,
    pub reform: String,
    pub timezone: String,
    pub lunar_tz_minutes: i64,
    pub version: i64,
    pub created_at: String,
    pub updated_at: String,
}

fn calendar_row(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> anyhow::Result<Option<ProjectCalendarRow>> {
    Ok(conn
        .query_row(
            "SELECT project_id, days_per_year, season_boundaries, start_year,
                    months, weekday_names, weekday_start_index, leap_rule,
                    age_reckoning, eras, reform, timezone, lunar_tz_minutes,
                    version, created_at, updated_at
               FROM project_calendar
              WHERE project_id = ?1",
            params![project_id],
            |row| {
                Ok(ProjectCalendarRow {
                    project_id: row.get(0)?,
                    days_per_year: row.get(1)?,
                    season_boundaries: row.get(2)?,
                    start_year: row.get(3)?,
                    months: row.get(4)?,
                    weekday_names: row.get(5)?,
                    weekday_start_index: row.get(6)?,
                    leap_rule: row.get(7)?,
                    age_reckoning: row.get(8)?,
                    eras: row.get(9)?,
                    reform: row.get(10)?,
                    timezone: row.get(11)?,
                    lunar_tz_minutes: row.get(12)?,
                    version: row.get(13)?,
                    created_at: row.get(14)?,
                    updated_at: row.get(15)?,
                })
            },
        )
        .optional()?)
}

/// Create-or-update the single Project Calendar row for `project_id` under
/// one `BEGIN IMMEDIATE` transaction. Returns `Ok(None)` for every OCC
/// conflict (create-when-exists, update-when-missing, stale `base_version`)
/// so the caller can map it to a typed version-conflict error without
/// inspecting error text.
pub fn upsert_project_calendar(
    db: &Database,
    payload: UpsertProjectCalendarPayload,
) -> anyhow::Result<Option<ProjectCalendarRow>> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.season_boundaries, "seasonBoundaries")?;
    require_non_empty(&payload.updated_at, "updatedAt")?;
    if payload.base_version.is_some_and(|version| version < 0) {
        anyhow::bail!("chronicle calendar baseVersion must be non-negative");
    }

    db.with_conn(|conn| {
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Option<ProjectCalendarRow>> {
            let existing_version: Option<i64> = conn
                .query_row(
                    "SELECT version FROM project_calendar WHERE project_id = ?1",
                    params![payload.project_id],
                    |row| row.get(0),
                )
                .optional()?;

            match (payload.base_version, existing_version) {
                (None, Some(_)) => return Ok(None),
                (Some(_), None) => return Ok(None),
                (Some(base_version), Some(current_version)) => {
                    if current_version != base_version {
                        return Ok(None);
                    }
                    let updated = conn.execute(
                        "UPDATE project_calendar SET
                            days_per_year = ?1,
                            season_boundaries = ?2,
                            start_year = ?3,
                            months = ?4,
                            weekday_names = ?5,
                            weekday_start_index = ?6,
                            leap_rule = ?7,
                            age_reckoning = ?8,
                            eras = ?9,
                            reform = ?10,
                            timezone = ?11,
                            lunar_tz_minutes = ?12,
                            version = ?13,
                            updated_at = ?14
                          WHERE project_id = ?15 AND version = ?16",
                        params![
                            payload.days_per_year,
                            payload.season_boundaries,
                            payload.start_year,
                            payload.months,
                            payload.weekday_names,
                            payload.weekday_start_index,
                            payload.leap_rule,
                            payload.age_reckoning,
                            payload.eras,
                            payload.reform,
                            payload.timezone,
                            payload.lunar_tz_minutes,
                            base_version + 1,
                            payload.updated_at,
                            payload.project_id,
                            base_version,
                        ],
                    )?;
                    if updated == 0 {
                        return Ok(None);
                    }
                }
                (None, None) => {
                    conn.execute(
                        "INSERT INTO project_calendar (
                            project_id, days_per_year, season_boundaries, start_year,
                            months, weekday_names, weekday_start_index, leap_rule,
                            age_reckoning, eras, reform, timezone, lunar_tz_minutes,
                            version, created_at, updated_at
                        ) VALUES (
                            ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                            0, ?14, ?14
                        )",
                        params![
                            payload.project_id,
                            payload.days_per_year,
                            payload.season_boundaries,
                            payload.start_year,
                            payload.months,
                            payload.weekday_names,
                            payload.weekday_start_index,
                            payload.leap_rule,
                            payload.age_reckoning,
                            payload.eras,
                            payload.reform,
                            payload.timezone,
                            payload.lunar_tz_minutes,
                            payload.updated_at,
                        ],
                    )?;
                }
            }

            calendar_row(conn, &payload.project_id)
        })();

        match result {
            Ok(value) => {
                if let Err(error) = conn.execute_batch("COMMIT") {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
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

    fn calendar_payload(base_version: Option<i64>) -> UpsertProjectCalendarPayload {
        UpsertProjectCalendarPayload {
            project_id: "p1".to_string(),
            days_per_year: 360,
            season_boundaries: "[]".to_string(),
            start_year: 0,
            months: "[]".to_string(),
            weekday_names: "[]".to_string(),
            weekday_start_index: 0,
            leap_rule: "{\"kind\":\"none\"}".to_string(),
            age_reckoning: "full".to_string(),
            eras: "[]".to_string(),
            reform: "null".to_string(),
            timezone: "null".to_string(),
            lunar_tz_minutes: 480,
            base_version,
            updated_at: "2026-08-10T00:00:00.000Z".to_string(),
        }
    }

    #[test]
    fn calendar_create_inserts_version_zero() {
        let db = fixture();
        let created = upsert_project_calendar(&db, calendar_payload(None))
            .expect("create")
            .expect("row");
        assert_eq!(created.version, 0);
        assert_eq!(created.days_per_year, 360);
        assert_eq!(created.project_id, "p1");
    }

    #[test]
    fn calendar_create_conflicts_when_row_already_exists() {
        let db = fixture();
        upsert_project_calendar(&db, calendar_payload(None))
            .expect("first create")
            .expect("row");
        let conflict = upsert_project_calendar(&db, calendar_payload(None)).expect("second create");
        assert_eq!(conflict, None);
    }

    #[test]
    fn calendar_update_conflicts_when_row_is_missing() {
        let db = fixture();
        let conflict =
            upsert_project_calendar(&db, calendar_payload(Some(0))).expect("update missing row");
        assert_eq!(conflict, None);
    }

    #[test]
    fn calendar_update_advances_version_and_rejects_stale_base() {
        let db = fixture();
        upsert_project_calendar(&db, calendar_payload(None))
            .expect("create")
            .expect("row");

        let mut updated_payload = calendar_payload(Some(0));
        updated_payload.days_per_year = 400;
        let updated = upsert_project_calendar(&db, updated_payload)
            .expect("update")
            .expect("row");
        assert_eq!(updated.version, 1);
        assert_eq!(updated.days_per_year, 400);

        let mut stale_payload = calendar_payload(Some(0));
        stale_payload.days_per_year = 999;
        let conflict = upsert_project_calendar(&db, stale_payload).expect("stale update");
        assert_eq!(conflict, None);

        db.with_conn(|conn| {
            let (days_per_year, version): (i64, i64) = conn.query_row(
                "SELECT days_per_year, version FROM project_calendar WHERE project_id = 'p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(days_per_year, 400);
            assert_eq!(version, 1);
            Ok(())
        })
        .expect("read calendar after stale update");
    }

    #[test]
    fn calendar_upsert_is_project_scoped() {
        let db = fixture();
        upsert_project_calendar(&db, calendar_payload(None))
            .expect("create p1")
            .expect("row");

        let mut other_project = calendar_payload(None);
        other_project.project_id = "p2".to_string();
        let created_other = upsert_project_calendar(&db, other_project)
            .expect("create p2")
            .expect("row");
        assert_eq!(created_other.project_id, "p2");
        assert_eq!(created_other.version, 0);
    }
}
