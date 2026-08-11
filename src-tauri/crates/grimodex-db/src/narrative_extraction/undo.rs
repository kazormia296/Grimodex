//! Atomic undo / redo for narrative apply commits (Chronicle + Codex).

use chrono::Utc;
use rusqlite::params;
use serde_json::{json, Value};
use uuid::Uuid;

use super::codex_undo::{
    delete_codex_relation_checked, ensure_patch_pre_redo_matches_before,
    reapply_codex_entry_create_snapshot, reapply_codex_relation_snapshot, restore_codex_entry_patch,
    undo_created_codex_entry,
};
use super::detail_operations::collect_detail_value_snapshot;
use super::phase_operations::collect_phase_snapshot;
use super::phase_undo::{
    reapply_detail_value_create_snapshot, reapply_phase_create_snapshot,
    reapply_semantic_binding_create_snapshot, restore_detail_value_patch, restore_phase_patch,
    restore_semantic_binding_patch, undo_created_detail_value, undo_created_phase,
    undo_created_semantic_binding,
};
use super::semantic_bindings::collect_semantic_binding_snapshot;
use super::commit::{load_commit_by_id, load_commit_by_request, CommitRow};
use super::models::UndoCommitPayload;
use super::task_leases::with_immediate_transaction;
use crate::agent_writes::{
    apply_event_snapshot, collect_codex_entry_snapshot, collect_event_snapshot,
    delete_event_cascade,
};
use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::Database;

const STATUS_APPLIED: &str = "applied";
const STATUS_UNDONE: &str = "undone";
const STATUS_REDONE: &str = "redone";

pub fn narrative_extraction_undo_commit(
    db: &Database,
    payload: UndoCommitPayload,
) -> anyhow::Result<Value> {
    mutate_commit(db, &payload, UndoDirection::Undo)
}

pub fn narrative_extraction_redo_commit(
    db: &Database,
    payload: UndoCommitPayload,
) -> anyhow::Result<Value> {
    mutate_commit(db, &payload, UndoDirection::Redo)
}

#[derive(Clone, Copy)]
enum UndoDirection {
    Undo,
    Redo,
}

