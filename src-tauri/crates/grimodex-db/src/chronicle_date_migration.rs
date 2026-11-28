//! CED/1 date placement for migration and forward edits. The caller owns the transaction.
use std::collections::{BTreeMap, BTreeSet, HashMap};

use anyhow::Result;
use grimodex_core::chronicle_order::{
    provisional_event_dates, ChronicleProvisionalDate, ChronicleProvisionalEventRow,
    ChronicleProvisionalSceneDate,
};
use grimodex_core::chronicle_time::{require_event_date, ChronicleDateRange, ChronicleTimestamp};
use rusqlite::{params, Connection, Row};

#[derive(Debug, PartialEq, Eq)]
pub enum ChronicleDateAction {
    RepairedStartGranularity,
    ClearedEnd,
    AssignedProvisionalDate,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ChronicleDateChange {
    pub project_id: String,
    pub event_id: String,
    pub actions: Vec<ChronicleDateAction>,
    /// SQL column names whose stored values changed.
    pub changed_columns: Vec<&'static str>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct ChronicleDateMigrationReport {
    pub changed: Vec<ChronicleDateChange>,
    /// IDs of events with unexpected values, listed again on every call.
    pub skipped_event_ids: Vec<String>,
}

struct Event {
    id: String,
    ordinal: String,
    created: String,
    start: Option<i64>,
    end: Option<i64>,
    start_minute: Option<i64>,
    end_minute: Option<i64>,
    start_granularity: String,
    end_granularity: String,
    changes_precision: bool,
    valid: bool,
}

/// The largest day the renderer holds exactly. A day beyond it is an unexpected value (I4).
const MAX_SAFE_DAY: u64 = (1 << 53) - 1;

fn safe_day(day: i64) -> bool {
    day.unsigned_abs() <= MAX_SAFE_DAY
}

fn read_event(row: &Row<'_>) -> rusqlite::Result<Event> {
    // Keep the distinction between a stored NULL and a non-integer storage class.
    let integer = |col: usize| row.get::<_, Option<i64>>(col).ok();
    let day = |col: usize| integer(col).filter(|v| v.is_none_or(safe_day));
    let start = day(3);
    let end = day(4);
    let start_minute = integer(5);
    let end_minute = integer(6);
    let start_granularity: String = row.get(7).unwrap_or_default();
    let end_granularity: String = row.get(8).unwrap_or_default();
    let known = |g: &str| g == "none" || require_event_date(Some(0), g).is_ok();
    let minute_ok = |v| matches!(v, Some(None | Some(0..=1439)));
    let ordinal = row.get::<_, String>(1).ok();
    let created = row.get::<_, String>(2).ok();
    Ok(Event {
        valid: start.is_some()
            && end.is_some()
            && minute_ok(start_minute)
            && minute_ok(end_minute)
            && known(&start_granularity)
            && known(&end_granularity)
            && ordinal.is_some()
            && created.is_some(),
        id: row.get(0)?,
        ordinal: ordinal.unwrap_or_default(),
        created: created.unwrap_or_default(),
        start: start.flatten(),
        end: end.flatten(),
        start_minute: start_minute.flatten(),
        end_minute: end_minute.flatten(),
        start_granularity,
        end_granularity,
        changes_precision: row.get(9)?,
    })
}

impl Event {
    fn repaired_start(&self) -> Option<ChronicleTimestamp<'static>> {
        let day = self.start?;
        (self.start_granularity == "none").then_some(ChronicleTimestamp {
            day: Some(day),
            minute: self.start_minute,
            granularity: if self.start_minute.is_some() {
                "time"
            } else {
                "day"
            },
        })
    }
}

/// Fill all projects in ID order inside the caller's transaction or savepoint.
pub fn fill_missing_chronicle_dates(conn: &Connection) -> Result<ChronicleDateMigrationReport> {
    let mut stmt = conn.prepare("SELECT id FROM projects ORDER BY id")?;
    let projects = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut report = ChronicleDateMigrationReport::default();
    for project in projects {
        fill_project(conn, &project?, &mut report)?;
    }
    Ok(report)
}

