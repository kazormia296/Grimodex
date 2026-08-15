//! Chronicle (作中年表) tools — parity with the in-app agent chronicle tools.
//!
//! Reads (`list_events`, `get_event_detail`, `get_character_timeline`,
//! `get_chronicle_state`) return the same JSON shapes as
//! `chronicleReadTools.ts`. `get_chronicle_state` runs the Rust port of the TS
//! snapshot derive (`crate::chronicle_snapshot`), gated against drift by a
//! shared fixture.
//!
//! Writes (8 tools) are tracked the same way the in-app `agent_event_*`
//! commands are: one BEGIN IMMEDIATE tx writes the entity rows + undo_journal +
//! change_events(domain "event"), surface "mcp". Each write is gated
//! readonly → license → knowledgeWrite policy, like the foreshadow writes.

use std::collections::HashMap;

use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::ErrorData;
use schemars;
use serde::{Deserialize, Serialize};

use crate::chronicle_snapshot as snap;
use crate::db;
use crate::server::{internal_err, GrimodexServer};

fn ok_json<T: Serialize>(value: &T) -> Result<CallToolResult, ErrorData> {
    let json = serde_json::to_string_pretty(value).map_err(internal_err)?;
    Ok(CallToolResult::success(vec![ContentBlock::text(json)]))
}

fn ok_null() -> Result<CallToolResult, ErrorData> {
    Ok(CallToolResult::success(vec![ContentBlock::text(
        "null".to_string(),
    )]))
}

/// Shared write gate: readonly (call-time) → license → knowledgeWrite policy.
fn ensure_write_allowed(server: &GrimodexServer) -> Result<(), ErrorData> {
    if server.readonly {
        return Err(ErrorData::invalid_params(
            "Server is running in readonly mode; write tools are disabled",
            None,
        ));
    }
    server.ensure_license_allows_write()?;
    let policy = server.reload_policy()?;
    if !policy.knowledge_write {
        return Err(ErrorData::invalid_params(
            "knowledgeWrite policy is off for this project",
            None,
        ));
    }
    Ok(())
}

/// MCP has no current-scene disclosure context, so secret events must remain
/// indistinguishable from missing/cross-project events for every write-by-id.
fn ensure_event_visible_for_write(
    server: &GrimodexServer,
    event_id: &str,
) -> Result<(), ErrorData> {
    let conn = server.conn.lock().map_err(internal_err)?;
    let visible: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM events
                 WHERE id = ?1 AND project_id = ?2 AND secret = 0
             )",
            rusqlite::params![event_id, server.project_id()],
            |row| row.get(0),
        )
        .map_err(internal_err)?;
    if !visible {
        return Err(ErrorData::invalid_params("event not found", None));
    }
    Ok(())
}

fn valid_kind(kind: &str) -> bool {
    matches!(kind, "generic" | "birth" | "death")
}