fn mutate_commit(
    db: &Database,
    payload: &UndoCommitPayload,
    direction: UndoDirection,
) -> anyhow::Result<Value> {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let timestamp = Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        with_immediate_transaction(conn, |conn| {
            let commit = resolve_commit(conn, payload)?;
            let journal_after = load_journal_after(conn, &commit.commit_id)?;
            let entities = journal_entities(&journal_after)?;
            let entity_bindings = journal_after
                .get("entityBindings")
                .cloned()
                .unwrap_or(Value::Null);

            match direction {
                UndoDirection::Undo => {
                    anyhow::ensure!(
                        commit.status == STATUS_APPLIED || commit.status == STATUS_REDONE,
                        "NEX_COMMIT_NOT_UNDOABLE: status is '{}'",
                        commit.status
                    );

                    // Preflight: refuse if any committed entity diverged.
                    for entity in &entities {
                        preflight_undo_entity(conn, &payload.project_id, entity)?;
                    }

                    // Reverse order: relations first, then entry delete/patch restore, then events.
                    for entity in entities.iter().rev() {
                        undo_one_entity(conn, &payload.project_id, entity, &now)?;
                    }

                    // Refresh journal after_json so the next Redo→Undo cycle has
                    // correct OCC expectations (symmetric with redo's update_journal_after).
                    // Surviving entities (patches) get post-undo live versions; deleted
                    // creates keep their recreate snapshot for redo.
                    let mut after_entities = Vec::new();
                    for entity in &entities {
                        let mut row = entity.clone();
                        let kind = entity_kind(entity)?;
                        let id = entity_id(entity)?;
                        let op_kind = entity
                            .get("opKind")
                            .and_then(Value::as_str)
                            .unwrap_or("create");
                        if kind == "codex_entry" && op_kind == "patch" {
                            let live = collect_codex_entry_snapshot(conn, id)?;
                            let live_version = live
                                .get("version")
                                .and_then(Value::as_i64)
                                .ok_or_else(|| {
                                    anyhow::anyhow!(
                                        "codex entry snapshot missing version after undo"
                                    )
                                })?;
                            if let Some(obj) = row.as_object_mut() {
                                obj.insert("version".to_string(), Value::from(live_version));
                                // Keep `snapshot` as the post-apply (redo) target.
                                // Refresh beforeSnapshot to the restored live state so a
                                // subsequent redo preflight compares against current OCC.
                                obj.insert("beforeSnapshot".to_string(), live);
                            }
                        }
                        after_entities.push(row);
                    }
                    update_journal_after(
                        conn,
                        &commit.commit_id,
                        &after_entities,
                        &entity_bindings,
                    )?;

                    let change_uid = Uuid::new_v4().to_string();
                    append_change_events_in_tx(
                        conn,
                        &payload.project_id,
                        &payload.session_id,
                        &[AppendChangeEvent {
                            event_uid: change_uid.clone(),
                            scene_id: None,
                            domain: "narrative".to_string(),
                            op_type: "narrative.commit.undo".to_string(),
                            entity_type: Some("narrative_apply_commit".to_string()),
                            entity_id: Some(commit.commit_id.clone()),
                            payload: json!({
                                "commitId": commit.commit_id,
                                "requestId": commit.request_id,
                            })
                            .to_string(),
                            timestamp,
                        }],
                    )?;

                    let receipt = update_receipt_status(
                        conn,
                        &commit,
                        STATUS_UNDONE,
                        &now,
                        Some(&change_uid),
                    )?;
                    Ok(receipt)
                }
                UndoDirection::Redo => {
                    anyhow::ensure!(
                        commit.status == STATUS_UNDONE,
                        "NEX_COMMIT_NOT_REDOABLE: status is '{}'",
                        commit.status
                    );

                    // Preflight: current state must still match the post-Undo expectation
                    // before we re-apply after-snapshots (especially patch summary/aliases).
                    for entity in &entities {
                        preflight_redo_entity(conn, &payload.project_id, entity)?;
                    }

                    let mut restored = Vec::new();
                    let mut after_entities = Vec::new();
                    for entity in &entities {
                        let entity_kind = entity_kind(entity)?;
                        let entity_id = entity_id(entity)?;
                        let snapshot = entity
                            .get("snapshot")
                            .cloned()
                            .ok_or_else(|| anyhow::anyhow!("journal entity missing snapshot"))?;
                        let (replay_version, live_snapshot) = match entity_kind {
                            "event" => {
                                let previous_version = entity
                                    .get("version")
                                    .and_then(Value::as_i64)
                                    .ok_or_else(|| {
                                        anyhow::anyhow!("journal event missing version")
                                    })?;
                                let replay_version = previous_version
                                    .checked_add(1)
                                    .ok_or_else(|| {
                                        anyhow::anyhow!("event version overflow during redo")
                                    })?;
                                apply_event_snapshot(
                                    conn,
                                    &payload.project_id,
                                    &snapshot,
                                    Some(replay_version),
                                    true,
                                )?;
                                let live_snapshot = collect_event_snapshot(conn, entity_id)?;
                                (replay_version, live_snapshot)
                            }
                            "codex_entry" => {
                                let op_kind = entity
                                    .get("opKind")
                                    .and_then(Value::as_str)
                                    .unwrap_or("create");
                                if op_kind == "patch" {
                                    let live_version: i64 = conn.query_row(
                                        "SELECT version FROM codex_entries WHERE id = ?1 AND project_id = ?2",
                                        params![entity_id, payload.project_id],
                                        |row| row.get(0),
                                    )?;
                                    let aliases =
                                        snapshot.get("aliases").cloned().unwrap_or(Value::Null);
                                    let summary = snapshot
                                        .get("summary")
                                        .and_then(Value::as_str)
                                        .unwrap_or("");
                                    let aliases_sql = match &aliases {
                                        Value::Null => None,
                                        Value::String(s) => Some(s.clone()),
                                        other => Some(other.to_string()),
                                    };
                                    let next = live_version
                                        .checked_add(1)
                                        .ok_or_else(|| {
                                            anyhow::anyhow!(
                                                "codex entry version overflow during redo"
                                            )
                                        })?;
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
                                            next,
                                            now,
                                            entity_id,
                                            payload.project_id,
                                            live_version
                                        ],
                                    )?;
                                    anyhow::ensure!(
                                        updated == 1,
                                        "NEX_COMMIT_ENTRY_EDITED: entry '{entity_id}' redo patch conflict"
                                    );
                                    let live_snapshot =
                                        collect_codex_entry_snapshot(conn, entity_id)?;
                                    (next, live_snapshot)
                                } else if op_kind == "bind" {
                                    let live_snapshot =
                                        collect_codex_entry_snapshot(conn, entity_id)?;
                                    let version = live_snapshot
                                        .get("version")
                                        .and_then(Value::as_i64)
                                        .unwrap_or(1);
                                    (version, live_snapshot)
                                } else {
                                    reapply_codex_entry_create_snapshot(
                                        conn,
                                        &payload.project_id,
                                        &snapshot,
                                        &now,
                                    )?
                                }
                            }
                            "codex_relation" => reapply_codex_relation_snapshot(
                                conn,
                                &payload.project_id,
                                &snapshot,
                                &now,
                            )?,
                            "codex_detail_value" => {
                                let op_kind = entity
                                    .get("opKind")
                                    .and_then(Value::as_str)
                                    .unwrap_or("create");
                                if op_kind == "patch" {
                                    let live_version: i64 = conn.query_row(
                                        "SELECT version FROM codex_detail_values WHERE id = ?1",
                                        params![entity_id],
                                        |row| row.get(0),
                                    )?;
                                    let value = snapshot.get("value").and_then(Value::as_str);
                                    let next = live_version
                                        .checked_add(1)
                                        .ok_or_else(|| {
                                            anyhow::anyhow!(
                                                "detail value version overflow during redo"
                                            )
                                        })?;
                                    let updated = conn.execute(
                                        "UPDATE codex_detail_values
                                            SET value = ?1,
                                                version = ?2,
                                                updated_at = ?3
                                          WHERE id = ?4 AND version = ?5",
                                        params![value, next, now, entity_id, live_version],
                                    )?;
                                    anyhow::ensure!(
                                        updated == 1,
                                        "NEX_COMMIT_DETAIL_EDITED: detail value '{entity_id}' redo conflict"
                                    );
                                    let live_snapshot =
                                        collect_detail_value_snapshot(conn, entity_id)?;
                                    (next, live_snapshot)
                                } else {
                                    let replay_version = reapply_detail_value_create_snapshot(
                                        conn, &snapshot, &now,
                                    )?;
                                    let live_snapshot =
                                        collect_detail_value_snapshot(conn, entity_id)?;
                                    (replay_version, live_snapshot)
                                }
                            }
                            "codex_phase" => {
                                let op_kind = entity
                                    .get("opKind")
                                    .and_then(Value::as_str)
                                    .unwrap_or("create");
                                if op_kind == "patch" {
                                    let live_version: i64 = conn.query_row(
                                        "SELECT version FROM codex_entry_phases WHERE id = ?1",
                                        params![entity_id],
                                        |row| row.get(0),
                                    )?;
                                    let label = snapshot
                                        .get("label")
                                        .and_then(Value::as_str)
                                        .unwrap_or("");
                                    let summary =
                                        snapshot.get("summaryOverride").and_then(Value::as_str);
                                    let content =
                                        snapshot.get("contentOverride").and_then(Value::as_str);
                                    let context_mode = snapshot
                                        .get("contextModeOverride")
                                        .and_then(Value::as_str);
                                    let next = live_version
                                        .checked_add(1)
                                        .ok_or_else(|| {
                                            anyhow::anyhow!("phase version overflow during redo")
                                        })?;
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
                                            next,
                                            now,
                                            entity_id,
                                            live_version
                                        ],
                                    )?;
                                    anyhow::ensure!(
                                        updated == 1,
                                        "NEX_COMMIT_PHASE_EDITED: phase '{entity_id}' redo conflict"
                                    );
                                    conn.execute(
                                        "DELETE FROM codex_phase_detail_overrides WHERE phase_id = ?1",
                                        params![entity_id],
                                    )?;
                                    if let Some(overrides) = snapshot
                                        .get("detailOverrides")
                                        .and_then(Value::as_array)
                                    {
                                        for item in overrides {
                                            let definition_id = item
                                                .get("definitionId")
                                                .and_then(Value::as_str)
                                                .ok_or_else(|| {
                                                    anyhow::anyhow!("override missing definitionId")
                                                })?;
                                            let value = item.get("value").and_then(Value::as_str);
                                            conn.execute(
                                                "INSERT INTO codex_phase_detail_overrides
                                                    (phase_id, definition_id, value)
                                                 VALUES (?1, ?2, ?3)",
                                                params![entity_id, definition_id, value],
                                            )?;
                                        }
                                    }
                                    let live_snapshot = collect_phase_snapshot(conn, entity_id)?;
                                    (next, live_snapshot)
                                } else {
                                    let replay_version =
                                        reapply_phase_create_snapshot(conn, &snapshot, &now)?;
                                    let live_snapshot = collect_phase_snapshot(conn, entity_id)?;
                                    (replay_version, live_snapshot)
                                }
                            }
                            "codex_semantic_binding" => {
                                let op_kind = entity
                                    .get("opKind")
                                    .and_then(Value::as_str)
                                    .unwrap_or("create");
                                if op_kind == "patch" {
                                    let live_version: i64 = conn.query_row(
                                        "SELECT version FROM codex_detail_semantic_bindings WHERE id = ?1",
                                        params![entity_id],
                                        |row| row.get(0),
                                    )?;
                                    let definition_id = snapshot
                                        .get("definitionId")
                                        .and_then(Value::as_str)
                                        .unwrap_or("");
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
                                    let next = live_version
                                        .checked_add(1)
                                        .ok_or_else(|| {
                                            anyhow::anyhow!(
                                                "semantic binding version overflow during redo"
                                            )
                                        })?;
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
                                            next,
                                            now,
                                            entity_id,
                                            live_version
                                        ],
                                    )?;
                                    anyhow::ensure!(
                                        updated == 1,
                                        "NEX_COMMIT_BINDING_EDITED: binding '{entity_id}' redo conflict"
                                    );
                                    let live_snapshot =
                                        collect_semantic_binding_snapshot(conn, entity_id)?;
                                    (next, live_snapshot)
                                } else {
                                    let replay_version = reapply_semantic_binding_create_snapshot(
                                        conn,
                                        &payload.project_id,
                                        &snapshot,
                                        &now,
                                    )?;
                                    let live_snapshot =
                                        collect_semantic_binding_snapshot(conn, entity_id)?;
                                    (replay_version, live_snapshot)
                                }
                            }
                            other => anyhow::bail!("unsupported journal entity kind '{other}'"),
                        };

                        let mut row = entity.clone();
                        if let Some(obj) = row.as_object_mut() {
                            obj.insert("version".to_string(), Value::from(replay_version));
                            obj.insert("snapshot".to_string(), live_snapshot);
                        }
                        after_entities.push(row);
                        restored.push(json!({
                            "entityKind": entity_kind,
                            "entityId": entity_id,
                            "version": replay_version,
                        }));
                    }

                    update_journal_after(conn, &commit.commit_id, &after_entities, &entity_bindings)?;

                    let change_uid = Uuid::new_v4().to_string();
                    append_change_events_in_tx(
                        conn,
                        &payload.project_id,
                        &payload.session_id,
                        &[AppendChangeEvent {
                            event_uid: change_uid.clone(),
                            scene_id: None,
                            domain: "narrative".to_string(),
                            op_type: "narrative.commit.redo".to_string(),
                            entity_type: Some("narrative_apply_commit".to_string()),
                            entity_id: Some(commit.commit_id.clone()),
                            payload: json!({
                                "commitId": commit.commit_id,
                                "requestId": commit.request_id,
                                "restored": restored,
                            })
                            .to_string(),
                            timestamp,
                        }],
                    )?;

                    let receipt =
                        update_receipt_status(conn, &commit, STATUS_REDONE, &now, Some(&change_uid))?;
                    Ok(receipt)
                }
            }
        })
    })
}

