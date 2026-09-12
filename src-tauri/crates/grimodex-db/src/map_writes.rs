//! Typed Map aggregate persistence.
//!
//! Renderer Map features still compute layouts and IDs, but they no longer
//! transmit SQL. This module owns the fixed table set, FK-safe ordering,
//! transaction boundaries, and project/board ownership checks.

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::Database;
use crate::change_events::AppendChangeEvent;
use crate::codex_relation_keys::{build_codex_relation_semantic_key, normalize_relation_label};
use crate::idempotency::{
    insert_idempotent_response, load_idempotent_response, payload_fingerprint, IdempotencyRequest,
};
use crate::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_object_key, narrative_snapshot_digest,
    require_replay_lineage_in_project, AppendNarrativeChangeTransactionInput,
    NarrativeChangeCauseKind, NarrativeChangeEventInput, NarrativeChangeOrigin,
};
use crate::undo_journal::{insert_undo_journal_in_tx, UndoJournalInsert};

fn require_non_empty(value: &str, field: &str) -> anyhow::Result<()> {
    if value.is_empty() {
        anyhow::bail!("map write {field} must not be empty");
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapBoardRow {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub sort_order: f64,
    pub mode: String,
    pub viewport_x: f64,
    pub viewport_y: f64,
    pub viewport_zoom: f64,
    pub show_config: String,
    pub color_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapAiBranchRow {
    pub id: String,
    pub board_id: String,
    pub prompt: String,
    pub seed_node_ids: String,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub token_usage: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapStickyRow {
    pub id: String,
    pub board_id: String,
    pub title: Option<String>,
    pub body: String,
    pub preview_text: Option<String>,
    pub palette_id: String,
    pub color_slot: i64,
    pub ai_branch_id: Option<String>,
    pub ai_derived: i64,
    pub source_chat_message_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapNodePositionRow {
    pub id: String,
    pub board_id: String,
    pub node_ref_type: String,
    pub tree_node_id: Option<String>,
    pub codex_entry_id: Option<String>,
    pub snippet_id: Option<String>,
    pub sticky_id: Option<String>,
    pub ai_branch_id: Option<String>,
    pub x: f64,
    pub y: f64,
    pub pinned: i64,
    pub z_index: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapEdgeRow {
    pub id: String,
    pub board_id: String,
    pub from_position_id: String,
    pub to_position_id: String,
    pub forward_label: Option<String>,
    pub backward_label: Option<String>,
    pub labels: String,
    pub style: String,
    pub color: String,
    pub direction: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapFrameRow {
    pub id: String,
    pub board_id: String,
    pub title: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub background: String,
    pub border_color: String,
    pub z_index: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapAuthorshipSpanRow {
    pub id: String,
    pub node_id: Option<String>,
    pub codex_entry_id: Option<String>,
    pub snippet_id: Option<String>,
    pub detail_value_id: Option<String>,
    pub sticky_id: Option<String>,
    pub from_pos: i64,
    pub to_pos: i64,
    pub source: String,
    pub model: Option<String>,
    pub timestamp: Option<String>,
    pub chat_msg_id: Option<String>,
    pub trace_id: Option<String>,
    pub phase_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapWritePayload {
    pub kind: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    #[serde(default = "default_map_write_origin")]
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    pub project_id: Option<String>,
    pub board_id: Option<String>,
    pub board: Option<MapBoardRow>,
    pub branch: Option<MapAiBranchRow>,
    pub branch_position: Option<MapNodePositionRow>,
    #[serde(default)]
    pub stickies: Vec<MapStickyRow>,
    #[serde(default)]
    pub positions: Vec<MapNodePositionRow>,
    #[serde(default)]
    pub edges: Vec<MapEdgeRow>,
    #[serde(default)]
    pub frames: Vec<MapFrameRow>,
    #[serde(default)]
    pub spans: Vec<MapAuthorshipSpanRow>,
    pub target_type: Option<String>,
    pub new_entity_id: Option<String>,
    pub title: Option<String>,
    pub body: Option<String>,
    pub parent_id: Option<String>,
    pub sort_order: Option<String>,
    pub codex_type: Option<String>,
    pub position_id: Option<String>,
    pub sticky_id: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub branch_id: Option<String>,
    #[serde(default)]
    pub span_ids: Vec<String>,
    #[serde(default)]
    pub sticky_position_ids: Vec<String>,
    #[serde(default)]
    pub sticky_ids: Vec<String>,
    pub codex_id: Option<String>,
    pub frame_id: Option<String>,
    pub content: Option<String>,
    pub edge_id: Option<String>,
    pub relation_id: Option<String>,
    pub from_codex_id: Option<String>,
    pub to_codex_id: Option<String>,
    pub relation_type: Option<String>,
    pub label: Option<String>,
    #[serde(default)]
    pub reuse_existing_relation: bool,
}

fn default_map_write_origin() -> NarrativeChangeOrigin {
    NarrativeChangeOrigin::Human
}

fn required<'a>(value: &'a Option<String>, field: &str) -> anyhow::Result<&'a str> {
    let value = value.as_deref().unwrap_or_default();
    require_non_empty(value, field)?;
    Ok(value)
}

fn ensure_project(tx: &Transaction<'_>, project_id: &str) -> anyhow::Result<()> {
    let exists = tx
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1",
            params![project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    if !exists {
        anyhow::bail!("map project '{project_id}' does not exist");
    }
    Ok(())
}

fn board_project(tx: &Transaction<'_>, board_id: &str) -> anyhow::Result<String> {
    tx.query_row(
        "SELECT project_id FROM map_boards WHERE id = ?1",
        params![board_id],
        |row| row.get(0),
    )
    .optional()?
    .ok_or_else(|| anyhow::anyhow!("map board '{board_id}' does not exist"))
}

fn ensure_board_project(
    tx: &Transaction<'_>,
    board_id: &str,
    project_id: &str,
) -> anyhow::Result<()> {
    if board_project(tx, board_id)? != project_id {
        anyhow::bail!("map board '{board_id}' is not in project '{project_id}'");
    }
    Ok(())
}

fn ensure_row_board(actual: &str, expected: &str, field: &str) -> anyhow::Result<()> {
    if actual != expected {
        anyhow::bail!("map {field} belongs to a foreign board");
    }
    Ok(())
}

fn ensure_position_reference(
    tx: &Transaction<'_>,
    project_id: &str,
    row: &MapNodePositionRow,
    sticky_ids: &HashSet<&str>,
    branch_ids: &HashSet<&str>,
) -> anyhow::Result<()> {
    let scalar_exists = |sql: &str, id: &str| -> anyhow::Result<bool> {
        Ok(tx
            .query_row(sql, params![id, project_id], |r| r.get::<_, i64>(0))
            .optional()?
            .is_some())
    };
    let valid = match row.node_ref_type.as_str() {
        "scene" | "note" => match row.tree_node_id.as_deref() {
            Some(id) => scalar_exists(
                "SELECT 1 FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
                id,
            )?,
            None => false,
        },
        "codex" => match row.codex_entry_id.as_deref() {
            Some(id) => scalar_exists(
                "SELECT 1 FROM codex_entries WHERE id = ?1 AND project_id = ?2",
                id,
            )?,
            None => false,
        },
        "snippet" => match row.snippet_id.as_deref() {
            Some(id) => scalar_exists(
                "SELECT 1 FROM snippets WHERE id = ?1 AND project_id = ?2",
                id,
            )?,
            None => false,
        },
        "sticky" => row
            .sticky_id
            .as_deref()
            .is_some_and(|id| sticky_ids.contains(id)),
        "ai_branch" => row
            .ai_branch_id
            .as_deref()
            .is_some_and(|id| branch_ids.contains(id)),
        _ => false,
    };
    if !valid {
        anyhow::bail!(
            "map position '{}' has an invalid or cross-project reference",
            row.id
        );
    }
    Ok(())
}

fn insert_board(tx: &Transaction<'_>, row: &MapBoardRow) -> anyhow::Result<()> {
    tx.execute(
        "INSERT INTO map_boards
           (id, project_id, title, sort_order, mode, viewport_x, viewport_y,
            viewport_zoom, show_config, color_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            row.id,
            row.project_id,
            row.title,
            row.sort_order,
            row.mode,
            row.viewport_x,
            row.viewport_y,
            row.viewport_zoom,
            row.show_config,
            row.color_by,
            row.created_at,
            row.updated_at
        ],
    )?;
    Ok(())
}

fn insert_branch(
    tx: &Transaction<'_>,
    row: &MapAiBranchRow,
    ignore_conflict: bool,
) -> anyhow::Result<()> {
    let verb = if ignore_conflict {
        "INSERT OR IGNORE"
    } else {
        "INSERT"
    };
    tx.execute(
        &format!(
            "{verb} INTO map_ai_branches
               (id, board_id, prompt, seed_node_ids, session_id, model,
                token_usage, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
        ),
        params![
            row.id,
            row.board_id,
            row.prompt,
            row.seed_node_ids,
            row.session_id,
            row.model,
            row.token_usage,
            row.created_at,
            row.updated_at
        ],
    )?;
    Ok(())
}

fn insert_sticky(
    tx: &Transaction<'_>,
    row: &MapStickyRow,
    ignore_conflict: bool,
) -> anyhow::Result<()> {
    let verb = if ignore_conflict {
        "INSERT OR IGNORE"
    } else {
        "INSERT"
    };
    tx.execute(
        &format!(
            "{verb} INTO map_stickies
               (id, board_id, title, body, preview_text, palette_id, color_slot,
                ai_branch_id, ai_derived, source_chat_message_id, created_at,
                updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
        ),
        params![
            row.id,
            row.board_id,
            row.title,
            row.body,
            row.preview_text,
            row.palette_id,
            row.color_slot,
            row.ai_branch_id,
            row.ai_derived,
            row.source_chat_message_id,
            row.created_at,
            row.updated_at
        ],
    )?;
    Ok(())
}

fn insert_position(
    tx: &Transaction<'_>,
    row: &MapNodePositionRow,
    ignore_conflict: bool,
) -> anyhow::Result<()> {
    let verb = if ignore_conflict {
        "INSERT OR IGNORE"
    } else {
        "INSERT"
    };
    tx.execute(
        &format!(
            "{verb} INTO map_node_positions
               (id, board_id, node_ref_type, tree_node_id, codex_entry_id,
                snippet_id, sticky_id, ai_branch_id, x, y, pinned, z_index,
                created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"
        ),
        params![
            row.id,
            row.board_id,
            row.node_ref_type,
            row.tree_node_id,
            row.codex_entry_id,
            row.snippet_id,
            row.sticky_id,
            row.ai_branch_id,
            row.x,
            row.y,
            row.pinned,
            row.z_index,
            row.created_at,
            row.updated_at
        ],
    )?;
    Ok(())
}

fn insert_edge(
    tx: &Transaction<'_>,
    row: &MapEdgeRow,
    ignore_conflict: bool,
) -> anyhow::Result<()> {
    let verb = if ignore_conflict {
        "INSERT OR IGNORE"
    } else {
        "INSERT"
    };
    tx.execute(
        &format!(
            "{verb} INTO map_edges
               (id, board_id, from_position_id, to_position_id, forward_label,
                backward_label, labels, style, color, direction, created_at,
                updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
        ),
        params![
            row.id,
            row.board_id,
            row.from_position_id,
            row.to_position_id,
            row.forward_label,
            row.backward_label,
            row.labels,
            row.style,
            row.color,
            row.direction,
            row.created_at,
            row.updated_at
        ],
    )?;
    Ok(())
}

fn insert_frame(
    tx: &Transaction<'_>,
    row: &MapFrameRow,
    ignore_conflict: bool,
) -> anyhow::Result<()> {
    let verb = if ignore_conflict {
        "INSERT OR IGNORE"
    } else {
        "INSERT"
    };
    tx.execute(
        &format!(
            "{verb} INTO map_frames
               (id, board_id, title, x, y, width, height, background,
                border_color, z_index, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
        ),
        params![
            row.id,
            row.board_id,
            row.title,
            row.x,
            row.y,
            row.width,
            row.height,
            row.background,
            row.border_color,
            row.z_index,
            row.created_at,
            row.updated_at
        ],
    )?;
    Ok(())
}

fn insert_span(
    tx: &Transaction<'_>,
    row: &MapAuthorshipSpanRow,
    ignore_conflict: bool,
) -> anyhow::Result<()> {
    let verb = if ignore_conflict {
        "INSERT OR IGNORE"
    } else {
        "INSERT"
    };
    tx.execute(
        &format!(
            "{verb} INTO authorship_spans
               (id, node_id, codex_entry_id, snippet_id, detail_value_id,
                sticky_id, from_pos, to_pos, source, model, timestamp,
                chat_msg_id, trace_id, phase_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"
        ),
        params![
            row.id,
            row.node_id,
            row.codex_entry_id,
            row.snippet_id,
            row.detail_value_id,
            row.sticky_id,
            row.from_pos,
            row.to_pos,
            row.source,
            row.model,
            row.timestamp,
            row.chat_msg_id,
            row.trace_id,
            row.phase_id
        ],
    )?;
    Ok(())
}

struct MapGraphRows<'a> {
    branches: &'a [MapAiBranchRow],
    stickies: &'a [MapStickyRow],
    positions: &'a [MapNodePositionRow],
    edges: &'a [MapEdgeRow],
    frames: &'a [MapFrameRow],
    spans: &'a [MapAuthorshipSpanRow],
}

fn validate_graph_rows(
    tx: &Transaction<'_>,
    project_id: &str,
    board_id: &str,
    rows: MapGraphRows<'_>,
) -> anyhow::Result<()> {
    let branch_ids: HashSet<&str> = rows.branches.iter().map(|row| row.id.as_str()).collect();
    let sticky_ids: HashSet<&str> = rows.stickies.iter().map(|row| row.id.as_str()).collect();
    let position_ids: HashSet<&str> = rows.positions.iter().map(|row| row.id.as_str()).collect();
    for row in rows.branches {
        ensure_row_board(&row.board_id, board_id, "AI branch")?;
    }
    for row in rows.stickies {
        ensure_row_board(&row.board_id, board_id, "sticky")?;
        if let Some(branch_id) = row.ai_branch_id.as_deref() {
            if !branch_ids.contains(branch_id) {
                anyhow::bail!("map sticky '{}' references a foreign AI branch", row.id);
            }
        }
    }
    for row in rows.positions {
        ensure_row_board(&row.board_id, board_id, "position")?;
        ensure_position_reference(tx, project_id, row, &sticky_ids, &branch_ids)?;
    }
    for row in rows.edges {
        ensure_row_board(&row.board_id, board_id, "edge")?;
        if !position_ids.contains(row.from_position_id.as_str())
            || !position_ids.contains(row.to_position_id.as_str())
        {
            anyhow::bail!("map edge '{}' references a foreign position", row.id);
        }
    }
    for row in rows.frames {
        ensure_row_board(&row.board_id, board_id, "frame")?;
    }
    for row in rows.spans {
        let sticky_id = row
            .sticky_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("map authorship span must belong to a sticky"))?;
        if !sticky_ids.contains(sticky_id) {
            anyhow::bail!(
                "map authorship span '{}' references a foreign sticky",
                row.id
            );
        }
    }
    Ok(())
}

fn create_board_bundle(tx: &Transaction<'_>, payload: &MapWritePayload) -> anyhow::Result<()> {
    let project_id = required(&payload.project_id, "projectId")?;
    ensure_project(tx, project_id)?;
    let board = payload
        .board
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("create-board requires board"))?;
    if board.project_id != project_id {
        anyhow::bail!("map board project does not match payload project");
    }
    validate_graph_rows(
        tx,
        project_id,
        &board.id,
        MapGraphRows {
            branches: &[],
            stickies: &payload.stickies,
            positions: &payload.positions,
            edges: &payload.edges,
            frames: &payload.frames,
            spans: &[],
        },
    )?;
    insert_board(tx, board)?;
    for row in &payload.stickies {
        insert_sticky(tx, row, false)?;
    }
    for row in &payload.positions {
        insert_position(tx, row, false)?;
    }
    for row in &payload.edges {
        insert_edge(tx, row, false)?;
    }
    for row in &payload.frames {
        insert_frame(tx, row, false)?;
    }
    Ok(())
}

fn create_or_restore_ai_branch(
    tx: &Transaction<'_>,
    payload: &MapWritePayload,
    restore: bool,
) -> anyhow::Result<()> {
    let project_id = required(&payload.project_id, "projectId")?;
    let branch = payload
        .branch
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("AI branch bundle requires branch"))?;
    ensure_board_project(tx, &branch.board_id, project_id)?;
    let branch_position = payload
        .branch_position
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("AI branch bundle requires branchPosition"))?;
    let mut positions = Vec::with_capacity(payload.positions.len() + 1);
    positions.push(branch_position.clone());
    positions.extend(payload.positions.iter().cloned());
    validate_graph_rows(
        tx,
        project_id,
        &branch.board_id,
        MapGraphRows {
            branches: std::slice::from_ref(branch),
            stickies: &payload.stickies,
            positions: &positions,
            edges: &payload.edges,
            frames: &[],
            spans: &payload.spans,
        },
    )?;

    insert_branch(tx, branch, restore)?;
    insert_position(tx, branch_position, restore)?;
    for row in &payload.stickies {
        insert_sticky(tx, row, restore)?;
    }
    if restore {
        for row in &payload.stickies {
            tx.execute(
                "UPDATE map_stickies SET ai_branch_id = ?1
                  WHERE id = ?2 AND board_id = ?3",
                params![branch.id, row.id, branch.board_id],
            )?;
        }
    }
    for row in &payload.positions {
        insert_position(tx, row, restore)?;
    }
    for row in &payload.edges {
        insert_edge(tx, row, restore)?;
    }
    for row in &payload.spans {
        insert_span(tx, row, restore)?;
    }
    Ok(())
}

fn promote_sticky(tx: &Transaction<'_>, payload: &MapWritePayload) -> anyhow::Result<()> {
    let project_id = required(&payload.project_id, "projectId")?;
    let board_id = required(&payload.board_id, "boardId")?;
    ensure_board_project(tx, board_id, project_id)?;
    let target_type = required(&payload.target_type, "targetType")?;
    let new_entity_id = required(&payload.new_entity_id, "newEntityId")?;
    let title = required(&payload.title, "title")?;
    let body = required(&payload.body, "body")?;
    let position_id = required(&payload.position_id, "positionId")?;
    let sticky_id = required(&payload.sticky_id, "stickyId")?;
    let created_at = required(&payload.created_at, "createdAt")?;
    let updated_at = required(&payload.updated_at, "updatedAt")?;

    let sticky_exists = tx
        .query_row(
            "SELECT 1 FROM map_stickies WHERE id = ?1 AND board_id = ?2",
            params![sticky_id, board_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    let position_exists = tx
        .query_row(
            "SELECT 1 FROM map_node_positions
              WHERE id = ?1 AND board_id = ?2 AND sticky_id = ?3",
            params![position_id, board_id, sticky_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    if !sticky_exists || !position_exists {
        anyhow::bail!("map sticky promotion target is stale or outside the board");
    }

    let (node_ref_type, tree_node_id, codex_entry_id, snippet_id) = match target_type {
        "scene" | "note" => {
            let sort_order = required(&payload.sort_order, "sortOrder")?;
            if let Some(parent_id) = payload.parent_id.as_deref() {
                let parent_exists = tx
                    .query_row(
                        "SELECT 1 FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
                        params![parent_id, project_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .is_some();
                if !parent_exists {
                    anyhow::bail!("map sticky promotion parent is outside project");
                }
            }
            tx.execute(
                "INSERT INTO tree_nodes
                   (id, project_id, parent_id, node_type, title, sort_order,
                    content, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    new_entity_id,
                    project_id,
                    payload.parent_id,
                    target_type,
                    title,
                    sort_order,
                    body,
                    created_at,
                    updated_at
                ],
            )?;
            (target_type.to_string(), Some(new_entity_id), None, None)
        }
        "snippet" => {
            tx.execute(
                "INSERT INTO snippets
                   (id, project_id, title, content, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    new_entity_id,
                    project_id,
                    title,
                    body,
                    created_at,
                    updated_at
                ],
            )?;
            ("snippet".to_string(), None, None, Some(new_entity_id))
        }
        "codex" => {
            let codex_type = required(&payload.codex_type, "codexType")?;
            tx.execute(
                "INSERT INTO codex_entries
                   (id, project_id, type, name, content, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    new_entity_id,
                    project_id,
                    codex_type,
                    title,
                    body,
                    created_at,
                    updated_at
                ],
            )?;
            ("codex".to_string(), None, Some(new_entity_id), None)
        }
        _ => anyhow::bail!("unsupported sticky promotion target '{target_type}'"),
    };

    tx.execute(
        "UPDATE map_node_positions
            SET node_ref_type = ?1, tree_node_id = ?2, codex_entry_id = ?3,
                snippet_id = ?4, sticky_id = NULL, ai_branch_id = NULL,
                updated_at = ?5
          WHERE id = ?6 AND board_id = ?7 AND sticky_id = ?8",
        params![
            node_ref_type,
            tree_node_id,
            codex_entry_id,
            snippet_id,
            updated_at,
            position_id,
            board_id,
            sticky_id
        ],
    )?;
    tx.execute(
        "UPDATE authorship_spans
            SET node_id = ?1, codex_entry_id = ?2, snippet_id = ?3,
                sticky_id = NULL
          WHERE sticky_id = ?4",
        params![tree_node_id, codex_entry_id, snippet_id, sticky_id],
    )?;
    tx.execute(
        "DELETE FROM map_stickies WHERE id = ?1 AND board_id = ?2",
        params![sticky_id, board_id],
    )?;
    Ok(())
}

fn erase_ai_branch(tx: &Transaction<'_>, payload: &MapWritePayload) -> anyhow::Result<()> {
    let project_id = required(&payload.project_id, "projectId")?;
    let branch_id = required(&payload.branch_id, "branchId")?;
    let board_id: String = tx
        .query_row(
            "SELECT branch.board_id
               FROM map_ai_branches branch
               JOIN map_boards board ON board.id = branch.board_id
              WHERE branch.id = ?1 AND board.project_id = ?2",
            params![branch_id, project_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("AI branch is outside project"))?;
    for id in &payload.span_ids {
        tx.execute(
            "DELETE FROM authorship_spans
              WHERE id = ?1 AND sticky_id IN (
                SELECT id FROM map_stickies
                 WHERE board_id = ?2 AND ai_branch_id = ?3
              )",
            params![id, board_id, branch_id],
        )?;
    }
    for id in &payload.sticky_position_ids {
        tx.execute(
            "DELETE FROM map_node_positions
              WHERE id = ?1 AND board_id = ?2 AND sticky_id IN (
                SELECT id FROM map_stickies
                 WHERE board_id = ?2 AND ai_branch_id = ?3
              )",
            params![id, board_id, branch_id],
        )?;
    }
    for id in &payload.sticky_ids {
        tx.execute(
            "DELETE FROM map_stickies
              WHERE id = ?1 AND board_id = ?2 AND ai_branch_id = ?3",
            params![id, board_id, branch_id],
        )?;
    }
    tx.execute(
        "DELETE FROM map_ai_branches WHERE id = ?1 AND board_id = ?2",
        params![branch_id, board_id],
    )?;
    Ok(())
}

fn extract_frame_to_codex(tx: &Transaction<'_>, payload: &MapWritePayload) -> anyhow::Result<()> {
    let project_id = required(&payload.project_id, "projectId")?;
    let board_id = required(&payload.board_id, "boardId")?;
    ensure_board_project(tx, board_id, project_id)?;
    let codex_id = required(&payload.codex_id, "codexId")?;
    let codex_type = required(&payload.codex_type, "codexType")?;
    let title = required(&payload.title, "title")?;
    let content = required(&payload.content, "content")?;
    let frame_id = required(&payload.frame_id, "frameId")?;
    let created_at = required(&payload.created_at, "createdAt")?;
    let updated_at = required(&payload.updated_at, "updatedAt")?;
    let frame_exists = tx
        .query_row(
            "SELECT 1 FROM map_frames WHERE id = ?1 AND board_id = ?2",
            params![frame_id, board_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    if !frame_exists {
        anyhow::bail!("map frame is stale or outside board");
    }
    for sticky_id in &payload.sticky_ids {
        let exists = tx
            .query_row(
                "SELECT 1 FROM map_stickies WHERE id = ?1 AND board_id = ?2",
                params![sticky_id, board_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if !exists {
            anyhow::bail!("map frame contains a foreign sticky");
        }
    }
    tx.execute(
        "INSERT INTO codex_entries
           (id, project_id, type, name, content, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![codex_id, project_id, codex_type, title, content, created_at, updated_at],
    )?;
    for sticky_id in &payload.sticky_ids {
        tx.execute(
            "UPDATE authorship_spans
                SET codex_entry_id = ?1, sticky_id = NULL
              WHERE sticky_id = ?2",
            params![codex_id, sticky_id],
        )?;
    }
    for sticky_id in &payload.sticky_ids {
        tx.execute(
            "DELETE FROM map_stickies WHERE id = ?1 AND board_id = ?2",
            params![sticky_id, board_id],
        )?;
    }
    tx.execute(
        "DELETE FROM map_frames WHERE id = ?1 AND board_id = ?2",
        params![frame_id, board_id],
    )?;
    anyhow::ensure!(
        payload.positions.len() == 1,
        "frame extraction requires exactly one Codex map position"
    );
    let position = &payload.positions[0];
    ensure_row_board(&position.board_id, board_id, "position")?;
    anyhow::ensure!(
        position.node_ref_type == "codex"
            && position.codex_entry_id.as_deref() == Some(codex_id)
            && position.tree_node_id.is_none()
            && position.snippet_id.is_none()
            && position.sticky_id.is_none()
            && position.ai_branch_id.is_none(),
        "frame extraction position must reference the created Codex entry"
    );
    ensure_position_reference(tx, project_id, position, &HashSet::new(), &HashSet::new())?;
    insert_position(tx, position, false)?;
    Ok(())
}

fn promote_user_edge_to_codex_relation(
    tx: &Transaction<'_>,
    payload: &MapWritePayload,
) -> anyhow::Result<()> {
    let project_id = required(&payload.project_id, "projectId")?;
    let board_id = required(&payload.board_id, "boardId")?;
    let edge_id = required(&payload.edge_id, "edgeId")?;
    let relation_id = required(&payload.relation_id, "relationId")?;
    let from_codex_id = required(&payload.from_codex_id, "fromCodexId")?;
    let to_codex_id = required(&payload.to_codex_id, "toCodexId")?;
    let relation_type = required(&payload.relation_type, "relationType")?;
    let forward_label = normalize_relation_label(required(&payload.label, "label")?);
    let created_at = required(&payload.created_at, "createdAt")?;
    let updated_at = required(&payload.updated_at, "updatedAt")?;
    anyhow::ensure!(
        from_codex_id != to_codex_id,
        "map relation endpoints must differ"
    );
    anyhow::ensure!(
        !forward_label.is_empty(),
        "map relation label must not be empty"
    );
    ensure_board_project(tx, board_id, project_id)?;

    let edge_endpoints = tx
        .query_row(
            "SELECT edge.from_position_id, edge.to_position_id
               FROM map_edges edge
              WHERE edge.id = ?1 AND edge.board_id = ?2",
            params![edge_id, board_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("map edge is stale or outside board"))?;
    let position_codex_id = |position_id: &str| -> anyhow::Result<String> {
        tx.query_row(
            "SELECT position.codex_entry_id
               FROM map_node_positions position
               JOIN codex_entries entry ON entry.id = position.codex_entry_id
              WHERE position.id = ?1
                AND position.board_id = ?2
                AND position.node_ref_type = 'codex'
                AND entry.project_id = ?3",
            params![position_id, board_id, project_id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("map edge endpoint is not a Codex entry in this project"))
    };
    let actual_from = position_codex_id(&edge_endpoints.0)?;
    let actual_to = position_codex_id(&edge_endpoints.1)?;
    anyhow::ensure!(
        actual_from == from_codex_id && actual_to == to_codex_id,
        "map relation endpoints do not match the authoritative edge"
    );

    if payload.reuse_existing_relation {
        let valid_existing = tx
            .query_row(
                "SELECT 1
                   FROM codex_relations
                  WHERE id = ?1 AND project_id = ?2 AND relation_type = ?3
                    AND ((from_codex_id = ?4 AND to_codex_id = ?5)
                      OR (from_codex_id = ?5 AND to_codex_id = ?4))",
                params![
                    relation_id,
                    project_id,
                    relation_type,
                    from_codex_id,
                    to_codex_id
                ],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        anyhow::ensure!(
            valid_existing,
            "reused Codex relation is stale or outside the project"
        );
    } else {
        let semantic_key = build_codex_relation_semantic_key(
            project_id,
            from_codex_id,
            to_codex_id,
            relation_type,
            "directed",
            &forward_label,
            None,
        );
        tx.execute(
            "INSERT INTO codex_relations
                (id, project_id, from_codex_id, to_codex_id, relation_type, label,
                 directionality, inverse_label, semantic_key, version,
                 source_map_edge_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'directed', NULL, ?7, 1, ?8, ?9, ?10)",
            params![
                relation_id,
                project_id,
                from_codex_id,
                to_codex_id,
                relation_type,
                forward_label,
                semantic_key,
                edge_id,
                created_at,
                updated_at,
            ],
        )?;
        crate::narrative_extraction::record_human_field_write(
            tx,
            project_id,
            "codex-relation",
            relation_id,
            &[
                "/fromCodexId",
                "/toCodexId",
                "/relationType",
                "/directionality",
                "/forwardLabel",
                "/inverseLabel",
                "/semanticKey",
            ],
            updated_at,
        )?;
    }

    let deleted = tx.execute(
        "DELETE FROM map_edges WHERE id = ?1 AND board_id = ?2",
        params![edge_id, board_id],
    )?;
    anyhow::ensure!(deleted == 1, "map edge was not deleted");
    Ok(())
}

fn map_component_key(kind: &str, id: &str) -> Value {
    json!({
        "kind": "component",
        "componentId": format!("map-{kind}:{id}"),
    })
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct MapFeedState {
    board: Option<Value>,
    branch: Option<Value>,
    target_entity: Option<Value>,
    sticky: Option<Value>,
    codex: Option<Value>,
    frame: Option<Value>,
    position: Option<Value>,
    edge: Option<Value>,
    relation: Option<Value>,
}

impl MapFeedState {
    fn is_empty(&self) -> bool {
        self.board.is_none()
            && self.branch.is_none()
            && self.target_entity.is_none()
            && self.sticky.is_none()
            && self.codex.is_none()
            && self.frame.is_none()
            && self.position.is_none()
            && self.edge.is_none()
            && self.relation.is_none()
    }

    fn journal_json(&self) -> anyhow::Result<Option<String>> {
        if self.is_empty() {
            Ok(None)
        } else {
            Ok(Some(serde_json::to_string(self)?))
        }
    }
}

fn map_write_cause(origin: NarrativeChangeOrigin) -> NarrativeChangeCauseKind {
    match origin {
        NarrativeChangeOrigin::Undo => NarrativeChangeCauseKind::Undo,
        NarrativeChangeOrigin::Redo => NarrativeChangeCauseKind::Redo,
        _ => NarrativeChangeCauseKind::Forward,
    }
}

fn validate_map_write_lineage(payload: &MapWritePayload) -> anyhow::Result<()> {
    let replay = matches!(
        payload.origin,
        NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
    );
    let original = payload
        .original_transaction_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let undo_journal = payload
        .undo_journal_id
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    anyhow::ensure!(
        replay == (original.is_some() && undo_journal.is_some())
            && (replay
                || (payload.original_transaction_id.is_none()
                    && payload.undo_journal_id.is_none())),
        "map undo/redo requires originalTransactionId and undoJournalId; forward writes forbid replay lineage"
    );
    Ok(())
}

fn load_map_feed_snapshot(
    tx: &Transaction<'_>,
    sql: &str,
    params: &[&str],
) -> anyhow::Result<Option<Value>> {
    let params = params
        .iter()
        .map(|value| Value::String((*value).to_string()))
        .collect::<Vec<_>>();
    Ok(Database::execute_with_conn(tx, sql, &params, "get")?
        .into_iter()
        .next()
        .map(Value::Object))
}

fn capture_map_feed_state(
    tx: &Transaction<'_>,
    payload: &MapWritePayload,
) -> anyhow::Result<MapFeedState> {
    let project_id = required(&payload.project_id, "projectId")?;
    let mut state = MapFeedState::default();
    match payload.kind.as_str() {
        "create-board" => {
            let board = payload
                .board
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("create-board requires board"))?;
            state.board = load_map_feed_snapshot(
                tx,
                "SELECT * FROM map_boards WHERE id = ?1 AND project_id = ?2",
                &[&board.id, project_id],
            )?;
        }
        "create-ai-branch" | "restore-ai-branch" => {
            let branch = payload
                .branch
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("AI branch bundle requires branch"))?;
            state.branch = load_map_feed_snapshot(
                tx,
                "SELECT branch.*
                   FROM map_ai_branches branch
                   JOIN map_boards board ON board.id = branch.board_id
                  WHERE branch.id = ?1 AND board.project_id = ?2",
                &[&branch.id, project_id],
            )?;
        }
        "erase-ai-branch" => {
            state.branch = load_map_feed_snapshot(
                tx,
                "SELECT branch.*
                   FROM map_ai_branches branch
                   JOIN map_boards board ON board.id = branch.board_id
                  WHERE branch.id = ?1 AND board.project_id = ?2",
                &[required(&payload.branch_id, "branchId")?, project_id],
            )?;
        }
        "promote-sticky" => {
            state.sticky = load_map_feed_snapshot(
                tx,
                "SELECT sticky.*
                   FROM map_stickies sticky
                   JOIN map_boards board ON board.id = sticky.board_id
                  WHERE sticky.id = ?1 AND board.project_id = ?2",
                &[required(&payload.sticky_id, "stickyId")?, project_id],
            )?;
            let entity_id = required(&payload.new_entity_id, "newEntityId")?;
            state.target_entity = match required(&payload.target_type, "targetType")? {
                "scene" => crate::canonical_feed_snapshots::canonical_scene_snapshot(
                    tx, project_id, entity_id,
                )
                .ok(),
                "note" => crate::canonical_feed_snapshots::canonical_tree_node_snapshot(
                    tx, project_id, entity_id,
                )
                .ok(),
                "snippet" => crate::canonical_feed_snapshots::canonical_snippet_snapshot(
                    tx, project_id, entity_id,
                )
                .ok(),
                "codex" => crate::canonical_feed_snapshots::canonical_codex_entry_snapshot(
                    tx, project_id, entity_id,
                )
                .ok(),
                other => anyhow::bail!("unsupported promote target '{other}'"),
            };
        }
        "extract-frame-to-codex" => {
            let board_id = required(&payload.board_id, "boardId")?;
            state.codex = crate::canonical_feed_snapshots::canonical_codex_entry_snapshot(
                tx,
                project_id,
                required(&payload.codex_id, "codexId")?,
            )
            .ok();
            state.frame = load_map_feed_snapshot(
                tx,
                "SELECT * FROM map_frames WHERE id = ?1 AND board_id = ?2",
                &[required(&payload.frame_id, "frameId")?, board_id],
            )?;
            let position = payload
                .positions
                .first()
                .ok_or_else(|| anyhow::anyhow!("frame extraction requires a map position"))?;
            state.position = load_map_feed_snapshot(
                tx,
                "SELECT * FROM map_node_positions WHERE id = ?1 AND board_id = ?2",
                &[&position.id, board_id],
            )?;
        }
        "promote-user-edge-to-codex-relation" => {
            let board_id = required(&payload.board_id, "boardId")?;
            state.edge = load_map_feed_snapshot(
                tx,
                "SELECT * FROM map_edges WHERE id = ?1 AND board_id = ?2",
                &[required(&payload.edge_id, "edgeId")?, board_id],
            )?;
            state.relation = crate::canonical_feed_snapshots::canonical_codex_relation_snapshot(
                tx,
                project_id,
                required(&payload.relation_id, "relationId")?,
            )
            .ok();
        }
        other => anyhow::bail!("unsupported map write kind '{other}'"),
    }
    Ok(state)
}

fn map_snapshot_version(snapshot: Option<&Value>) -> Option<i64> {
    snapshot
        .and_then(Value::as_object)
        .and_then(|row| row.get("version"))
        .and_then(Value::as_i64)
}

fn map_feed_event(
    object_key: Value,
    change_kind: &str,
    mutation_kind: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    changed_paths: Vec<String>,
) -> anyhow::Result<NarrativeChangeEventInput> {
    let before_digest = before.map(narrative_snapshot_digest).transpose()?;
    let after_digest = after.map(narrative_snapshot_digest).transpose()?;
    if mutation_kind == "update" {
        anyhow::ensure!(
            before_digest != after_digest,
            "map Feed update must describe a changed snapshot"
        );
    }
    Ok(NarrativeChangeEventInput {
        object_key,
        change_kind: change_kind.to_string(),
        mutation_kind: mutation_kind.to_string(),
        before_version: map_snapshot_version(before),
        before_digest,
        after_version: map_snapshot_version(after),
        after_digest,
        structural_impact: Some(json!({ "changedPaths": changed_paths })),
        changed_paths,
        text_impact: None,
    })
}

fn map_feed_events(
    payload: &MapWritePayload,
    before: &MapFeedState,
    after: &MapFeedState,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    let events = match payload.kind.as_str() {
        "create-board" => {
            let board = payload
                .board
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("create-board requires board"))?;
            vec![map_feed_event(
                map_component_key("board", &board.id),
                "association",
                "create",
                None,
                after.board.as_ref(),
                vec!["/".to_string()],
            )?]
        }
        "create-ai-branch" | "restore-ai-branch" => {
            let branch = payload
                .branch
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("AI branch bundle requires branch"))?;
            vec![map_feed_event(
                map_component_key("ai-branch", &branch.id),
                "association",
                if payload.kind == "restore-ai-branch" {
                    "restore"
                } else {
                    "create"
                },
                None,
                after.branch.as_ref(),
                vec!["/".to_string()],
            )?]
        }
        "erase-ai-branch" => vec![map_feed_event(
            map_component_key("ai-branch", required(&payload.branch_id, "branchId")?),
            "association",
            "delete",
            before.branch.as_ref(),
            None,
            vec!["/".to_string()],
        )?],
        "promote-sticky" => {
            let target_type = required(&payload.target_type, "targetType")?;
            let entity_id = required(&payload.new_entity_id, "newEntityId")?;
            let object_key = match target_type {
                "scene" => narrative_object_key("scene", entity_id),
                "codex" => narrative_object_key("codex_entry", entity_id),
                "note" | "snippet" => map_component_key(target_type, entity_id),
                _ => anyhow::bail!("unsupported promote target '{target_type}'"),
            };
            vec![
                map_feed_event(
                    object_key,
                    if target_type == "codex" {
                        "catalog"
                    } else {
                        "content"
                    },
                    "create",
                    None,
                    after.target_entity.as_ref(),
                    vec!["/".to_string()],
                )?,
                map_feed_event(
                    map_component_key("sticky", required(&payload.sticky_id, "stickyId")?),
                    "association",
                    "delete",
                    before.sticky.as_ref(),
                    None,
                    vec!["/".to_string()],
                )?,
            ]
        }
        "extract-frame-to-codex" => {
            let position = payload
                .positions
                .first()
                .ok_or_else(|| anyhow::anyhow!("frame extraction requires a map position"))?;
            vec![
                map_feed_event(
                    narrative_object_key("codex_entry", required(&payload.codex_id, "codexId")?),
                    "catalog",
                    "create",
                    None,
                    after.codex.as_ref(),
                    vec!["/".to_string()],
                )?,
                map_feed_event(
                    map_component_key("frame", required(&payload.frame_id, "frameId")?),
                    "association",
                    "delete",
                    before.frame.as_ref(),
                    None,
                    vec!["/".to_string()],
                )?,
                map_feed_event(
                    map_component_key("position", &position.id),
                    "association",
                    "create",
                    None,
                    after.position.as_ref(),
                    vec!["/".to_string()],
                )?,
            ]
        }
        "promote-user-edge-to-codex-relation" => {
            let mut events = Vec::new();
            if !payload.reuse_existing_relation {
                events.push(map_feed_event(
                    json!({
                        "kind": "codex-relation",
                        "relationId": required(&payload.relation_id, "relationId")?,
                    }),
                    "association",
                    "create",
                    None,
                    after.relation.as_ref(),
                    vec!["/".to_string()],
                )?);
            }
            events.push(map_feed_event(
                map_component_key("edge", required(&payload.edge_id, "edgeId")?),
                "association",
                "delete",
                before.edge.as_ref(),
                None,
                vec!["/".to_string()],
            )?);
            events
        }
        other => anyhow::bail!("unsupported map write kind '{other}'"),
    };
    Ok(events)
}

fn map_root_entity(payload: &MapWritePayload) -> anyhow::Result<(&'static str, &str)> {
    match payload.kind.as_str() {
        "create-board" => Ok((
            "map_board",
            &payload
                .board
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("create-board requires board"))?
                .id,
        )),
        "create-ai-branch" | "restore-ai-branch" => Ok((
            "map_ai_branch",
            &payload
                .branch
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("AI branch bundle requires branch"))?
                .id,
        )),
        "erase-ai-branch" => Ok(("map_ai_branch", required(&payload.branch_id, "branchId")?)),
        "promote-sticky" => Ok((
            "map_promotion",
            required(&payload.new_entity_id, "newEntityId")?,
        )),
        "extract-frame-to-codex" => Ok(("map_extraction", required(&payload.codex_id, "codexId")?)),
        "promote-user-edge-to-codex-relation" => Ok((
            "map_relation_promotion",
            required(&payload.relation_id, "relationId")?,
        )),
        other => anyhow::bail!("unsupported map write kind '{other}'"),
    }
}

pub fn apply_map_write(db: &Database, payload: MapWritePayload) -> anyhow::Result<Value> {
    require_non_empty(&payload.kind, "kind")?;
    require_non_empty(&payload.request_id, "requestId")?;
    require_non_empty(&payload.session_id, "sessionId")?;
    require_non_empty(&payload.event_uid, "eventUid")?;
    validate_map_write_lineage(&payload)?;
    let project_id = required(&payload.project_id, "projectId")?.to_string();
    let mut fingerprint_payload = payload.clone();
    fingerprint_payload.session_id.clear();
    fingerprint_payload.event_uid.clear();
    let request_hash = payload_fingerprint("map_write_bundle", &fingerprint_payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "map_write_bundle",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "MAP_WRITE_REQUEST_CONFLICT",
    };
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(response) = load_idempotent_response(&tx, &idempotency_request)? {
            tx.commit()?;
            return Ok(response);
        }
        if matches!(
            payload.origin,
            NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
        ) {
            require_replay_lineage_in_project(
                &tx,
                &project_id,
                payload
                    .original_transaction_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("originalTransactionId is required"))?,
                payload
                    .undo_journal_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("undoJournalId is required"))?,
            )?;
        }
        let before_feed_state = capture_map_feed_state(&tx, &payload)?;
        match payload.kind.as_str() {
            "create-board" => create_board_bundle(&tx, &payload)?,
            "create-ai-branch" => create_or_restore_ai_branch(&tx, &payload, false)?,
            "restore-ai-branch" => create_or_restore_ai_branch(&tx, &payload, true)?,
            "erase-ai-branch" => erase_ai_branch(&tx, &payload)?,
            "promote-sticky" => promote_sticky(&tx, &payload)?,
            "extract-frame-to-codex" => extract_frame_to_codex(&tx, &payload)?,
            "promote-user-edge-to-codex-relation" => {
                promote_user_edge_to_codex_relation(&tx, &payload)?
            }
            _ => anyhow::bail!("unsupported map write kind '{}'", payload.kind),
        }
        let after_feed_state = capture_map_feed_state(&tx, &payload)?;
        let operation = format!("map.{}", payload.kind.replace('-', "."));
        let timestamp = chrono::Utc::now().timestamp_millis();
        let occurred_at = chrono::DateTime::from_timestamp_millis(timestamp)
            .ok_or_else(|| anyhow::anyhow!("map writer timestamp is outside the supported range"))?
            .to_rfc3339();
        let (entity_type, entity_id) = map_root_entity(&payload)?;
        let undo_journal_id = payload
            .undo_journal_id
            .clone()
            .unwrap_or_else(|| payload.request_id.clone());
        if !matches!(
            payload.origin,
            NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
        ) {
            let before_json = before_feed_state.journal_json()?;
            let after_json = after_feed_state.journal_json()?;
            insert_undo_journal_in_tx(
                &tx,
                UndoJournalInsert {
                    id: &undo_journal_id,
                    project_id: &project_id,
                    surface: "map",
                    entity_kind: entity_type,
                    entity_id,
                    op_kind: &payload.kind,
                    before_json: before_json.as_deref(),
                    after_json: after_json.as_deref(),
                    base_version: 0,
                    result_version: 1,
                    change_event_uid: Some(&payload.event_uid),
                },
            )?;
        }
        let events = map_feed_events(&payload, &before_feed_state, &after_feed_state)?;
        let append = append_canonical_and_narrative_change_in_tx(
            &tx,
            &project_id,
            &payload.session_id,
            &AppendChangeEvent {
                event_uid: payload.event_uid.clone(),
                scene_id: None,
                domain: "map".to_string(),
                op_type: operation.clone(),
                entity_type: Some(entity_type.to_string()),
                entity_id: Some(entity_id.to_string()),
                payload: json!({
                    "kind": payload.kind,
                    "requestId": payload.request_id,
                })
                .to_string(),
                timestamp,
            },
            &AppendNarrativeChangeTransactionInput {
                project_id: project_id.clone(),
                request_id: payload.request_id.clone(),
                source_domain: operation,
                source_change_event_uid: payload.event_uid.clone(),
                cause_kind: map_write_cause(payload.origin),
                origin: payload.origin,
                original_transaction_id: payload.original_transaction_id.clone(),
                commit_id: None,
                journal_id: None,
                undo_journal_id: Some(undo_journal_id.clone()),
                application_ids: Vec::new(),
                occurred_at,
                events,
            },
        )?;
        let response = json!({
            "changeEventUid": payload.event_uid,
            "maintenanceTransactionId": append.narrative.transaction_id,
            "undoJournalId": undo_journal_id,
        });
        insert_idempotent_response(&tx, &idempotency_request, &project_id, &response)?;
        tx.commit()?;
        Ok(response)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row_snapshot_digest(db: &Database, sql: &str, params: &[&str]) -> String {
        db.with_conn(|conn| {
            let params = params
                .iter()
                .map(|value| Value::String((*value).to_string()))
                .collect::<Vec<_>>();
            let snapshot = Database::execute_with_conn(conn, sql, &params, "get")?
                .into_iter()
                .next()
                .map(Value::Object)
                .ok_or_else(|| anyhow::anyhow!("expected snapshot row"))?;
            narrative_snapshot_digest(&snapshot)
        })
        .expect("digest snapshot row")
    }

    fn canonical_codex_digest(db: &Database, project_id: &str, entry_id: &str) -> String {
        db.with_conn(|conn| {
            let snapshot = crate::canonical_feed_snapshots::canonical_codex_entry_snapshot(
                conn, project_id, entry_id,
            )?;
            narrative_snapshot_digest(&snapshot)
        })
        .expect("digest canonical Codex snapshot")
    }

    fn canonical_relation_digest(db: &Database, project_id: &str, relation_id: &str) -> String {
        db.with_conn(|conn| {
            let snapshot = crate::canonical_feed_snapshots::canonical_codex_relation_snapshot(
                conn,
                project_id,
                relation_id,
            )?;
            narrative_snapshot_digest(&snapshot)
        })
        .expect("digest canonical relation snapshot")
    }

    fn fixture() -> Database {
        let db = crate::test_support::current_schema_memory().expect("current-schema fixture");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects (id, title) VALUES ('p1', 'One'), ('p2', 'Two');
                 INSERT OR IGNORE INTO codex_types (id, project_id, slug, label)
                   VALUES ('type-p1', 'p1', 'character', 'Character');
                 INSERT INTO map_boards (id, project_id, title)
                   VALUES ('board-1', 'p1', 'Board'), ('board-2', 'p2', 'Foreign');
                 INSERT INTO map_stickies
                   (id, board_id, title, body, palette_id, color_slot)
                   VALUES ('sticky-1', 'board-1', 'Idea', '{}', 'post-it-playful', 0);
                 INSERT INTO map_node_positions
                   (id, board_id, node_ref_type, sticky_id, x, y)
                   VALUES ('position-1', 'board-1', 'sticky', 'sticky-1', 10, 20);",
            )?;
            Ok(())
        })
        .expect("seed database");
        db
    }

    #[test]
    fn sticky_promotion_migrates_position_and_deletes_source_atomically() {
        let db = fixture();
        let payload = MapWritePayload {
            kind: "promote-sticky".to_string(),
            request_id: "req-promote-1".to_string(),
            session_id: "session-map".to_string(),
            event_uid: "event-promote-1".to_string(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            project_id: Some("p1".to_string()),
            board_id: Some("board-1".to_string()),
            target_type: Some("codex".to_string()),
            new_entity_id: Some("codex-1".to_string()),
            title: Some("Idea".to_string()),
            body: Some("{}".to_string()),
            codex_type: Some("character".to_string()),
            position_id: Some("position-1".to_string()),
            sticky_id: Some("sticky-1".to_string()),
            created_at: Some("now".to_string()),
            updated_at: Some("now".to_string()),
            board: None,
            branch: None,
            branch_position: None,
            stickies: vec![],
            positions: vec![],
            edges: vec![],
            frames: vec![],
            spans: vec![],
            parent_id: None,
            sort_order: None,
            branch_id: None,
            span_ids: vec![],
            sticky_position_ids: vec![],
            sticky_ids: vec![],
            codex_id: None,
            frame_id: None,
            content: None,
            edge_id: None,
            relation_id: None,
            from_codex_id: None,
            to_codex_id: None,
            relation_type: None,
            label: None,
            reuse_existing_relation: false,
        };
        apply_map_write(&db, payload.clone()).expect("promote sticky");
        let mut replay = payload;
        replay.session_id = "map-session-after-restart".to_string();
        replay.event_uid = "map-event-after-restart".to_string();
        apply_map_write(&db, replay).expect("cross-session retry promote sticky");
        db.with_conn(|conn| {
            let codex_id: String = conn.query_row(
                "SELECT codex_entry_id FROM map_node_positions WHERE id = 'position-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(codex_id, "codex-1");
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM map_stickies WHERE id = 'sticky-1'",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            let feed_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE project_id = 'p1' AND request_id = 'req-promote-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(feed_count, 1);
            let event_keys = conn
                .prepare(
                    "SELECT object_key_json
                       FROM narrative_change_events
                      WHERE project_id = 'p1'
                      ORDER BY event_ordinal",
                )?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(
                event_keys,
                vec![
                    r#"{"kind":"codex-entry","entryId":"codex-1"}"#.to_string(),
                    r#"{"kind":"component","componentId":"map-sticky:sticky-1"}"#.to_string(),
                ]
            );
            Ok(())
        })
        .expect("read promotion");
    }

    #[test]
    fn sticky_promotion_rejects_cross_project_board() {
        let db = fixture();
        let payload_json = serde_json::json!({
            "kind": "promote-sticky",
            "requestId": "req-cross-project",
            "sessionId": "session-map",
            "eventUid": "event-cross-project",
            "projectId": "p2",
            "boardId": "board-1",
            "targetType": "codex",
            "newEntityId": "leak",
            "title": "Leak",
            "body": "{}",
            "codexType": "character",
            "positionId": "position-1",
            "stickyId": "sticky-1",
            "createdAt": "now",
            "updatedAt": "now"
        });
        let payload: MapWritePayload =
            serde_json::from_value(payload_json).expect("decode payload");
        assert!(apply_map_write(&db, payload).is_err());
    }

    #[test]
    fn feed_append_failure_rolls_back_map_domain_mutation() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_map_feed
                   BEFORE INSERT ON narrative_change_transactions
                   BEGIN SELECT RAISE(ABORT, 'forced map feed failure'); END;",
            )?;
            Ok(())
        })
        .expect("install failure trigger");
        let payload: MapWritePayload = serde_json::from_value(json!({
            "kind": "promote-sticky",
            "requestId": "req-feed-failure",
            "sessionId": "session-map",
            "eventUid": "event-feed-failure",
            "projectId": "p1",
            "boardId": "board-1",
            "targetType": "codex",
            "newEntityId": "codex-feed-failure",
            "title": "Rollback",
            "body": "{}",
            "codexType": "character",
            "positionId": "position-1",
            "stickyId": "sticky-1",
            "createdAt": "now",
            "updatedAt": "now"
        }))
        .expect("decode payload");
        assert!(apply_map_write(&db, payload).is_err());
        db.with_conn(|conn| {
            let codex_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM codex_entries WHERE id = 'codex-feed-failure'",
                [],
                |row| row.get(0),
            )?;
            let sticky_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM map_stickies WHERE id = 'sticky-1'",
                [],
                |row| row.get(0),
            )?;
            let canonical_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM change_events WHERE event_uid = 'event-feed-failure'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!((codex_count, sticky_count, canonical_count), (0, 1, 0));
            Ok(())
        })
        .expect("verify rollback");
    }

    fn seed_codex_edge(db: &Database) {
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO codex_entries (id, project_id, type, name)
                   VALUES ('codex-from', 'p1', 'character', 'From'),
                          ('codex-to', 'p1', 'character', 'To');
                 INSERT INTO map_node_positions
                   (id, board_id, node_ref_type, codex_entry_id, x, y)
                   VALUES ('position-from', 'board-1', 'codex', 'codex-from', 0, 0),
                          ('position-to', 'board-1', 'codex', 'codex-to', 100, 0);
                 INSERT INTO map_edges
                   (id, board_id, from_position_id, to_position_id, forward_label)
                   VALUES ('edge-promote', 'board-1', 'position-from', 'position-to', 'Mentor');",
            )?;
            Ok(())
        })
        .expect("seed Codex edge");
    }

    fn relation_promotion_payload() -> MapWritePayload {
        serde_json::from_value(json!({
            "kind": "promote-user-edge-to-codex-relation",
            "requestId": "req-edge-promotion",
            "sessionId": "session-map",
            "eventUid": "event-edge-promotion",
            "projectId": "p1",
            "boardId": "board-1",
            "edgeId": "edge-promote",
            "relationId": "relation-promoted",
            "fromCodexId": "codex-from",
            "toCodexId": "codex-to",
            "relationType": "mentor",
            "label": "Mentor",
            "reuseExistingRelation": false,
            "createdAt": "now",
            "updatedAt": "now"
        }))
        .expect("decode relation promotion")
    }

    #[test]
    fn user_edge_promotion_is_atomic_idempotent_and_deterministically_ordered() {
        let db = fixture();
        seed_codex_edge(&db);
        let edge_before_digest = row_snapshot_digest(
            &db,
            "SELECT * FROM map_edges WHERE id = ?1 AND board_id = ?2",
            &["edge-promote", "board-1"],
        );
        let payload = relation_promotion_payload();
        apply_map_write(&db, payload.clone()).expect("promote edge");
        let mut retry = payload;
        retry.session_id = "session-after-restart".to_string();
        retry.event_uid = "event-after-restart".to_string();
        apply_map_write(&db, retry).expect("retry promotion");
        let relation_after_digest = canonical_relation_digest(&db, "p1", "relation-promoted");

        db.with_conn(|conn| {
            let relation_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM codex_relations
                  WHERE id = 'relation-promoted' AND project_id = 'p1'",
                [],
                |row| row.get(0),
            )?;
            let edge_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM map_edges WHERE id = 'edge-promote'",
                [],
                |row| row.get(0),
            )?;
            let canonical_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM change_events
                  WHERE event_uid = 'event-edge-promotion'",
                [],
                |row| row.get(0),
            )?;
            let transaction_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE request_id = 'req-edge-promotion'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!((relation_count, edge_count), (1, 0));
            assert_eq!((canonical_count, transaction_count), (1, 1));
            let event_keys = conn
                .prepare(
                    "SELECT object_key_json FROM narrative_change_events
                      WHERE transaction_id = (
                        SELECT id FROM narrative_change_transactions
                         WHERE request_id = 'req-edge-promotion'
                      )
                      ORDER BY event_ordinal",
                )?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(
                event_keys,
                vec![
                    r#"{"kind":"codex-relation","relationId":"relation-promoted"}"#.to_string(),
                    r#"{"kind":"component","componentId":"map-edge:edge-promote"}"#.to_string(),
                ]
            );
            let event_digests = conn
                .prepare(
                    "SELECT before_digest, after_digest
                       FROM narrative_change_events
                      WHERE transaction_id = (
                        SELECT id FROM narrative_change_transactions
                         WHERE request_id = 'req-edge-promotion'
                      )
                      ORDER BY event_ordinal",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(
                event_digests,
                vec![
                    (None, Some(relation_after_digest)),
                    (Some(edge_before_digest.clone()), None),
                ]
            );
            Ok(())
        })
        .expect("inspect edge promotion");
    }

    #[test]
    fn user_edge_promotion_rejects_cross_project_scope_without_mutating() {
        let db = fixture();
        seed_codex_edge(&db);
        let mut payload = relation_promotion_payload();
        payload.project_id = Some("p2".to_string());
        assert!(apply_map_write(&db, payload).is_err());
        db.with_conn(|conn| {
            let relation_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM codex_relations WHERE id = 'relation-promoted'",
                [],
                |row| row.get(0),
            )?;
            let edge_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM map_edges WHERE id = 'edge-promote'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!((relation_count, edge_count), (0, 1));
            Ok(())
        })
        .expect("inspect rejected promotion");
    }

    #[test]
    fn edge_promotion_feed_failure_rolls_back_relation_and_edge_delete() {
        let db = fixture();
        seed_codex_edge(&db);
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_edge_promotion_feed
                   BEFORE INSERT ON narrative_change_transactions
                   BEGIN SELECT RAISE(ABORT, 'forced edge promotion feed failure'); END;",
            )?;
            Ok(())
        })
        .expect("install failure trigger");
        assert!(apply_map_write(&db, relation_promotion_payload()).is_err());
        db.with_conn(|conn| {
            let relation_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM codex_relations WHERE id = 'relation-promoted'",
                [],
                |row| row.get(0),
            )?;
            let edge_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM map_edges WHERE id = 'edge-promote'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!((relation_count, edge_count), (0, 1));
            Ok(())
        })
        .expect("inspect Feed rollback");
    }

    #[test]
    fn frame_extraction_creates_codex_position_in_the_same_feed_transaction() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO map_frames
                   (id, board_id, title, x, y, width, height)
                 VALUES ('frame-extract', 'board-1', 'Arc', 0, 0, 400, 300)",
                [],
            )?;
            Ok(())
        })
        .expect("seed frame");
        let frame_before_digest = row_snapshot_digest(
            &db,
            "SELECT * FROM map_frames WHERE id = ?1 AND board_id = ?2",
            &["frame-extract", "board-1"],
        );
        let payload: MapWritePayload = serde_json::from_value(json!({
            "kind": "extract-frame-to-codex",
            "requestId": "req-frame-extract",
            "sessionId": "session-map",
            "eventUid": "event-frame-extract",
            "projectId": "p1",
            "boardId": "board-1",
            "codexId": "codex-frame",
            "codexType": "character",
            "title": "Arc",
            "content": "{}",
            "frameId": "frame-extract",
            "stickyIds": ["sticky-1"],
            "positions": [{
                "id": "position-frame-codex",
                "boardId": "board-1",
                "nodeRefType": "codex",
                "treeNodeId": null,
                "codexEntryId": "codex-frame",
                "snippetId": null,
                "stickyId": null,
                "aiBranchId": null,
                "x": 200,
                "y": 150,
                "pinned": 0,
                "zIndex": 0,
                "createdAt": "now",
                "updatedAt": "now"
            }],
            "createdAt": "now",
            "updatedAt": "now"
        }))
        .expect("decode frame extraction");
        apply_map_write(&db, payload).expect("extract frame");
        let codex_after_digest = canonical_codex_digest(&db, "p1", "codex-frame");
        let position_after_digest = row_snapshot_digest(
            &db,
            "SELECT * FROM map_node_positions WHERE id = ?1 AND board_id = ?2",
            &["position-frame-codex", "board-1"],
        );
        db.with_conn(|conn| {
            let position_codex: String = conn.query_row(
                "SELECT codex_entry_id FROM map_node_positions
                  WHERE id = 'position-frame-codex'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(position_codex, "codex-frame");
            let event_keys = conn
                .prepare(
                    "SELECT object_key_json FROM narrative_change_events
                      WHERE transaction_id = (
                        SELECT id FROM narrative_change_transactions
                         WHERE request_id = 'req-frame-extract'
                      )
                      ORDER BY event_ordinal",
                )?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(
                event_keys,
                vec![
                    r#"{"kind":"codex-entry","entryId":"codex-frame"}"#.to_string(),
                    r#"{"kind":"component","componentId":"map-frame:frame-extract"}"#.to_string(),
                    r#"{"kind":"component","componentId":"map-position:position-frame-codex"}"#
                        .to_string(),
                ]
            );
            let event_digests = conn
                .prepare(
                    "SELECT before_digest, after_digest
                       FROM narrative_change_events
                      WHERE transaction_id = (
                        SELECT id FROM narrative_change_transactions
                         WHERE request_id = 'req-frame-extract'
                      )
                      ORDER BY event_ordinal",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(
                event_digests,
                vec![
                    (None, Some(codex_after_digest)),
                    (Some(frame_before_digest.clone()), None),
                    (None, Some(position_after_digest)),
                ]
            );
            Ok(())
        })
        .expect("inspect frame extraction");
    }

    #[test]
    fn map_feed_update_rejects_an_unchanged_snapshot_digest() {
        let snapshot = json!({ "id": "same", "value": "unchanged" });
        let result = map_feed_event(
            map_component_key("position", "same"),
            "association",
            "update",
            Some(&snapshot),
            Some(&snapshot),
            vec!["/value".to_string()],
        );
        assert!(result.is_err());
    }

    #[test]
    fn ai_branch_delete_undo_redo_preserves_lineage_and_deduplicates_retry() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO map_ai_branches
                   (id, board_id, prompt, seed_node_ids, created_at, updated_at)
                 VALUES ('branch-history', 'board-1', 'Prompt', '[]', 'before', 'before');
                 INSERT INTO map_node_positions
                   (id, board_id, node_ref_type, ai_branch_id, x, y, created_at, updated_at)
                 VALUES ('position-history', 'board-1', 'ai_branch', 'branch-history', 0, 0, 'before', 'before');",
            )?;
            Ok(())
        })
        .expect("seed AI branch history");
        let forward: MapWritePayload = serde_json::from_value(json!({
            "kind": "erase-ai-branch",
            "requestId": "req-branch-delete",
            "sessionId": "session-map",
            "eventUid": "event-branch-delete",
            "projectId": "p1",
            "branchId": "branch-history",
            "spanIds": [],
            "stickyPositionIds": [],
            "stickyIds": []
        }))
        .expect("decode forward branch delete");
        let forward_receipt = apply_map_write(&db, forward).expect("delete branch");
        let original_transaction_id = forward_receipt["maintenanceTransactionId"]
            .as_str()
            .expect("forward transaction id")
            .to_string();
        let undo_journal_id = forward_receipt["undoJournalId"]
            .as_str()
            .expect("forward Undo journal id")
            .to_string();

        let undo: MapWritePayload = serde_json::from_value(json!({
            "kind": "restore-ai-branch",
            "requestId": "req-branch-undo",
            "sessionId": "session-map",
            "eventUid": "event-branch-undo",
            "origin": "undo",
            "originalTransactionId": original_transaction_id.clone(),
            "undoJournalId": undo_journal_id.clone(),
            "projectId": "p1",
            "branch": {
                "id": "branch-history",
                "boardId": "board-1",
                "prompt": "Prompt",
                "seedNodeIds": "[]",
                "sessionId": null,
                "model": null,
                "tokenUsage": null,
                "createdAt": "before",
                "updatedAt": "before"
            },
            "branchPosition": {
                "id": "position-history",
                "boardId": "board-1",
                "nodeRefType": "ai_branch",
                "treeNodeId": null,
                "codexEntryId": null,
                "snippetId": null,
                "stickyId": null,
                "aiBranchId": "branch-history",
                "x": 0,
                "y": 0,
                "pinned": 0,
                "zIndex": 0,
                "createdAt": "before",
                "updatedAt": "before"
            },
            "stickies": [],
            "positions": [],
            "edges": [],
            "spans": []
        }))
        .expect("decode branch undo");
        apply_map_write(&db, undo.clone()).expect("undo branch delete");
        let mut undo_retry = undo;
        undo_retry.session_id = "session-after-restart".to_string();
        undo_retry.event_uid = "event-branch-undo-retry".to_string();
        apply_map_write(&db, undo_retry).expect("retry branch undo");

        let redo: MapWritePayload = serde_json::from_value(json!({
            "kind": "erase-ai-branch",
            "requestId": "req-branch-redo",
            "sessionId": "session-map",
            "eventUid": "event-branch-redo",
            "origin": "redo",
            "originalTransactionId": original_transaction_id.clone(),
            "undoJournalId": undo_journal_id.clone(),
            "projectId": "p1",
            "branchId": "branch-history",
            "spanIds": [],
            "stickyPositionIds": [],
            "stickyIds": []
        }))
        .expect("decode branch redo");
        apply_map_write(&db, redo).expect("redo branch delete");

        db.with_conn(|conn| {
            let branch_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM map_ai_branches WHERE id = 'branch-history'",
                [],
                |row| row.get(0),
            )?;
            let replay_rows = conn
                .prepare(
                    "SELECT request_id, cause_kind, origin, original_transaction_id,
                            undo_journal_id
                       FROM narrative_change_transactions
                      WHERE request_id IN ('req-branch-undo', 'req-branch-redo')
                      ORDER BY request_id",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(branch_count, 0);
            assert_eq!(replay_rows.len(), 2);
            assert_eq!(replay_rows[0].0, "req-branch-redo");
            assert_eq!(
                (&replay_rows[0].1, &replay_rows[0].2),
                (&"redo".to_string(), &"redo".to_string())
            );
            assert_eq!(replay_rows[1].0, "req-branch-undo");
            assert_eq!(
                (&replay_rows[1].1, &replay_rows[1].2),
                (&"undo".to_string(), &"undo".to_string())
            );
            for row in replay_rows {
                assert_eq!(row.3.as_deref(), Some(original_transaction_id.as_str()));
                assert_eq!(row.4.as_deref(), Some(undo_journal_id.as_str()));
            }
            Ok(())
        })
        .expect("inspect Map replay lineage");
    }
}
