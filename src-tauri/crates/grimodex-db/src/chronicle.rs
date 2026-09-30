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
use serde_json::json;

use super::Database;
use crate::agent_writes::collect_event_snapshot;
use crate::change_events::AppendChangeEvent;
use crate::idempotency::{
    insert_idempotent_response, load_idempotent_response, payload_fingerprint, IdempotencyRequest,
};
use crate::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_snapshot_digest,
    AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind, NarrativeChangeEventInput,
    NarrativeChangeOrigin,
};

const PARTICIPANTS_IDEMPOTENCY_DOMAIN: &str = "event_set_participants";
const CALENDAR_IDEMPOTENCY_DOMAIN: &str = "project_calendar_upsert";

fn event_timestamp(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetParticipantsPayload {
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub event_id: String,
    pub codex_entry_ids: Vec<String>,
    pub base_version: i64,
    pub updated_at: String,
}

fn require_non_empty(value: &str, field: &str) -> anyhow::Result<()> {
    if value.trim().is_empty() {
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
    require_non_empty(&payload.request_id, "requestId")?;
    require_non_empty(&payload.session_id, "sessionId")?;
    require_non_empty(&payload.event_uid, "eventUid")?;
    require_non_empty(&payload.event_id, "eventId")?;
    require_non_empty(&payload.updated_at, "updatedAt")?;
    for codex_entry_id in &payload.codex_entry_ids {
        require_non_empty(codex_entry_id, "codexEntryIds[]")?;
    }
    let result_version = payload
        .base_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("chronicle event version overflow"))?;
    let mut fingerprint_payload = payload.clone();
    fingerprint_payload.session_id.clear();
    fingerprint_payload.event_uid.clear();
    let request_hash = payload_fingerprint(PARTICIPANTS_IDEMPOTENCY_DOMAIN, &fingerprint_payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: PARTICIPANTS_IDEMPOTENCY_DOMAIN,
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "EVENT_SET_PARTICIPANTS_IDEMPOTENCY_CONFLICT",
    };
    let timestamp = event_timestamp(&payload.updated_at);

    db.with_conn(|conn| {
        let transaction = conn.unchecked_transaction()?;
        if let Some(response) = load_idempotent_response(&transaction, &idempotency_request)? {
            transaction.commit()?;
            return Ok(serde_json::from_value(response)?);
        }
        let before = collect_event_snapshot(&transaction, &payload.event_id)?;
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
        crate::narrative_extraction::record_human_field_write(
            &transaction,
            &payload.project_id,
            "event",
            &payload.event_id,
            &["/participants"],
            &payload.updated_at,
        )?;
        let after = collect_event_snapshot(&transaction, &payload.event_id)?;
        append_canonical_and_narrative_change_in_tx(
            &transaction,
            &payload.project_id,
            &payload.session_id,
            &AppendChangeEvent {
                event_uid: payload.event_uid.clone(),
                scene_id: None,
                domain: "chronicle".to_string(),
                op_type: "chronicle.participants.set".to_string(),
                entity_type: Some("event".to_string()),
                entity_id: Some(payload.event_id.clone()),
                payload: json!({ "eventId": payload.event_id }).to_string(),
                timestamp,
            },
            &AppendNarrativeChangeTransactionInput {
                project_id: payload.project_id.clone(),
                request_id: payload.request_id.clone(),
                source_domain: "chronicle.participants.set".to_string(),
                source_change_event_uid: payload.event_uid.clone(),
                cause_kind: NarrativeChangeCauseKind::Forward,
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                commit_id: None,
                journal_id: None,
                undo_journal_id: None,
                application_ids: Vec::new(),
                occurred_at: payload.updated_at.clone(),
                events: vec![NarrativeChangeEventInput {
                    object_key: json!({
                        "kind": "chronicle-event",
                        "eventId": payload.event_id,
                    }),
                    change_kind: "association".to_string(),
                    mutation_kind: "update".to_string(),
                    before_version: before["eventData"]["version"].as_i64(),
                    before_digest: Some(narrative_snapshot_digest(&before)?),
                    after_version: Some(result_version),
                    after_digest: Some(narrative_snapshot_digest(&after)?),
                    changed_paths: vec!["/participants".to_string()],
                    text_impact: None,
                    structural_impact: Some(json!({
                        "changedPaths": ["/participants"],
                    })),
                }],
            },
        )?;
        let response = Some(result_version);
        insert_idempotent_response(
            &transaction,
            &idempotency_request,
            &payload.project_id,
            &serde_json::to_value(response)?,
        )?;
        transaction.commit()?;
        Ok(response)
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProjectCalendarPayload {
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
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

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
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
    require_non_empty(&payload.request_id, "requestId")?;
    require_non_empty(&payload.session_id, "sessionId")?;
    require_non_empty(&payload.event_uid, "eventUid")?;
    require_non_empty(&payload.season_boundaries, "seasonBoundaries")?;
    require_non_empty(&payload.updated_at, "updatedAt")?;
    if payload.base_version.is_some_and(|version| version < 0) {
        anyhow::bail!("chronicle calendar baseVersion must be non-negative");
    }
    let mut fingerprint_payload = payload.clone();
    fingerprint_payload.session_id.clear();
    fingerprint_payload.event_uid.clear();
    let request_hash = payload_fingerprint(CALENDAR_IDEMPOTENCY_DOMAIN, &fingerprint_payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: CALENDAR_IDEMPOTENCY_DOMAIN,
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "PROJECT_CALENDAR_UPSERT_IDEMPOTENCY_CONFLICT",
    };
    let timestamp = event_timestamp(&payload.updated_at);

    db.with_conn(|conn| {
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Option<ProjectCalendarRow>> {
            if load_idempotent_response(conn, &idempotency_request)?.is_some() {
                return calendar_row(conn, &payload.project_id);
            }
            let before = calendar_row(conn, &payload.project_id)?;
            let existing_version = before.as_ref().map(|row| row.version);

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

            crate::narrative_extraction::record_human_field_write(
                conn,
                &payload.project_id,
                "project",
                &payload.project_id,
                &["/calendar"],
                &payload.updated_at,
            )?;
            let after = calendar_row(conn, &payload.project_id)?
                .ok_or_else(|| anyhow::anyhow!("project calendar disappeared during upsert"))?;
            let before_value = before.as_ref().map(serde_json::to_value).transpose()?;
            let after_value = serde_json::to_value(&after)?;
            append_canonical_and_narrative_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &AppendChangeEvent {
                    event_uid: payload.event_uid.clone(),
                    scene_id: None,
                    domain: "chronicle".to_string(),
                    op_type: "chronicle.calendar.upsert".to_string(),
                    entity_type: Some("project_calendar".to_string()),
                    entity_id: Some(payload.project_id.clone()),
                    payload: json!({ "projectId": payload.project_id }).to_string(),
                    timestamp,
                },
                &AppendNarrativeChangeTransactionInput {
                    project_id: payload.project_id.clone(),
                    request_id: payload.request_id.clone(),
                    source_domain: "chronicle.calendar.upsert".to_string(),
                    source_change_event_uid: payload.event_uid.clone(),
                    cause_kind: NarrativeChangeCauseKind::Forward,
                    origin: NarrativeChangeOrigin::Human,
                    original_transaction_id: None,
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: None,
                    application_ids: Vec::new(),
                    occurred_at: payload.updated_at.clone(),
                    events: vec![NarrativeChangeEventInput {
                        object_key: json!({
                            "kind": "calendar",
                            "calendarRef": payload.project_id,
                        }),
                        change_kind: "calendar".to_string(),
                        mutation_kind: if before.is_some() {
                            "update".to_string()
                        } else {
                            "create".to_string()
                        },
                        before_version: before.as_ref().map(|row| row.version),
                        before_digest: before_value
                            .as_ref()
                            .map(narrative_snapshot_digest)
                            .transpose()?,
                        after_version: Some(after.version),
                        after_digest: Some(narrative_snapshot_digest(&after_value)?),
                        changed_paths: vec!["/".to_string()],
                        text_impact: None,
                        structural_impact: Some(json!({ "changedPaths": ["/"] })),
                    }],
                },
            )?;
            let response = Some(after);
            insert_idempotent_response(
                conn,
                &idempotency_request,
                &payload.project_id,
                &json!({ "completed": true }),
            )?;
            Ok(response)
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

    fn fixture() -> Database {
        let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
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
        let request_id = uuid::Uuid::new_v4().to_string();
        SetParticipantsPayload {
            project_id: "p1".to_string(),
            event_uid: request_id.clone(),
            request_id,
            session_id: "chronicle-test-session".to_string(),
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
        db.with_conn(|conn| {
            let tracked: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(tracked, 0);
            Ok(())
        })
        .expect("foreign participant must not emit feed");
    }

    fn calendar_payload(base_version: Option<i64>) -> UpsertProjectCalendarPayload {
        let request_id = uuid::Uuid::new_v4().to_string();
        UpsertProjectCalendarPayload {
            project_id: "p1".to_string(),
            event_uid: request_id.clone(),
            request_id,
            session_id: "chronicle-test-session".to_string(),
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

    #[test]
    fn participants_and_calendar_append_project_scoped_feed_roots() {
        let db = fixture();
        let mut participants = payload(0, &["c2", "c1"]);
        participants.request_id = "participants-request".to_string();
        participants.event_uid = "participants-event".to_string();
        participants.session_id = "chronicle-session".to_string();
        set_event_participants(&db, participants)
            .expect("set participants")
            .expect("participant version");

        let mut calendar = calendar_payload(None);
        calendar.request_id = "calendar-request".to_string();
        calendar.event_uid = "calendar-event".to_string();
        calendar.session_id = "chronicle-session".to_string();
        upsert_project_calendar(&db, calendar)
            .expect("upsert calendar")
            .expect("calendar row");

        db.with_conn(|conn| {
            let rows = conn
                .prepare(
                    "SELECT feed_tx.request_id, feed_tx.source_domain,
                            event.object_key_json, event.change_kind,
                            event.mutation_kind, event.changed_paths_json
                       FROM narrative_change_transactions feed_tx
                       JOIN narrative_change_events event
                         ON event.transaction_id = feed_tx.id
                      ORDER BY feed_tx.source_change_event_sequence, event.event_ordinal",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(2)?)
                            .expect("valid object key"),
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        serde_json::from_str::<serde_json::Value>(&row.get::<_, String>(5)?)
                            .expect("valid changed paths"),
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0].0, "participants-request");
            assert_eq!(rows[0].1, "chronicle.participants.set");
            assert_eq!(
                rows[0].2,
                serde_json::json!({ "kind": "chronicle-event", "eventId": "e1" })
            );
            assert_eq!(
                (&rows[0].3, &rows[0].4),
                (&"association".to_string(), &"update".to_string())
            );
            assert_eq!(rows[0].5, serde_json::json!(["/participants"]));
            assert_eq!(rows[1].0, "calendar-request");
            assert_eq!(rows[1].1, "chronicle.calendar.upsert");
            assert_eq!(
                rows[1].2,
                serde_json::json!({ "kind": "calendar", "calendarRef": "p1" })
            );
            assert_eq!(
                (&rows[1].3, &rows[1].4),
                (&"calendar".to_string(), &"create".to_string())
            );
            Ok(())
        })
        .expect("inspect Chronicle feed");
    }

    #[test]
    fn chronicle_writers_require_caller_owned_identity() {
        let db = fixture();
        for missing in ["request", "session", "event"] {
            let mut participants = payload(0, &["c2"]);
            let mut calendar = calendar_payload(None);
            match missing {
                "request" => {
                    participants.request_id.clear();
                    calendar.request_id.clear();
                }
                "session" => {
                    participants.session_id.clear();
                    calendar.session_id.clear();
                }
                "event" => {
                    participants.event_uid.clear();
                    calendar.event_uid.clear();
                }
                _ => unreachable!(),
            }
            assert!(set_event_participants(&db, participants).is_err());
            assert!(upsert_project_calendar(&db, calendar).is_err());
        }
        assert_eq!(
            get_event_version(&db, "p1".to_string(), "e1".to_string()).expect("version"),
            Some(0)
        );
        db.with_conn(|conn| {
            assert_eq!(calendar_row(conn, "p1")?, None);
            Ok(())
        })
        .expect("calendar remains absent");
    }

    #[test]
    fn participant_cross_session_retry_is_idempotent_and_changed_payload_conflicts() {
        let db = fixture();
        let input = payload(0, &["c2"]);
        assert_eq!(
            set_event_participants(&db, input.clone()).expect("first set"),
            Some(1)
        );
        let mut replay = input.clone();
        replay.session_id = "chronicle-session-after-restart".to_string();
        replay.event_uid = "participant-event-after-restart".to_string();
        assert_eq!(
            set_event_participants(&db, replay).expect("cross-session retry"),
            Some(1)
        );

        let mut conflict = input;
        conflict.codex_entry_ids = vec!["c1".to_string()];
        let error = set_event_participants(&db, conflict)
            .expect_err("changed payload must conflict for the same request");
        assert!(error
            .to_string()
            .contains("EVENT_SET_PARTICIPANTS_IDEMPOTENCY_CONFLICT"));

        db.with_conn(|conn| {
            let state: (i64, String, i64, i64, i64) = conn.query_row(
                "SELECT (SELECT version FROM events WHERE id = 'e1'),
                        (SELECT codex_entry_id FROM event_participants WHERE event_id = 'e1'),
                        (SELECT COUNT(*) FROM change_events),
                        (SELECT COUNT(*) FROM narrative_change_transactions),
                        (SELECT COUNT(*) FROM idempotency_requests
                          WHERE domain = 'event_set_participants')",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
            assert_eq!(state, (1, "c2".to_string(), 1, 1, 1));
            Ok(())
        })
        .expect("inspect participant retry");
    }

    #[test]
    fn calendar_cross_session_retry_is_idempotent_and_changed_payload_conflicts() {
        let db = fixture();
        let input = calendar_payload(None);
        let first = upsert_project_calendar(&db, input.clone())
            .expect("first upsert")
            .expect("calendar");
        let mut replay = input.clone();
        replay.session_id = "chronicle-session-after-restart".to_string();
        replay.event_uid = "calendar-event-after-restart".to_string();
        let retry = upsert_project_calendar(&db, replay)
            .expect("cross-session retry")
            .expect("calendar");
        assert_eq!(retry, first);

        let mut conflict = input;
        conflict.days_per_year = 365;
        let error = upsert_project_calendar(&db, conflict)
            .expect_err("changed payload must conflict for the same request");
        assert!(error
            .to_string()
            .contains("PROJECT_CALENDAR_UPSERT_IDEMPOTENCY_CONFLICT"));

        db.with_conn(|conn| {
            let state: (i64, i64, i64, i64) = conn.query_row(
                "SELECT days_per_year,
                        (SELECT COUNT(*) FROM change_events),
                        (SELECT COUNT(*) FROM narrative_change_transactions),
                        (SELECT COUNT(*) FROM idempotency_requests
                          WHERE domain = 'project_calendar_upsert')
                   FROM project_calendar WHERE project_id = 'p1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(state, (360, 1, 1, 1));
            Ok(())
        })
        .expect("inspect calendar retry");
    }

    #[test]
    fn participant_feed_failure_rolls_back_domain_and_idempotency() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_participant_feed
                 BEFORE INSERT ON narrative_change_events
                 BEGIN
                   SELECT RAISE(ABORT, 'forced participant feed failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("install trigger");

        let error = set_event_participants(&db, payload(0, &["c2"]))
            .expect_err("feed failure must roll back participant replacement");
        assert!(error
            .to_string()
            .contains("forced participant feed failure"));
        db.with_conn(|conn| {
            let state: (i64, String, i64, i64, i64) = conn.query_row(
                "SELECT (SELECT version FROM events WHERE id = 'e1'),
                        (SELECT codex_entry_id FROM event_participants WHERE event_id = 'e1'),
                        (SELECT COUNT(*) FROM change_events),
                        (SELECT COUNT(*) FROM narrative_change_transactions),
                        (SELECT COUNT(*) FROM idempotency_requests
                          WHERE domain = 'event_set_participants')",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
            assert_eq!(state, (0, "c1".to_string(), 0, 0, 0));
            Ok(())
        })
        .expect("inspect participant rollback");
    }

    #[test]
    fn calendar_feed_failure_rolls_back_domain_and_idempotency() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_calendar_feed
                 BEFORE INSERT ON narrative_change_events
                 BEGIN
                   SELECT RAISE(ABORT, 'forced calendar feed failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("install trigger");

        let error = upsert_project_calendar(&db, calendar_payload(None))
            .expect_err("feed failure must roll back calendar upsert");
        assert!(error.to_string().contains("forced calendar feed failure"));
        db.with_conn(|conn| {
            let state: (i64, i64, i64, i64) = conn.query_row(
                "SELECT (SELECT COUNT(*) FROM project_calendar WHERE project_id = 'p1'),
                        (SELECT COUNT(*) FROM change_events),
                        (SELECT COUNT(*) FROM narrative_change_transactions),
                        (SELECT COUNT(*) FROM idempotency_requests
                          WHERE domain = 'project_calendar_upsert')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(state, (0, 0, 0, 0));
            Ok(())
        })
        .expect("inspect calendar rollback");
    }
}
