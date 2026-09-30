//! Plot thread domain operations for narrative apply commits.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use super::codex_operations::{CommitMap, PatchFieldString};

pub(crate) const OP_KIND_PLOT_THREAD_CREATE: &str = "plot.thread.create";
pub(crate) const OP_KIND_PLOT_THREAD_PATCH: &str = "plot.thread.patch";
pub(crate) const OP_KIND_PLOT_MARKER_CREATE: &str = "plot.marker.create";
pub(crate) const OP_KIND_PLOT_BRANCH_CREATE: &str = "plot.branch.create";

const PHASE_TYPES: [&str; 5] = ["introduce", "develop", "turn", "climax", "resolve"];
const BRANCH_KINDS: [&str; 2] = ["branch", "merge"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlotThreadCreatePayload {
    pub thread_id: String,
    pub hypothesis_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    pub sort_order: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlotThreadPatchPayload {
    pub thread_id: String,
    pub hypothesis_id: String,
    pub base_version: i64,
    #[serde(default)]
    pub name: Option<PatchFieldString>,
    #[serde(default)]
    pub color: Option<PatchFieldString>,
    #[serde(default)]
    pub description: Option<PatchFieldString>,
    #[serde(default)]
    pub sort_order: Option<PatchFieldString>,
    #[serde(default)]
    pub start_node_id: Option<PatchFieldString>,
    #[serde(default)]
    pub end_node_id: Option<PatchFieldString>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlotMarkerCreatePayload {
    pub marker_id: String,
    pub hypothesis_id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    pub scene_id: String,
    pub phase_type: String,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub semantic_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlotBranchCreatePayload {
    pub branch_id: String,
    pub from_hypothesis_id: String,
    pub to_hypothesis_id: String,
    #[serde(default)]
    pub from_thread_id: Option<String>,
    #[serde(default)]
    pub to_thread_id: Option<String>,
    pub at_scene_id: String,
    pub kind: String,
    #[serde(default)]
    pub semantic_key: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PlotThreadTxResult {
    pub entity_id: String,
    pub version: i64,
    pub after_snapshot: Value,
    pub before_snapshot: Option<Value>,
    pub op_kind: &'static str,
}

pub(crate) fn parse_plot_thread_create_payload(
    payload: &Value,
) -> anyhow::Result<PlotThreadCreatePayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid plot.thread.create payload: {err}"))
}

pub(crate) fn parse_plot_thread_patch_payload(
    payload: &Value,
) -> anyhow::Result<PlotThreadPatchPayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid plot.thread.patch payload: {err}"))
}

pub(crate) fn parse_plot_marker_create_payload(
    payload: &Value,
) -> anyhow::Result<PlotMarkerCreatePayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid plot.marker.create payload: {err}"))
}

pub(crate) fn parse_plot_branch_create_payload(
    payload: &Value,
) -> anyhow::Result<PlotBranchCreatePayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid plot.branch.create payload: {err}"))
}

fn validate_phase(phase_type: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        PHASE_TYPES.contains(&phase_type),
        "invalid phase_type: {phase_type:?}"
    );
    Ok(())
}

fn validate_branch_kind(kind: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        BRANCH_KINDS.contains(&kind),
        "invalid plot branch kind: {kind:?}"
    );
    Ok(())
}

pub(crate) fn build_marker_semantic_key(
    thread_id: &str,
    scene_id: &str,
    phase_type: &str,
) -> String {
    format!("{thread_id}|{scene_id}|{phase_type}")
}

pub(crate) fn build_branch_semantic_key(
    from_thread_id: &str,
    to_thread_id: &str,
    at_scene_id: &str,
    kind: &str,
) -> String {
    format!("{from_thread_id}|{to_thread_id}|{at_scene_id}|{kind}")
}

pub(crate) fn ensure_thread_id_available(
    conn: &Connection,
    project_id: &str,
    thread_id: &str,
) -> anyhow::Result<()> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM plot_threads WHERE id = ?1 AND project_id = ?2",
        params![thread_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        exists == 0,
        "plot thread '{thread_id}' already exists in project '{project_id}'"
    );
    Ok(())
}