fn preflight_undo_entity(
    conn: &rusqlite::Connection,
    project_id: &str,
    entity: &Value,
) -> anyhow::Result<()> {
    let entity_kind = entity_kind(entity)?;
    let entity_id = entity_id(entity)?;
    match entity_kind {
        "event" => {
            let expected = entity
                .get("snapshot")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("journal entity missing snapshot"))?;
            let current = collect_event_snapshot(conn, entity_id)?;
            if normalize_snapshot_for_compare(&current) != normalize_snapshot_for_compare(&expected)
            {
                anyhow::bail!("NEX_COMMIT_EVENT_EDITED: event '{entity_id}' was modified after commit");
            }
        }
        "codex_entry" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "patch" {
                let expected_version = entity
                    .get("version")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| anyhow::anyhow!("journal patch missing version"))?;
                let live_version: i64 = conn.query_row(
                    "SELECT version FROM codex_entries WHERE id = ?1 AND project_id = ?2",
                    params![entity_id, project_id],
                    |row| row.get(0),
                )?;
                if live_version != expected_version {
                    anyhow::bail!(
                        "NEX_COMMIT_ENTRY_EDITED: entry '{entity_id}' was modified after commit"
                    );
                }
            } else {
                let expected = entity
                    .get("snapshot")
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("journal entity missing snapshot"))?;
                let current = collect_codex_entry_snapshot(conn, entity_id)?;
                let expected_version = expected.get("version").and_then(Value::as_i64);
                let current_version = current.get("version").and_then(Value::as_i64);
                if expected_version != current_version {
                    anyhow::bail!(
                        "NEX_COMMIT_ENTRY_EDITED: entry '{entity_id}' was modified after commit"
                    );
                }
            }
        }
        "codex_relation" => {
            let expected = entity
                .get("snapshot")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("journal entity missing snapshot"))?;
            let current = super::codex_operations::collect_codex_relation_snapshot(conn, entity_id)?;
            if current.get("version") != expected.get("version")
                || current.get("semanticKey") != expected.get("semanticKey")
            {
                anyhow::bail!(
                    "NEX_COMMIT_RELATION_EDITED: relation '{entity_id}' was modified after commit"
                );
            }
        }
        "codex_detail_value" => {
            let expected_version = entity
                .get("version")
                .and_then(Value::as_i64)
                .unwrap_or(1);
            let live_version: i64 = conn.query_row(
                "SELECT version FROM codex_detail_values WHERE id = ?1",
                params![entity_id],
                |row| row.get(0),
            )?;
            if live_version != expected_version {
                anyhow::bail!(
                    "NEX_COMMIT_DETAIL_EDITED: detail value '{entity_id}' was modified after commit"
                );
            }
        }
        "codex_phase" => {
            let expected_version = entity
                .get("version")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let live_version: i64 = conn.query_row(
                "SELECT version FROM codex_entry_phases WHERE id = ?1",
                params![entity_id],
                |row| row.get(0),
            )?;
            if live_version != expected_version {
                anyhow::bail!(
                    "NEX_COMMIT_PHASE_EDITED: phase '{entity_id}' was modified after commit"
                );
            }
            // Sticky / authorship preflight for create undo.
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "create" {
                super::phase_undo::ensure_no_external_phase_dependencies(conn, entity_id)?;
            }
        }
        "codex_semantic_binding" => {
            let expected_version = entity
                .get("version")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let live_version: i64 = conn.query_row(
                "SELECT version FROM codex_detail_semantic_bindings WHERE id = ?1",
                params![entity_id],
                |row| row.get(0),
            )?;
            if live_version != expected_version {
                anyhow::bail!(
                    "NEX_COMMIT_BINDING_EDITED: semantic binding '{entity_id}' was modified after commit"
                );
            }
        }
        other => anyhow::bail!("unsupported journal entity kind '{other}'"),
    }
    Ok(())
}

