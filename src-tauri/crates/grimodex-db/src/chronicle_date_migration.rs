//! CED/1 data repair. The caller owns the transaction and any migration markers.
use std::collections::HashMap;

use anyhow::Result;
use grimodex_core::chronicle_order::{
    provisional_event_dates, ChronicleProvisionalEventRow, ChronicleProvisionalSceneDate,
};
use grimodex_core::chronicle_time::require_event_date;
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

    let mut stmt = conn.prepare(
        "SELECT id, ordinal, created_at, start_time, end_time, start_minute, end_minute,
                start_granularity, end_granularity, precision IS NOT 'unknown'
           FROM events WHERE project_id = ? ORDER BY id",
    )?;
    let events = stmt
        .query_map([project], read_event)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut targets = HashMap::new();
    for e in &events {
        if !e.valid {
            report.skipped_event_ids.push(e.id.clone());
        } else if e.start.is_none() {
            targets.insert(e.id.as_str(), e);
        } else if e.start_granularity == "none" {
            let granularity = if e.start_minute.is_some() {
                "time"
            } else {
                "day"
            };
            conn.execute(
                "UPDATE events SET start_granularity = ? WHERE id = ?",
                params![granularity, e.id],
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
    // Rows left unchanged still count towards the latest day when their day is readable.
    let inputs: Vec<_> = events
        .iter()
        .filter(|e| e.valid || e.start.is_some())
        .map(|e| ChronicleProvisionalEventRow {
            id: e.id.clone(),
            ordinal: e.ordinal.clone(),
            created_at: e.created.clone(),
            start_time: e.start.map(|day| day as f64),
            end_time: e.end.map(|day| day as f64),
            start_granularity: e.start_granularity.clone(),
            end_granularity: e.end_granularity.clone(),
        })
        .collect();
    let dates = provisional_event_dates(&inputs, &scenes);
    for date in dates {
        let e = targets[date.id.as_str()];
        let day = date.start_time as i64;
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

#[cfg(test)]
mod tests;