pub(crate) fn ensure_marker_id_available(conn: &Connection, marker_id: &str) -> anyhow::Result<()> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM plot_thread_scene_links WHERE id = ?1",
        params![marker_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        exists == 0,
        "plot thread marker '{marker_id}' already exists"
    );
    Ok(())
}

pub(crate) fn ensure_branch_id_available(conn: &Connection, branch_id: &str) -> anyhow::Result<()> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM plot_thread_branches WHERE id = ?1",
        params![branch_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        exists == 0,
        "plot thread branch '{branch_id}' already exists"
    );
    Ok(())
}

pub(crate) fn ensure_thread_version(
    conn: &Connection,
    project_id: &str,
    thread_id: &str,
    expected_version: i64,
) -> anyhow::Result<()> {
    let version: Option<i64> = conn
        .query_row(
            "SELECT version FROM plot_threads WHERE id = ?1 AND project_id = ?2",
            params![thread_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(version) = version else {
        anyhow::bail!("plot thread '{thread_id}' not found in project '{project_id}'");
    };
    if version != expected_version {
        anyhow::bail!(
            "NEX_PLOT_THREAD_VERSION_MISMATCH: thread '{thread_id}' expected version {expected_version}, found {version}"
        );
    }
    Ok(())
}

fn ensure_scene_in_project(
    conn: &Connection,
    project_id: &str,
    scene_id: &str,
) -> anyhow::Result<()> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tree_nodes
          WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
        params![scene_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        found == 1,
        "scene '{scene_id}' not found in project '{project_id}'"
    );
    Ok(())
}

fn ensure_thread_in_project(
    conn: &Connection,
    project_id: &str,
    thread_id: &str,
) -> anyhow::Result<()> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM plot_threads WHERE id = ?1 AND project_id = ?2",
        params![thread_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        found == 1,
        "plot thread '{thread_id}' not found in project '{project_id}'"
    );
    Ok(())
}

fn ensure_semantic_key_unique(
    conn: &Connection,
    table: &str,
    semantic_key: &str,
    label: &str,
) -> anyhow::Result<()> {
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE semantic_key = ?1");
    let duplicate: i64 = conn.query_row(&sql, params![semantic_key], |row| row.get(0))?;
    anyhow::ensure!(
        duplicate == 0,
        "NEX_PLOT_SEMANTIC_DUPLICATE: {label} semantic_key already exists"
    );
    Ok(())
}

fn resolve_thread_id(
    explicit_thread_id: Option<&str>,
    hypothesis_id: Option<&str>,
    commit_map: &CommitMap,
) -> anyhow::Result<String> {
    if let Some(id) = explicit_thread_id.filter(|value| !value.is_empty()) {
        return Ok(id.to_string());
    }
    let Some(hypothesis_id) = hypothesis_id.filter(|value| !value.is_empty()) else {
        anyhow::bail!("plot operation missing threadId / hypothesisId");
    };
    Ok(commit_map
        .resolve_plot_thread(hypothesis_id)?
        .plot_thread_id
        .clone())
}