fn preflight_redo_entity(
    conn: &rusqlite::Connection,
    project_id: &str,
    entity: &Value,
) -> anyhow::Result<()> {
    let entity_kind = entity_kind(entity)?;
    let entity_id = entity_id(entity)?;
    match entity_kind {
        "event" => {
            // Create redo expects the event to be absent after undo.
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1 AND project_id = ?2",
                params![entity_id, project_id],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                exists == 0,
                "NEX_COMMIT_EVENT_EDITED: event '{entity_id}' still exists before redo"
            );
        }
        "codex_entry" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "patch" {
                let before = entity
                    .get("beforeSnapshot")
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("patch journal missing beforeSnapshot"))?;
                let live = collect_codex_entry_snapshot(conn, entity_id)?;
                ensure_patch_pre_redo_matches_before(&live, &before, entity_id)?;
            } else {
                let exists: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
                    params![entity_id, project_id],
                    |row| row.get(0),
                )?;
                anyhow::ensure!(
                    exists == 0,
                    "NEX_COMMIT_ENTRY_EDITED: entry '{entity_id}' still exists before redo"
                );
            }
        }
        "codex_relation" => {
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM codex_relations WHERE id = ?1 AND project_id = ?2",
                params![entity_id, project_id],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                exists == 0,
                "NEX_COMMIT_RELATION_EDITED: relation '{entity_id}' still exists before redo"
            );
        }
        other => anyhow::bail!("unsupported journal entity kind '{other}'"),
    }
    Ok(())
}

