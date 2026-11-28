//! Resolve missing extraction dates against the current apply transaction.
use std::collections::{BTreeMap, HashSet};

use crate::chronicle_read::{chronicle_get_calendar, live_scenes, ChronicleScene};
use grimodex_core::chronicle_order::{
    provisional_base_day, reading_order_from_list, resolve_chronicle_anchor_by_date,
    ChronicleAnchorContext, ChronicleAnchorEventRow, ChronicleEventSpanRow, ChronicleOrderRow,
    ChronicleProvisionalEventRow, ChronicleProvisionalSceneDate, SceneChronicleDate, SceneEventLink,
};
use grimodex_core::chronicle_time::require_event_date;
use rusqlite::Connection;
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
    let evidence: HashSet<_> = evidence.iter().map(String::as_str).collect();
    let mut first_evidence = None;
    let scenes = live_scenes(conn, project_id)?;
    let mut scene_dates = BTreeMap::new();
    for scene in &scenes {
        let date = scene.date();
        if evidence.contains(scene.id.as_str()) {
            if date.is_some() {
                let has_end = require_event_date(scene.end_time, &scene.end_granularity).is_ok();
                return Ok(EventDate {
                    start_time: scene.start_time,
                    start_minute: scene.start_minute.filter(|_| scene.start_granularity == "time"),
                    start_granularity: Some(scene.start_granularity.clone()),
                    end_time: scene.end_time.filter(|_| has_end),
                    end_minute: scene.end_minute.filter(|_| has_end && scene.end_granularity == "time"),
                    end_granularity: has_end.then(|| scene.end_granularity.clone()),
                });
            }
            first_evidence.get_or_insert_with(|| scene.id.clone());
        }
        if let Some(date) = date {
            scene_dates.insert(scene.id.clone(), date);
        }
    }
    if let Some(id) = first_evidence {
        if let Some(day) = evidence_anchor_day(conn, project_id, &id, &scenes, &scene_dates)? {
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
    scenes: &[ChronicleScene],
    scene_dates: &BTreeMap<String, SceneChronicleDate>,
) -> anyhow::Result<Option<f64>> {
    let reading_order = reading_order_from_list(scenes);
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
    let calendar = chronicle_get_calendar(conn, project_id)?.map(|raw| raw.order_calendar());
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
