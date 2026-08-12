//! Trusted, deterministic seed writer for the Electron runtime-performance lane.
//!
//! The command is gated by a per-run owner token at the N-API boundary. This
//! module accepts typed rows only, validates their complete reference graph,
//! and commits the fixture in one transaction without user-facing history,
//! audit, or idempotency side effects.

use std::collections::HashSet;
use std::io::{Error as IoError, ErrorKind, Write};
use std::time::Duration;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::Database;

const PROJECT_ID: &str = "default-project";
const FIXTURE_ID_PREFIX: &str = "grimodex-runtime-perf-";
const MAX_TREE_NODES: usize = 10_500;
const MAX_MAP_ROWS: usize = 2_200;
const MAX_PLOT_THREADS: usize = 200;
const MAX_PLOT_LINKS: usize = 6_000;
const MAX_EVENTS: usize = 5_500;
const MAX_EVENT_RELATIONS: usize = 1_100;
const MAX_CHAT_MESSAGES: usize = 5_500;
const MAX_TOTAL_ROWS: usize = 25_000;
const MAX_SCENE_CONTENT_BYTES: usize = 2_000_000;
const MAX_TOTAL_CONTENT_BYTES: usize = 20_000_000;
const MAX_WIRE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeTreeNodeSeed {
    pub id: String,
    pub parent_id: Option<String>,
    pub node_type: String,
    pub title: String,
    pub content: String,
    pub char_count: i64,
    pub sort_order: String,
    pub story_time_order: Option<String>,
    pub chronicle_start_time: Option<i64>,
    pub chronicle_start_granularity: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeMapBoardSeed {
    pub id: String,
    pub title: String,
    pub sort_order: i64,
    pub mode: String,
    pub show_config: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeProjectSettingSeed {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeMapNodePositionSeed {
    pub id: String,
    pub board_id: String,
    pub tree_node_id: String,
    pub x: f64,
    pub y: f64,
    pub z_index: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeMapEdgeSeed {
    pub id: String,
    pub board_id: String,
    pub from_position_id: String,
    pub to_position_id: String,
    pub labels: String,
    pub style: String,
    pub color: String,
    pub direction: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePlotThreadSeed {
    pub id: String,
    pub name: String,
    pub color: String,
    pub sort_order: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePlotThreadSceneLinkSeed {
    pub id: String,
    pub thread_id: String,
    pub node_id: String,
    pub phase_type: String,
    pub sort_order: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEventSeed {
    pub id: String,
    pub title: String,
    pub ordinal: String,
    pub start_time: i64,
    pub end_time: Option<i64>,
    pub start_granularity: String,
    pub end_granularity: String,
    pub precision: String,
    pub kind: String,
    pub secret: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeEventRelationSeed {
    pub cause_event_id: String,
    pub effect_event_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeChatSessionSeed {
    pub id: String,
    pub node_id: String,
    pub title: String,
    pub model: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeChatMessageSeed {
    pub id: String,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub model: Option<String>,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePerformanceSeedPayload {
    pub fixture_id: String,
    pub project_id: String,
    pub tree_nodes: Vec<RuntimeTreeNodeSeed>,
    pub map_board: RuntimeMapBoardSeed,
    pub project_setting: RuntimeProjectSettingSeed,
    pub map_node_positions: Vec<RuntimeMapNodePositionSeed>,
    pub map_edges: Vec<RuntimeMapEdgeSeed>,
    pub plot_threads: Vec<RuntimePlotThreadSeed>,
    pub plot_thread_scene_links: Vec<RuntimePlotThreadSceneLinkSeed>,
    pub events: Vec<RuntimeEventSeed>,
    pub event_relations: Vec<RuntimeEventRelationSeed>,
    pub chat_session: Option<RuntimeChatSessionSeed>,
    pub chat_messages: Vec<RuntimeChatMessageSeed>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePerformanceSeedResult {
    pub fixture_id: String,
    pub inserted_row_count: usize,
    pub db_transaction_count: u32,
    pub history_side_effect_count: i64,
}

struct BoundedJsonWriter {
    written: usize,
    max_bytes: usize,
}

impl Write for BoundedJsonWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let written = self
            .written
            .checked_add(buffer.len())
            .ok_or_else(|| IoError::new(ErrorKind::InvalidData, "serialized size overflow"))?;
        if written > self.max_bytes {
            return Err(IoError::new(
                ErrorKind::InvalidData,
                "serialized input limit exceeded",
            ));
        }
        self.written = written;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn validate_serialized_size<T: Serialize + ?Sized>(
    value: &T,
    max_bytes: usize,
) -> anyhow::Result<()> {
    let mut writer = BoundedJsonWriter {
        written: 0,
        max_bytes,
    };
    serde_json::to_writer(&mut writer, value).map_err(|error| {
        anyhow::anyhow!("runtime performance seed exceeds its serialized input limit: {error}")
    })?;
    Ok(())
}

/// Enforce the aggregate payload limit before converting an N-API JSON value
/// into the typed fixture contract.
pub fn validate_runtime_performance_seed_wire_value(
    value: &serde_json::Value,
) -> anyhow::Result<()> {
    validate_serialized_size(value, MAX_WIRE_BYTES)
}

fn require_non_empty(value: &str, field: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !value.trim().is_empty(),
        "runtime performance seed {field} must not be empty"
    );
    anyhow::ensure!(
        value.len() <= 2_000_000,
        "runtime performance seed {field} is too large"
    );
    Ok(())
}

fn require_fixture_id(value: &str, field: &str) -> anyhow::Result<()> {
    require_non_empty(value, field)?;
    anyhow::ensure!(
        value.starts_with(FIXTURE_ID_PREFIX),
        "runtime performance seed {field} must use fixture-owned IDs"
    );
    anyhow::ensure!(
        value.len() <= 200,
        "runtime performance seed {field} is too long"
    );
    Ok(())
}

fn insert_unique<'a>(
    ids: &mut HashSet<&'a str>,
    value: &'a str,
    field: &str,
) -> anyhow::Result<()> {
    require_fixture_id(value, field)?;
    anyhow::ensure!(
        ids.insert(value),
        "runtime performance seed {field} contains duplicate ID '{value}'"
    );
    Ok(())
}

fn validate_payload(payload: &RuntimePerformanceSeedPayload) -> anyhow::Result<usize> {
    require_non_empty(&payload.fixture_id, "fixtureId")?;
    anyhow::ensure!(
        payload.fixture_id.len() <= 120
            && payload
                .fixture_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
        "runtime performance seed fixtureId must be a short canonical identifier"
    );
    anyhow::ensure!(
        payload.project_id == PROJECT_ID,
        "runtime performance seed is restricted to project '{PROJECT_ID}'"
    );
    anyhow::ensure!(
        !payload.tree_nodes.is_empty() && payload.tree_nodes.len() <= MAX_TREE_NODES,
        "runtime performance seed treeNodes exceeds its input limit"
    );
    for (len, max, field) in [
        (
            payload.map_node_positions.len(),
            MAX_MAP_ROWS,
            "mapNodePositions",
        ),
        (payload.map_edges.len(), MAX_MAP_ROWS, "mapEdges"),
        (payload.plot_threads.len(), MAX_PLOT_THREADS, "plotThreads"),
        (
            payload.plot_thread_scene_links.len(),
            MAX_PLOT_LINKS,
            "plotThreadSceneLinks",
        ),
        (payload.events.len(), MAX_EVENTS, "events"),
        (
            payload.event_relations.len(),
            MAX_EVENT_RELATIONS,
            "eventRelations",
        ),
        (
            payload.chat_messages.len(),
            MAX_CHAT_MESSAGES,
            "chatMessages",
        ),
    ] {
        anyhow::ensure!(
            len <= max,
            "runtime performance seed {field} exceeds its input limit"
        );
    }
    let total_rows = payload.tree_nodes.len()
        + 2
        + payload.map_node_positions.len()
        + payload.map_edges.len()
        + payload.plot_threads.len()
        + payload.plot_thread_scene_links.len()
        + payload.events.len()
        + payload.event_relations.len()
        + usize::from(payload.chat_session.is_some())
        + payload.chat_messages.len();
    anyhow::ensure!(
        total_rows <= MAX_TOTAL_ROWS,
        "runtime performance seed exceeds the total row input limit"
    );
    validate_serialized_size(payload, MAX_WIRE_BYTES)?;

    let mut node_ids = HashSet::new();
    let mut folder_ids = HashSet::new();
    let mut scene_ids = HashSet::new();
    let mut total_content_bytes = 0usize;
    for node in &payload.tree_nodes {
        insert_unique(&mut node_ids, &node.id, "treeNodes[].id")?;
        require_non_empty(&node.title, "treeNodes[].title")?;
        require_non_empty(&node.sort_order, "treeNodes[].sortOrder")?;
        anyhow::ensure!(
            matches!(node.node_type.as_str(), "folder" | "scene"),
            "runtime performance seed tree node type must be folder or scene"
        );
        anyhow::ensure!(
            node.char_count >= 0,
            "runtime performance seed tree node charCount must be non-negative"
        );
        anyhow::ensure!(
            node.content.len() <= MAX_SCENE_CONTENT_BYTES,
            "runtime performance seed scene content exceeds its input limit"
        );
        serde_json::from_str::<serde_json::Value>(&node.content)
            .map_err(|error| anyhow::anyhow!("runtime tree content is invalid JSON: {error}"))?;
        total_content_bytes = total_content_bytes
            .checked_add(node.content.len())
            .ok_or_else(|| anyhow::anyhow!("runtime content byte count overflow"))?;
        if node.node_type == "folder" {
            anyhow::ensure!(
                node.parent_id.is_none(),
                "runtime performance seed fixture folders must be roots"
            );
            folder_ids.insert(node.id.as_str());
        } else {
            scene_ids.insert(node.id.as_str());
        }
        anyhow::ensure!(
            node.chronicle_start_granularity
                .as_deref()
                .is_none_or(|value| value == "day"),
            "runtime performance seed chronicle granularity must be day"
        );
    }
    anyhow::ensure!(
        total_content_bytes <= MAX_TOTAL_CONTENT_BYTES,
        "runtime performance seed total scene content exceeds its input limit"
    );
    for node in &payload.tree_nodes {
        if node.node_type == "scene" {
            let Some(parent_id) = node.parent_id.as_deref() else {
                continue;
            };
            anyhow::ensure!(
                folder_ids.contains(parent_id),
                "runtime performance seed tree parent '{parent_id}' is not a fixture folder"
            );
        }
    }

    require_fixture_id(&payload.map_board.id, "mapBoard.id")?;
    require_non_empty(&payload.map_board.title, "mapBoard.title")?;
    anyhow::ensure!(
        payload.map_board.mode == "free",
        "runtime performance seed map mode must be free"
    );
    serde_json::from_str::<serde_json::Value>(&payload.map_board.show_config)
        .map_err(|error| anyhow::anyhow!("runtime map showConfig is invalid JSON: {error}"))?;
    anyhow::ensure!(
        payload.project_setting.key == "editor.tabState",
        "runtime performance seed may write only editor.tabState"
    );
    serde_json::from_str::<serde_json::Value>(&payload.project_setting.value)
        .map_err(|error| anyhow::anyhow!("runtime editor.tabState is invalid JSON: {error}"))?;

    let mut position_ids = HashSet::new();
    for position in &payload.map_node_positions {
        insert_unique(&mut position_ids, &position.id, "mapNodePositions[].id")?;
        anyhow::ensure!(
            position.board_id == payload.map_board.id,
            "runtime map position references a foreign board"
        );
        anyhow::ensure!(
            scene_ids.contains(position.tree_node_id.as_str()),
            "runtime map position references an unknown fixture scene"
        );
        anyhow::ensure!(
            position.x.is_finite() && position.y.is_finite(),
            "runtime map position coordinates must be finite"
        );
    }
    let mut edge_ids = HashSet::new();
    for edge in &payload.map_edges {
        insert_unique(&mut edge_ids, &edge.id, "mapEdges[].id")?;
        anyhow::ensure!(
            edge.board_id == payload.map_board.id
                && position_ids.contains(edge.from_position_id.as_str())
                && position_ids.contains(edge.to_position_id.as_str()),
            "runtime map edge references an unknown board position"
        );
        serde_json::from_str::<serde_json::Value>(&edge.labels).map_err(|error| {
            anyhow::anyhow!("runtime map edge labels are invalid JSON: {error}")
        })?;
        for (value, field) in [
            (&edge.style, "mapEdges[].style"),
            (&edge.color, "mapEdges[].color"),
            (&edge.direction, "mapEdges[].direction"),
        ] {
            require_non_empty(value, field)?;
        }
    }

    let mut thread_ids = HashSet::new();
    for thread in &payload.plot_threads {
        insert_unique(&mut thread_ids, &thread.id, "plotThreads[].id")?;
        require_non_empty(&thread.name, "plotThreads[].name")?;
        require_non_empty(&thread.color, "plotThreads[].color")?;
        require_non_empty(&thread.sort_order, "plotThreads[].sortOrder")?;
    }
    let mut link_ids = HashSet::new();
    let mut link_semantic_keys = HashSet::new();
    for link in &payload.plot_thread_scene_links {
        insert_unique(&mut link_ids, &link.id, "plotThreadSceneLinks[].id")?;
        anyhow::ensure!(
            thread_ids.contains(link.thread_id.as_str())
                && scene_ids.contains(link.node_id.as_str()),
            "runtime plot-thread link references an unknown fixture row"
        );
        anyhow::ensure!(
            matches!(
                link.phase_type.as_str(),
                "introduce" | "develop" | "turn" | "climax" | "resolve"
            ),
            "runtime plot-thread link has an invalid phaseType"
        );
        require_non_empty(&link.sort_order, "plotThreadSceneLinks[].sortOrder")?;
        anyhow::ensure!(
            link_semantic_keys.insert((
                link.thread_id.as_str(),
                link.node_id.as_str(),
                link.phase_type.as_str(),
            )),
            "runtime plot-thread link has a duplicate canonical semantic key"
        );
    }

    let mut event_ids = HashSet::new();
    for event in &payload.events {
        insert_unique(&mut event_ids, &event.id, "events[].id")?;
        require_non_empty(&event.title, "events[].title")?;
        require_non_empty(&event.ordinal, "events[].ordinal")?;
        anyhow::ensure!(
            event.start_time >= 0 && event.end_time.is_none_or(|end| end >= event.start_time),
            "runtime event time range is invalid"
        );
        anyhow::ensure!(
            event.start_granularity == "day"
                && event.end_granularity == "day"
                && event.precision == "exact"
                && event.kind == "generic"
                && !event.secret,
            "runtime event semantic fields do not match the fixture contract"
        );
    }
    let mut relations = HashSet::new();
    for relation in &payload.event_relations {
        anyhow::ensure!(
            relation.cause_event_id != relation.effect_event_id
                && event_ids.contains(relation.cause_event_id.as_str())
                && event_ids.contains(relation.effect_event_id.as_str()),
            "runtime event relation references an unknown or identical event"
        );
        anyhow::ensure!(
            relations.insert((
                relation.cause_event_id.as_str(),
                relation.effect_event_id.as_str(),
            )),
            "runtime event relation is duplicated"
        );
    }

    match payload.chat_session.as_ref() {
        Some(session) => {
            require_non_empty(&session.id, "chatSession.id")?;
            anyhow::ensure!(
                session.id.len() <= 200 && session.id.ends_with("-session"),
                "runtime chat session ID must be fixture-owned"
            );
            anyhow::ensure!(
                scene_ids.contains(session.node_id.as_str()),
                "runtime chat session references an unknown fixture scene"
            );
            for (value, field) in [
                (&session.title, "chatSession.title"),
                (&session.model, "chatSession.model"),
                (&session.created_at, "chatSession.createdAt"),
                (&session.updated_at, "chatSession.updatedAt"),
            ] {
                require_non_empty(value, field)?;
            }
        }
        None => anyhow::ensure!(
            payload.chat_messages.is_empty(),
            "runtime chat messages require a chat session"
        ),
    }
    let mut message_ids = HashSet::new();
    for message in &payload.chat_messages {
        insert_unique(&mut message_ids, &message.id, "chatMessages[].id")?;
        let session = payload
            .chat_session
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("runtime chat message has no session"))?;
        anyhow::ensure!(
            message.session_id == session.id,
            "runtime chat message references a foreign session"
        );
        anyhow::ensure!(
            matches!(message.role.as_str(), "user" | "assistant"),
            "runtime chat message role is invalid"
        );
        require_non_empty(&message.content, "chatMessages[].content")?;
        require_non_empty(&message.created_at, "chatMessages[].createdAt")?;
    }

    Ok(total_rows)
}

fn history_side_effect_count(conn: &rusqlite::Connection) -> anyhow::Result<i64> {
    conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM change_events) +
            (SELECT COUNT(*) FROM undo_journal) +
            (SELECT COUNT(*) FROM idempotency_requests)",
        [],
        |row| row.get(0),
    )
    .map_err(Into::into)
}

pub fn seed_runtime_performance_fixture(
    db: &Database,
    payload: RuntimePerformanceSeedPayload,
) -> anyhow::Result<RuntimePerformanceSeedResult> {
    let inserted_row_count = validate_payload(&payload)?;
    db.with_conn(|conn| {
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<RuntimePerformanceSeedResult> {
            let project_exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
                params![payload.project_id],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                project_exists,
                "runtime performance seed project is missing"
            );
            let history_before = history_side_effect_count(conn)?;

            {
                let mut statement = conn.prepare_cached(
                    "INSERT INTO tree_nodes
                      (id, project_id, parent_id, node_type, title, content, char_count,
                       sort_order, story_time_order, chronicle_start_time,
                       chronicle_start_granularity)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                             COALESCE(?11, 'none'))",
                )?;
                for node in &payload.tree_nodes {
                    anyhow::ensure!(
                        statement.execute(params![
                            node.id,
                            payload.project_id,
                            node.parent_id,
                            node.node_type,
                            node.title,
                            node.content,
                            node.char_count,
                            node.sort_order,
                            node.story_time_order,
                            node.chronicle_start_time,
                            node.chronicle_start_granularity,
                        ])? == 1,
                        "runtime tree node insert did not affect one row"
                    );
                }
            }
            conn.execute(
                "INSERT INTO map_boards
                  (id, project_id, title, sort_order, mode, show_config)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    payload.map_board.id,
                    payload.project_id,
                    payload.map_board.title,
                    payload.map_board.sort_order,
                    payload.map_board.mode,
                    payload.map_board.show_config,
                ],
            )?;
            conn.execute(
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value",
                params![
                    payload.project_id,
                    payload.project_setting.key,
                    payload.project_setting.value,
                ],
            )?;
            {
                let mut statement = conn.prepare_cached(
                    "INSERT INTO map_node_positions
                      (id, board_id, node_ref_type, tree_node_id, x, y, z_index)
                     VALUES (?1, ?2, 'scene', ?3, ?4, ?5, ?6)",
                )?;
                for position in &payload.map_node_positions {
                    statement.execute(params![
                        position.id,
                        position.board_id,
                        position.tree_node_id,
                        position.x,
                        position.y,
                        position.z_index,
                    ])?;
                }
            }
            {
                let mut statement = conn.prepare_cached(
                    "INSERT INTO map_edges
                      (id, board_id, from_position_id, to_position_id, labels,
                       style, color, direction)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )?;
                for edge in &payload.map_edges {
                    statement.execute(params![
                        edge.id,
                        edge.board_id,
                        edge.from_position_id,
                        edge.to_position_id,
                        edge.labels,
                        edge.style,
                        edge.color,
                        edge.direction,
                    ])?;
                }
            }
            {
                let mut statement = conn.prepare_cached(
                    "INSERT INTO plot_threads
                      (id, project_id, name, color, sort_order)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )?;
                for thread in &payload.plot_threads {
                    statement.execute(params![
                        thread.id,
                        payload.project_id,
                        thread.name,
                        thread.color,
                        thread.sort_order,
                    ])?;
                }
            }
            {
                let mut statement = conn.prepare_cached(
                    "INSERT INTO plot_thread_scene_links
                      (id, thread_id, node_id, phase_type, sort_order, semantic_key)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )?;
                for link in &payload.plot_thread_scene_links {
                    let semantic_key =
                        format!("{}|{}|{}", link.thread_id, link.node_id, link.phase_type);
                    statement.execute(params![
                        link.id,
                        link.thread_id,
                        link.node_id,
                        link.phase_type,
                        link.sort_order,
                        semantic_key,
                    ])?;
                }
            }
            {
                let mut statement = conn.prepare_cached(
                    "INSERT INTO events
                      (id, project_id, title, ordinal, start_time, end_time,
                       start_granularity, end_granularity, precision, kind, secret)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                )?;
                for event in &payload.events {
                    statement.execute(params![
                        event.id,
                        payload.project_id,
                        event.title,
                        event.ordinal,
                        event.start_time,
                        event.end_time,
                        event.start_granularity,
                        event.end_granularity,
                        event.precision,
                        event.kind,
                        event.secret,
                    ])?;
                }
            }
            {
                let mut statement = conn.prepare_cached(
                    "INSERT INTO event_relations
                      (project_id, cause_event_id, effect_event_id)
                     VALUES (?1, ?2, ?3)",
                )?;
                for relation in &payload.event_relations {
                    statement.execute(params![
                        payload.project_id,
                        relation.cause_event_id,
                        relation.effect_event_id,
                    ])?;
                }
            }
            if let Some(session) = payload.chat_session.as_ref() {
                conn.execute(
                    "INSERT INTO chat_sessions
                      (id, project_id, node_id, title, model, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![
                        session.id,
                        payload.project_id,
                        session.node_id,
                        session.title,
                        session.model,
                        session.created_at,
                        session.updated_at,
                    ],
                )?;
            }
            {
                let mut statement = conn.prepare_cached(
                    "INSERT INTO chat_messages
                      (id, session_id, role, content, model, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )?;
                for message in &payload.chat_messages {
                    statement.execute(params![
                        message.id,
                        message.session_id,
                        message.role,
                        message.content,
                        message.model,
                        message.created_at,
                    ])?;
                }
            }

            let history_after = history_side_effect_count(conn)?;
            anyhow::ensure!(
                history_after == history_before,
                "runtime performance seed produced forbidden history side effects"
            );
            Ok(RuntimePerformanceSeedResult {
                fixture_id: payload.fixture_id.clone(),
                inserted_row_count,
                db_transaction_count: 1,
                history_side_effect_count: history_after - history_before,
            })
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
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use std::path::Path;

    use super::*;

    fn database() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open test database");
        db.migrate().expect("migrate test database");
        db.execute(
            "INSERT OR IGNORE INTO projects (id, title) VALUES ('default-project', 'Fixture')",
            &[],
            "run",
        )
        .expect("seed default project");
        db
    }

    fn payload() -> RuntimePerformanceSeedPayload {
        RuntimePerformanceSeedPayload {
            fixture_id: "runtime-fixture-test".to_string(),
            project_id: PROJECT_ID.to_string(),
            tree_nodes: vec![
                RuntimeTreeNodeSeed {
                    id: "grimodex-runtime-perf-folder".to_string(),
                    parent_id: None,
                    node_type: "folder".to_string(),
                    title: "Folder".to_string(),
                    content: "{}".to_string(),
                    char_count: 0,
                    sort_order: "a0".to_string(),
                    story_time_order: None,
                    chronicle_start_time: None,
                    chronicle_start_granularity: None,
                },
                RuntimeTreeNodeSeed {
                    id: "grimodex-runtime-perf-scene-a".to_string(),
                    parent_id: Some("grimodex-runtime-perf-folder".to_string()),
                    node_type: "scene".to_string(),
                    title: "Scene A".to_string(),
                    content: r#"{"type":"doc"}"#.to_string(),
                    char_count: 0,
                    sort_order: "a0".to_string(),
                    story_time_order: Some("0000".to_string()),
                    chronicle_start_time: None,
                    chronicle_start_granularity: None,
                },
                RuntimeTreeNodeSeed {
                    id: "grimodex-runtime-perf-scene-b".to_string(),
                    parent_id: Some("grimodex-runtime-perf-folder".to_string()),
                    node_type: "scene".to_string(),
                    title: "Scene B".to_string(),
                    content: r#"{"type":"doc"}"#.to_string(),
                    char_count: 0,
                    sort_order: "a1".to_string(),
                    story_time_order: Some("0001".to_string()),
                    chronicle_start_time: None,
                    chronicle_start_granularity: None,
                },
            ],
            map_board: RuntimeMapBoardSeed {
                id: "grimodex-runtime-perf-board".to_string(),
                title: "Board".to_string(),
                sort_order: -1,
                mode: "free".to_string(),
                show_config: "{}".to_string(),
            },
            project_setting: RuntimeProjectSettingSeed {
                key: "editor.tabState".to_string(),
                value: r#"{"tabs":[]}"#.to_string(),
            },
            map_node_positions: vec![
                RuntimeMapNodePositionSeed {
                    id: "grimodex-runtime-perf-position-a".to_string(),
                    board_id: "grimodex-runtime-perf-board".to_string(),
                    tree_node_id: "grimodex-runtime-perf-scene-a".to_string(),
                    x: 0.0,
                    y: 0.0,
                    z_index: 0,
                },
                RuntimeMapNodePositionSeed {
                    id: "grimodex-runtime-perf-position-b".to_string(),
                    board_id: "grimodex-runtime-perf-board".to_string(),
                    tree_node_id: "grimodex-runtime-perf-scene-b".to_string(),
                    x: 1.0,
                    y: 1.0,
                    z_index: 1,
                },
            ],
            map_edges: vec![RuntimeMapEdgeSeed {
                id: "grimodex-runtime-perf-edge-a".to_string(),
                board_id: "grimodex-runtime-perf-board".to_string(),
                from_position_id: "grimodex-runtime-perf-position-a".to_string(),
                to_position_id: "grimodex-runtime-perf-position-b".to_string(),
                labels: "[]".to_string(),
                style: "solid".to_string(),
                color: "#000".to_string(),
                direction: "none".to_string(),
            }],
            plot_threads: vec![RuntimePlotThreadSeed {
                id: "grimodex-runtime-perf-thread-a".to_string(),
                name: "Thread".to_string(),
                color: "#000".to_string(),
                sort_order: "0000".to_string(),
            }],
            plot_thread_scene_links: vec![RuntimePlotThreadSceneLinkSeed {
                id: "grimodex-runtime-perf-link-a".to_string(),
                thread_id: "grimodex-runtime-perf-thread-a".to_string(),
                node_id: "grimodex-runtime-perf-scene-a".to_string(),
                phase_type: "introduce".to_string(),
                sort_order: "0000".to_string(),
            }],
            events: vec![
                RuntimeEventSeed {
                    id: "grimodex-runtime-perf-event-a".to_string(),
                    title: "Event A".to_string(),
                    ordinal: "0000".to_string(),
                    start_time: 0,
                    end_time: Some(1),
                    start_granularity: "day".to_string(),
                    end_granularity: "day".to_string(),
                    precision: "exact".to_string(),
                    kind: "generic".to_string(),
                    secret: false,
                },
                RuntimeEventSeed {
                    id: "grimodex-runtime-perf-event-b".to_string(),
                    title: "Event B".to_string(),
                    ordinal: "0001".to_string(),
                    start_time: 1,
                    end_time: None,
                    start_granularity: "day".to_string(),
                    end_granularity: "day".to_string(),
                    precision: "exact".to_string(),
                    kind: "generic".to_string(),
                    secret: false,
                },
            ],
            event_relations: vec![RuntimeEventRelationSeed {
                cause_event_id: "grimodex-runtime-perf-event-a".to_string(),
                effect_event_id: "grimodex-runtime-perf-event-b".to_string(),
            }],
            chat_session: Some(RuntimeChatSessionSeed {
                id: "runtime-fixture-test-session".to_string(),
                node_id: "grimodex-runtime-perf-scene-a".to_string(),
                title: "Chat".to_string(),
                model: "runtime-fixture".to_string(),
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
                updated_at: "2026-01-01T00:00:00.000Z".to_string(),
            }),
            chat_messages: vec![RuntimeChatMessageSeed {
                id: "grimodex-runtime-perf-chat-message-a".to_string(),
                session_id: "runtime-fixture-test-session".to_string(),
                role: "user".to_string(),
                content: "Message".to_string(),
                model: None,
                created_at: "2026-01-01T00:00:00.000Z".to_string(),
            }],
        }
    }

    #[test]
    fn seed_is_one_transaction_and_has_no_history_side_effects() {
        let db = database();
        let expected_rows = validate_payload(&payload()).expect("valid payload");
        let result = seed_runtime_performance_fixture(&db, payload()).expect("seed fixture");
        assert_eq!(result.inserted_row_count, expected_rows);
        assert_eq!(result.db_transaction_count, 1);
        assert_eq!(result.history_side_effect_count, 0);
        db.with_conn(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM tree_nodes WHERE id LIKE 'grimodex-runtime-perf-%'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                3
            );
            assert_eq!(
                conn.query_row(
                    "SELECT semantic_key, version FROM plot_thread_scene_links
                     WHERE id = 'grimodex-runtime-perf-link-a'",
                    [],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )?,
                (
                    "grimodex-runtime-perf-thread-a|grimodex-runtime-perf-scene-a|introduce"
                        .to_string(),
                    0,
                )
            );
            assert_eq!(history_side_effect_count(conn)?, 0);
            Ok(())
        })
        .expect("verify fixture rows");
    }

    #[test]
    fn formal_timeline_5k_plot_seed_generates_unique_semantic_keys() {
        let db = database();
        let mut canonical = payload();
        canonical.tree_nodes = std::iter::once(RuntimeTreeNodeSeed {
            id: "grimodex-runtime-perf-folder".to_string(),
            parent_id: None,
            node_type: "folder".to_string(),
            title: "Folder".to_string(),
            content: "{}".to_string(),
            char_count: 0,
            sort_order: "a1".to_string(),
            story_time_order: None,
            chronicle_start_time: None,
            chronicle_start_granularity: None,
        })
        .chain((0..1_000).map(|index| RuntimeTreeNodeSeed {
            id: format!("grimodex-runtime-perf-scene-{index:03}"),
            parent_id: Some("grimodex-runtime-perf-folder".to_string()),
            node_type: "scene".to_string(),
            title: format!("Scene {index}"),
            content: r#"{"type":"doc"}"#.to_string(),
            char_count: 0,
            sort_order: format!("{index:04}"),
            story_time_order: Some(format!("{index:04}")),
            chronicle_start_time: None,
            chronicle_start_granularity: None,
        }))
        .collect();
        canonical.map_node_positions[0].tree_node_id =
            "grimodex-runtime-perf-scene-000".to_string();
        canonical.map_node_positions[1].tree_node_id =
            "grimodex-runtime-perf-scene-001".to_string();
        canonical.plot_threads = (0..100)
            .map(|index| RuntimePlotThreadSeed {
                id: format!("grimodex-runtime-perf-thread-{index:03}"),
                name: format!("Thread {index}"),
                color: "#000".to_string(),
                sort_order: format!("{index:04}"),
            })
            .collect();
        let phase_types = ["introduce", "develop", "turn", "climax", "resolve"];
        canonical.plot_thread_scene_links = (0..5_000)
            .map(|index| RuntimePlotThreadSceneLinkSeed {
                id: format!("grimodex-runtime-perf-marker-link-{index:05}"),
                thread_id: format!("grimodex-runtime-perf-thread-{:03}", index % 100),
                node_id: format!("grimodex-runtime-perf-scene-{:03}", index % 1_000),
                phase_type: phase_types[(index / 1_000) % phase_types.len()].to_string(),
                sort_order: format!("{index:05}"),
            })
            .collect();
        canonical
            .chat_session
            .as_mut()
            .expect("chat session")
            .node_id = "grimodex-runtime-perf-scene-000".to_string();

        let result =
            seed_runtime_performance_fixture(&db, canonical).expect("seed canonical fixture");
        assert_eq!(result.db_transaction_count, 1);
        assert_eq!(result.history_side_effect_count, 0);
        db.with_conn(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*), COUNT(DISTINCT semantic_key), SUM(version)
                     FROM plot_thread_scene_links",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    },
                )?,
                (5_000, 5_000, 0)
            );
            assert_eq!(history_side_effect_count(conn)?, 0);
            Ok(())
        })
        .expect("verify canonical fixture");
    }

    #[test]
    fn formal_tree_grid_10k_seed_fits_with_explicit_headroom() {
        let db = database();
        let mut tree_grid = payload();
        tree_grid.fixture_id = "tree-grid-10k".to_string();
        tree_grid
            .tree_nodes
            .extend((0..9_997).map(|index| RuntimeTreeNodeSeed {
                id: format!("grimodex-runtime-perf-grid-scene-{index:05}"),
                parent_id: Some("grimodex-runtime-perf-folder".to_string()),
                node_type: "scene".to_string(),
                title: format!("Grid scene {index}"),
                content: r#"{"type":"doc"}"#.to_string(),
                char_count: 0,
                sort_order: format!("{index:05}"),
                story_time_order: Some(format!("{index:05}")),
                chronicle_start_time: None,
                chronicle_start_granularity: None,
            }));

        assert_eq!(tree_grid.tree_nodes.len(), 10_000);
        assert_eq!(MAX_TREE_NODES - tree_grid.tree_nodes.len(), 500);
        validate_payload(&tree_grid).expect("formal tree-grid-10k must validate");
        let result =
            seed_runtime_performance_fixture(&db, tree_grid).expect("seed formal tree grid");
        assert_eq!(result.db_transaction_count, 1);
        assert_eq!(result.history_side_effect_count, 0);
        db.with_conn(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM tree_nodes
                     WHERE id LIKE 'grimodex-runtime-perf-%'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                10_000
            );
            assert_eq!(history_side_effect_count(conn)?, 0);
            Ok(())
        })
        .expect("verify formal tree grid");
    }

    #[test]
    fn database_failure_rolls_back_rows_inserted_earlier_in_the_bundle() {
        let db = database();
        db.execute(
            "INSERT INTO tree_nodes
              (id, project_id, node_type, title, content, char_count, sort_order)
             VALUES ('grimodex-runtime-perf-scene-b', 'default-project', 'scene',
                     'Existing', '{}', 0, 'existing')",
            &[],
            "run",
        )
        .expect("seed conflicting database row");

        let error = seed_runtime_performance_fixture(&db, payload())
            .expect_err("mid-bundle uniqueness failure must abort the seed");
        assert!(error.to_string().contains("UNIQUE constraint failed"));
        db.with_conn(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM tree_nodes
                      WHERE id IN ('grimodex-runtime-perf-folder',
                                   'grimodex-runtime-perf-scene-a')",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                0
            );
            assert_eq!(
                conn.query_row(
                    "SELECT title FROM tree_nodes WHERE id = 'grimodex-runtime-perf-scene-b'",
                    [],
                    |row| row.get::<_, String>(0),
                )?,
                "Existing"
            );
            assert_eq!(history_side_effect_count(conn)?, 0);
            Ok(())
        })
        .expect("verify transaction rollback");
    }

    #[test]
    fn input_limits_and_reference_graph_fail_before_mutation() {
        let db = database();
        let oversized_wire = serde_json::json!({ "padding": "0123456789" });
        let error = validate_serialized_size(&oversized_wire, 8)
            .expect_err("aggregate serialized input limit must be enforced");
        assert!(error.to_string().contains("serialized input limit"));

        let mut invalid_reference = payload();
        invalid_reference.plot_thread_scene_links[0].node_id =
            "grimodex-runtime-perf-missing".to_string();
        let error = seed_runtime_performance_fixture(&db, invalid_reference)
            .expect_err("unknown reference must be rejected");
        assert!(error.to_string().contains("unknown fixture row"));

        let mut folder_parent = payload();
        folder_parent.tree_nodes[0].parent_id = Some("grimodex-runtime-perf-scene-a".to_string());
        let error = seed_runtime_performance_fixture(&db, folder_parent)
            .expect_err("fixture folders must not form a parent cycle");
        assert!(error.to_string().contains("folders must be roots"));

        let mut map_folder_reference = payload();
        map_folder_reference.map_node_positions[0].tree_node_id =
            "grimodex-runtime-perf-folder".to_string();
        let error = seed_runtime_performance_fixture(&db, map_folder_reference)
            .expect_err("map positions must reference fixture scenes");
        assert!(error.to_string().contains("unknown fixture scene"));

        let mut plot_folder_reference = payload();
        plot_folder_reference.plot_thread_scene_links[0].node_id =
            "grimodex-runtime-perf-folder".to_string();
        let error = seed_runtime_performance_fixture(&db, plot_folder_reference)
            .expect_err("plot markers must reference fixture scenes");
        assert!(error.to_string().contains("unknown fixture row"));

        let mut duplicate_semantic_key = payload();
        let mut duplicate_link = duplicate_semantic_key.plot_thread_scene_links[0].clone();
        duplicate_link.id = "grimodex-runtime-perf-link-b".to_string();
        duplicate_semantic_key
            .plot_thread_scene_links
            .push(duplicate_link);
        let error = seed_runtime_performance_fixture(&db, duplicate_semantic_key)
            .expect_err("duplicate semantic keys must fail before the transaction");
        assert!(error
            .to_string()
            .contains("duplicate canonical semantic key"));

        let mut oversized = payload();
        oversized.tree_nodes = vec![oversized.tree_nodes[0].clone(); MAX_TREE_NODES + 1];
        let error = seed_runtime_performance_fixture(&db, oversized)
            .expect_err("oversized payload must be rejected");
        assert!(error.to_string().contains("input limit"));

        db.with_conn(|conn| {
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM tree_nodes WHERE id LIKE 'grimodex-runtime-perf-%'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?,
                0
            );
            Ok(())
        })
        .expect("verify validation failures are non-mutating");
    }
}