// ───────── read: list_events ─────────

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListEventsParams {
    /// Optional kind filter: "birth" | "death" | "generic". Omit for all.
    pub kind: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventListItem {
    id: String,
    title: String,
    kind: String,
    ordinal: String,
    /// Aggregate OCC token used as `baseVersion` by Event write tools.
    version: i64,
    start_time: Option<i64>,
    /// 暦整形済みの絶対日付（暦なし/粒度 none は None）。TS list_events と同 shape。
    start_date: Option<String>,
    primary_character: Option<String>,
}

#[derive(Serialize)]
struct EventListResult {
    events: Vec<EventListItem>,
}

pub async fn list_events(
    server: &GrimodexServer,
    params: ListEventsParams,
) -> Result<CallToolResult, ErrorData> {
    let conn = server.conn.lock().map_err(internal_err)?;
    let project_id = server.project_id();
    let events = db::chronicle_list_events(&conn, &project_id).map_err(internal_err)?;
    let names = db::chronicle_codex_names(&conn, &project_id).map_err(internal_err)?;
    let calendar = db::chronicle_get_calendar(&conn, &project_id).map_err(internal_err)?;
    let cal_input = parse_calendar(calendar);
    let kind = params.kind.as_deref().map(str::trim).unwrap_or("");
    let filtered: Vec<EventListItem> = events
        .into_iter()
        .filter(|e| !valid_kind(kind) || e.kind == kind)
        .map(|e| EventListItem {
            id: e.id,
            title: e.title,
            kind: e.kind,
            ordinal: e.ordinal,
            version: e.version,
            start_time: e.start_time,
            start_date: fmt_event_date(
                cal_input.as_ref(),
                e.start_time,
                e.start_minute,
                &e.start_granularity,
            ),
            // `e.primaryCodexId ? (names.get(id) ?? null) : null`: a present id
            // whose codex is missing resolves to JSON null, not "".
            primary_character: e
                .primary_codex_id
                .as_ref()
                .and_then(|id| names.get(id).cloned()),
        })
        .collect();
    ok_json(&EventListResult { events: filtered })
}

// ───────── read: get_event_detail ─────────

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetEventDetailParams {
    /// The event id.
    pub event_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DetailParticipant {
    codex_id: String,
    name: Option<String>,
    role: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DetailScene {
    scene_id: String,
    title: Option<String>,
}

#[derive(Serialize)]
struct DetailRelation {
    cause: Option<String>,
    effect: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventDetail {
    id: String,
    title: String,
    note: Option<String>,
    kind: String,
    ordinal: String,
    /// Aggregate OCC token used as `baseVersion` by Event write tools.
    version: i64,
    start_time: Option<i64>,
    end_time: Option<i64>,
    start_minute: Option<i64>,
    end_minute: Option<i64>,
    start_granularity: String,
    end_granularity: String,
    /// 暦整形済みの絶対日付（両端。暦なし/粒度 none は None）。TS get_event_detail と同 shape。
    start_date: Option<String>,
    end_date: Option<String>,
    precision: String,
    primary_character: Option<String>,
    location: Option<String>,
    participants: Vec<DetailParticipant>,
    scenes: Vec<DetailScene>,
    relations: Vec<DetailRelation>,
}

/// `codexId ? (names.get(id) ?? null) : null` — both an absent id and a
/// present-but-unknown codex resolve to JSON null.
fn name_or_null(names: &HashMap<String, String>, id: &Option<String>) -> Option<String> {
    id.as_ref().and_then(|id| names.get(id).cloned())
}

pub async fn get_event_detail(
    server: &GrimodexServer,
    params: GetEventDetailParams,
) -> Result<CallToolResult, ErrorData> {
    let event_id = params.event_id.trim().to_string();
    if event_id.is_empty() {
        return ok_null();
    }
    let conn = server.conn.lock().map_err(internal_err)?;
    let project_id = server.project_id();

    let events = db::chronicle_list_events(&conn, &project_id).map_err(internal_err)?;
    let Some(ev) = events.iter().find(|e| e.id == event_id).cloned() else {
        return ok_null();
    };
    let names = db::chronicle_codex_names(&conn, &project_id).map_err(internal_err)?;
    let participants = db::chronicle_list_participants(&conn, &project_id).map_err(internal_err)?;
    let scene_events = db::chronicle_list_scene_events(&conn, &project_id).map_err(internal_err)?;
    let relations = db::chronicle_list_relations(&conn, &project_id).map_err(internal_err)?;
    let scene_titles = db::chronicle_scene_titles(&conn, &project_id).map_err(internal_err)?;
    let calendar = db::chronicle_get_calendar(&conn, &project_id).map_err(internal_err)?;
    let cal_input = parse_calendar(calendar);
    let title_by_event: HashMap<&str, &str> = events
        .iter()
        .map(|e| (e.id.as_str(), e.title.as_str()))
        .collect();

    let detail = EventDetail {
        id: ev.id.clone(),
        title: ev.title.clone(),
        note: ev.note.clone(),
        kind: ev.kind.clone(),
        ordinal: ev.ordinal.clone(),
        version: ev.version,
        start_time: ev.start_time,
        end_time: ev.end_time,
        start_minute: ev.start_minute,
        end_minute: ev.end_minute,
        start_granularity: ev.start_granularity.clone(),
        end_granularity: ev.end_granularity.clone(),
        start_date: fmt_event_date(
            cal_input.as_ref(),
            ev.start_time,
            ev.start_minute,
            &ev.start_granularity,
        ),
        end_date: fmt_event_date(
            cal_input.as_ref(),
            ev.end_time,
            ev.end_minute,
            &ev.end_granularity,
        ),
        precision: ev.precision.clone(),
        primary_character: name_or_null(&names, &ev.primary_codex_id),
        location: name_or_null(&names, &ev.location_codex_id),
        participants: participants
            .iter()
            .filter(|p| p.event_id == event_id)
            .map(|p| DetailParticipant {
                codex_id: p.codex_entry_id.clone(),
                name: names.get(&p.codex_entry_id).cloned(),
                role: p.role.clone(),
            })
            .collect(),
        scenes: scene_events
            .iter()
            .filter(|s| s.event_id == event_id)
            .map(|s| DetailScene {
                scene_id: s.scene_id.clone(),
                title: scene_titles.get(&s.scene_id).cloned(),
            })
            .collect(),
        relations: relations
            .iter()
            .filter(|r| r.cause_id == event_id || r.effect_id == event_id)
            .map(|r| DetailRelation {
                cause: title_by_event
                    .get(r.cause_id.as_str())
                    .map(|s| s.to_string()),
                effect: title_by_event
                    .get(r.effect_id.as_str())
                    .map(|s| s.to_string()),
            })
            .collect(),
    };
    ok_json(&detail)
}

// ───────── read: get_character_timeline ─────────

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetCharacterTimelineParams {
    /// The character's codex entry id.
    pub codex_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TimelineEvent {
    id: String,
    title: String,
    kind: String,
    ordinal: String,
    start_time: Option<i64>,
    age_at_event: Option<i64>,
}

#[derive(Serialize)]
struct CharacterTimeline {
    character: String,
    events: Vec<TimelineEvent>,
}

pub async fn get_character_timeline(
    server: &GrimodexServer,
    params: GetCharacterTimelineParams,
) -> Result<CallToolResult, ErrorData> {
    let codex_id = params.codex_id.trim().to_string();
    if codex_id.is_empty() {
        return ok_json(&CharacterTimeline {
            character: String::new(),
            events: Vec::new(),
        });
    }
    let conn = server.conn.lock().map_err(internal_err)?;
    let project_id = server.project_id();

    let events = db::chronicle_list_events(&conn, &project_id).map_err(internal_err)?;
    let participants = db::chronicle_list_participants(&conn, &project_id).map_err(internal_err)?;
    let calendar = db::chronicle_get_calendar(&conn, &project_id).map_err(internal_err)?;
    let names = db::chronicle_codex_names(&conn, &project_id).map_err(internal_err)?;

    let participant_event_ids: std::collections::HashSet<&str> = participants
        .iter()
        .filter(|p| p.codex_entry_id == codex_id)
        .map(|p| p.event_id.as_str())
        .collect();

    // birthTime = min start_time over the character's birth events.
    let mut birth_time: Option<i64> = None;
    for e in &events {
        if e.primary_codex_id.as_deref() == Some(codex_id.as_str())
            && e.kind == "birth"
            && e.start_time.is_some()
        {
            let st = e.start_time.unwrap_or_default();
            birth_time = Some(birth_time.map_or(st, |b| b.min(st)));
        }
    }
    let days_per_year = calendar.as_ref().map_or(0, |c| c.days_per_year);
    let cal_input = parse_calendar(calendar);

    // events come ordered (ordinal asc, id asc) == the stable cmpKeys(ordinal) order.
    let involved: Vec<TimelineEvent> = events
        .iter()
        .filter(|e| {
            e.primary_codex_id.as_deref() == Some(codex_id.as_str())
                || participant_event_ids.contains(e.id.as_str())
        })
        .map(|e| TimelineEvent {
            id: e.id.clone(),
            title: e.title.clone(),
            kind: e.kind.clone(),
            ordinal: e.ordinal.clone(),
            start_time: e.start_time,
            age_at_event: match (birth_time, e.start_time, cal_input.as_ref()) {
                (Some(b), Some(st), Some(c)) if days_per_year > 0 => {
                    Some(snap::compute_age(b, st, c))
                }
                _ => None,
            },
        })
        .collect();

    ok_json(&CharacterTimeline {
        character: names.get(&codex_id).cloned().unwrap_or(codex_id),
        events: involved,
    })
}

// ───────── read: get_chronicle_state ─────────

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetChronicleStateParams {
    /// The scene to anchor the world-state snapshot to. Required (MCP has no
    /// notion of an "active scene").
    pub scene_id: Option<String>,
}

/// 出来事の day 番号を暦整形した絶対日付文字列（TS の fmtEventDate と同 shape）。
/// 暦なし/粒度 none/日付欠落は None。lang は get_chronicle_state と同じ ja 固定。
fn fmt_event_date(
    cal: Option<&snap::CalendarInput>,
    day: Option<i64>,
    minute: Option<i64>,
    granularity: &str,
) -> Option<String> {
    let cal = cal?;
    let s = snap::format_chronicle_date(day, minute, granularity, cal, "ja");
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn parse_calendar(raw: Option<db::ChronicleCalendarRaw>) -> Option<snap::CalendarInput> {
    let raw = raw?;
    let season_boundaries =
        serde_json::from_str::<Vec<snap::SeasonBoundary>>(&raw.season_boundaries)
            .unwrap_or_default();
    let months = serde_json::from_str::<Vec<snap::MonthDef>>(&raw.months).unwrap_or_default();
    let weekday_names = serde_json::from_str::<Vec<String>>(&raw.weekday_names).unwrap_or_default();
    let leap = serde_json::from_str::<snap::LeapRule>(&raw.leap_rule).unwrap_or_default();
    Some(snap::CalendarInput {
        days_per_year: raw.days_per_year,
        season_boundaries,
        start_year: raw.start_year,
        months,
        weekday_names,
        weekday_start_index: raw.weekday_start_index,
        leap,
        age_reckoning: raw.age_reckoning,
    })
}

pub async fn get_chronicle_state(
    server: &GrimodexServer,
    params: GetChronicleStateParams,
) -> Result<CallToolResult, ErrorData> {
    let scene_id = params
        .scene_id
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_string();
    if scene_id.is_empty() {
        return ok_null();
    }
    let conn = server.conn.lock().map_err(internal_err)?;
    let project_id = server.project_id();

    let events = db::chronicle_list_events(&conn, &project_id).map_err(internal_err)?;
    if events.is_empty() {
        return ok_null();
    }
    let participants = db::chronicle_list_participants(&conn, &project_id).map_err(internal_err)?;
    let scene_events = db::chronicle_list_scene_events(&conn, &project_id).map_err(internal_err)?;
    let relations = db::chronicle_list_relations(&conn, &project_id).map_err(internal_err)?;
    let calendar = db::chronicle_get_calendar(&conn, &project_id).map_err(internal_err)?;
    let codex_names = db::chronicle_codex_names(&conn, &project_id).map_err(internal_err)?;
    let nodes = db::chronicle_scene_nodes(&conn, &project_id).map_err(internal_err)?;

    let input = snap::AssembleInput {
        scene_id,
        nodes,
        events: events
            .into_iter()
            .map(|e| snap::EventInput {
                id: e.id,
                title: e.title,
                note: e.note,
                ordinal: e.ordinal,
                primary_codex_id: e.primary_codex_id,
                location_codex_id: e.location_codex_id,
                start_time: e.start_time,
                start_minute: e.start_minute,
                start_granularity: e.start_granularity,
                kind: e.kind,
                precision: e.precision,
            })
            .collect(),
        participants: participants
            .into_iter()
            .map(|p| snap::ParticipantInput {
                event_id: p.event_id,
                codex_entry_id: p.codex_entry_id,
            })
            .collect(),
        relations: relations
            .into_iter()
            .map(|r| snap::RelationInput {
                cause_id: r.cause_id,
                effect_id: r.effect_id,
            })
            .collect(),
        scene_events: scene_events
            .into_iter()
            .map(|s| snap::SceneEventInput {
                scene_id: s.scene_id,
                event_id: s.event_id,
            })
            .collect(),
        calendar: parse_calendar(calendar),
        codex_names,
        // MCP has no app i18n; default to ja (matches AssembleInput default).
        lang: None,
    };
    let snapshot = snap::assemble_snapshot(&input);
    ok_json(&snapshot)
}

// ───────── writes ─────────

#[allow(dead_code)]
fn map_write(
    outcome: anyhow::Result<Option<db::EventWriteResult>>,
    not_found_msg: &str,
) -> Result<CallToolResult, ErrorData> {
    match outcome.map_err(internal_err)? {
        Some(res) => ok_json(&res),
        None => Err(ErrorData::invalid_params(not_found_msg.to_string(), None)),
    }
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct CreateEventParams {
    /// Stable logical request id. Reuse it only when retrying this create.
    pub request_id: String,
    /// Event title (required).
    pub title: String,
    /// Freeform note (optional).
    pub note: Option<String>,
    /// "generic" | "birth" | "death" (default "generic").
    pub kind: Option<String>,
    /// Home-lane character codex id (optional).
    pub primary_codex_id: Option<String>,
    /// Location codex id (optional).
    pub location_codex_id: Option<String>,
    /// Calendar-light numeric time (days from epoch; optional).
    pub start_time: Option<i64>,
    /// Interval end time (optional).
    pub end_time: Option<i64>,
    /// Time of day for the start, in minutes (0-1439, 24h clock; optional).
    pub start_minute: Option<i64>,
    /// Time of day for the end, in minutes (0-1439, 24h clock; optional).
    pub end_minute: Option<i64>,
    /// How precise the start date is: 'none'|'season'|'year'|'month'|'day'|'time' (default 'none').
    pub start_granularity: Option<String>,
    /// How precise the end date is: 'none'|'season'|'year'|'month'|'day'|'time' (default 'none').
    pub end_granularity: Option<String>,
    /// Hide this event from AI context (spoiler protection; default false).
    /// Like a foreshadow's secret flag — a secret event is excluded from MCP
    /// reads until disclosed in-story. From MCP it is always hidden once set.
    pub secret: Option<bool>,
    /// Reading-order disclosure anchor scene id (optional override). Empty/None
    /// auto-derives from the earliest stamped scene, or stays permanently hidden.
    pub reveal_scene_id: Option<String>,
    /// Participant codex ids to attach (optional).
    pub participant_codex_ids: Option<Vec<String>>,
    /// Scene ids to stamp this event onto (optional).
    pub scene_ids: Option<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateEventResult {
    id: String,
    title: String,
    /// Initial aggregate OCC token. Pass this as `base_version` to the next write.
    version: i64,
}

pub async fn create_event(
    server: &GrimodexServer,
    params: CreateEventParams,
) -> Result<CallToolResult, ErrorData> {
    ensure_write_allowed(server)?;
    let title = crate::sanitize::sanitize_name(&params.title)
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
    let note = params
        .note
        .as_deref()
        .map(crate::sanitize::sanitize_freetext)
        .transpose()
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
    let kind = params.kind.as_deref().filter(|k| valid_kind(k));
    let participants = params.participant_codex_ids.unwrap_or_default();
    let scene_ids = params.scene_ids.unwrap_or_default();

    let request_id = params.request_id.trim();
    if request_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "request_id must not be empty",
            None,
        ));
    }
    let res = grimodex_db::agent_writes::agent_event_create_impl(
        &server.conn,
        grimodex_db::agent_writes::AgentEventCreatePayload {
            request_id: request_id.to_string(),
            event_id: None,
            project_id: server.project_id(),
            session_id: server.session_id.clone(),
            surface: Some("mcp".to_string()),
            title: Some(title.clone()),
            note,
            detail: None,
            ordinal: None,
            primary_codex_id: params.primary_codex_id,
            lane_group: None,
            location_codex_id: params.location_codex_id,
            start_time: params.start_time,
            end_time: params.end_time,
            start_minute: params.start_minute,
            end_minute: params.end_minute,
            start_granularity: params.start_granularity,
            end_granularity: params.end_granularity,
            precision: None,
            kind: kind.map(str::to_string),
            secret: params.secret,
            reveal_scene_id: params.reveal_scene_id,
            participant_codex_ids: Some(participants),
            scene_ids: Some(scene_ids),
        },
    )
    .map_err(internal_err)?;
    ok_json(&CreateEventResult {
        id: res["entityId"]
            .as_str()
            .ok_or_else(|| internal_err("Event writer returned no entityId"))?
            .to_string(),
        title,
        version: res["version"]
            .as_i64()
            .ok_or_else(|| internal_err("Event writer returned no version"))?,
    })
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UpdateEventParams {
    /// Stable logical request id. Reuse it only when retrying this update.
    pub request_id: String,
    /// The event id (required).
    pub event_id: String,
    /// Required aggregate OCC token returned by create/list/detail/the previous write.
    pub base_version: i64,
    pub title: Option<String>,
    pub note: Option<String>,
    pub kind: Option<String>,
    pub primary_codex_id: Option<String>,
    pub location_codex_id: Option<String>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    /// Start time of day in minutes (0-1439, 24h clock).
    pub start_minute: Option<i64>,
    /// End time of day in minutes (0-1439, 24h clock).
    pub end_minute: Option<i64>,
    /// Start date precision: 'none'|'season'|'year'|'month'|'day'|'time'.
    pub start_granularity: Option<String>,
    /// End date precision: 'none'|'season'|'year'|'month'|'day'|'time'.
    pub end_granularity: Option<String>,
    /// Hide/unhide this event from AI context (spoiler protection).
    pub secret: Option<bool>,
    /// Reading-order disclosure anchor scene id. Empty string clears the
    /// override (back to auto-derive from the earliest stamped scene).
    pub reveal_scene_id: Option<String>,
}

pub async fn update_event(
    server: &GrimodexServer,
    params: UpdateEventParams,
) -> Result<CallToolResult, ErrorData> {
    ensure_write_allowed(server)?;
    let event_id = params.event_id.trim().to_string();
    if event_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "event_id must not be empty",
            None,
        ));
    }
    if let Some(k) = params.kind.as_deref() {
        if !valid_kind(k) {
            return Err(ErrorData::invalid_params(
                "invalid kind (expected generic|birth|death)",
                None,
            ));
        }
    }
    let title = params
        .title
        .as_deref()
        .map(crate::sanitize::sanitize_name)
        .transpose()
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;
    let note = params
        .note
        .as_deref()
        .map(crate::sanitize::sanitize_freetext)
        .transpose()
        .map_err(|e| ErrorData::invalid_params(e.to_string(), None))?;

    ensure_event_visible_for_write(server, &event_id)?;
    let request_id = params.request_id.trim();
    if request_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "request_id must not be empty",
            None,
        ));
    }
    let outcome = grimodex_db::agent_writes::agent_event_update_with_request_impl(
        &server.conn,
        grimodex_db::agent_writes::AgentEventUpdatePayload {
            project_id: server.project_id(),
            session_id: server.session_id.clone(),
            surface: Some("mcp".to_string()),
            event_id,
            base_version: params.base_version,
            title,
            note,
            detail: None,
            ordinal: None,
            primary_codex_id: params.primary_codex_id,
            lane_group: None,
            location_codex_id: params.location_codex_id,
            start_time: params.start_time,
            end_time: params.end_time,
            start_minute: params.start_minute,
            end_minute: params.end_minute,
            start_granularity: params.start_granularity,
            end_granularity: params.end_granularity,
            precision: None,
            kind: params.kind,
            secret: params.secret,
            reveal_scene_id: params.reveal_scene_id,
        },
        Some(request_id),
    )
    .map_err(internal_err)?;
    ok_json(&outcome)
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct EventIdParams {
    /// Stable logical request id. Reuse it only when retrying this delete.
    pub request_id: String,
    /// The event id (required).
    pub event_id: String,
    /// Required aggregate OCC token returned by create/list/detail/the previous write.
    pub base_version: i64,
}

pub async fn delete_event(
    server: &GrimodexServer,
    params: EventIdParams,
) -> Result<CallToolResult, ErrorData> {
    ensure_write_allowed(server)?;
    let event_id = params.event_id.trim().to_string();
    if event_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "event_id must not be empty",
            None,
        ));
    }
    ensure_event_visible_for_write(server, &event_id)?;
    let request_id = params.request_id.trim();
    if request_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "request_id must not be empty",
            None,
        ));
    }
    let outcome = grimodex_db::agent_writes::agent_event_delete_with_request_impl(
        &server.conn,
        grimodex_db::agent_writes::AgentEventIdPayload {
            project_id: server.project_id(),
            session_id: server.session_id.clone(),
            surface: Some("mcp".to_string()),
            event_id,
            base_version: params.base_version,
        },
        Some(request_id),
    )
    .map_err(internal_err)?;
    ok_json(&outcome)
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SceneEventParams {
    /// Stable logical request id. Reuse it only when retrying this link write.
    pub request_id: String,
    /// The scene id (required).
    pub scene_id: String,
    /// The event id (required).
    pub event_id: String,
}

