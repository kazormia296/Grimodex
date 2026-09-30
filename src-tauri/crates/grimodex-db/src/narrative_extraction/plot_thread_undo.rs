//! Plot thread undo / redo helpers for narrative apply commits.

use rusqlite::{params, Connection};
use serde_json::Value;

use super::plot_thread_operations::{
    collect_plot_branch_snapshot, collect_plot_marker_snapshot, collect_plot_thread_snapshot,
};

pub(crate) fn ensure_no_external_plot_thread_dependencies(
    conn: &Connection,
    thread_id: &str,
) -> anyhow::Result<()> {
    let marker_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM plot_thread_scene_links WHERE thread_id = ?1",
        params![thread_id],
        |row| row.get(0),
    )?;
    if marker_count > 0 {
        anyhow::bail!("NEX_UNDO_EXTERNAL_DEPENDENCY: plot thread '{thread_id}' still has markers");
    }

    let branch_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM plot_thread_branches
          WHERE from_thread_id = ?1 OR to_thread_id = ?1",
        params![thread_id],
        |row| row.get(0),
    )?;
    if branch_count > 0 {
        anyhow::bail!("NEX_UNDO_EXTERNAL_DEPENDENCY: plot thread '{thread_id}' still has branches");
    }

    Ok(())
}

pub(crate) fn undo_created_plot_thread(
    conn: &Connection,
    thread_id: &str,
    expected_version: i64,
) -> anyhow::Result<()> {
    ensure_no_external_plot_thread_dependencies(conn, thread_id)?;
    let current = collect_plot_thread_snapshot(conn, thread_id)?;
    let live_version = current.get("version").and_then(Value::as_i64).unwrap_or(0);
    if live_version != expected_version {
        anyhow::bail!(
            "NEX_COMMIT_PLOT_THREAD_EDITED: thread '{thread_id}' was modified after commit"
        );
    }
    let deleted = conn.execute(
        "DELETE FROM plot_threads WHERE id = ?1 AND version = ?2",
        params![thread_id, expected_version],
    )?;
    anyhow::ensure!(
        deleted == 1,
        "NEX_COMMIT_PLOT_THREAD_EDITED: thread '{thread_id}' delete conflict"
    );
    Ok(())
}

pub(crate) fn restore_plot_thread_patch(
    conn: &Connection,
    thread_id: &str,
    before_snapshot: &Value,
    expected_after_version: i64,
    now: &str,
) -> anyhow::Result<i64> {
    let live_version: i64 = conn.query_row(
        "SELECT version FROM plot_threads WHERE id = ?1",
        params![thread_id],
        |row| row.get(0),
    )?;
    if live_version != expected_after_version {
        anyhow::bail!(
            "NEX_COMMIT_PLOT_THREAD_EDITED: thread '{thread_id}' version mismatch (expected {expected_after_version}, found {live_version})"
        );
    }

    let description = before_snapshot.get("description").and_then(Value::as_str);
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("plot thread version overflow during undo"))?;

    let updated = conn.execute(
        "UPDATE plot_threads
            SET description = ?1,
                version = ?2,
                updated_at = ?3
          WHERE id = ?4 AND version = ?5",
        params![description, next_version, now, thread_id, live_version],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_COMMIT_PLOT_THREAD_EDITED: thread '{thread_id}' patch restore conflict"
    );
    Ok(next_version)
}

pub(crate) fn undo_created_plot_marker(
    conn: &Connection,
    marker_id: &str,
    expected_version: i64,
    expected_semantic_key: &str,
) -> anyhow::Result<()> {
    let current = collect_plot_marker_snapshot(conn, marker_id)?;
    let live_version = current.get("version").and_then(Value::as_i64).unwrap_or(0);
    let live_semantic_key = current
        .get("semanticKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    if live_version != expected_version || live_semantic_key != expected_semantic_key {
        anyhow::bail!(
            "NEX_COMMIT_PLOT_MARKER_EDITED: marker '{marker_id}' was modified after commit"
        );
    }
    let deleted = conn.execute(
        "DELETE FROM plot_thread_scene_links WHERE id = ?1 AND version = ?2",
        params![marker_id, expected_version],
    )?;
    anyhow::ensure!(
        deleted == 1,
        "NEX_COMMIT_PLOT_MARKER_EDITED: marker '{marker_id}' delete conflict"
    );
    Ok(())
}