pub(crate) fn collect_plot_thread_snapshot(
    conn: &Connection,
    thread_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'projectId', project_id,
            'name', name,
            'color', color,
            'description', description,
            'sortOrder', sort_order,
            'startNodeId', start_node_id,
            'endNodeId', end_node_id,
            'version', version
         ) FROM plot_threads WHERE id = ?1",
        params![thread_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

pub(crate) fn collect_plot_marker_snapshot(
    conn: &Connection,
    marker_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'threadId', thread_id,
            'nodeId', node_id,
            'phaseType', phase_type,
            'note', note,
            'sortOrder', sort_order,
            'semanticKey', semantic_key,
            'version', version
         ) FROM plot_thread_scene_links WHERE id = ?1",
        params![marker_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

pub(crate) fn collect_plot_branch_snapshot(
    conn: &Connection,
    branch_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'projectId', project_id,
            'fromThreadId', from_thread_id,
            'toThreadId', to_thread_id,
            'atNodeId', at_node_id,
            'kind', kind,
            'semanticKey', semantic_key,
            'version', version
         ) FROM plot_thread_branches WHERE id = ?1",
        params![branch_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

pub(crate) fn apply_plot_thread_create_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &PlotThreadCreatePayload,
    now: &str,
) -> anyhow::Result<PlotThreadTxResult> {
    ensure_thread_id_available(conn, project_id, &payload.thread_id)?;

    conn.execute(
        "INSERT INTO plot_threads
            (id, project_id, name, color, description, sort_order,
             start_node_id, end_node_id, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, 0, ?7, ?7)",
        params![
            payload.thread_id,
            project_id,
            payload.name,
            payload.color,
            payload.description,
            payload.sort_order,
            now,
        ],
    )?;

    let after_snapshot = collect_plot_thread_snapshot(conn, &payload.thread_id)?;
    Ok(PlotThreadTxResult {
        entity_id: payload.thread_id.clone(),
        version: 0,
        after_snapshot,
        before_snapshot: None,
        op_kind: "create",
    })
}

pub(crate) fn apply_plot_thread_patch_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &PlotThreadPatchPayload,
    now: &str,
) -> anyhow::Result<PlotThreadTxResult> {
    for field in [
        ("name", &payload.name),
        ("color", &payload.color),
        ("sortOrder", &payload.sort_order),
        ("startNodeId", &payload.start_node_id),
        ("endNodeId", &payload.end_node_id),
    ] {
        if let Some(patch) = field.1 {
            anyhow::ensure!(
                patch.kind == "leave",
                "NEX_PLOT_THREAD_PATCH_SCOPE: {} changes are not allowed in v1",
                field.0
            );
        }
    }

    let live: Option<(i64, Option<String>)> = conn
        .query_row(
            "SELECT version, description FROM plot_threads
              WHERE id = ?1 AND project_id = ?2",
            params![payload.thread_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((live_version, live_description)) = live else {
        anyhow::bail!("plot thread '{}' not found", payload.thread_id);
    };
    if live_version != payload.base_version {
        anyhow::bail!(
            "NEX_PLOT_THREAD_VERSION_MISMATCH: thread '{}' expected version {}, found {}",
            payload.thread_id,
            payload.base_version,
            live_version
        );
    }

    let next_description = match &payload.description {
        None => None,
        Some(PatchFieldString { kind, .. }) if kind == "leave" => None,
        Some(PatchFieldString { kind, value }) if kind == "set" => {
            let is_empty = live_description
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true);
            anyhow::ensure!(
                is_empty,
                "NEX_PLOT_THREAD_PATCH_SCOPE: description may only be set when currently empty"
            );
            Some(
                value
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("description.set requires value"))?,
            )
        }
        Some(PatchFieldString { kind, .. }) => {
            anyhow::bail!("unsupported description patch kind '{kind}'")
        }
    };

    let before_snapshot = collect_plot_thread_snapshot(conn, &payload.thread_id)?;
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("plot thread version overflow"))?;

    let updated = if let Some(description) = next_description {
        conn.execute(
            "UPDATE plot_threads
                SET description = ?1,
                    version = ?2,
                    updated_at = ?3
              WHERE id = ?4 AND project_id = ?5 AND version = ?6",
            params![
                description,
                next_version,
                now,
                payload.thread_id,
                project_id,
                live_version
            ],
        )?
    } else {
        conn.execute(
            "UPDATE plot_threads
                SET version = ?1,
                    updated_at = ?2
              WHERE id = ?3 AND project_id = ?4 AND version = ?5",
            params![
                next_version,
                now,
                payload.thread_id,
                project_id,
                live_version
            ],
        )?
    };
    anyhow::ensure!(
        updated == 1,
        "NEX_PLOT_THREAD_VERSION_MISMATCH: thread '{}' patch conflict",
        payload.thread_id
    );

    let after_snapshot = collect_plot_thread_snapshot(conn, &payload.thread_id)?;
    Ok(PlotThreadTxResult {
        entity_id: payload.thread_id.clone(),
        version: next_version,
        after_snapshot,
        before_snapshot: Some(before_snapshot),
        op_kind: "patch",
    })
}