pub async fn stamp_scene_event(
    server: &GrimodexServer,
    params: SceneEventParams,
) -> Result<CallToolResult, ErrorData> {
    ensure_write_allowed(server)?;
    let scene_id = params.scene_id.trim().to_string();
    let event_id = params.event_id.trim().to_string();
    if scene_id.is_empty() || event_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "scene_id and event_id are required",
            None,
        ));
    }
    ensure_event_visible_for_write(server, &event_id)?;
    let request_id = params.request_id.trim();
    if request_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "request_id must not be empty",
            None,
        ));
    }
    let outcome = grimodex_db::agent_writes::agent_scene_event_mutate_impl(
        &server.conn,
        grimodex_db::agent_writes::AgentSceneEventPayload {
            request_id: request_id.to_string(),
            project_id: server.project_id(),
            session_id: server.session_id.clone(),
            surface: Some("mcp".to_string()),
            scene_id,
            event_id,
        },
        true,
    )
    .map_err(internal_err)?;
    ok_json(&outcome)
}

pub async fn unstamp_scene_event(
    server: &GrimodexServer,
    params: SceneEventParams,
) -> Result<CallToolResult, ErrorData> {
    ensure_write_allowed(server)?;
    let scene_id = params.scene_id.trim().to_string();
    let event_id = params.event_id.trim().to_string();
    if scene_id.is_empty() || event_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "scene_id and event_id are required",
            None,
        ));
    }
    ensure_event_visible_for_write(server, &event_id)?;
    let request_id = params.request_id.trim();
    if request_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "request_id must not be empty",
            None,
        ));
    }
    let outcome = grimodex_db::agent_writes::agent_scene_event_mutate_impl(
        &server.conn,
        grimodex_db::agent_writes::AgentSceneEventPayload {
            request_id: request_id.to_string(),
            project_id: server.project_id(),
            session_id: server.session_id.clone(),
            surface: Some("mcp".to_string()),
            scene_id,
            event_id,
        },
        false,
    )
    .map_err(internal_err)?;
    ok_json(&outcome)
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetParticipantsParams {
    /// Stable logical request id. Reuse it only when retrying this replacement.
    pub request_id: String,
    /// The event id (required).
    pub event_id: String,
    /// Required aggregate OCC token returned by create/list/detail/the previous write.
    pub base_version: i64,
    /// The full replacement set of participant codex ids.
    pub codex_entry_ids: Vec<String>,
}