pub(crate) fn undo_created_plot_branch(
    conn: &Connection,
    branch_id: &str,
    expected_version: i64,
    expected_semantic_key: &str,
) -> anyhow::Result<()> {
    let current = collect_plot_branch_snapshot(conn, branch_id)?;
    let live_version = current.get("version").and_then(Value::as_i64).unwrap_or(0);
    let live_semantic_key = current
        .get("semanticKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    if live_version != expected_version || live_semantic_key != expected_semantic_key {
        anyhow::bail!(
            "NEX_COMMIT_PLOT_BRANCH_EDITED: branch '{branch_id}' was modified after commit"
        );
    }
    let deleted = conn.execute(
        "DELETE FROM plot_thread_branches WHERE id = ?1 AND version = ?2",
        params![branch_id, expected_version],
    )?;
    anyhow::ensure!(
        deleted == 1,
        "NEX_COMMIT_PLOT_BRANCH_EDITED: branch '{branch_id}' delete conflict"
    );
    Ok(())
}

pub(crate) fn reapply_plot_thread_create_snapshot(
    conn: &Connection,
    project_id: &str,
    snapshot: &Value,
    now: &str,
) -> anyhow::Result<i64> {
    let thread_id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot thread snapshot missing id"))?;
    let name = snapshot.get("name").and_then(Value::as_str).unwrap_or("");
    let color = snapshot.get("color").and_then(Value::as_str);
    let description = snapshot.get("description").and_then(Value::as_str);
    let sort_order = snapshot
        .get("sortOrder")
        .and_then(Value::as_str)
        .unwrap_or("a0");
    let start_node_id = snapshot.get("startNodeId").and_then(Value::as_str);
    let end_node_id = snapshot.get("endNodeId").and_then(Value::as_str);
    let previous_version = snapshot.get("version").and_then(Value::as_i64).unwrap_or(0);
    let replay_version = previous_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("plot thread version overflow during redo"))?;

    conn.execute(
        "INSERT INTO plot_threads
            (id, project_id, name, color, description, sort_order,
             start_node_id, end_node_id, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            thread_id,
            project_id,
            name,
            color,
            description,
            sort_order,
            start_node_id,
            end_node_id,
            replay_version,
            now,
        ],
    )?;
    Ok(replay_version)
}

pub(crate) fn reapply_plot_marker_create_snapshot(
    conn: &Connection,
    snapshot: &Value,
    now: &str,
) -> anyhow::Result<i64> {
    let marker_id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot marker snapshot missing id"))?;
    let thread_id = snapshot
        .get("threadId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot marker snapshot missing threadId"))?;
    let node_id = snapshot
        .get("nodeId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot marker snapshot missing nodeId"))?;
    let phase_type = snapshot
        .get("phaseType")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot marker snapshot missing phaseType"))?;
    let note = snapshot.get("note").and_then(Value::as_str);
    let sort_order = snapshot.get("sortOrder").and_then(Value::as_str);
    let semantic_key = snapshot
        .get("semanticKey")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot marker snapshot missing semanticKey"))?;
    let previous_version = snapshot.get("version").and_then(Value::as_i64).unwrap_or(0);
    let replay_version = previous_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("plot marker version overflow during redo"))?;

    conn.execute(
        "INSERT INTO plot_thread_scene_links
            (id, thread_id, node_id, phase_type, note, sort_order, semantic_key, version,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            marker_id,
            thread_id,
            node_id,
            phase_type,
            note,
            sort_order,
            semantic_key,
            replay_version,
            now,
        ],
    )?;
    Ok(replay_version)
}

pub(crate) fn reapply_plot_branch_create_snapshot(
    conn: &Connection,
    snapshot: &Value,
    now: &str,
) -> anyhow::Result<i64> {
    let branch_id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot branch snapshot missing id"))?;
    let project_id = snapshot
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot branch snapshot missing projectId"))?;
    let from_thread_id = snapshot
        .get("fromThreadId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot branch snapshot missing fromThreadId"))?;
    let to_thread_id = snapshot
        .get("toThreadId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot branch snapshot missing toThreadId"))?;
    let at_node_id = snapshot
        .get("atNodeId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot branch snapshot missing atNodeId"))?;
    let kind = snapshot
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot branch snapshot missing kind"))?;
    let semantic_key = snapshot
        .get("semanticKey")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("plot branch snapshot missing semanticKey"))?;
    let previous_version = snapshot.get("version").and_then(Value::as_i64).unwrap_or(0);
    let replay_version = previous_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("plot branch version overflow during redo"))?;

    conn.execute(
        "INSERT INTO plot_thread_branches
            (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
             semantic_key, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            branch_id,
            project_id,
            from_thread_id,
            to_thread_id,
            at_node_id,
            kind,
            semantic_key,
            replay_version,
            now,
        ],
    )?;
    Ok(replay_version)
}
