//! Codex snapshot helpers for narrative commit undo / redo.

use rusqlite::{params, Connection};
use serde_json::{json, Value};

use super::codex_operations::collect_codex_relation_snapshot;
use crate::agent_writes::{collect_codex_entry_snapshot, delete_codex_entry_cascade};

fn query_dependency_count(
    conn: &Connection,
    sql: &str,
    params: impl rusqlite::Params,
    label: &str,
) -> anyhow::Result<i64> {
    conn.query_row(sql, params, |row| row.get(0))
        .map_err(|err| anyhow::anyhow!("NEX_UNDO_DEPENDENCY_CHECK_FAILED: {label}: {err}"))
}

pub(crate) fn ensure_no_external_codex_dependencies(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
) -> anyhow::Result<()> {
    let relation_count = query_dependency_count(
        conn,
        "SELECT COUNT(*) FROM codex_relations
          WHERE project_id = ?1
            AND (from_codex_id = ?2 OR to_codex_id = ?2)",
        params![project_id, entry_id],
        "codex_relations",
    )?;
    if relation_count > 0 {
        anyhow::bail!(
            "NEX_UNDO_EXTERNAL_DEPENDENCY: entry '{entry_id}' has external codex_relations"
        );
    }

    let participant_count = query_dependency_count(
        conn,
        "SELECT COUNT(*) FROM event_participants WHERE codex_entry_id = ?1",
        params![entry_id],
        "event_participants",
    )?;
    if participant_count > 0 {
        anyhow::bail!(
            "NEX_UNDO_EXTERNAL_DEPENDENCY: entry '{entry_id}' is referenced by event_participants"
        );
    }

    let child_count = query_dependency_count(
        conn,
        "SELECT COUNT(*) FROM codex_entries
          WHERE project_id = ?1 AND parent_id = ?2",
        params![project_id, entry_id],
        "codex_entries.parent_id",
    )?;
    if child_count > 0 {
        anyhow::bail!(
            "NEX_UNDO_EXTERNAL_DEPENDENCY: entry '{entry_id}' has child entries via parent_id"
        );
    }

    let detail_count = query_dependency_count(
        conn,
        "SELECT COUNT(*) FROM codex_detail_values WHERE entry_id = ?1",
        params![entry_id],
        "codex_detail_values",
    )?;
    if detail_count > 0 {
        anyhow::bail!("NEX_UNDO_EXTERNAL_DEPENDENCY: entry '{entry_id}' has codex_detail_values");
    }

    let phase_count = query_dependency_count(
        conn,
        "SELECT COUNT(*) FROM codex_entry_phases WHERE entry_id = ?1",
        params![entry_id],
        "codex_entry_phases",
    )?;
    if phase_count > 0 {
        anyhow::bail!("NEX_UNDO_EXTERNAL_DEPENDENCY: entry '{entry_id}' has codex_entry_phases");
    }

    let tag_count = query_dependency_count(
        conn,
        "SELECT COUNT(*) FROM codex_entry_tags WHERE entry_id = ?1",
        params![entry_id],
        "codex_entry_tags",
    )?;
    if tag_count > 0 {
        anyhow::bail!("NEX_UNDO_EXTERNAL_DEPENDENCY: entry '{entry_id}' has codex_entry_tags");
    }

    Ok(())
}

pub(crate) fn delete_codex_relation_checked(
    conn: &Connection,
    project_id: &str,
    relation_id: &str,
    expected: &Value,
) -> anyhow::Result<()> {
    let current = collect_codex_relation_snapshot(conn, relation_id)?;
    let expected_version = expected
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("relation snapshot missing version"))?;
    let current_version = current
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("live relation missing version"))?;
    let expected_key = expected.get("semanticKey").and_then(Value::as_str);
    let current_key = current.get("semanticKey").and_then(Value::as_str);
    if current_version != expected_version || expected_key != current_key {
        anyhow::bail!(
            "NEX_COMMIT_RELATION_EDITED: relation '{relation_id}' was modified after commit"
        );
    }
    let deleted = conn.execute(
        "DELETE FROM codex_relations
          WHERE id = ?1 AND project_id = ?2 AND version = ?3",
        params![relation_id, project_id, expected_version],
    )?;
    anyhow::ensure!(
        deleted == 1,
        "NEX_COMMIT_RELATION_EDITED: relation '{relation_id}' delete conflict"
    );
    Ok(())
}