pub async fn set_event_participants(
    server: &GrimodexServer,
    params: SetParticipantsParams,
) -> Result<CallToolResult, ErrorData> {
    ensure_write_allowed(server)?;
    let event_id = params.event_id.trim().to_string();
    if event_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "event_id must not be empty",
            None,
        ));
    }
    ensure_event_visible_for_write(server, &event_id)?;
    let request_id = params.request_id.trim();
    if request_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "request_id must not be empty",
            None,
        ));
    }
    let outcome = grimodex_db::agent_writes::agent_event_set_participants_with_request_impl(
        &server.conn,
        grimodex_db::agent_writes::AgentEventParticipantsPayload {
            project_id: server.project_id(),
            session_id: server.session_id.clone(),
            surface: Some("mcp".to_string()),
            event_id,
            base_version: params.base_version,
            codex_entry_ids: params.codex_entry_ids,
            participant_roles: None,
        },
        Some(request_id),
    )
    .map_err(internal_err)?;
    ok_json(&outcome)
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct EventRelationParams {
    /// Stable logical request id. Reuse it only when retrying this relation write.
    pub request_id: String,
    /// Cause event id (required).
    pub cause_event_id: String,
    /// Effect event id (required).
    pub effect_event_id: String,
}

pub async fn add_event_relation(
    server: &GrimodexServer,
    params: EventRelationParams,
) -> Result<CallToolResult, ErrorData> {
    ensure_write_allowed(server)?;
    let cause = params.cause_event_id.trim().to_string();
    let effect = params.effect_event_id.trim().to_string();
    if cause.is_empty() || effect.is_empty() {
        return Err(ErrorData::invalid_params(
            "cause_event_id and effect_event_id are required",
            None,
        ));
    }
    if cause == effect {
        return Err(ErrorData::invalid_params(
            "self-loop event relation forbidden",
            None,
        ));
    }
    ensure_event_visible_for_write(server, &cause)?;
    ensure_event_visible_for_write(server, &effect)?;
    let request_id = params.request_id.trim();
    if request_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "request_id must not be empty",
            None,
        ));
    }
    let outcome = grimodex_db::agent_writes::agent_event_relation_mutate_impl(
        &server.conn,
        grimodex_db::agent_writes::AgentEventRelationPayload {
            request_id: request_id.to_string(),
            project_id: server.project_id(),
            session_id: server.session_id.clone(),
            surface: Some("mcp".to_string()),
            cause_event_id: cause,
            effect_event_id: effect,
        },
        true,
    )
    .map_err(internal_err)?;
    ok_json(&outcome)
}