fn fill_project(
    conn: &Connection,
    project: &str,
    report: &mut ChronicleDateMigrationReport,
) -> Result<()> {
    use ChronicleDateAction::*;

    let events = project_events(conn, project)?;
    let mut targets = HashMap::new();
    for e in &events {
        if !e.valid {
            report.skipped_event_ids.push(e.id.clone());
        } else if e.start.is_none() {
            targets.insert(e.id.as_str(), e);
        } else if let Some(start) = e.repaired_start() {
            conn.execute(
                "UPDATE events SET start_granularity = ? WHERE id = ?",
                params![start.granularity, e.id],
            )?;
            report.changed.push(ChronicleDateChange {
                project_id: project.into(),
                event_id: e.id.clone(),
                actions: vec![RepairedStartGranularity],
                changed_columns: vec!["start_granularity"],
            });
        }
    }
    if targets.is_empty() {
        return Ok(());
    }

    let inputs: Vec<_> = events
        .iter()
        .filter(|e| e.valid || e.start.is_some())
        .map(provisional_row)
        .collect();
    let dates = project_dates(conn, project, &inputs)?;
    for date in dates {
        let e = targets[date.id.as_str()];
        let day = date.start_time as i64;
        // A day past the bound would itself be an unexpected value on the next call.
        if !safe_day(day) {
            report.skipped_event_ids.push(date.id);
            continue;
        }
        let mut actions = Vec::new();
        let mut columns = Vec::new();
        for (changed, column) in [
            (e.end.is_some(), "end_time"),
            (e.end_minute.is_some(), "end_minute"),
            (e.end_granularity != "none", "end_granularity"),
        ] {
            if changed {
                columns.push(column);
            }
        }
        if !columns.is_empty() {
            actions.push(ClearedEnd);
        }
        actions.push(AssignedProvisionalDate);
        columns.push("start_time");
        for (changed, column) in [
            (e.start_minute.is_some(), "start_minute"),
            (e.start_granularity != "day", "start_granularity"),
            (e.changes_precision, "precision"),
        ] {
            if changed {
                columns.push(column);
            }
        }
        // I3 (orphan end) and I2 (placement) are one write for an event without a start day.
        conn.execute(
            "UPDATE events SET start_time = ?, start_minute = NULL, start_granularity = 'day',
                    precision = 'unknown', end_time = NULL, end_minute = NULL, end_granularity = 'none'
              WHERE id = ?", params![day, e.id],
        )?;
        report.changed.push(ChronicleDateChange {
            project_id: project.into(),
            event_id: date.id,
            actions,
            changed_columns: columns,
        });
    }
    Ok(())
}

fn project_events(conn: &Connection, project: &str) -> Result<Vec<Event>> {
    let mut stmt = conn.prepare(
        "SELECT id, ordinal, created_at, start_time, end_time, start_minute, end_minute,
                start_granularity, end_granularity, precision IS NOT 'unknown'
           FROM events WHERE project_id = ? ORDER BY id",
    )?;
    let events = stmt
        .query_map([project], read_event)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(events)
}

fn provisional_row(e: &Event) -> ChronicleProvisionalEventRow {
    ChronicleProvisionalEventRow {
        id: e.id.clone(),
        ordinal: e.ordinal.clone(),
        created_at: e.created.clone(),
        start_time: e.start.map(|day| day as f64),
        end_time: e.end.map(|day| day as f64),
        start_granularity: e.start_granularity.clone(),
        end_granularity: e.end_granularity.clone(),
    }
}

fn project_dates(
    conn: &Connection,
    project: &str,
    inputs: &[ChronicleProvisionalEventRow],
) -> Result<Vec<ChronicleProvisionalDate>> {
    let scenes = crate::chronicle_read::map_live_scenes(conn, project, |row| {
        Ok(ChronicleProvisionalSceneDate {
            start_time: row
                .get::<_, i64>(1)
                .ok()
                .filter(|day| safe_day(*day))
                .map(|day| day as f64),
            start_granularity: row.get::<_, String>(5).unwrap_or_default(),
        })
    })?;
    Ok(provisional_event_dates(inputs, &scenes))
}

#[derive(Clone, Copy)]
pub enum DateRepair {
    StartGranularity(ChronicleTimestamp<'static>),
    Provisional(i64),
}

impl DateRepair {
    pub fn range(self, end: ChronicleTimestamp<'_>) -> ChronicleDateRange<'_> {
        match self {
            Self::StartGranularity(start) => ChronicleDateRange { start, end },
            Self::Provisional(day) => ChronicleDateRange {
                start: ChronicleTimestamp {
                    day: Some(day),
                    minute: None,
                    granularity: "day",
                },
                end: ChronicleTimestamp {
                    day: None,
                    minute: None,
                    granularity: "none",
                },
            },
        }
    }

    pub fn precision(self) -> Option<&'static str> {
        match self {
            Self::StartGranularity(_) => None,
            Self::Provisional(_) => Some("unknown"),
        }
    }

    pub(crate) fn field_paths(self) -> &'static [&'static str] {
        match self {
            Self::StartGranularity(_) => &["/startGranularity"],
            Self::Provisional(_) => crate::narrative_extraction::TEMPORAL_FIELD_PATHS,
        }
    }

    pub fn record_authority(
        self,
        conn: &Connection,
        project: &str,
        event: &str,
        now: &str,
    ) -> Result<()> {
        record_system_date(conn, project, event, now, self.field_paths())
    }
}

