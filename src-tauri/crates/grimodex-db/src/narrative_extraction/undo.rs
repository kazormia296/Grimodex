//! Atomic undo / redo for narrative apply commits (Chronicle + Codex).

use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use super::change_feed::{
    append_narrative_change_transaction_in_tx, application_ids_for_commit,
    events_from_journal_entities, transaction_id_for_source_event,
    AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind, NarrativeChangeOrigin,
};
use super::codex_undo::{
    delete_codex_relation_checked, ensure_patch_pre_redo_matches_before,
    reapply_codex_entry_create_snapshot, reapply_codex_relation_snapshot,
    restore_codex_entry_patch, undo_created_codex_entry,
};
use super::commit::{load_commit_by_id, CommitRow};
use super::detail_operations::collect_detail_value_snapshot;
use super::foreshadow_operations::collect_aggregate_snapshot;
use super::models::UndoCommitPayload;
use super::phase_operations::collect_phase_snapshot;
use super::phase_undo::{
    reapply_detail_value_create_snapshot, reapply_phase_create_snapshot,
    reapply_semantic_binding_create_snapshot, restore_detail_value_patch, restore_phase_patch,
    restore_semantic_binding_patch, undo_created_detail_value, undo_created_phase,
    undo_created_semantic_binding,
};
use super::plot_thread_undo::{
    reapply_plot_branch_create_snapshot, reapply_plot_marker_create_snapshot,
    reapply_plot_thread_create_snapshot, restore_plot_thread_patch, undo_created_plot_branch,
    undo_created_plot_marker, undo_created_plot_thread,
};
use super::repository::validate_current_chronicle_live_catalog;
use super::semantic_bindings::collect_semantic_binding_snapshot;
use super::task_leases::with_immediate_transaction;
use super::temporal_undo::{
    reapply_constraint_create_snapshot, reapply_node_ensure_snapshot,
    reapply_projection_create_snapshot, restore_event_chronicle_patch, restore_projection_patch,
    restore_scene_chronicle_patch, restore_scene_story_order_patch, undo_created_constraint,
    undo_created_node, undo_created_projection,
};
use crate::agent_writes::{
    apply_event_snapshot, collect_codex_entry_snapshot, collect_event_snapshot,
    delete_event_cascade,
};
use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::idempotency::{
    insert_idempotent_response, load_idempotent_response, payload_fingerprint, IdempotencyRequest,
};
use crate::narrative_runtime_policy::{
    require_narrative_redo_allowed, require_narrative_undo_allowed,
};
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

impl UndoDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Undo => "undo",
            Self::Redo => "redo",
        }
    }

    fn idempotency_domain(self) -> &'static str {
        match self {
            Self::Undo => "narrative_commit_undo",
            Self::Redo => "narrative_commit_redo",
        }
    }

    fn conflict_marker(self) -> &'static str {
        match self {
            Self::Undo => "NEX_COMMIT_UNDO_IDEMPOTENCY_CONFLICT",
            Self::Redo => "NEX_COMMIT_REDO_IDEMPOTENCY_CONFLICT",
        }
    }
}