pub async fn remove_event_relation(
    server: &GrimodexServer,
    params: EventRelationParams,
) -> Result<CallToolResult, ErrorData> {
    ensure_write_allowed(server)?;
    let cause = params.cause_event_id.trim().to_string();
    let effect = params.effect_event_id.trim().to_string();
    if cause.is_empty() || effect.is_empty() {
        return Err(ErrorData::invalid_params(
            "cause_event_id and effect_event_id are required",
            None,
        ));
    }
    if cause == effect {
        return Err(ErrorData::invalid_params(
            "self-loop event relation forbidden",
            None,
        ));
    }
    ensure_event_visible_for_write(server, &cause)?;
    ensure_event_visible_for_write(server, &effect)?;
    let request_id = params.request_id.trim();
    if request_id.is_empty() {
        return Err(ErrorData::invalid_params(
            "request_id must not be empty",
            None,
        ));
    }
    let outcome = grimodex_db::agent_writes::agent_event_relation_mutate_impl(
        &server.conn,
        grimodex_db::agent_writes::AgentEventRelationPayload {
            request_id: request_id.to_string(),
            project_id: server.project_id(),
            session_id: server.session_id.clone(),
            surface: Some("mcp".to_string()),
            cause_event_id: cause,
            effect_event_id: effect,
        },
        false,
    )
    .map_err(internal_err)?;
    ok_json(&outcome)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::db::tests::make_simple_db;
    use rusqlite::params;

    /// Writable (or readonly) server over the shared fixture with projects
    /// p1 (active) and p2 (the XPROJ "other" project). NULL ai_policy →
    /// fail-open full toggles (knowledge_write on); licensing off in tests.
    fn make_server(readonly: bool) -> GrimodexServer {
        let conn = make_simple_db();
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('p1', 'Novel')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO projects (id, title) VALUES ('p2', 'Other')",
            [],
        )
        .unwrap();
        let policy = grimodex_core::policy::load_policy(&conn, "p1").unwrap();
        GrimodexServer::new(
            conn,
            "p1".to_string(),
            false,
            readonly,
            "sess-mcp".to_string(),
            policy,
        )
    }

    fn seed_event(server: &GrimodexServer, project: &str, id: &str, title: &str, ordinal: &str) {
        let conn = server.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO events (id, project_id, title, ordinal, kind, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'generic', datetime('now'), datetime('now'))",
            params![id, project, title, ordinal],
        )
        .unwrap();
        for field_path in [
            "/title",
            "/note",
            "/detail",
            "/ordinal",
            "/primaryCodexId",
            "/laneGroup",
            "/locationCodexId",
            "/startTime",
            "/endTime",
            "/startMinute",
            "/endMinute",
            "/startGranularity",
            "/endGranularity",
            "/precision",
            "/kind",
            "/secret",
            "/revealSceneId",
            "/participants",
            "/sceneIds",
            "/relations",
        ] {
            conn.execute(
                "INSERT INTO narrative_field_authority
                    (project_id, entity_kind, entity_id, field_path, owner_kind, updated_at)
                 VALUES (?1, 'event', ?2, ?3, 'ai', datetime('now'))",
                params![project, id, field_path],
            )
            .unwrap();
        }
    }

    fn seed_scene(server: &GrimodexServer, project: &str, id: &str) {
        let conn = server.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
             VALUES (?1, ?2, 'scene', 'Scene', 'a0')",
            params![id, project],
        )
        .unwrap();
    }

    fn seed_codex(server: &GrimodexServer, project: &str, id: &str) {
        let conn = server.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO codex_entries (id, project_id, name) VALUES (?1, ?2, ?1)",
            params![id, project],
        )
        .unwrap();
    }

    /// Extract the tool's JSON payload (CallToolResult.content[0].text), parsed.
    fn result_json(res: &CallToolResult) -> serde_json::Value {
        let v = serde_json::to_value(res).unwrap();
        let text = v["content"][0]["text"].as_str().expect("text content");
        serde_json::from_str(text).expect("valid json")
    }

    fn scalar(server: &GrimodexServer, sql: &str, p: &str) -> i64 {
        let conn = server.conn.lock().unwrap();
        conn.query_row(sql, params![p], |r| r.get(0)).unwrap()
    }

    fn set_secret(server: &GrimodexServer, id: &str) {
        let conn = server.conn.lock().unwrap();
        conn.execute("UPDATE events SET secret = 1 WHERE id = ?1", params![id])
            .unwrap();
    }

    #[test]
    fn event_mutation_params_require_base_version() {
        assert!(
            serde_json::from_value::<UpdateEventParams>(serde_json::json!({
                "event_id": "e1"
            }))
            .is_err(),
            "update_event must reject a missing base_version"
        );
        assert!(
            serde_json::from_value::<EventIdParams>(serde_json::json!({
                "event_id": "e1"
            }))
            .is_err(),
            "delete_event must reject a missing base_version"
        );
        assert!(
            serde_json::from_value::<SetParticipantsParams>(serde_json::json!({
                "event_id": "e1",
                "codex_entry_ids": []
            }))
            .is_err(),
            "set_event_participants must reject a missing base_version"
        );
    }

    // ── AI secrecy (fail-closed: MCP has no current-scene context) ────────────

    #[tokio::test]
    async fn secret_event_hidden_from_reads_and_writes() {
        let server = make_server(false);
        seed_event(&server, "p1", "pub", "Public", "a0");
        seed_event(&server, "p1", "sec", "Secret poisoning", "a1");
        set_secret(&server, "sec");

        // read: list_events excludes the secret event.
        let listed = list_events(&server, ListEventsParams { kind: None })
            .await
            .unwrap();
        let ids: Vec<String> = result_json(&listed)["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap().to_string())
            .collect();
        assert!(ids.contains(&"pub".to_string()));
        assert!(
            !ids.contains(&"sec".to_string()),
            "secret event must not be listed"
        );

        // read: get_event_detail on the secret event → null (not found).
        let detail = get_event_detail(
            &server,
            GetEventDetailParams {
                event_id: "sec".into(),
            },
        )
        .await
        .unwrap();
        assert!(
            result_json(&detail).is_null(),
            "secret detail must be null (generic not found)"
        );

        // write-by-id: update / delete on the secret event → error (fail-closed).
        let upd = update_event(
            &server,
            UpdateEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: "sec".into(),
                base_version: 0,
                title: Some("leaked".into()),
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                secret: None,
                reveal_scene_id: None,
            },
        )
        .await;
        assert!(upd.is_err(), "update on a secret event must fail-closed");
        let del = delete_event(
            &server,
            EventIdParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: "sec".into(),
                base_version: 0,
            },
        )
        .await;
        assert!(del.is_err(), "delete on a secret event must fail-closed");

        // the secret row is untouched (title not leaked-overwritten, not deleted).
        assert_eq!(
            scalar(
                &server,
                "SELECT COUNT(*) FROM events WHERE id = ?1 AND title = 'Secret poisoning'",
                "sec",
            ),
            1
        );
    }

    #[tokio::test]
    async fn create_event_persists_secret_and_reveal() {
        let server = make_server(false);
        seed_scene(&server, "p1", "s1");
        let res = create_event(
            &server,
            CreateEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                title: "Hidden".into(),
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                secret: Some(true),
                reveal_scene_id: Some("s1".into()),
                participant_codex_ids: None,
                scene_ids: None,
            },
        )
        .await
        .unwrap();
        let result = result_json(&res);
        assert_eq!(
            result["version"], 1,
            "create must return the token for the next write"
        );
        let id = result["id"].as_str().unwrap().to_string();
        let conn = server.conn.lock().unwrap();
        let (secret, reveal): (i64, Option<String>) = conn
            .query_row(
                "SELECT secret, reveal_scene_id FROM events WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(secret, 1, "create must persist secret flag");
        assert_eq!(reveal.as_deref(), Some("s1"), "create must persist reveal");
    }

    // ── XPROJ read regression ────────────────────────────────────────────────

    #[tokio::test]
    async fn list_events_is_project_scoped() {
        let server = make_server(false);
        seed_event(&server, "p1", "mine", "Mine", "a0");
        seed_event(&server, "p2", "theirs", "Theirs", "a1");

        let res = list_events(&server, ListEventsParams { kind: None })
            .await
            .unwrap();
        let json = result_json(&res);
        let events = json["events"].as_array().unwrap();
        assert_eq!(events.len(), 1, "only p1's event is visible");
        assert_eq!(events[0]["id"], "mine");
        assert_eq!(
            events[0]["version"], 0,
            "list must expose the Event OCC token"
        );
    }

    #[tokio::test]
    async fn list_and_detail_include_formatted_dates() {
        let server = make_server(false);
        {
            let conn = server.conn.lock().unwrap();
            let months = (1..=12)
                .map(|i| format!("{{\"name\":\"{i}月\",\"days\":30}}"))
                .collect::<Vec<_>>()
                .join(",");
            conn.execute(
                "INSERT INTO project_calendar (project_id, days_per_year, season_boundaries, \
                 start_year, months, weekday_names, weekday_start_index, leap_rule, age_reckoning) \
                 VALUES ('p1', 360, '[]', 1000, ?1, '[]', 0, '{\"kind\":\"none\"}', 'full')",
                params![format!("[{months}]")],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events (id, project_id, title, ordinal, kind, start_time, \
                 start_granularity, end_time, end_granularity, created_at, updated_at) \
                 VALUES ('e1', 'p1', '祭', 'a0', 'generic', 0, 'day', 90, 'day', \
                 datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }
        // list_events: startDate is calendar-formatted.
        let listed = list_events(&server, ListEventsParams { kind: None })
            .await
            .unwrap();
        let lj = result_json(&listed);
        assert!(
            lj["events"][0]["startDate"]
                .as_str()
                .unwrap()
                .contains("1000年"),
            "list_events startDate should be calendar-formatted"
        );
        // get_event_detail: both startDate and endDate (day 90 = 1000年4月1日).
        let detail = get_event_detail(
            &server,
            GetEventDetailParams {
                event_id: "e1".to_string(),
            },
        )
        .await
        .unwrap();
        let dj = result_json(&detail);
        assert!(dj["startDate"].as_str().unwrap().contains("1000年"));
        assert_eq!(dj["endDate"].as_str().unwrap(), "1000年4月1日");
    }

    #[tokio::test]
    async fn get_event_detail_returns_null_for_foreign_event() {
        let server = make_server(false);
        seed_event(&server, "p2", "theirs", "Theirs", "a0");
        let res = get_event_detail(
            &server,
            GetEventDetailParams {
                event_id: "theirs".to_string(),
            },
        )
        .await
        .unwrap();
        assert!(
            result_json(&res).is_null(),
            "cross-project id reads as null"
        );
    }

    #[tokio::test]
    async fn get_character_timeline_is_project_scoped() {
        let server = make_server(false);
        // p2 event with hero as primary must not leak into p1's timeline.
        {
            let conn = server.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO events (id, project_id, title, ordinal, kind, primary_codex_id,
                                     created_at, updated_at)
                 VALUES ('e2', 'p2', 'Foreign', 'a0', 'generic', 'hero',
                         datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
        }
        let res = get_character_timeline(
            &server,
            GetCharacterTimelineParams {
                codex_id: "hero".to_string(),
            },
        )
        .await
        .unwrap();
        let json = result_json(&res);
        assert_eq!(json["events"].as_array().unwrap().len(), 0);
    }

    // ── tracked write round-trip ─────────────────────────────────────────────

    #[tokio::test]
    async fn create_event_is_tracked_with_mcp_surface() {
        let server = make_server(false);
        let res = create_event(
            &server,
            CreateEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                title: "First clash".to_string(),
                note: Some("a note".to_string()),
                kind: Some("generic".to_string()),
                primary_codex_id: None,
                location_codex_id: None,
                start_time: Some(10),
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: None,
                scene_ids: None,
            },
        )
        .await
        .unwrap();
        let id = result_json(&res)["id"].as_str().unwrap().to_string();

        let conn = server.conn.lock().unwrap();
        let title: String = conn
            .query_row(
                "SELECT title FROM events WHERE id = ?1 AND project_id = 'p1'",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(title, "First clash");
        let (domain, op_type, session): (String, String, String) = conn
            .query_row(
                "SELECT domain, op_type, session_id FROM change_events",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(domain, "event");
        assert_eq!(op_type, "event.create");
        assert_eq!(session, "sess-mcp");
        let (surface, op_kind): (String, String) = conn
            .query_row("SELECT surface, op_kind FROM undo_journal", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(surface, "mcp");
        assert_eq!(op_kind, "create");
    }

    #[tokio::test]
    async fn create_event_round_trips_calendar_fields() {
        let server = make_server(false);
        let res = create_event(
            &server,
            CreateEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                title: "Dawn raid".to_string(),
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: Some(3),
                end_time: Some(4),
                start_minute: Some(540),
                end_minute: Some(600),
                start_granularity: Some("time".to_string()),
                end_granularity: Some("day".to_string()),
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: None,
                scene_ids: None,
            },
        )
        .await
        .unwrap();
        let id = result_json(&res)["id"].as_str().unwrap().to_string();

        // detail round-trip (camelCase keys)
        let detail = get_event_detail(
            &server,
            GetEventDetailParams {
                event_id: id.clone(),
            },
        )
        .await
        .unwrap();
        let json = result_json(&detail);
        assert_eq!(json["version"], 1, "detail must expose the Event OCC token");
        assert_eq!(json["startMinute"], 540);
        assert!(json["endMinute"].is_null());
        assert_eq!(json["startGranularity"], "time");
        assert_eq!(json["endGranularity"], "day");

        // collect_event_snapshot round-trip via undo_journal.after_json
        let conn = server.conn.lock().unwrap();
        let after: String = conn
            .query_row(
                "SELECT after_json FROM undo_journal WHERE op_kind = 'create'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let snap: serde_json::Value = serde_json::from_str(&after).unwrap();
        assert_eq!(snap["eventData"]["startMinute"], 540);
        assert!(snap["eventData"]["endMinute"].is_null());
        assert_eq!(snap["eventData"]["startGranularity"], "time");
        assert_eq!(snap["eventData"]["endGranularity"], "day");
    }

    #[tokio::test]
    async fn create_event_infers_omitted_granularity_from_date_components() {
        let server = make_server(false);
        let res = create_event(
            &server,
            CreateEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                title: "Inferred".to_string(),
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: Some(3),
                end_time: Some(4),
                start_minute: None,
                end_minute: Some(600),
                start_granularity: None,
                end_granularity: None,
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: None,
                scene_ids: None,
            },
        )
        .await
        .expect("inferred create");
        let id = result_json(&res)["id"].as_str().unwrap().to_string();
        let detail = get_event_detail(&server, GetEventDetailParams { event_id: id })
            .await
            .expect("event detail");
        let json = result_json(&detail);
        assert_eq!(json["startGranularity"], "day");
        assert!(json["startMinute"].is_null());
        assert_eq!(json["endGranularity"], "time");
        assert_eq!(json["endMinute"], 600);
    }

    #[tokio::test]
    async fn create_event_defaults_granularity_to_none() {
        let server = make_server(false);
        let res = create_event(
            &server,
            CreateEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                title: "Vague".to_string(),
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: None,
                scene_ids: None,
            },
        )
        .await
        .unwrap();
        let id = result_json(&res)["id"].as_str().unwrap().to_string();
        let detail = get_event_detail(&server, GetEventDetailParams { event_id: id })
            .await
            .unwrap();
        let json = result_json(&detail);
        assert_eq!(json["startGranularity"], "none");
        assert_eq!(json["endGranularity"], "none");
        assert!(json["startMinute"].is_null());
        assert!(json["endMinute"].is_null());
    }

    #[tokio::test]
    async fn update_event_changes_calendar_fields() {
        let server = make_server(false);
        seed_event(&server, "p1", "e1", "E1", "a0");
        {
            let conn = server.conn.lock().unwrap();
            conn.execute(
                "UPDATE events SET detail = 'rich-detail', lane_group = 'lane-a'
                 WHERE id = 'e1'",
                [],
            )
            .unwrap();
        }
        update_event(
            &server,
            UpdateEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: "e1".to_string(),
                base_version: 0,
                title: None,
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: Some(5),
                end_time: None,
                start_minute: Some(720),
                end_minute: None,
                start_granularity: Some("month".to_string()),
                end_granularity: None,
                secret: None,
                reveal_scene_id: None,
            },
        )
        .await
        .unwrap();
        let detail = get_event_detail(
            &server,
            GetEventDetailParams {
                event_id: "e1".to_string(),
            },
        )
        .await
        .unwrap();
        let json = result_json(&detail);
        assert_eq!(json["startTime"], 5);
        assert!(json["startMinute"].is_null());
        assert_eq!(json["startGranularity"], "month");
        // untouched end_* keep the seeded defaults
        assert_eq!(json["endGranularity"], "none");
        assert!(json["endMinute"].is_null());

        let conn = server.conn.lock().unwrap();
        let (before, after): (String, String) = conn
            .query_row(
                "SELECT before_json, after_json FROM undo_journal
                 WHERE entity_id = 'e1' AND op_kind = 'update'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        for snapshot in [before, after] {
            let snapshot: serde_json::Value = serde_json::from_str(&snapshot).unwrap();
            assert_eq!(snapshot["eventData"]["detail"], "rich-detail");
            assert_eq!(snapshot["eventData"]["laneGroup"], "lane-a");
        }
    }

    #[tokio::test]
    async fn update_event_rejects_empty_patch() {
        let server = make_server(false);
        seed_event(&server, "p1", "e1", "E1", "a0");

        let error = update_event(
            &server,
            UpdateEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: "e1".to_string(),
                base_version: 0,
                title: None,
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                secret: None,
                reveal_scene_id: None,
            },
        )
        .await
        .expect_err("empty MCP event updates must be rejected");

        assert_eq!(error.message, "internal error");
        assert_eq!(scalar(&server, "SELECT version FROM events WHERE id = ?1", "e1"), 0);
        assert_eq!(
            scalar(
                &server,
                "SELECT COUNT(*) FROM undo_journal WHERE entity_id = ?1",
                "e1"
            ),
            0
        );
    }

    #[tokio::test]
    async fn update_event_rejects_stale_base_version_non_destructively() {
        let server = make_server(false);
        seed_event(&server, "p1", "e1", "Seed", "a0");
        let params = |title: &str, base_version| UpdateEventParams {
            request_id: uuid::Uuid::new_v4().to_string(),
            event_id: "e1".to_string(),
            base_version,
            title: Some(title.to_string()),
            note: None,
            kind: None,
            primary_codex_id: None,
            location_codex_id: None,
            start_time: None,
            end_time: None,
            start_minute: None,
            end_minute: None,
            start_granularity: None,
            end_granularity: None,
            secret: None,
            reveal_scene_id: None,
        };

        let fresh = update_event(&server, params("Fresh", 0))
            .await
            .expect("fresh update");
        assert_eq!(
            result_json(&fresh)["version"],
            1,
            "update must return the incremented token"
        );
        assert!(update_event(&server, params("Stale", 0)).await.is_err());

        let conn = server.conn.lock().unwrap();
        let (title, version): (String, i64) = conn
            .query_row(
                "SELECT title, version FROM events WHERE id = 'e1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Fresh");
        assert_eq!(version, 1);
        let journal_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM undo_journal WHERE entity_id = 'e1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(journal_count, 1);
    }

    #[tokio::test]
    async fn delete_event_rejects_stale_base_version_non_destructively() {
        let server = make_server(false);
        seed_event(&server, "p1", "e1", "Seed", "a0");
        update_event(
            &server,
            UpdateEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: "e1".to_string(),
                base_version: 0,
                title: Some("Fresh".to_string()),
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                secret: None,
                reveal_scene_id: None,
            },
        )
        .await
        .expect("fresh update");

        assert!(delete_event(
            &server,
            EventIdParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: "e1".to_string(),
                base_version: 0,
            },
        )
        .await
        .is_err());

        let conn = server.conn.lock().unwrap();
        let (title, version): (String, i64) = conn
            .query_row(
                "SELECT title, version FROM events WHERE id = 'e1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(title, "Fresh");
        assert_eq!(version, 1);
        let delete_journals: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM undo_journal WHERE op_kind = 'delete'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(delete_journals, 0);
    }

    #[tokio::test]
    async fn delete_event_cascades_and_snapshots_associations() {
        let server = make_server(false);
        seed_scene(&server, "p1", "s1");
        seed_codex(&server, "p1", "alice");
        seed_event(&server, "p1", "cause", "Cause", "a0");
        // Effect event the relation points at; create the host via tool so it
        // carries participants + scene link, then relate + delete it.
        let res = create_event(
            &server,
            CreateEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                title: "Host".to_string(),
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: Some(vec!["alice".to_string()]),
                scene_ids: Some(vec!["s1".to_string()]),
            },
        )
        .await
        .unwrap();
        let host = result_json(&res)["id"].as_str().unwrap().to_string();
        add_event_relation(
            &server,
            EventRelationParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                cause_event_id: "cause".to_string(),
                effect_event_id: host.clone(),
            },
        )
        .await
        .unwrap();

        delete_event(
            &server,
            EventIdParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: host.clone(),
                base_version: 1,
            },
        )
        .await
        .unwrap();

        // Host gone; its participants/scene link/relations cascaded.
        assert_eq!(
            scalar(&server, "SELECT COUNT(*) FROM events WHERE id = ?1", &host),
            0
        );
        assert_eq!(
            scalar(
                &server,
                "SELECT COUNT(*) FROM event_participants WHERE event_id = ?1",
                &host
            ),
            0
        );
        assert_eq!(
            scalar(
                &server,
                "SELECT COUNT(*) FROM scene_events WHERE event_id = ?1",
                &host
            ),
            0
        );
        assert_eq!(
            scalar(
                &server,
                "SELECT COUNT(*) FROM event_relations WHERE effect_event_id = ?1",
                &host
            ),
            0
        );
        // Delete journal carries a restorable cascade snapshot.
        let conn = server.conn.lock().unwrap();
        let before: String = conn
            .query_row(
                "SELECT before_json FROM undo_journal WHERE op_kind = 'delete'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let snap: serde_json::Value = serde_json::from_str(&before).unwrap();
        assert_eq!(snap["participants"][0]["codexEntryId"], "alice");
        assert_eq!(snap["sceneLinks"][0]["sceneId"], "s1");
        assert!(!snap["sceneLinks"][0]["incarnationToken"]
            .as_str()
            .unwrap_or_default()
            .is_empty());
        assert_eq!(snap["relations"]["asEffect"][0]["causeEventId"], "cause");
    }

    #[tokio::test]
    async fn set_participants_replaces_and_tracks() {
        let server = make_server(false);
        seed_event(&server, "p1", "e1", "E1", "a0");
        for id in ["a", "b", "c"] {
            seed_codex(&server, "p1", id);
        }
        let first = set_event_participants(
            &server,
            SetParticipantsParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: "e1".to_string(),
                base_version: 0,
                codex_entry_ids: vec!["a".to_string(), "b".to_string()],
            },
        )
        .await
        .unwrap();
        assert_eq!(result_json(&first)["version"], 1);
        assert_eq!(
            scalar(
                &server,
                "SELECT COUNT(*) FROM event_participants WHERE event_id = ?1",
                "e1"
            ),
            2
        );
        // Replace with a single participant.
        let second = set_event_participants(
            &server,
            SetParticipantsParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: "e1".to_string(),
                base_version: 1,
                codex_entry_ids: vec!["c".to_string()],
            },
        )
        .await
        .unwrap();
        assert_eq!(result_json(&second)["version"], 2);
        assert_eq!(
            scalar(
                &server,
                "SELECT COUNT(*) FROM event_participants WHERE event_id = ?1",
                "e1"
            ),
            1
        );
    }

    #[tokio::test]
    async fn set_participants_rejects_stale_aggregate_version() {
        let server = make_server(false);
        seed_event(&server, "p1", "e1", "E1", "a0");
        seed_codex(&server, "p1", "fresh");
        seed_codex(&server, "p1", "stale");
        set_event_participants(
            &server,
            SetParticipantsParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: "e1".to_string(),
                base_version: 0,
                codex_entry_ids: vec!["fresh".to_string()],
            },
        )
        .await
        .expect("fresh participants");

        assert!(set_event_participants(
            &server,
            SetParticipantsParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: "e1".to_string(),
                base_version: 0,
                codex_entry_ids: vec!["stale".to_string()],
            },
        )
        .await
        .is_err());

        let conn = server.conn.lock().unwrap();
        let participants: Vec<String> = conn
            .prepare(
                "SELECT codex_entry_id FROM event_participants
                 WHERE event_id = 'e1' ORDER BY codex_entry_id",
            )
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(participants, vec!["fresh"]);
        let version: i64 = conn
            .query_row("SELECT version FROM events WHERE id = 'e1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, 1);
    }

    #[tokio::test]
    async fn set_participants_rejects_foreign_codex_without_mutation() {
        let server = make_server(false);
        seed_event(&server, "p1", "e1", "E1", "a0");
        seed_codex(&server, "p2", "foreign");

        assert!(set_event_participants(
            &server,
            SetParticipantsParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: "e1".to_string(),
                base_version: 0,
                codex_entry_ids: vec!["foreign".to_string()],
            },
        )
        .await
        .is_err());

        let conn = server.conn.lock().unwrap();
        let (version, participants): (i64, i64) = conn
            .query_row(
                "SELECT e.version, COUNT(ep.codex_entry_id)
                 FROM events e
                 LEFT JOIN event_participants ep ON ep.event_id = e.id
                 WHERE e.id = 'e1'
                 GROUP BY e.id",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(version, 0);
        assert_eq!(participants, 0);
        let journals: i64 = conn
            .query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journals, 0);
    }

    #[tokio::test]
    async fn create_event_rejects_foreign_participant_and_scene_atomically() {
        let server = make_server(false);
        seed_codex(&server, "p2", "foreign-codex");
        seed_scene(&server, "p2", "foreign-scene");

        let params = |participants: Vec<String>, scenes: Vec<String>| CreateEventParams {
            request_id: uuid::Uuid::new_v4().to_string(),
            title: "Host".to_string(),
            note: None,
            kind: None,
            primary_codex_id: None,
            location_codex_id: None,
            start_time: None,
            end_time: None,
            start_minute: None,
            end_minute: None,
            start_granularity: None,
            end_granularity: None,
            secret: None,
            reveal_scene_id: None,
            participant_codex_ids: Some(participants),
            scene_ids: Some(scenes),
        };

        assert!(create_event(
            &server,
            params(vec!["foreign-codex".to_string()], Vec::new()),
        )
        .await
        .is_err());
        assert!(create_event(
            &server,
            params(Vec::new(), vec!["foreign-scene".to_string()]),
        )
        .await
        .is_err());

        let conn = server.conn.lock().unwrap();
        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
            .unwrap();
        let journals: i64 = conn
            .query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))
            .unwrap();
        let changes: i64 = conn
            .query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))
            .unwrap();
        assert_eq!((events, journals, changes), (0, 0, 0));
    }

    #[tokio::test]
    async fn create_event_rejects_foreign_scalar_references_atomically() {
        let server = make_server(false);
        seed_codex(&server, "p2", "foreign-codex");
        seed_scene(&server, "p2", "foreign-scene");

        let params = |primary_codex_id: Option<&str>,
                      location_codex_id: Option<&str>,
                      reveal_scene_id: Option<&str>| CreateEventParams {
            request_id: uuid::Uuid::new_v4().to_string(),
            title: "Host".to_string(),
            note: None,
            kind: None,
            primary_codex_id: primary_codex_id.map(str::to_string),
            location_codex_id: location_codex_id.map(str::to_string),
            start_time: None,
            end_time: None,
            start_minute: None,
            end_minute: None,
            start_granularity: None,
            end_granularity: None,
            secret: None,
            reveal_scene_id: reveal_scene_id.map(str::to_string),
            participant_codex_ids: None,
            scene_ids: None,
        };

        assert!(
            create_event(&server, params(Some("foreign-codex"), None, None),)
                .await
                .is_err()
        );
        assert!(
            create_event(&server, params(None, Some("foreign-codex"), None),)
                .await
                .is_err()
        );
        assert!(
            create_event(&server, params(None, None, Some("foreign-scene")),)
                .await
                .is_err()
        );

        let conn = server.conn.lock().unwrap();
        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM events", [], |row| row.get(0))
            .unwrap();
        let journals: i64 = conn
            .query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))
            .unwrap();
        let changes: i64 = conn
            .query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))
            .unwrap();
        assert_eq!((events, journals, changes), (0, 0, 0));
    }

    #[tokio::test]
    async fn update_event_rejects_foreign_scalar_references_atomically() {
        let server = make_server(false);
        seed_event(&server, "p1", "e1", "Original", "a0");
        seed_codex(&server, "p2", "foreign-codex");
        seed_scene(&server, "p2", "foreign-scene");

        let params = |primary_codex_id: Option<&str>,
                      location_codex_id: Option<&str>,
                      reveal_scene_id: Option<&str>| UpdateEventParams {
            request_id: uuid::Uuid::new_v4().to_string(),
            event_id: "e1".to_string(),
            base_version: 0,
            title: None,
            note: None,
            kind: None,
            primary_codex_id: primary_codex_id.map(str::to_string),
            location_codex_id: location_codex_id.map(str::to_string),
            start_time: None,
            end_time: None,
            start_minute: None,
            end_minute: None,
            start_granularity: None,
            end_granularity: None,
            secret: None,
            reveal_scene_id: reveal_scene_id.map(str::to_string),
        };

        assert!(
            update_event(&server, params(Some("foreign-codex"), None, None),)
                .await
                .is_err()
        );
        assert!(
            update_event(&server, params(None, Some("foreign-codex"), None),)
                .await
                .is_err()
        );
        assert!(
            update_event(&server, params(None, None, Some("foreign-scene")),)
                .await
                .is_err()
        );

        let conn = server.conn.lock().unwrap();
        let row: (String, i64, Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT title, version, primary_codex_id, location_codex_id, reveal_scene_id
                 FROM events WHERE id = 'e1'",
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
            )
            .unwrap();
        assert_eq!(row, ("Original".to_string(), 0, None, None, None));
        let journals: i64 = conn
            .query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))
            .unwrap();
        let changes: i64 = conn
            .query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))
            .unwrap();
        assert_eq!((journals, changes), (0, 0));
    }

    #[tokio::test]
    async fn stamp_and_unstamp_scene_event() {
        let server = make_server(false);
        seed_scene(&server, "p1", "s1");
        seed_event(&server, "p1", "e1", "E1", "a0");
        stamp_scene_event(
            &server,
            SceneEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                scene_id: "s1".to_string(),
                event_id: "e1".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            scalar(
                &server,
                "SELECT COUNT(*) FROM scene_events WHERE event_id = ?1",
                "e1"
            ),
            1
        );
        unstamp_scene_event(
            &server,
            SceneEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                scene_id: "s1".to_string(),
                event_id: "e1".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            scalar(
                &server,
                "SELECT COUNT(*) FROM scene_events WHERE event_id = ?1",
                "e1"
            ),
            0
        );
    }

    // ── validation + gating ──────────────────────────────────────────────────

    #[tokio::test]
    async fn add_relation_rejects_self_loop() {
        let server = make_server(false);
        seed_event(&server, "p1", "e1", "E1", "a0");
        let res = add_event_relation(
            &server,
            EventRelationParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                cause_event_id: "e1".to_string(),
                effect_event_id: "e1".to_string(),
            },
        )
        .await;
        assert!(res.is_err(), "self-loop must be rejected");
        assert_eq!(
            scalar(
                &server,
                "SELECT COUNT(*) FROM event_relations WHERE cause_event_id = ?1",
                "e1"
            ),
            0
        );
    }

    #[tokio::test]
    async fn stamp_rejects_foreign_scene() {
        let server = make_server(false);
        seed_scene(&server, "p2", "s2"); // belongs to the other project
        seed_event(&server, "p1", "e1", "E1", "a0");
        let res = stamp_scene_event(
            &server,
            SceneEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                scene_id: "s2".to_string(),
                event_id: "e1".to_string(),
            },
        )
        .await;
        assert!(res.is_err(), "cross-project scene must be rejected");
        assert_eq!(
            scalar(
                &server,
                "SELECT COUNT(*) FROM scene_events WHERE event_id = ?1",
                "e1"
            ),
            0
        );
    }

    #[tokio::test]
    async fn update_foreign_event_errors_and_writes_nothing() {
        let server = make_server(false);
        seed_event(&server, "p2", "theirs", "Theirs", "a0");
        let res = update_event(
            &server,
            UpdateEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                event_id: "theirs".to_string(),
                base_version: 0,
                title: Some("hijack".to_string()),
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                secret: None,
                reveal_scene_id: None,
            },
        )
        .await;
        assert!(res.is_err());
        let conn = server.conn.lock().unwrap();
        let n: i64 = conn
            .query_row("SELECT COUNT(*) FROM change_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "no tracked write for a foreign id");
        let title: String = conn
            .query_row("SELECT title FROM events WHERE id = 'theirs'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(title, "Theirs", "foreign row untouched");
    }

    #[tokio::test]
    async fn readonly_blocks_create_event() {
        let server = make_server(true);
        let res = create_event(
            &server,
            CreateEventParams {
                request_id: uuid::Uuid::new_v4().to_string(),
                title: "blocked".to_string(),
                note: None,
                kind: None,
                primary_codex_id: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: None,
                scene_ids: None,
            },
        )
        .await;
        assert!(res.is_err(), "readonly mode must reject writes");
        assert_eq!(
            scalar(
                &server,
                "SELECT COUNT(*) FROM events WHERE project_id = ?1",
                "p1"
            ),
            0
        );
    }

    // ── get_chronicle_state integration (DB path → Rust derive) ──────────────

    #[tokio::test]
    async fn chronicle_state_derives_for_stamped_scene() {
        let server = make_server(false);
        seed_scene(&server, "p1", "s1");
        {
            let conn = server.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO codex_entries (id, project_id, name, type) VALUES ('hero','p1','Hero','character')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO events (id, project_id, title, ordinal, kind, primary_codex_id,
                                     start_time, created_at, updated_at)
                 VALUES ('e1','p1','Battle','a0','generic','hero', 5, datetime('now'), datetime('now'))",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO scene_events (scene_id, event_id) VALUES ('s1','e1')",
                [],
            )
            .unwrap();
        }
        let res = get_chronicle_state(
            &server,
            GetChronicleStateParams {
                scene_id: Some("s1".to_string()),
            },
        )
        .await
        .unwrap();
        let json = result_json(&res);
        assert_eq!(json["time"]["source"], "stamped");
        assert_eq!(json["time"]["startTime"], 5);
        // hero is the primary of the anchored event → present in characters.
        let chars = json["characters"].as_array().unwrap();
        assert!(chars
            .iter()
            .any(|c| c["codexId"] == "hero" && c["name"] == "Hero"));
    }

    #[tokio::test]
    async fn chronicle_state_null_without_events() {
        let server = make_server(false);
        seed_scene(&server, "p1", "s1");
        let res = get_chronicle_state(
            &server,
            GetChronicleStateParams {
                scene_id: Some("s1".to_string()),
            },
        )
        .await
        .unwrap();
        assert!(result_json(&res).is_null());
    }
}
