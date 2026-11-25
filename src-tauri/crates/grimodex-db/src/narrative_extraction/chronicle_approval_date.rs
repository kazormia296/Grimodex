//! Resolve missing extraction dates against the current apply transaction.
use std::collections::{BTreeMap, HashSet};

use grimodex_core::chronicle_calendar::ChronicleCalendar;
use grimodex_core::chronicle_order::{
    provisional_base_day, reading_order_from_list, resolve_chronicle_anchor_by_date,
    ChronicleAnchorContext, ChronicleAnchorEventRow, ChronicleEventSpanRow, ChronicleOrderRow,
    ChronicleProvisionalEventRow, ChronicleProvisionalSceneDate, SceneChronicleDate, SceneEventLink,
};
use grimodex_core::chronicle_time::require_event_date;
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EventDate {
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub start_minute: Option<i64>,
    pub end_minute: Option<i64>,
    pub start_granularity: Option<String>,
    pub end_granularity: Option<String>,
}

impl EventDate {
    fn day(day: f64) -> Self {
        Self {
            start_time: Some(day.floor() as i64),
            start_granularity: Some("day".into()),
            ..Self::default()
        }
    }
}

pub(super) fn resolve_approval_date(
    conn: &Connection,
    project_id: &str,
    evidence: &[String],
) -> anyhow::Result<EventDate> {
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
                n.chronicle_precision
           FROM live JOIN tree_nodes n ON n.id = live.id
          WHERE live.node_type = 'scene' ORDER BY live.path",
    )?;
    let evidence: HashSet<_> = evidence.iter().map(String::as_str).collect();
    let mut first_evidence = None;
    let mut scene_ids = Vec::new();
    let mut scene_dates = BTreeMap::new();
    let mut rows = stmt.query([project_id])?;
    while let Some(row) = rows.next()? {
        let id: String = row.get(0)?;
        let start: Option<i64> = row.get(1)?;
        let granularity: String = row.get(5)?;
        let dated = require_event_date(start, &granularity).is_ok();
        if evidence.contains(id.as_str()) {
            if dated {
                let end: Option<i64> = row.get(2)?;
                let end_granularity: String = row.get(6)?;
                let has_end = require_event_date(end, &end_granularity).is_ok();
                return Ok(EventDate {
                    start_time: start,
                    start_minute: row
                        .get::<_, Option<i64>>(3)?
                        .filter(|_| granularity == "time"),
                    start_granularity: Some(granularity),
                    end_time: end.filter(|_| has_end),
                    end_minute: row
                        .get::<_, Option<i64>>(4)?
                        .filter(|_| has_end && end_granularity == "time"),
                    end_granularity: has_end.then_some(end_granularity),
                });
            }
            first_evidence.get_or_insert_with(|| id.clone());
        }
        if dated {
            let start_time = start.map(|day| day as f64);
            scene_dates.insert(
                id.clone(),
                SceneChronicleDate {
                    start_time,
                    start_minute: row.get(3)?,
                    start_granularity: granularity,
                    precision: row.get::<_, String>(7)?.into(),
                },
            );
        }
        scene_ids.push(id);
    }
    if let Some(id) = first_evidence {
        if let Some(day) = evidence_anchor_day(conn, project_id, &id, &scene_ids, &scene_dates)? {
            return Ok(EventDate::day(day));
        }
    }

    let mut stmt = conn.prepare(
        "SELECT id, ordinal, created_at, start_time, end_time, start_granularity, end_granularity
           FROM events WHERE project_id = ?1 AND start_time IS NOT NULL",
    )?;
    let events = stmt
        .query_map([project_id], |row| {
            Ok(ChronicleProvisionalEventRow {
                id: row.get(0)?,
                ordinal: row.get(1)?,
                created_at: row.get(2)?,
                start_time: row.get(3)?,
                end_time: row.get(4)?,
                start_granularity: row.get(5)?,
                end_granularity: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let provisional_scenes: Vec<_> = scene_dates
        .into_values()
        .map(|scene| ChronicleProvisionalSceneDate {
            start_time: scene.start_time,
            start_granularity: scene.start_granularity,
        })
        .collect();
    Ok(EventDate::day(provisional_base_day(
        &events,
        &provisional_scenes,
    )))
}

fn evidence_anchor_day(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
    scene_ids: &[String],
    scene_dates: &BTreeMap<String, SceneChronicleDate>,
) -> anyhow::Result<Option<f64>> {
    let reading_order = reading_order_from_list(scene_ids);
    let mut stmt = conn.prepare(
        "SELECT se.scene_id, se.event_id FROM scene_events se
           JOIN events e ON e.id = se.event_id WHERE e.project_id = ?1",
    )?;
    let mut scene_events = Vec::new();
    let mut links = stmt.query([project_id])?;
    while let Some(row) = links.next()? {
        let scene_id: String = row.get(0)?;
        if reading_order.contains_key(&scene_id) {
            scene_events.push(SceneEventLink {
                scene_id,
                event_id: row.get(1)?,
            });
        }
    }
    if scene_events.is_empty() && scene_dates.is_empty() {
        return Ok(None);
    }

    let mut stmt = conn.prepare(
        "SELECT id, ordinal, precision, start_time, end_time, start_minute, end_minute,
                start_granularity, end_granularity FROM events WHERE project_id = ?1",
    )?;
    let events = stmt
        .query_map([project_id], |row| {
            Ok(ChronicleAnchorEventRow {
                order: ChronicleOrderRow {
                    id: row.get(0)?,
                    ordinal: row.get(1)?,
                    span: ChronicleEventSpanRow {
                        start_time: row.get(3)?,
                        end_time: row.get(4)?,
                        start_minute: row.get(5)?,
                        end_minute: row.get(6)?,
                        start_granularity: row.get(7)?,
                        end_granularity: row.get(8)?,
                    },
                },
                precision: row.get::<_, String>(2)?.into(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let calendar = approval_calendar(conn, project_id)?;
    let context = ChronicleAnchorContext {
        scene_events: &scene_events,
        events: &events,
        reading_order: &reading_order,
        scene_chronicle: Some(scene_dates),
        calendar: calendar.as_ref(),
        has_dated_live_scene: None,
    };
    Ok(resolve_chronicle_anchor_by_date(scene_id, &context)
        .anchor
        .start_time)
}

fn approval_calendar(
    conn: &Connection,
    project_id: &str,
) -> anyhow::Result<Option<ChronicleCalendar>> {
    Ok(conn
        .query_row(
            "SELECT days_per_year, start_year, months, season_boundaries, leap_rule, reform
           FROM project_calendar WHERE project_id = ?1",
            [project_id],
            |row| {
                Ok(ChronicleCalendar {
                    days_per_year: row.get(0)?,
                    start_year: row.get(1)?,
                    months: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or_default(),
                    season_boundaries: serde_json::from_str(&row.get::<_, String>(3)?)
                        .unwrap_or_default(),
                    leap: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
                    reform: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
                    weekday_names: None,
                    weekday_start_index: None,
                })
            },
        )
        .optional()?)
}
