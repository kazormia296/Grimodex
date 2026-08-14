//! Phase / Detail / Semantic Binding snapshot helpers for undo / redo.

use rusqlite::{params, Connection};
use serde_json::Value;

use super::detail_operations::collect_detail_value_snapshot;
use super::phase_operations::{collect_phase_overrides, collect_phase_snapshot};
use super::semantic_bindings::collect_semantic_binding_snapshot;

/// Refuse undo when Phase has sticky / authorship external dependencies.
pub(crate) fn ensure_no_external_phase_dependencies(
    conn: &Connection,
    phase_id: &str,
) -> anyhow::Result<()> {
    let sticky_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM editor_stickies WHERE phase_id = ?1",
            params![phase_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if sticky_count > 0 {
        anyhow::bail!("NEX_UNDO_EXTERNAL_DEPENDENCY: phase '{phase_id}' has editor_stickies");
    }

    let authorship_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM authorship_spans WHERE phase_id = ?1",
            params![phase_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if authorship_count > 0 {
        anyhow::bail!(
            "NEX_UNDO_EXTERNAL_DEPENDENCY: phase '{phase_id}' is referenced by authorship_spans"
        );
    }

    Ok(())
}

pub(crate) fn undo_created_phase(
    conn: &Connection,
    phase_id: &str,
    expected_version: i64,
) -> anyhow::Result<()> {
    ensure_no_external_phase_dependencies(conn, phase_id)?;
    let current = collect_phase_snapshot(conn, phase_id)?;
    let live_version = current.get("version").and_then(Value::as_i64).unwrap_or(0);
    if live_version != expected_version {
        anyhow::bail!("NEX_COMMIT_PHASE_EDITED: phase '{phase_id}' was modified after commit");
    }
    let deleted = conn.execute(
        "DELETE FROM codex_entry_phases WHERE id = ?1 AND version = ?2",
        params![phase_id, expected_version],
    )?;
    anyhow::ensure!(
        deleted == 1,
        "NEX_COMMIT_PHASE_EDITED: phase '{phase_id}' delete conflict"
    );
    Ok(())
}

pub(crate) fn restore_phase_patch(
    conn: &Connection,
    phase_id: &str,
    before_snapshot: &Value,
    expected_after_version: i64,
    now: &str,
) -> anyhow::Result<i64> {
    ensure_no_external_phase_dependencies(conn, phase_id)?;
    let live_version: i64 = conn.query_row(
        "SELECT version FROM codex_entry_phases WHERE id = ?1",
        params![phase_id],
        |row| row.get(0),
    )?;
    if live_version != expected_after_version {
        anyhow::bail!(
            "NEX_COMMIT_PHASE_EDITED: phase '{phase_id}' version mismatch (expected {expected_after_version}, found {live_version})"
        );
    }

    let label = before_snapshot
        .get("label")
        .and_then(Value::as_str)
        .unwrap_or("");
    let summary = before_snapshot
        .get("summaryOverride")
        .and_then(Value::as_str);
    let content = before_snapshot
        .get("contentOverride")
        .and_then(Value::as_str);
    let context_mode = before_snapshot
        .get("contextModeOverride")
        .and_then(Value::as_str);
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("phase version overflow during undo"))?;

    let updated = conn.execute(
        "UPDATE codex_entry_phases
            SET label = ?1,
                summary_override = ?2,
                content_override = ?3,
                context_mode_override = ?4,
                version = ?5,
                updated_at = ?6
          WHERE id = ?7 AND version = ?8",
        params![
            label,
            summary,
            content,
            context_mode,
            next_version,
            now,
            phase_id,
            live_version
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_COMMIT_PHASE_EDITED: phase '{phase_id}' patch restore conflict"
    );

    conn.execute(
        "DELETE FROM codex_phase_detail_overrides WHERE phase_id = ?1",
        params![phase_id],
    )?;
    if let Some(overrides) = before_snapshot
        .get("detailOverrides")
        .and_then(Value::as_array)
    {
        for item in overrides {
            let definition_id = item
                .get("definitionId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("override missing definitionId"))?;
            let value = item.get("value").and_then(Value::as_str);
            conn.execute(
                "INSERT INTO codex_phase_detail_overrides (phase_id, definition_id, value)
                 VALUES (?1, ?2, ?3)",
                params![phase_id, definition_id, value],
            )?;
        }
    }
    let _ = collect_phase_overrides(conn, phase_id)?;
    Ok(next_version)
}

pub(crate) fn undo_created_detail_value(
    conn: &Connection,
    detail_value_id: &str,
    expected_version: i64,
) -> anyhow::Result<()> {
    let current = collect_detail_value_snapshot(conn, detail_value_id)?;
    let live_version = current.get("version").and_then(Value::as_i64).unwrap_or(0);
    if live_version != expected_version {
        anyhow::bail!(
            "NEX_COMMIT_DETAIL_EDITED: detail value '{detail_value_id}' was modified after commit"
        );
    }
    let deleted = conn.execute(
        "DELETE FROM codex_detail_values WHERE id = ?1 AND version = ?2",
        params![detail_value_id, expected_version],
    )?;
    anyhow::ensure!(
        deleted == 1,
        "NEX_COMMIT_DETAIL_EDITED: detail value '{detail_value_id}' delete conflict"
    );
    Ok(())
}

pub(crate) fn restore_detail_value_patch(
    conn: &Connection,
    detail_value_id: &str,
    before_snapshot: &Value,
    expected_after_version: i64,
    now: &str,
) -> anyhow::Result<i64> {
    let live_version: i64 = conn.query_row(
        "SELECT version FROM codex_detail_values WHERE id = ?1",
        params![detail_value_id],
        |row| row.get(0),
    )?;
    if live_version != expected_after_version {
        anyhow::bail!(
            "NEX_COMMIT_DETAIL_EDITED: detail value '{detail_value_id}' version mismatch"
        );
    }
    let value = before_snapshot.get("value").and_then(Value::as_str);
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("detail value version overflow during undo"))?;
    let updated = conn.execute(
        "UPDATE codex_detail_values
            SET value = ?1,
                version = ?2,
                updated_at = ?3
          WHERE id = ?4 AND version = ?5",
        params![value, next_version, now, detail_value_id, live_version],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_COMMIT_DETAIL_EDITED: detail value '{detail_value_id}' restore conflict"
    );
    Ok(next_version)
}

pub(crate) fn undo_created_semantic_binding(
    conn: &Connection,
    binding_id: &str,
    expected_version: i64,
) -> anyhow::Result<()> {
    let current = collect_semantic_binding_snapshot(conn, binding_id)?;
    let live_version = current.get("version").and_then(Value::as_i64).unwrap_or(0);
    if live_version != expected_version {
        anyhow::bail!(
            "NEX_COMMIT_BINDING_EDITED: semantic binding '{binding_id}' was modified after commit"
        );
    }
    let deleted = conn.execute(
        "DELETE FROM codex_detail_semantic_bindings WHERE id = ?1 AND version = ?2",
        params![binding_id, expected_version],
    )?;
    anyhow::ensure!(
        deleted == 1,
        "NEX_COMMIT_BINDING_EDITED: semantic binding '{binding_id}' delete conflict"
    );
    Ok(())
}

pub(crate) fn restore_semantic_binding_patch(
    conn: &Connection,
    binding_id: &str,
    before_snapshot: &Value,
    expected_after_version: i64,
    now: &str,
) -> anyhow::Result<i64> {
    let live_version: i64 = conn.query_row(
        "SELECT version FROM codex_detail_semantic_bindings WHERE id = ?1",
        params![binding_id],
        |row| row.get(0),
    )?;
    if live_version != expected_after_version {
        anyhow::bail!(
            "NEX_COMMIT_BINDING_EDITED: semantic binding '{binding_id}' version mismatch"
        );
    }
    let definition_id = before_snapshot
        .get("definitionId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("binding snapshot missing definitionId"))?;
    let facet_key = before_snapshot
        .get("facetKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    let projection_kind = before_snapshot
        .get("projectionKind")
        .and_then(Value::as_str)
        .unwrap_or("scalar-text");
    let temporal_policy = before_snapshot
        .get("temporalPolicy")
        .and_then(Value::as_str)
        .unwrap_or("base-only");
    let source = before_snapshot
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("user");
    let confirmed = before_snapshot
        .get("confirmed")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("semantic binding version overflow during undo"))?;
    let updated = conn.execute(
        "UPDATE codex_detail_semantic_bindings
            SET definition_id = ?1,
                facet_key = ?2,
                projection_kind = ?3,
                temporal_policy = ?4,
                source = ?5,
                confirmed = ?6,
                version = ?7,
                updated_at = ?8
          WHERE id = ?9 AND version = ?10",
        params![
            definition_id,
            facet_key,
            projection_kind,
            temporal_policy,
            source,
            confirmed,
            next_version,
            now,
            binding_id,
            live_version
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_COMMIT_BINDING_EDITED: semantic binding '{binding_id}' restore conflict"
    );
    Ok(next_version)
}

pub(crate) fn reapply_phase_create_snapshot(
    conn: &Connection,
    snapshot: &Value,
    now: &str,
) -> anyhow::Result<i64> {
    let phase_id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("phase snapshot missing id"))?;
    let entry_id = snapshot
        .get("entryId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("phase snapshot missing entryId"))?;
    let anchor_node_id = snapshot.get("anchorNodeId").and_then(Value::as_str);
    let label = snapshot.get("label").and_then(Value::as_str).unwrap_or("");
    let summary = snapshot.get("summaryOverride").and_then(Value::as_str);
    let content = snapshot.get("contentOverride").and_then(Value::as_str);
    let context_mode = snapshot.get("contextModeOverride").and_then(Value::as_str);
    let previous_version = snapshot.get("version").and_then(Value::as_i64).unwrap_or(0);
    let replay_version = previous_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("phase version overflow during redo"))?;

    conn.execute(
        "INSERT INTO codex_entry_phases
            (id, entry_id, anchor_node_id, label, summary_override,
             content_override, context_mode_override, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            phase_id,
            entry_id,
            anchor_node_id,
            label,
            summary,
            content,
            context_mode,
            replay_version,
            now,
        ],
    )?;
    if let Some(overrides) = snapshot.get("detailOverrides").and_then(Value::as_array) {
        for item in overrides {
            let definition_id = item
                .get("definitionId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("override missing definitionId"))?;
            let value = item.get("value").and_then(Value::as_str);
            conn.execute(
                "INSERT INTO codex_phase_detail_overrides (phase_id, definition_id, value)
                 VALUES (?1, ?2, ?3)",
                params![phase_id, definition_id, value],
            )?;
        }
    }
    Ok(replay_version)
}

pub(crate) fn reapply_detail_value_create_snapshot(
    conn: &Connection,
    snapshot: &Value,
    now: &str,
) -> anyhow::Result<i64> {
    let id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("detail value snapshot missing id"))?;
    let entry_id = snapshot
        .get("entryId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("detail value snapshot missing entryId"))?;
    let definition_id = snapshot
        .get("definitionId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("detail value snapshot missing definitionId"))?;
    let value = snapshot.get("value").and_then(Value::as_str);
    let previous_version = snapshot.get("version").and_then(Value::as_i64).unwrap_or(1);
    let replay_version = previous_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("detail value version overflow during redo"))?;
    conn.execute(
        "INSERT INTO codex_detail_values
            (id, entry_id, definition_id, value, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, entry_id, definition_id, value, replay_version, now],
    )?;
    Ok(replay_version)
}

pub(crate) fn reapply_semantic_binding_create_snapshot(
    conn: &Connection,
    project_id: &str,
    snapshot: &Value,
    now: &str,
) -> anyhow::Result<i64> {
    let id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("binding snapshot missing id"))?;
    let definition_id = snapshot
        .get("definitionId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("binding snapshot missing definitionId"))?;
    let facet_key = snapshot
        .get("facetKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    let projection_kind = snapshot
        .get("projectionKind")
        .and_then(Value::as_str)
        .unwrap_or("scalar-text");
    let temporal_policy = snapshot
        .get("temporalPolicy")
        .and_then(Value::as_str)
        .unwrap_or("base-only");
    let source = snapshot
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("reviewed-ai");
    let confirmed = snapshot
        .get("confirmed")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let previous_version = snapshot.get("version").and_then(Value::as_i64).unwrap_or(0);
    let replay_version = previous_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("binding version overflow during redo"))?;
    conn.execute(
        "INSERT INTO codex_detail_semantic_bindings
            (id, project_id, definition_id, facet_key, projection_kind,
             temporal_policy, source, confirmed, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
        params![
            id,
            project_id,
            definition_id,
            facet_key,
            projection_kind,
            temporal_policy,
            source,
            confirmed,
            replay_version,
            now,
        ],
    )?;
    Ok(replay_version)
}