pub(crate) fn apply_plot_marker_create_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &PlotMarkerCreatePayload,
    commit_map: &CommitMap,
    now: &str,
) -> anyhow::Result<PlotThreadTxResult> {
    validate_phase(&payload.phase_type)?;
    ensure_scene_in_project(conn, project_id, &payload.scene_id)?;

    let thread_id = resolve_thread_id(
        payload.thread_id.as_deref(),
        Some(payload.hypothesis_id.as_str()),
        commit_map,
    )?;
    ensure_thread_in_project(conn, project_id, &thread_id)?;

    let semantic_key = payload.semantic_key.clone().unwrap_or_else(|| {
        build_marker_semantic_key(&thread_id, &payload.scene_id, &payload.phase_type)
    });
    ensure_semantic_key_unique(conn, "plot_thread_scene_links", &semantic_key, "marker")?;
    ensure_marker_id_available(conn, &payload.marker_id)?;

    conn.execute(
        "INSERT INTO plot_thread_scene_links
            (id, thread_id, node_id, phase_type, note, sort_order, semantic_key, version,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, 0, ?7, ?7)",
        params![
            payload.marker_id,
            thread_id,
            payload.scene_id,
            payload.phase_type,
            payload.note,
            semantic_key,
            now,
        ],
    )?;

    let after_snapshot = collect_plot_marker_snapshot(conn, &payload.marker_id)?;
    Ok(PlotThreadTxResult {
        entity_id: payload.marker_id.clone(),
        version: 0,
        after_snapshot,
        before_snapshot: None,
        op_kind: "create",
    })
}

fn ensure_target_marker_at_anchor(
    conn: &Connection,
    thread_id: &str,
    at_scene_id: &str,
) -> anyhow::Result<()> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM plot_thread_scene_links
          WHERE thread_id = ?1 AND node_id = ?2",
        params![thread_id, at_scene_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        count >= 1,
        "NEX_PLOT_BRANCH_ANCHOR: target thread '{thread_id}' has no marker at scene '{at_scene_id}'"
    );
    Ok(())
}

pub(crate) fn apply_plot_branch_create_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &PlotBranchCreatePayload,
    commit_map: &CommitMap,
    now: &str,
) -> anyhow::Result<PlotThreadTxResult> {
    validate_branch_kind(&payload.kind)?;

    let from_thread_id = resolve_thread_id(
        payload.from_thread_id.as_deref(),
        Some(payload.from_hypothesis_id.as_str()),
        commit_map,
    )?;
    let to_thread_id = resolve_thread_id(
        payload.to_thread_id.as_deref(),
        Some(payload.to_hypothesis_id.as_str()),
        commit_map,
    )?;
    anyhow::ensure!(
        from_thread_id != to_thread_id,
        "NEX_PLOT_BRANCH_SELF: from and to threads must differ"
    );

    ensure_thread_in_project(conn, project_id, &from_thread_id)?;
    ensure_thread_in_project(conn, project_id, &to_thread_id)?;
    ensure_scene_in_project(conn, project_id, &payload.at_scene_id)?;
    ensure_target_marker_at_anchor(conn, &to_thread_id, &payload.at_scene_id)?;

    let semantic_key = payload.semantic_key.clone().unwrap_or_else(|| {
        build_branch_semantic_key(
            &from_thread_id,
            &to_thread_id,
            &payload.at_scene_id,
            &payload.kind,
        )
    });
    ensure_semantic_key_unique(conn, "plot_thread_branches", &semantic_key, "branch")?;
    ensure_branch_id_available(conn, &payload.branch_id)?;

    conn.execute(
        "INSERT INTO plot_thread_branches
            (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
             semantic_key, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?8)",
        params![
            payload.branch_id,
            project_id,
            from_thread_id,
            to_thread_id,
            payload.at_scene_id,
            payload.kind,
            semantic_key,
            now,
        ],
    )?;

    let after_snapshot = collect_plot_branch_snapshot(conn, &payload.branch_id)?;
    Ok(PlotThreadTxResult {
        entity_id: payload.branch_id.clone(),
        version: 0,
        after_snapshot,
        before_snapshot: None,
        op_kind: "create",
    })
}