pub(crate) fn restore_codex_entry_patch(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
    before_snapshot: &Value,
    expected_after_version: i64,
    now: &str,
) -> anyhow::Result<i64> {
    let live_version: i64 = conn.query_row(
        "SELECT version FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        params![entry_id, project_id],
        |row| row.get(0),
    )?;
    if live_version != expected_after_version {
        anyhow::bail!(
            "NEX_COMMIT_ENTRY_EDITED: entry '{entry_id}' version mismatch (expected {expected_after_version}, found {live_version})"
        );
    }

    let aliases = before_snapshot
        .get("aliases")
        .cloned()
        .unwrap_or(Value::Null);
    let summary = before_snapshot
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("");
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("codex entry version overflow during undo"))?;

    let aliases_sql = match &aliases {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    };

    let updated = conn.execute(
        "UPDATE codex_entries
            SET aliases = ?1,
                summary = ?2,
                version = ?3,
                updated_at = ?4
          WHERE id = ?5 AND project_id = ?6 AND version = ?7",
        params![
            aliases_sql,
            summary,
            next_version,
            now,
            entry_id,
            project_id,
            live_version
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_COMMIT_ENTRY_EDITED: entry '{entry_id}' patch restore conflict"
    );
    Ok(next_version)
}

pub(crate) fn undo_created_codex_entry(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
    expected_version: i64,
) -> anyhow::Result<()> {
    ensure_no_external_codex_dependencies(conn, project_id, entry_id)?;
    let current = collect_codex_entry_snapshot(conn, entry_id)?;
    let live_version = current
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("codex entry snapshot missing version"))?;
    if live_version != expected_version {
        anyhow::bail!("NEX_COMMIT_ENTRY_EDITED: entry '{entry_id}' was modified after commit");
    }
    delete_codex_entry_cascade(conn, project_id, entry_id, Some(expected_version))
}

pub(crate) fn reapply_codex_relation_snapshot(
    conn: &Connection,
    project_id: &str,
    snapshot: &Value,
    now: &str,
) -> anyhow::Result<(i64, Value)> {
    let relation_id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("relation snapshot missing id"))?;
    let from_codex_id = snapshot
        .get("fromCodexId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("relation snapshot missing fromCodexId"))?;
    let to_codex_id = snapshot
        .get("toCodexId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("relation snapshot missing toCodexId"))?;
    let relation_type = snapshot
        .get("relationType")
        .and_then(Value::as_str)
        .unwrap_or("custom");
    let label = snapshot.get("label").and_then(Value::as_str);
    let directionality = snapshot
        .get("directionality")
        .and_then(Value::as_str)
        .unwrap_or("directed");
    let inverse_label = snapshot.get("inverseLabel").and_then(Value::as_str);
    let semantic_key = snapshot
        .get("semanticKey")
        .and_then(Value::as_str)
        .unwrap_or("");
    let previous_version = snapshot
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("relation snapshot missing version"))?;
    let replay_version = previous_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("relation version overflow during redo"))?;

    conn.execute(
        "INSERT INTO codex_relations
            (id, project_id, from_codex_id, to_codex_id, relation_type, label,
             directionality, inverse_label, semantic_key, version,
             depth_hint, source_map_edge_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, NULL, ?11, ?11)",
        params![
            relation_id,
            project_id,
            from_codex_id,
            to_codex_id,
            relation_type,
            label,
            directionality,
            inverse_label,
            semantic_key,
            replay_version,
            now,
        ],
    )?;
    let live = collect_codex_relation_snapshot(conn, relation_id)?;
    Ok((replay_version, live))
}

pub(crate) fn reapply_codex_entry_create_snapshot(
    conn: &Connection,
    project_id: &str,
    snapshot: &Value,
    now: &str,
) -> anyhow::Result<(i64, Value)> {
    let entry_id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("codex snapshot missing id"))?;
    let type_slug = snapshot
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("codex snapshot missing type"))?;
    let name = snapshot
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("codex snapshot missing name"))?;
    let summary = snapshot
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("");
    let content = snapshot
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let aliases = match snapshot.get("aliases") {
        Some(Value::Null) | None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(other) => Some(other.to_string()),
    };
    let previous_version = snapshot
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("codex snapshot missing version"))?;
    let replay_version = previous_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("codex entry version overflow during redo"))?;

    conn.execute(
        "INSERT INTO codex_entries
         (id, project_id, type, name, aliases, summary, content, parent_id,
          source_chat_message_id, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?9, ?9)",
        params![
            entry_id,
            project_id,
            type_slug,
            name,
            aliases,
            summary,
            content,
            replay_version,
            now,
        ],
    )?;
    let _ = json!({ "restored": true });
    let live = collect_codex_entry_snapshot(conn, entry_id)?;
    Ok((replay_version, live))
}

/// Compare alias/summary fields that Redo of a patch would overwrite.
pub(crate) fn ensure_patch_pre_redo_matches_before(
    live: &Value,
    before_snapshot: &Value,
    entry_id: &str,
) -> anyhow::Result<()> {
    let live_aliases = live.get("aliases").cloned().unwrap_or(Value::Null);
    let before_aliases = before_snapshot
        .get("aliases")
        .cloned()
        .unwrap_or(Value::Null);
    let live_summary = live.get("summary").and_then(Value::as_str).unwrap_or("");
    let before_summary = before_snapshot
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or("");
    if live_aliases != before_aliases || live_summary != before_summary {
        anyhow::bail!(
            "NEX_COMMIT_ENTRY_EDITED: entry '{entry_id}' diverged after undo; refusing redo patch clobber"
        );
    }
    Ok(())
}
