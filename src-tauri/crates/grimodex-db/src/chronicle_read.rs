//! Project-scoped inputs shared by chronicle approval and the MCP read tools.
use anyhow::{Context, Result};
use grimodex_core::chronicle_calendar::ChronicleCalendar;
use grimodex_core::chronicle_order::SceneChronicleDate;
use grimodex_core::chronicle_time::require_event_date;
use rusqlite::{params, Connection};

#[derive(Debug)]
pub struct ChronicleScene {
    pub id: String,
    pub title: Option<String>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub start_minute: Option<i64>,
    pub end_minute: Option<i64>,
    pub start_granularity: String,
    pub end_granularity: String,
    pub precision: String,
}

impl AsRef<str> for ChronicleScene {
    fn as_ref(&self) -> &str {
        &self.id
    }
}

impl ChronicleScene {
    pub fn date(&self) -> Option<SceneChronicleDate> {
        require_event_date(self.start_time, &self.start_granularity).ok()?;
        Some(SceneChronicleDate {
            start_time: self.start_time.map(|v| v as f64),
            start_minute: self.start_minute.map(|v| v as f64),
            start_granularity: self.start_granularity.clone(),
            precision: self.precision.clone().into(),
        })
    }
}

pub fn live_scenes(conn: &Connection, project_id: &str) -> Result<Vec<ChronicleScene>> {
    // Rank siblings first so DFS keeps a folder's entire subtree together.
    let mut stmt = conn.prepare(
        "WITH RECURSIVE siblings AS (
            SELECT id, parent_id, node_type,
                   printf('%016x', row_number() OVER (
                       PARTITION BY parent_id ORDER BY sort_order, id
                   )) AS position
              FROM tree_nodes WHERE project_id = ?1 AND archived_at IS NULL
         ), live(id, node_type, path) AS (
            SELECT id, node_type, position FROM siblings WHERE parent_id IS NULL
            UNION ALL
            SELECT child.id, child.node_type, live.path || child.position
              FROM live JOIN siblings child ON child.parent_id = live.id
             WHERE live.node_type = 'folder'
         )
         SELECT n.id, n.chronicle_start_time, n.chronicle_end_time,
                n.chronicle_start_minute, n.chronicle_end_minute,
                n.chronicle_start_granularity, n.chronicle_end_granularity,
                n.chronicle_precision, n.title
           FROM live JOIN tree_nodes n ON n.id = live.id
          WHERE live.node_type = 'scene' ORDER BY live.path",
    )?;
    let scenes = stmt.query_map([project_id], |row| Ok(ChronicleScene {
        id: row.get(0)?,
        start_time: row.get(1)?,
        end_time: row.get(2)?,
        start_minute: row.get(3)?,
        end_minute: row.get(4)?,
        start_granularity: row.get(5)?,
        end_granularity: row.get(6)?,
        precision: row.get(7)?,
        title: row.get(8)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    Ok(scenes)
}

#[derive(Debug, Clone)]
pub struct ChronicleCalendarRaw {
    pub days_per_year: i64,
    /// Raw JSON string (`SeasonBoundary[]`).
    pub season_boundaries: String,
    /// Calendar start-year label (day 0 = first month/day of start_year).
    pub start_year: i64,
    /// Raw JSON string (`MonthDef[]`). '[]' = no month concept.
    pub months: String,
    /// Raw JSON string (`string[]` weekday names). '[]' = no weekday concept.
    pub weekday_names: String,
    /// Weekday index corresponding to day number 0.
    pub weekday_start_index: i64,
    /// Raw JSON string (`LeapRule`). '{"kind":"none"}' = no leap years.
    pub leap_rule: String,
    /// Age reckoning. 'full' = 満年齢 (default) / 'counting' = 数え年.
    pub age_reckoning: String,
    /// Raw JSON string（改暦の決まり）。'null' = 改暦なし。
    pub reform: String,
}

/// 1-project-1-calendar (optional). None = no calendar configured.
pub fn chronicle_get_calendar(
    conn: &Connection,
    project_id: &str,
) -> Result<Option<ChronicleCalendarRaw>> {
    use rusqlite::OptionalExtension;
    conn.query_row(
        "SELECT days_per_year, season_boundaries, start_year, months, weekday_names, \
                weekday_start_index, leap_rule, age_reckoning, reform
         FROM project_calendar
         WHERE project_id = ?1",
        params![project_id],
        |row| {
            Ok(ChronicleCalendarRaw {
                days_per_year: row.get(0)?,
                season_boundaries: row.get(1)?,
                start_year: row.get(2)?,
                months: row.get(3)?,
                weekday_names: row.get(4)?,
                weekday_start_index: row.get(5)?,
                leap_rule: row.get(6)?,
                age_reckoning: row.get(7)?,
                reform: row.get(8)?,
            })
        },
    )
    .optional()
    .context("chronicle_get_calendar failed")
}

impl ChronicleCalendarRaw {
    pub fn order_calendar(&self) -> ChronicleCalendar {
        ChronicleCalendar {
            days_per_year: self.days_per_year,
            start_year: Some(self.start_year),
            months: serde_json::from_str(&self.months).unwrap_or_default(),
            season_boundaries: serde_json::from_str(&self.season_boundaries).unwrap_or_default(),
            leap: serde_json::from_str(&self.leap_rule).unwrap_or_default(),
            reform: serde_json::from_str(&self.reform).unwrap_or_default(),
            weekday_names: None,
            weekday_start_index: None,
        }
    }
}