pub(crate) fn update_date_repairs(
    conn: &Connection,
    project: &str,
    ids: &BTreeSet<&str>,
) -> Result<BTreeMap<String, DateRepair>> {
    let mut repairs = BTreeMap::new();
    if ids.is_empty() {
        return Ok(repairs);
    }
    let mut inputs = Vec::new();
    for event in project_events(conn, project)? {
        let mut row = provisional_row(&event);
        if ids.contains(event.id.as_str()) {
            anyhow::ensure!(event.valid, "invalid date repair target '{}'", event.id);
            if let Some(start) = event.repaired_start() {
                repairs.insert(event.id, DateRepair::StartGranularity(start));
            } else {
                anyhow::ensure!(
                    event.start.is_none(),
                    "invalid provisional date target '{}'",
                    event.id
                );
                // Equal creation keys leave ordinal and ID as the N4a comparison keys.
                row.created_at.clear();
            }
        } else if event.start.is_none() {
            continue;
        }
        inputs.push(row);
    }
    if repairs.len() < ids.len() {
        for date in project_dates(conn, project, &inputs)? {
            let day = date.start_time as i64;
            anyhow::ensure!(
                safe_day(day),
                "provisional event date exceeds the safe integer range"
            );
            repairs.insert(date.id, DateRepair::Provisional(day));
        }
    }
    anyhow::ensure!(repairs.len() == ids.len(), "missing date repair target");
    Ok(repairs)
}

/// Resolve a single forward writer's unchanged date fields against the stored precision.
pub fn date_repair_if_needed(
    conn: &Connection,
    project: &str,
    id: &str,
    touches_date: bool,
    start: ChronicleTimestamp<'_>,
    precision: Option<&str>,
    stored_precision: &str,
) -> Result<Option<DateRepair>> {
    if touches_date || require_event_date(start.day, start.granularity).is_ok() {
        return Ok(None);
    }
    if precision.is_some_and(|value| value != stored_precision) {
        require_event_date(start.day, start.granularity)?;
    }
    let mut repairs = update_date_repairs(conn, project, &BTreeSet::from([id]))?;
    Ok(repairs.remove(id))
}

pub(super) fn record_date_changes(
    conn: &Connection,
    report: &ChronicleDateMigrationReport,
) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for change in &report.changed {
        conn.execute(
            "INSERT INTO chronicle_date_migration_events(project_id, event_id, recorded_at)
             VALUES (?1, ?2, ?3) ON CONFLICT(project_id, event_id) DO NOTHING",
            params![change.project_id, change.event_id, now],
        )?;
        if change
            .actions
            .contains(&ChronicleDateAction::AssignedProvisionalDate)
        {
            record_system_date(
                conn,
                &change.project_id,
                &change.event_id,
                &now,
                crate::narrative_extraction::TEMPORAL_FIELD_PATHS,
            )?;
        }
    }
    Ok(())
}

/// Record the generated fields without touching an explicitly locked record.
pub(crate) fn record_system_date(
    conn: &Connection,
    project: &str,
    event: &str,
    now: &str,
    paths: &[&str],
) -> Result<()> {
    for path in paths {
        conn.execute(
            "INSERT INTO narrative_field_authority
                (project_id, entity_kind, entity_id, field_path, owner_kind, updated_at)
             VALUES (?1, 'event', ?2, ?3, 'system', ?4)
             ON CONFLICT(project_id, entity_kind, entity_id, field_path) DO UPDATE SET
                 owner_kind = excluded.owner_kind, updated_at = excluded.updated_at,
                 version = narrative_field_authority.version + 1
             WHERE narrative_field_authority.explicit_lock = 0",
            params![project, event, path, now],
        )?;
    }
    Ok(())
}

pub(super) fn prune_stale_heads(conn: &Connection) -> Result<()> {
    use crate::narrative_extraction::change_feed::{
        narrative_snapshot_digest, previous_event_after_state,
    };

    let mut stmt = conn.prepare(
        "SELECT m.project_id, m.event_id, e.id IS NOT NULL FROM chronicle_date_migration_events m
           LEFT JOIN events e ON e.project_id = m.project_id AND e.id = m.event_id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, bool>(2)?,
        ))
    })?;
    for row in rows {
        let (project, event, exists) = row?;
        let identity = crate::canonical_feed_snapshots::object_key_identity(
            &serde_json::json!({"kind": "chronicle-event", "eventId": event}),
        )?;
        let Some(head) = previous_event_after_state(conn, &project, &identity)? else {
            continue;
        };
        let current = if exists {
            let snapshot = crate::agent_writes::collect_event_snapshot(conn, &event)?;
            (
                snapshot["eventData"]["version"].as_i64(),
                Some(narrative_snapshot_digest(&snapshot)?),
            )
        } else {
            (None, None)
        };
        if head != current {
            conn.execute(
                "DELETE FROM narrative_change_object_heads WHERE project_id = ?1 AND object_identity = ?2",
                params![project, identity],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