fn mutate_commit(
    db: &Database,
    payload: &UndoCommitPayload,
    direction: UndoDirection,
) -> anyhow::Result<Value> {
    let action_request_id = payload
        .request_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("requestId is required for narrative commit replay"))?;
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let timestamp = Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        with_immediate_transaction(conn, |conn| {
            let commit = resolve_commit(conn, payload)?;
            let request_hash = payload_fingerprint(
                direction.idempotency_domain(),
                &json!({
                    "projectId": &payload.project_id,
                    "commitId": &commit.commit_id,
                    "direction": direction.as_str(),
                }),
            )?;
            let idempotency_request = IdempotencyRequest {
                domain: direction.idempotency_domain(),
                request_id: Some(action_request_id),
                payload_hash: &request_hash,
                conflict_marker: direction.conflict_marker(),
            };
            if let Some(response) = load_idempotent_response(conn, &idempotency_request)? {
                return Ok(response);
            }
            match direction {
                UndoDirection::Undo => require_narrative_undo_allowed(conn)?,
                UndoDirection::Redo => require_narrative_redo_allowed(conn)?,
            }
            let (journal_id, journal_after) = load_journal_after(conn, &commit.commit_id)?;
            let entities = journal_entities(&journal_after)?;
            let application_ids =
                application_ids_for_commit(conn, &payload.project_id, &commit.commit_id)?;
            let parsed_receipt = commit
                .receipt_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
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

                    // Legacy commits may not yet have their root Forward
                    // maintenance transaction. Materialize it while the
                    // post-apply objects are still live so Feed ownership
                    // validation can prove their project scope.
                    let original_transaction_id = ensure_original_maintenance_transaction(
                        conn,
                        &payload.project_id,
                        &commit,
                        &journal_id,
                        &entities,
                        &application_ids,
                        parsed_receipt.as_ref(),
                    )?;

                    // Reverse order: relations first, then entry delete/patch restore, then events.
                    let mut scene_scope_refresh_events = Vec::new();
                    for entity in entities.iter().rev() {
                        undo_one_entity(
                            conn,
                            &payload.project_id,
                            entity,
                            &now,
                            &mut scene_scope_refresh_events,
                        )?;
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
                        } else if kind == "foreshadow" && op_kind == "patch" {
                            let live =
                                collect_aggregate_snapshot(conn, &payload.project_id, id)?;
                            let live_version = live
                                .get("version")
                                .and_then(Value::as_i64)
                                .ok_or_else(|| {
                                    anyhow::anyhow!(
                                        "foreshadow aggregate snapshot missing version after undo"
                                    )
                                })?;
                            if let Some(obj) = row.as_object_mut() {
                                obj.insert("version".to_string(), Value::from(live_version));
                                // Keep `snapshot` as the post-apply target. The live
                                // aggregate is the OCC baseline for the next redo.
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
                    let canonical_append = append_change_events_in_tx(
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
                                "requestId": action_request_id,
                                "applyRequestId": commit.request_id,
                            })
                            .to_string(),
                            timestamp,
                        }],
                    )?;
                    anyhow::ensure!(
                        canonical_append.inserted_count == 1,
                        "NEX_CHANGE_EVENT_CORRELATION_FAILED: canonical undo event was not appended"
                    );
                    let mut maintenance_events = events_from_journal_entities(
                        &after_entities,
                        NarrativeChangeCauseKind::Undo,
                    )?;
                    maintenance_events.extend(scene_scope_refresh_events);
                    let maintenance_transaction = if maintenance_events.is_empty() {
                        None
                    } else {
                        let original_transaction_id =
                            original_transaction_id.as_ref().ok_or_else(|| {
                                anyhow::anyhow!(
                                    "maintenance Undo requires a root forward transaction"
                                )
                            })?;
                        Some(append_narrative_change_transaction_in_tx(
                            conn,
                            &AppendNarrativeChangeTransactionInput {
                                project_id: payload.project_id.clone(),
                                request_id: action_request_id.to_string(),
                                source_domain: "narrative.commit.undo".to_string(),
                                source_change_event_uid: change_uid.clone(),
                                cause_kind: NarrativeChangeCauseKind::Undo,
                                origin: NarrativeChangeOrigin::Undo,
                                original_transaction_id: Some(original_transaction_id.clone()),
                                commit_id: Some(commit.commit_id.clone()),
                                journal_id: Some(journal_id.clone()),
                                undo_journal_id: None,
                                application_ids: application_ids.clone(),
                                occurred_at: now.clone(),
                                events: maintenance_events,
                            },
                        )?)
                    };

                    let receipt = update_receipt_status(
                        conn,
                        &commit,
                        STATUS_UNDONE,
                        &now,
                        Some(&change_uid),
                        maintenance_transaction
                            .as_ref()
                            .map(|transaction| transaction.transaction_id.as_str()),
                        original_transaction_id.as_deref(),
                    )?;
                    insert_idempotent_response(
                        conn,
                        &idempotency_request,
                        &payload.project_id,
                        &receipt,
                    )?;
                    Ok(receipt)
                }
                UndoDirection::Redo => {
                    anyhow::ensure!(
                        commit.status == STATUS_UNDONE,
                        "NEX_COMMIT_NOT_REDOABLE: status is '{}'",
                        commit.status
                    );

                    // Undo removes Event creates made by the original
                    // Chronicle Apply, so an unchanged workspace is once
                    // again byte-identical to the Run's sealed match catalog.
                    // Recheck that catalog under this Redo transaction before
                    // restoring any journal entity. This blocks a different-id
                    // duplicate added after Undo while preserving a legitimate
                    // Redo of the original Event.
                    if let Some(run_id) = commit.run_id.as_deref() {
                        validate_current_chronicle_live_catalog(
                            conn,
                            &payload.project_id,
                            run_id,
                        )?;
                    }

                    // Preflight: current state must still match the post-Undo expectation
                    // before we re-apply after-snapshots (especially patch summary/aliases).
                    for entity in &entities {
                        preflight_redo_entity(conn, &payload.project_id, entity)?;
                    }

                    let mut restored = Vec::new();
                    let mut scene_scope_refresh_events = Vec::new();
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
                            "temporal_node" => {
                                let op_kind = entity
                                    .get("opKind")
                                    .and_then(Value::as_str)
                                    .unwrap_or("create");
                                let replay_version = if op_kind == "ensure-existing" {
                                    conn.query_row(
                                        "SELECT version FROM narrative_temporal_nodes WHERE id = ?1",
                                        params![entity_id],
                                        |row| row.get(0),
                                    )?
                                } else {
                                    reapply_node_ensure_snapshot(
                                        conn,
                                        &payload.project_id,
                                        &snapshot,
                                        &now,
                                    )?
                                };
                                (replay_version, snapshot.clone())
                            }
                            "temporal_constraint" => {
                                let replay_version = reapply_constraint_create_snapshot(
                                    conn,
                                    &payload.project_id,
                                    &snapshot,
                                    &now,
                                )?;
                                (replay_version, snapshot.clone())
                            }
                            "temporal_scene_chronicle" => {
                                let live_version: i64 = conn.query_row(
                                    "SELECT version FROM tree_nodes WHERE id = ?1",
                                    params![entity_id],
                                    |row| row.get(0),
                                )?;
                                let (replay_version, scope_refresh_event) =
                                    restore_scene_chronicle_patch(
                                        conn,
                                        entity_id,
                                        &snapshot,
                                        live_version,
                                        &now,
                                    )?;
                                scene_scope_refresh_events.push(scope_refresh_event);
                                (replay_version, snapshot.clone())
                            }
                            "temporal_event_chronicle" => {
                                let live_version: i64 = conn.query_row(
                                    "SELECT version FROM events WHERE id = ?1",
                                    params![entity_id],
                                    |row| row.get(0),
                                )?;
                                let replay_version = restore_event_chronicle_patch(
                                    conn,
                                    entity_id,
                                    &snapshot,
                                    live_version,
                                    &now,
                                )?;
                                (replay_version, snapshot.clone())
                            }
                            "temporal_scene_story_order" => {
                                let live_version: i64 = conn.query_row(
                                    "SELECT version FROM tree_nodes WHERE id = ?1",
                                    params![entity_id],
                                    |row| row.get(0),
                                )?;
                                let (replay_version, scope_refresh_event) =
                                    restore_scene_story_order_patch(
                                        conn,
                                        entity_id,
                                        &snapshot,
                                        live_version,
                                        &now,
                                    )?;
                                scene_scope_refresh_events.push(scope_refresh_event);
                                (replay_version, snapshot.clone())
                            }
                            "temporal_projection" => {
                                let op_kind = entity
                                    .get("opKind")
                                    .and_then(Value::as_str)
                                    .unwrap_or("create");
                                let replay_version = if op_kind == "patch" {
                                    let live_version: i64 = conn.query_row(
                                        "SELECT version FROM narrative_temporal_projections WHERE id = ?1",
                                        params![entity_id],
                                        |row| row.get(0),
                                    )?;
                                    restore_projection_patch(
                                        conn,
                                        entity_id,
                                        &snapshot,
                                        live_version,
                                        &now,
                                    )?
                                } else {
                                    reapply_projection_create_snapshot(
                                        conn,
                                        &payload.project_id,
                                        &snapshot,
                                        &now,
                                    )?
                                };
                                (replay_version, snapshot.clone())
                            }
                            "plot_thread" => {
                                let op_kind = entity
                                    .get("opKind")
                                    .and_then(Value::as_str)
                                    .unwrap_or("create");
                                let replay_version = if op_kind == "patch" {
                                    let live_version: i64 = conn.query_row(
                                        "SELECT version FROM plot_threads WHERE id = ?1 AND project_id = ?2",
                                        params![entity_id, payload.project_id],
                                        |row| row.get(0),
                                    )?;
                                    let description = snapshot
                                        .get("description")
                                        .and_then(Value::as_str);
                                    let next = live_version
                                        .checked_add(1)
                                        .ok_or_else(|| {
                                            anyhow::anyhow!(
                                                "plot thread version overflow during redo"
                                            )
                                        })?;
                                    let updated = conn.execute(
                                        "UPDATE plot_threads
                                            SET description = ?1,
                                                version = ?2,
                                                updated_at = ?3
                                          WHERE id = ?4 AND project_id = ?5 AND version = ?6",
                                        params![
                                            description,
                                            next,
                                            now,
                                            entity_id,
                                            payload.project_id,
                                            live_version
                                        ],
                                    )?;
                                    anyhow::ensure!(
                                        updated == 1,
                                        "NEX_COMMIT_PLOT_THREAD_EDITED: thread '{entity_id}' redo conflict"
                                    );
                                    next
                                } else {
                                    reapply_plot_thread_create_snapshot(
                                        conn,
                                        &payload.project_id,
                                        &snapshot,
                                        &now,
                                    )?
                                };
                                (replay_version, snapshot.clone())
                            }
                            "plot_thread_marker" => {
                                let replay_version =
                                    reapply_plot_marker_create_snapshot(conn, &snapshot, &now)?;
                                (replay_version, snapshot.clone())
                            }
                            "plot_thread_branch" => {
                                let replay_version =
                                    reapply_plot_branch_create_snapshot(conn, &snapshot, &now)?;
                                (replay_version, snapshot.clone())
                            }
                            "foreshadow" => {
                                let op_kind = entity
                                    .get("opKind")
                                    .and_then(Value::as_str)
                                    .unwrap_or("create");
                                let previous_version = entity
                                    .get("version")
                                    .and_then(Value::as_i64)
                                    .ok_or_else(|| {
                                        anyhow::anyhow!(
                                            "journal foreshadow missing replay version"
                                        )
                                    })?;
                                let replay_version = if op_kind == "patch" {
                                    super::foreshadow_undo::restore_patch(
                                        conn,
                                        &payload.project_id,
                                        entity_id,
                                        &snapshot,
                                        previous_version,
                                        &now,
                                    )?
                                } else {
                                    super::foreshadow_undo::reapply_created_snapshot(
                                        conn,
                                        &payload.project_id,
                                        entity_id,
                                        &snapshot,
                                        previous_version,
                                        &now,
                                    )?
                                };
                                let live_snapshot = collect_aggregate_snapshot(
                                    conn,
                                    &payload.project_id,
                                    entity_id,
                                )?;
                                (replay_version, live_snapshot)
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

                    // During Redo, entities created by the original commit do
                    // not exist until replay has completed. Defer legacy root
                    // materialization until now so live ownership validation
                    // observes the restored aggregate. This remains atomic
                    // with the replay and rolls back on any later failure.
                    let original_transaction_id = ensure_original_maintenance_transaction(
                        conn,
                        &payload.project_id,
                        &commit,
                        &journal_id,
                        &after_entities,
                        &application_ids,
                        parsed_receipt.as_ref(),
                    )?;

                    let change_uid = Uuid::new_v4().to_string();
                    let canonical_append = append_change_events_in_tx(
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
                                "requestId": action_request_id,
                                "applyRequestId": commit.request_id,
                                "restored": restored,
                            })
                            .to_string(),
                            timestamp,
                        }],
                    )?;
                    anyhow::ensure!(
                        canonical_append.inserted_count == 1,
                        "NEX_CHANGE_EVENT_CORRELATION_FAILED: canonical redo event was not appended"
                    );
                    let mut maintenance_events = events_from_journal_entities(
                        &after_entities,
                        NarrativeChangeCauseKind::Redo,
                    )?;
                    maintenance_events.extend(scene_scope_refresh_events);
                    let maintenance_transaction = if maintenance_events.is_empty() {
                        None
                    } else {
                        let original_transaction_id =
                            original_transaction_id.as_ref().ok_or_else(|| {
                                anyhow::anyhow!(
                                    "maintenance Redo requires a root forward transaction"
                                )
                            })?;
                        Some(append_narrative_change_transaction_in_tx(
                            conn,
                            &AppendNarrativeChangeTransactionInput {
                                project_id: payload.project_id.clone(),
                                request_id: action_request_id.to_string(),
                                source_domain: "narrative.commit.redo".to_string(),
                                source_change_event_uid: change_uid.clone(),
                                cause_kind: NarrativeChangeCauseKind::Redo,
                                origin: NarrativeChangeOrigin::Redo,
                                original_transaction_id: Some(original_transaction_id.clone()),
                                commit_id: Some(commit.commit_id.clone()),
                                journal_id: Some(journal_id.clone()),
                                undo_journal_id: None,
                                application_ids: application_ids.clone(),
                                occurred_at: now.clone(),
                                events: maintenance_events,
                            },
                        )?)
                    };

                    let receipt = update_receipt_status(
                        conn,
                        &commit,
                        STATUS_REDONE,
                        &now,
                        Some(&change_uid),
                        maintenance_transaction
                            .as_ref()
                            .map(|transaction| transaction.transaction_id.as_str()),
                        original_transaction_id.as_deref(),
                    )?;
                    insert_idempotent_response(
                        conn,
                        &idempotency_request,
                        &payload.project_id,
                        &receipt,
                    )?;
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
                anyhow::bail!(
                    "NEX_COMMIT_EVENT_EDITED: event '{entity_id}' was modified after commit"
                );
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
            let current =
                super::codex_operations::collect_codex_relation_snapshot(conn, entity_id)?;
            if current.get("version") != expected.get("version")
                || current.get("semanticKey") != expected.get("semanticKey")
            {
                anyhow::bail!(
                    "NEX_COMMIT_RELATION_EDITED: relation '{entity_id}' was modified after commit"
                );
            }
        }
        "codex_detail_value" => {
            let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(1);
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
            let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
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
            let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
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
        "temporal_node" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "ensure-existing" {
                // Node pre-existed before this commit; nothing to preflight.
                return Ok(());
            }
            let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
            let live_version: i64 = conn.query_row(
                "SELECT version FROM narrative_temporal_nodes WHERE id = ?1",
                params![entity_id],
                |row| row.get(0),
            )?;
            if live_version != expected_version {
                anyhow::bail!(
                    "NEX_COMMIT_TEMPORAL_NODE_EDITED: node '{entity_id}' was modified after commit"
                );
            }
        }
        "temporal_constraint" => {
            let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
            let live_version: i64 = conn.query_row(
                "SELECT version FROM narrative_temporal_constraints WHERE id = ?1",
                params![entity_id],
                |row| row.get(0),
            )?;
            if live_version != expected_version {
                anyhow::bail!(
                    "NEX_COMMIT_TEMPORAL_CONSTRAINT_EDITED: constraint '{entity_id}' was modified after commit"
                );
            }
        }
        "temporal_scene_chronicle" | "temporal_scene_story_order" => {
            let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
            let live_version: i64 = conn.query_row(
                "SELECT version FROM tree_nodes WHERE id = ?1",
                params![entity_id],
                |row| row.get(0),
            )?;
            if live_version != expected_version {
                anyhow::bail!(
                    "NEX_COMMIT_SCENE_EDITED: scene '{entity_id}' was modified after commit"
                );
            }
        }
        "temporal_event_chronicle" => {
            let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
            let live_version: i64 = conn.query_row(
                "SELECT version FROM events WHERE id = ?1",
                params![entity_id],
                |row| row.get(0),
            )?;
            if live_version != expected_version {
                anyhow::bail!(
                    "NEX_COMMIT_EVENT_EDITED: event '{entity_id}' was modified after commit"
                );
            }
        }
        "temporal_projection" => {
            let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
            let live_version: i64 = conn.query_row(
                "SELECT version FROM narrative_temporal_projections WHERE id = ?1",
                params![entity_id],
                |row| row.get(0),
            )?;
            if live_version != expected_version {
                anyhow::bail!(
                    "NEX_COMMIT_TEMPORAL_PROJECTION_EDITED: projection '{entity_id}' was modified after commit"
                );
            }
        }
        "plot_thread" => {
            let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
            let live_version: i64 = conn.query_row(
                "SELECT version FROM plot_threads WHERE id = ?1 AND project_id = ?2",
                params![entity_id, project_id],
                |row| row.get(0),
            )?;
            if live_version != expected_version {
                anyhow::bail!(
                    "NEX_COMMIT_PLOT_THREAD_EDITED: thread '{entity_id}' was modified after commit"
                );
            }
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "create" {
                super::plot_thread_undo::ensure_no_external_plot_thread_dependencies(
                    conn, entity_id,
                )?;
            }
        }
        "plot_thread_marker" => {
            let expected = entity
                .get("snapshot")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("journal entity missing snapshot"))?;
            let expected_version = expected.get("version").and_then(Value::as_i64).unwrap_or(0);
            let expected_semantic_key = expected
                .get("semanticKey")
                .and_then(Value::as_str)
                .unwrap_or("");
            let current =
                super::plot_thread_operations::collect_plot_marker_snapshot(conn, entity_id)?;
            if current.get("version") != expected.get("version")
                || current
                    .get("semanticKey")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    != expected_semantic_key
            {
                anyhow::bail!(
                    "NEX_COMMIT_PLOT_MARKER_EDITED: marker '{entity_id}' was modified after commit"
                );
            }
            let _ = expected_version;
        }
        "plot_thread_branch" => {
            let expected = entity
                .get("snapshot")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("journal entity missing snapshot"))?;
            let expected_semantic_key = expected
                .get("semanticKey")
                .and_then(Value::as_str)
                .unwrap_or("");
            let current =
                super::plot_thread_operations::collect_plot_branch_snapshot(conn, entity_id)?;
            if current.get("version") != expected.get("version")
                || current
                    .get("semanticKey")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    != expected_semantic_key
            {
                anyhow::bail!(
                    "NEX_COMMIT_PLOT_BRANCH_EDITED: branch '{entity_id}' was modified after commit"
                );
            }
        }
        "foreshadow" => {
            let expected_version = entity
                .get("version")
                .and_then(Value::as_i64)
                .ok_or_else(|| anyhow::anyhow!("journal foreshadow missing version"))?;
            let expected = entity
                .get("snapshot")
                .ok_or_else(|| anyhow::anyhow!("journal foreshadow missing snapshot"))?;
            super::foreshadow_undo::ensure_matches_snapshot(
                conn,
                project_id,
                entity_id,
                expected,
                expected_version,
            )?;
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
        "foreshadow" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "patch" {
                let expected_version = entity
                    .get("version")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| anyhow::anyhow!("journal foreshadow missing version"))?;
                let before = entity.get("beforeSnapshot").ok_or_else(|| {
                    anyhow::anyhow!("foreshadow patch journal missing beforeSnapshot")
                })?;
                super::foreshadow_undo::ensure_matches_snapshot(
                    conn,
                    project_id,
                    entity_id,
                    before,
                    expected_version,
                )?;
            } else {
                let snapshot = entity
                    .get("snapshot")
                    .ok_or_else(|| anyhow::anyhow!("journal foreshadow missing snapshot"))?;
                super::foreshadow_undo::ensure_absent_for_redo(
                    conn, project_id, entity_id, snapshot,
                )?;
            }
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
    scene_scope_refresh_events: &mut Vec<super::change_feed::NarrativeChangeEventInput>,
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
                let before = entity.get("beforeSnapshot").cloned().ok_or_else(|| {
                    anyhow::anyhow!("detail patch journal missing beforeSnapshot")
                })?;
                let expected_after_version =
                    entity.get("version").and_then(Value::as_i64).unwrap_or(1);
                restore_detail_value_patch(conn, entity_id, &before, expected_after_version, now)?;
            } else {
                let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(1);
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
                let expected_after_version =
                    entity.get("version").and_then(Value::as_i64).unwrap_or(0);
                restore_phase_patch(conn, entity_id, &before, expected_after_version, now)?;
            } else {
                let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
                undo_created_phase(conn, entity_id, expected_version)?;
            }
        }
        "codex_semantic_binding" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "patch" {
                let before = entity.get("beforeSnapshot").cloned().ok_or_else(|| {
                    anyhow::anyhow!("binding patch journal missing beforeSnapshot")
                })?;
                let expected_after_version =
                    entity.get("version").and_then(Value::as_i64).unwrap_or(0);
                restore_semantic_binding_patch(
                    conn,
                    entity_id,
                    &before,
                    expected_after_version,
                    now,
                )?;
            } else {
                let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
                undo_created_semantic_binding(conn, entity_id, expected_version)?;
            }
        }
        "temporal_node" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind != "ensure-existing" {
                let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
                undo_created_node(conn, entity_id, expected_version)?;
            }
        }
        "temporal_constraint" => {
            let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
            undo_created_constraint(conn, entity_id, expected_version)?;
        }
        "temporal_scene_chronicle" => {
            let before = entity.get("beforeSnapshot").cloned().ok_or_else(|| {
                anyhow::anyhow!("scene chronicle patch journal missing beforeSnapshot")
            })?;
            let expected_after_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
            let (_, scope_refresh_event) = restore_scene_chronicle_patch(
                conn,
                entity_id,
                &before,
                expected_after_version,
                now,
            )?;
            scene_scope_refresh_events.push(scope_refresh_event);
        }
        "temporal_event_chronicle" => {
            let before = entity.get("beforeSnapshot").cloned().ok_or_else(|| {
                anyhow::anyhow!("event chronicle patch journal missing beforeSnapshot")
            })?;
            let expected_after_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
            restore_event_chronicle_patch(conn, entity_id, &before, expected_after_version, now)?;
        }
        "temporal_scene_story_order" => {
            let before = entity.get("beforeSnapshot").cloned().ok_or_else(|| {
                anyhow::anyhow!("scene story-order patch journal missing beforeSnapshot")
            })?;
            let expected_after_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
            let (_, scope_refresh_event) = restore_scene_story_order_patch(
                conn,
                entity_id,
                &before,
                expected_after_version,
                now,
            )?;
            scene_scope_refresh_events.push(scope_refresh_event);
        }
        "temporal_projection" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "patch" {
                let before = entity.get("beforeSnapshot").cloned().ok_or_else(|| {
                    anyhow::anyhow!("projection patch journal missing beforeSnapshot")
                })?;
                let expected_after_version =
                    entity.get("version").and_then(Value::as_i64).unwrap_or(0);
                restore_projection_patch(conn, entity_id, &before, expected_after_version, now)?;
            } else {
                let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
                undo_created_projection(conn, entity_id, expected_version)?;
            }
        }
        "plot_thread" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            if op_kind == "patch" {
                let before = entity.get("beforeSnapshot").cloned().ok_or_else(|| {
                    anyhow::anyhow!("plot thread patch journal missing beforeSnapshot")
                })?;
                let expected_after_version =
                    entity.get("version").and_then(Value::as_i64).unwrap_or(0);
                restore_plot_thread_patch(conn, entity_id, &before, expected_after_version, now)?;
            } else {
                let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
                undo_created_plot_thread(conn, entity_id, expected_version)?;
            }
        }
        "plot_thread_marker" => {
            let snapshot = entity
                .get("snapshot")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("journal entity missing snapshot"))?;
            let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
            let semantic_key = snapshot
                .get("semanticKey")
                .and_then(Value::as_str)
                .unwrap_or("");
            undo_created_plot_marker(conn, entity_id, expected_version, semantic_key)?;
        }
        "plot_thread_branch" => {
            let snapshot = entity
                .get("snapshot")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("journal entity missing snapshot"))?;
            let expected_version = entity.get("version").and_then(Value::as_i64).unwrap_or(0);
            let semantic_key = snapshot
                .get("semanticKey")
                .and_then(Value::as_str)
                .unwrap_or("");
            undo_created_plot_branch(conn, entity_id, expected_version, semantic_key)?;
        }
        "foreshadow" => {
            let op_kind = entity
                .get("opKind")
                .and_then(Value::as_str)
                .unwrap_or("create");
            let expected_version = entity
                .get("version")
                .and_then(Value::as_i64)
                .ok_or_else(|| anyhow::anyhow!("journal foreshadow missing version"))?;
            if op_kind == "patch" {
                let before = entity.get("beforeSnapshot").cloned().ok_or_else(|| {
                    anyhow::anyhow!("foreshadow patch journal missing beforeSnapshot")
                })?;
                super::foreshadow_undo::restore_patch(
                    conn,
                    project_id,
                    entity_id,
                    &before,
                    expected_version,
                    now,
                )?;
            } else {
                super::foreshadow_undo::undo_created(
                    conn,
                    project_id,
                    entity_id,
                    expected_version,
                )?;
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
    let commit_id = payload
        .commit_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("commitId is required"))?;
    let row = load_commit_by_id(conn, &payload.project_id, commit_id)?;
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
) -> anyhow::Result<(String, Value)> {
    let (journal_id, raw): (String, String) = conn.query_row(
        "SELECT id, after_json FROM narrative_commit_journals
          WHERE commit_id = ?1
          ORDER BY created_at DESC
          LIMIT 1",
        params![commit_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    Ok((journal_id, serde_json::from_str(&raw)?))
}

fn journal_entities(after: &Value) -> anyhow::Result<Vec<Value>> {
    after
        .get("entities")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("commit journal missing entities"))
}

/// SCHEMA 20 workspaces can contain commits that predate the maintenance feed.
/// Lazily materialize their root forward transaction from the immutable commit
/// journal and canonical apply event before recording the first post-upgrade
/// Undo/Redo. The backfill shares the mutation transaction, so a later failure
/// cannot leave a partial lineage behind.
fn ensure_original_maintenance_transaction(
    conn: &rusqlite::Connection,
    project_id: &str,
    commit: &CommitRow,
    journal_id: &str,
    entities: &[Value],
    application_ids: &[String],
    receipt: Option<&Value>,
) -> anyhow::Result<Option<String>> {
    let original_transaction_id = ensure_original_maintenance_root_transaction(
        conn,
        project_id,
        commit,
        journal_id,
        entities,
        application_ids,
        receipt,
    )?;
    if commit.status == STATUS_UNDONE {
        if let Some(original_transaction_id) = original_transaction_id.as_deref() {
            ensure_historical_undo_maintenance_transaction(
                conn,
                project_id,
                commit,
                journal_id,
                entities,
                application_ids,
                original_transaction_id,
            )?;
        }
    }
    Ok(original_transaction_id)
}

fn ensure_original_maintenance_root_transaction(
    conn: &rusqlite::Connection,
    project_id: &str,
    commit: &CommitRow,
    journal_id: &str,
    entities: &[Value],
    application_ids: &[String],
    receipt: Option<&Value>,
) -> anyhow::Result<Option<String>> {
    let forward_events = events_from_journal_entities(entities, NarrativeChangeCauseKind::Forward)?;
    if forward_events.is_empty() {
        return Ok(None);
    }

    if let Some(transaction_id) = receipt
        .and_then(|receipt| receipt.get("maintenanceOriginalTransactionId"))
        .and_then(Value::as_str)
    {
        anyhow::ensure!(
            is_matching_original_maintenance_transaction(
                conn,
                project_id,
                &commit.commit_id,
                journal_id,
                transaction_id,
            )?,
            "maintenance original transaction does not match the commit root"
        );
        return Ok(Some(transaction_id.to_string()));
    }
    if let Some(transaction_id) = receipt
        .and_then(|receipt| receipt.get("maintenanceTransactionId"))
        .and_then(Value::as_str)
    {
        if is_matching_original_maintenance_transaction(
            conn,
            project_id,
            &commit.commit_id,
            journal_id,
            transaction_id,
        )? {
            return Ok(Some(transaction_id.to_string()));
        }
    }

    // A SCHEMA 20 receipt's changeEventUid identifies its latest operation.
    // After an Undo or Redo that UID is not the root apply event, so recover
    // the root strictly from canonical commit identity instead.
    let source_change_event_uid: String = conn.query_row(
        "SELECT event_uid
           FROM change_events
          WHERE project_id = ?1
            AND op_type = 'narrative.commit.apply'
            AND entity_type = 'narrative_apply_commit'
            AND entity_id = ?2
            AND event_uid IS NOT NULL
          ORDER BY sequence ASC
          LIMIT 1",
        params![project_id, commit.commit_id],
        |row| row.get(0),
    )?;

    if let Some(transaction_id) =
        transaction_id_for_source_event(conn, project_id, &source_change_event_uid)?
    {
        anyhow::ensure!(
            is_matching_original_maintenance_transaction(
                conn,
                project_id,
                &commit.commit_id,
                journal_id,
                &transaction_id,
            )?,
            "maintenance transaction for canonical apply event does not match the commit root"
        );
        return Ok(Some(transaction_id));
    }

    let result = append_narrative_change_transaction_in_tx(
        conn,
        &AppendNarrativeChangeTransactionInput {
            project_id: project_id.to_string(),
            request_id: commit.request_id.clone(),
            source_domain: "narrative.commit.apply".to_string(),
            source_change_event_uid,
            cause_kind: NarrativeChangeCauseKind::Forward,
            origin: NarrativeChangeOrigin::AiApply,
            original_transaction_id: None,
            commit_id: Some(commit.commit_id.clone()),
            journal_id: Some(journal_id.to_string()),
            undo_journal_id: None,
            application_ids: application_ids.to_vec(),
            occurred_at: commit
                .completed_at
                .clone()
                .unwrap_or_else(|| commit.created_at.clone()),
            events: forward_events,
        },
    )?;
    Ok(Some(result.transaction_id))
}

/// A pre-Feed commit can already be undone when it is first replayed after
/// migration. Backfilling only its original Forward transaction would leave
/// the Feed head at the post-apply state, so the next Redo (absent -> live)
/// would be discontinuous. Reconstruct the canonical historical Undo as well
/// before appending the new Redo transaction.
fn ensure_historical_undo_maintenance_transaction(
    conn: &rusqlite::Connection,
    project_id: &str,
    commit: &CommitRow,
    journal_id: &str,
    entities: &[Value],
    application_ids: &[String],
    original_transaction_id: &str,
) -> anyhow::Result<()> {
    let historical_undo: Option<(String, String, i64)> = conn
        .query_row(
            "SELECT event_uid, payload, timestamp
               FROM change_events
              WHERE project_id = ?1
                AND op_type = 'narrative.commit.undo'
                AND entity_type = 'narrative_apply_commit'
                AND entity_id = ?2
                AND event_uid IS NOT NULL
              ORDER BY sequence DESC
              LIMIT 1",
            params![project_id, commit.commit_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((source_change_event_uid, raw_payload, timestamp)) = historical_undo else {
        anyhow::bail!(
            "undone narrative commit '{}' has no canonical Undo event for maintenance backfill",
            commit.commit_id
        );
    };

    if let Some(existing_transaction_id) =
        transaction_id_for_source_event(conn, project_id, &source_change_event_uid)?
    {
        let matches: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1
                  FROM narrative_change_transactions
                 WHERE project_id = ?1
                   AND id = ?2
                   AND cause_kind = 'undo'
                   AND original_transaction_id = ?3
                   AND commit_id = ?4
                   AND journal_id = ?5
            )",
            params![
                project_id,
                existing_transaction_id,
                original_transaction_id,
                commit.commit_id,
                journal_id
            ],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            matches,
            "maintenance transaction for canonical Undo event does not match the commit lineage"
        );
        return Ok(());
    }

    let undo_events = events_from_journal_entities(entities, NarrativeChangeCauseKind::Undo)?;
    if undo_events.is_empty() {
        return Ok(());
    }
    let canonical_payload = serde_json::from_str::<Value>(&raw_payload).unwrap_or(Value::Null);
    let request_id = canonical_payload
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("legacy-undo-{source_change_event_uid}"));
    let occurred_at = chrono::DateTime::<Utc>::from_timestamp_millis(timestamp)
        .map(|value| value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .unwrap_or_else(|| commit.created_at.clone());

    append_narrative_change_transaction_in_tx(
        conn,
        &AppendNarrativeChangeTransactionInput {
            project_id: project_id.to_string(),
            request_id,
            source_domain: "narrative.commit.undo".to_string(),
            source_change_event_uid,
            cause_kind: NarrativeChangeCauseKind::Undo,
            origin: NarrativeChangeOrigin::Undo,
            original_transaction_id: Some(original_transaction_id.to_string()),
            commit_id: Some(commit.commit_id.clone()),
            journal_id: Some(journal_id.to_string()),
            undo_journal_id: None,
            application_ids: application_ids.to_vec(),
            occurred_at,
            events: undo_events,
        },
    )?;
    Ok(())
}

fn is_matching_original_maintenance_transaction(
    conn: &rusqlite::Connection,
    project_id: &str,
    commit_id: &str,
    journal_id: &str,
    transaction_id: &str,
) -> anyhow::Result<bool> {
    let row: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT cause_kind, commit_id, journal_id
               FROM narrative_change_transactions
              WHERE project_id = ?1 AND id = ?2",
            params![project_id, transaction_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    Ok(matches!(
        row,
        Some((cause_kind, Some(stored_commit_id), Some(stored_journal_id)))
            if cause_kind == "forward"
                && stored_commit_id == commit_id
                && stored_journal_id == journal_id
    ))
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
    maintenance_transaction_id: Option<&str>,
    maintenance_original_transaction_id: Option<&str>,
) -> anyhow::Result<Value> {
    let mut receipt = if let Some(raw) = commit.receipt_json.as_deref() {
        serde_json::from_str::<Value>(raw).unwrap_or_else(|_| json!({}))
    } else {
        json!({})
    };
    if let Some(obj) = receipt.as_object_mut() {
        obj.insert(
            "commitId".to_string(),
            Value::String(commit.commit_id.clone()),
        );
        obj.insert(
            "requestId".to_string(),
            Value::String(commit.request_id.clone()),
        );
        obj.insert(
            "planDigest".to_string(),
            Value::String(commit.plan_digest.clone()),
        );
        obj.insert("status".to_string(), Value::String(status.to_string()));
        if let Some(uid) = change_event_uid {
            obj.insert("changeEventUid".to_string(), Value::String(uid.to_string()));
        }
        if let Some(transaction_id) = maintenance_transaction_id {
            obj.insert(
                "maintenanceTransactionId".to_string(),
                Value::String(transaction_id.to_string()),
            );
        }
        if let Some(transaction_id) = maintenance_original_transaction_id {
            obj.insert(
                "maintenanceOriginalTransactionId".to_string(),
                Value::String(transaction_id.to_string()),
            );
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