fn undo_one_entity(
    conn: &rusqlite::Connection,
    project_id: &str,
    entity: &Value,
    now: &str,
) -> anyhow::Result<()> {
    let entity_kind = entity_kind(entity)?;
    let entity_id = entity_id(entity)?;
    match entity_kind {
        "event" => {
            let live_version: i64 = conn.query_row(
                "SELECT version FROM events WHERE id = ?1 AND project_id = ?2",
                params![entity_id, project_id],
                |row| row.get(0),
            )?;
            delete_event_cascade(conn, project_id, entity_id, Some(live_version))?;
        }
        "codex_relation" => {
            let snapshot = entity
                .get("snapshot")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("journal entity missing snapshot"))?;
            delete_codex_relation_checked(conn, project_id, entity_id, &snapshot)?;
        }
        "codex_entry" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "patch" {
                let before = entity
                    .get("beforeSnapshot")
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("patch journal missing beforeSnapshot"))?;
                let expected_after_version = entity
                    .get("version")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| anyhow::anyhow!("journal patch missing version"))?;
                restore_codex_entry_patch(
                    conn,
                    project_id,
                    entity_id,
                    &before,
                    expected_after_version,
                    now,
                )?;
            } else {
                let expected_version = entity
                    .get("version")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| anyhow::anyhow!("journal create missing version"))?;
                undo_created_codex_entry(conn, project_id, entity_id, expected_version)?;
            }
        }
        "codex_detail_value" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "patch" {
                let before = entity
                    .get("beforeSnapshot")
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("detail patch journal missing beforeSnapshot"))?;
                let expected_after_version = entity
                    .get("version")
                    .and_then(Value::as_i64)
                    .unwrap_or(1);
                restore_detail_value_patch(
                    conn,
                    entity_id,
                    &before,
                    expected_after_version,
                    now,
                )?;
            } else {
                let expected_version = entity
                    .get("version")
                    .and_then(Value::as_i64)
                    .unwrap_or(1);
                undo_created_detail_value(conn, entity_id, expected_version)?;
            }
        }
        "codex_phase" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "patch" {
                let before = entity
                    .get("beforeSnapshot")
                    .cloned()
                    .ok_or_else(|| anyhow::anyhow!("phase patch journal missing beforeSnapshot"))?;
                let expected_after_version = entity
                    .get("version")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                restore_phase_patch(
                    conn,
                    entity_id,
                    &before,
                    expected_after_version,
                    now,
                )?;
            } else {
                let expected_version = entity
                    .get("version")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                undo_created_phase(conn, entity_id, expected_version)?;
            }
        }
        "codex_semantic_binding" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "patch" {
                let before = entity
                    .get("beforeSnapshot")
                    .cloned()
                    .ok_or_else(|| {
                        anyhow::anyhow!("binding patch journal missing beforeSnapshot")
                    })?;
                let expected_after_version = entity
                    .get("version")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                restore_semantic_binding_patch(
                    conn,
                    entity_id,
                    &before,
                    expected_after_version,
                    now,
                )?;
            } else {
                let expected_version = entity
                    .get("version")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                undo_created_semantic_binding(conn, entity_id, expected_version)?;
            }
        }
        other => anyhow::bail!("unsupported journal entity kind '{other}'"),
    }
    Ok(())
}

