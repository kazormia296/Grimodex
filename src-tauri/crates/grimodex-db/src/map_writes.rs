//! Typed Map aggregate persistence.
//!
//! Renderer Map features still compute layouts and IDs, but they no longer
//! transmit SQL. This module owns the fixed table set, FK-safe ordering,
//! transaction boundaries, and project/board ownership checks.

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension, Transaction};
use serde::Deserialize;

use super::Database;

fn require_non_empty(value: &str, field: &str) -> anyhow::Result<()> {
    if value.is_empty() {
        anyhow::bail!("map write {field} must not be empty");
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Clone, Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapWritePayload {
    pub kind: String,
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
    Ok(())
}

pub fn apply_map_write(db: &Database, payload: MapWritePayload) -> anyhow::Result<()> {
    require_non_empty(&payload.kind, "kind")?;
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        match payload.kind.as_str() {
            "create-board" => create_board_bundle(&tx, &payload)?,
            "create-ai-branch" => create_or_restore_ai_branch(&tx, &payload, false)?,
            "restore-ai-branch" => create_or_restore_ai_branch(&tx, &payload, true)?,
            "erase-ai-branch" => erase_ai_branch(&tx, &payload)?,
            "promote-sticky" => promote_sticky(&tx, &payload)?,
            "extract-frame-to-codex" => extract_frame_to_codex(&tx, &payload)?,
            _ => anyhow::bail!("unsupported map write kind '{}'", payload.kind),
        }
        tx.commit()?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn fixture() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
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
        apply_map_write(
            &db,
            MapWritePayload {
                kind: "promote-sticky".to_string(),
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
            },
        )
        .expect("promote sticky");
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
            Ok(())
        })
        .expect("read promotion");
    }

    #[test]
    fn sticky_promotion_rejects_cross_project_board() {
        let db = fixture();
        let payload_json = serde_json::json!({
            "kind": "promote-sticky",
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
}