fn resolve_commit(
    conn: &rusqlite::Connection,
    payload: &UndoCommitPayload,
) -> anyhow::Result<CommitRow> {
    let row = if let Some(commit_id) = payload.commit_id.as_deref() {
        load_commit_by_id(conn, &payload.project_id, commit_id)?
    } else if let Some(request_id) = payload.request_id.as_deref() {
        load_commit_by_request(conn, &payload.project_id, request_id)?
    } else {
        anyhow::bail!("commitId or requestId is required");
    };
    row.ok_or_else(|| anyhow::anyhow!("narrative apply commit not found"))
}

fn update_journal_after(
    conn: &rusqlite::Connection,
    commit_id: &str,
    after_entities: &[Value],
    entity_bindings: &Value,
) -> anyhow::Result<()> {
    let after_json = if entity_bindings.is_null() {
        json!({ "entities": after_entities })
    } else {
        json!({ "entities": after_entities, "entityBindings": entity_bindings })
    };
    let updated = conn.execute(
        "UPDATE narrative_commit_journals
            SET after_json = ?1
          WHERE id = (
            SELECT id FROM narrative_commit_journals
             WHERE commit_id = ?2
             ORDER BY created_at DESC
             LIMIT 1
          )",
        params![after_json.to_string(), commit_id],
    )?;
    anyhow::ensure!(
        updated == 1,
        "commit journal not found for redo after-snapshot update"
    );
    Ok(())
}

fn load_journal_after(
    conn: &rusqlite::Connection,
    commit_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT after_json FROM narrative_commit_journals
          WHERE commit_id = ?1
          ORDER BY created_at DESC
          LIMIT 1",
        params![commit_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

fn journal_entities(after: &Value) -> anyhow::Result<Vec<Value>> {
    after
        .get("entities")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("commit journal missing entities"))
}

fn entity_id(entity: &Value) -> anyhow::Result<&str> {
    entity
        .get("entityId")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("journal entity missing entityId"))
}

fn entity_kind(entity: &Value) -> anyhow::Result<&str> {
    entity
        .get("entityKind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("journal entity missing entityKind"))
}

fn normalize_snapshot_for_compare(value: &Value) -> Value {
    let mut cloned = value.clone();
    if let Some(event_data) = cloned.get_mut("eventData").and_then(Value::as_object_mut) {
        event_data.remove("updatedAt");
        event_data.remove("createdAt");
    }
    cloned
}

fn update_receipt_status(
    conn: &rusqlite::Connection,
    commit: &CommitRow,
    status: &str,
    now: &str,
    change_event_uid: Option<&str>,
) -> anyhow::Result<Value> {
    let mut receipt = if let Some(raw) = commit.receipt_json.as_deref() {
        serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };
    if let Some(obj) = receipt.as_object_mut() {
        obj.insert("commitId".to_string(), Value::String(commit.commit_id.clone()));
        obj.insert("requestId".to_string(), Value::String(commit.request_id.clone()));
        obj.insert("planDigest".to_string(), Value::String(commit.plan_digest.clone()));
        obj.insert("status".to_string(), Value::String(status.to_string()));
        if let Some(uid) = change_event_uid {
            obj.insert("changeEventUid".to_string(), Value::String(uid.to_string()));
        }
    }

    conn.execute(
        "UPDATE narrative_apply_commits
            SET status = ?1,
                receipt_json = ?2,
                completed_at = ?3,
                version = version + 1
          WHERE id = ?4",
        params![status, receipt.to_string(), now, commit.commit_id],
    )?;
    Ok(receipt)
}
