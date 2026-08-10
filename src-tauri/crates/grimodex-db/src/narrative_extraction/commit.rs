//! Atomic narrative apply commit engine (prepare / apply / status).

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::chronicle_operations::{
    apply_chronicle_event_create, ensure_event_id_available, ensure_order_neighbor,
    ensure_scene_versions, generate_append_ordinals, parse_event_create_payload,
};
use super::codex_operations::{
    apply_codex_entry_create, apply_codex_entry_patch, apply_codex_relation_create_in_tx,
    ensure_entry_id_available, ensure_entry_version, ensure_operation_kind, is_chronicle_op,
    parse_entry_create_payload, parse_entry_patch_payload, parse_relation_create_payload,
    CodexEntityBinding, CommitMap, OP_KIND_ENTRY_CREATE, OP_KIND_ENTRY_PATCH,
    OP_KIND_EVENT_CREATE, OP_KIND_RELATION_CREATE, PlotThreadBinding,
};
use super::detail_operations::{
    apply_detail_value_set_in_tx, parse_detail_value_set_payload, OP_KIND_DETAIL_VALUE_SET,
};
use super::phase_operations::{
    apply_phase_create_in_tx, apply_phase_patch_in_tx, parse_phase_create_payload,
    parse_phase_patch_payload, OP_KIND_PHASE_CREATE, OP_KIND_PHASE_PATCH,
};
use super::plot_thread_operations::{
    apply_plot_branch_create_in_tx, apply_plot_marker_create_in_tx,
    apply_plot_thread_create_in_tx, apply_plot_thread_patch_in_tx,
    ensure_branch_id_available, ensure_marker_id_available, ensure_thread_id_available,
    ensure_thread_version, parse_plot_branch_create_payload, parse_plot_marker_create_payload,
    parse_plot_thread_create_payload, parse_plot_thread_patch_payload, OP_KIND_PLOT_BRANCH_CREATE,
    OP_KIND_PLOT_MARKER_CREATE, OP_KIND_PLOT_THREAD_CREATE, OP_KIND_PLOT_THREAD_PATCH,
};
use super::semantic_bindings::{
    apply_semantic_binding_upsert_in_tx, parse_semantic_binding_upsert_payload,
    OP_KIND_SEMANTIC_BINDING_UPSERT,
};
use super::temporal_constraints::{
    apply_constraint_create_in_tx, parse_constraint_create_payload, OP_KIND_CONSTRAINT_CREATE,
};
use super::temporal_nodes::{
    apply_node_ensure_in_tx, parse_node_ensure_payload, OP_KIND_NODE_ENSURE,
};
use super::temporal_operations::{
    apply_event_metadata_patch_in_tx, apply_scene_metadata_patch_in_tx,
    apply_story_order_materialize_in_tx, ensure_calendar_version,
    parse_event_metadata_patch_payload, parse_scene_metadata_patch_payload,
    parse_story_order_materialize_payload, OP_KIND_EVENT_METADATA_PATCH,
    OP_KIND_SCENE_METADATA_PATCH, OP_KIND_STORY_ORDER_MATERIALIZE,
};
use super::temporal_projections::{
    apply_projection_record_in_tx, parse_projection_record_payload, OP_KIND_PROJECTION_RECORD,
};
use super::models::{
    ApplyCommitPayload, CommitApplicationRef, CommitOperation, EntityBindingSeed,
    GetCommitStatusPayload, PrepareCommitPayload,
};
use super::repository::ensure_run_project;
use super::task_leases::with_immediate_transaction;
use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::Database;

const STATUS_APPLIED: &str = "applied";
const STATUS_UNDONE: &str = "undone";
const STATUS_REDONE: &str = "redone";
const STATUS_FAILED: &str = "failed";

pub fn narrative_extraction_prepare_commit(
    db: &Database,
    payload: PrepareCommitPayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |conn| {
            validate_commit_plan(
                conn,
                &payload.project_id,
                &payload.run_id,
                &payload.proposal_set_id,
                &payload.operations,
                &payload.applications,
                payload.expected_tail_ordinal.as_deref(),
                &payload.entity_bindings,
                payload.expected_calendar_version,
            )?;
            Ok(json!({
                "ok": true,
                "requestId": payload.request_id,
                "planDigest": payload.plan_digest,
                "operationCount": payload.operations.len(),
            }))
        })
    })
}

pub fn narrative_extraction_apply_commit(
    db: &Database,
    payload: ApplyCommitPayload,
) -> anyhow::Result<Value> {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    let timestamp = Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        with_immediate_transaction(conn, |conn| {
            if let Some(existing) = load_commit_by_request(
                conn,
                &payload.project_id,
                &payload.request_id,
            )? {
                return replay_or_conflict(existing, &payload.plan_digest);
            }

            validate_commit_plan(
                conn,
                &payload.project_id,
                &payload.run_id,
                &payload.proposal_set_id,
                &payload.operations,
                &payload.applications,
                payload.expected_tail_ordinal.as_deref(),
                &payload.entity_bindings,
                payload.expected_calendar_version,
            )?;

            let commit_id = Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO narrative_apply_commits
                    (id, project_id, run_id, proposal_set_id, request_id, plan_digest,
                     status, created_at, version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, 0)",
                params![
                    commit_id,
                    payload.project_id,
                    payload.run_id,
                    payload.proposal_set_id,
                    payload.request_id,
                    payload.plan_digest,
                    now,
                ],
            )?;

            let apply_result = (|| -> anyhow::Result<Value> {
                let mut commit_map = CommitMap::new();
                for seed in &payload.entity_bindings {
                    commit_map.insert_binding(CodexEntityBinding {
                        narrative_entity_id: seed.narrative_entity_id.clone(),
                        codex_entry_id: seed.codex_entry_id.clone(),
                        source: if seed.source.is_empty() {
                            "existing".to_string()
                        } else {
                            seed.source.clone()
                        },
                    });
                }

                let chronicle_count = payload
                    .operations
                    .iter()
                    .filter(|op| is_chronicle_op(&op.kind))
                    .count();
                let ordinals = if chronicle_count > 0 {
                    generate_append_ordinals(
                        payload.expected_tail_ordinal.as_deref(),
                        chronicle_count,
                    )?
                } else {
                    Vec::new()
                };
                let mut ordinal_index = 0usize;

                let mut created = Vec::new();
                let mut after_snapshots = Vec::new();

                for (index, op) in payload.operations.iter().enumerate() {
                    ensure_operation_kind(&op.kind)?;
                    let (entity_kind, entity_id, version, snapshot, before_snapshot, op_kind) =
                        match op.kind.as_str() {
                            OP_KIND_EVENT_CREATE => {
                                let event_payload = parse_event_create_payload(&op.payload)?;
                                let ordinal = &ordinals[ordinal_index];
                                ordinal_index += 1;
                                let result = apply_chronicle_event_create(
                                    conn,
                                    &payload.project_id,
                                    &payload.session_id,
                                    payload.surface.as_deref(),
                                    &event_payload,
                                    ordinal,
                                    &now,
                                    timestamp,
                                )?;
                                (
                                    "event",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    None,
                                    "create",
                                )
                            }
                            OP_KIND_ENTRY_CREATE => {
                                let entry_payload = parse_entry_create_payload(&op.payload)?;
                                let result = apply_codex_entry_create(
                                    conn,
                                    &payload.project_id,
                                    &payload.session_id,
                                    payload.surface.as_deref(),
                                    &entry_payload,
                                    &now,
                                    timestamp,
                                )?;
                                if let Some(narrative_entity_id) =
                                    entry_payload.narrative_entity_id.as_ref()
                                {
                                    commit_map.insert_binding(CodexEntityBinding {
                                        narrative_entity_id: narrative_entity_id.clone(),
                                        codex_entry_id: result.entity_id.clone(),
                                        source: "created".to_string(),
                                    });
                                }
                                (
                                    "codex_entry",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    None,
                                    "create",
                                )
                            }
                            OP_KIND_ENTRY_PATCH => {
                                let patch_payload = parse_entry_patch_payload(&op.payload)?;
                                let result = apply_codex_entry_patch(
                                    conn,
                                    &payload.project_id,
                                    &payload.session_id,
                                    payload.surface.as_deref(),
                                    &patch_payload,
                                    &now,
                                    timestamp,
                                )?;
                                if let Some(narrative_entity_id) =
                                    patch_payload.narrative_entity_id.as_ref()
                                {
                                    commit_map.insert_binding(CodexEntityBinding {
                                        narrative_entity_id: narrative_entity_id.clone(),
                                        codex_entry_id: result.entity_id.clone(),
                                        source: "existing".to_string(),
                                    });
                                }
                                (
                                    "codex_entry",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    Some(result.before_snapshot),
                                    "patch",
                                )
                            }
                            OP_KIND_RELATION_CREATE => {
                                let relation_payload =
                                    parse_relation_create_payload(&op.payload)?;
                                let result = apply_codex_relation_create_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &relation_payload,
                                    &commit_map,
                                    &now,
                                )?;
                                (
                                    "codex_relation",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    None,
                                    "create",
                                )
                            }
                            OP_KIND_DETAIL_VALUE_SET => {
                                let detail_payload =
                                    parse_detail_value_set_payload(&op.payload)?;
                                let result = apply_detail_value_set_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &detail_payload,
                                    &commit_map,
                                    &now,
                                )?;
                                (
                                    "codex_detail_value",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    result.before_snapshot,
                                    result.op_kind,
                                )
                            }
                            OP_KIND_PHASE_CREATE => {
                                let phase_payload = parse_phase_create_payload(&op.payload)?;
                                let result = apply_phase_create_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &phase_payload,
                                    &commit_map,
                                    &now,
                                )?;
                                (
                                    "codex_phase",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    result.before_snapshot,
                                    result.op_kind,
                                )
                            }
                            OP_KIND_PHASE_PATCH => {
                                let phase_payload = parse_phase_patch_payload(&op.payload)?;
                                let result = apply_phase_patch_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &phase_payload,
                                    &now,
                                )?;
                                (
                                    "codex_phase",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    result.before_snapshot,
                                    result.op_kind,
                                )
                            }
                            OP_KIND_SEMANTIC_BINDING_UPSERT => {
                                let binding_payload =
                                    parse_semantic_binding_upsert_payload(&op.payload)?;
                                let result = apply_semantic_binding_upsert_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &binding_payload,
                                    &now,
                                )?;
                                (
                                    "codex_semantic_binding",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    result.before_snapshot,
                                    result.op_kind,
                                )
                            }
                            OP_KIND_NODE_ENSURE => {
                                let node_payload = parse_node_ensure_payload(&op.payload)?;
                                let result = apply_node_ensure_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &node_payload,
                                    &now,
                                )?;
                                (
                                    "temporal_node",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    None,
                                    if result.created {
                                        "create"
                                    } else {
                                        "ensure-existing"
                                    },
                                )
                            }
                            OP_KIND_CONSTRAINT_CREATE => {
                                let constraint_payload =
                                    parse_constraint_create_payload(&op.payload)?;
                                let result = apply_constraint_create_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &constraint_payload,
                                    &now,
                                )?;
                                (
                                    "temporal_constraint",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    None,
                                    "create",
                                )
                            }
                            OP_KIND_SCENE_METADATA_PATCH => {
                                let scene_payload =
                                    parse_scene_metadata_patch_payload(&op.payload)?;
                                let result = apply_scene_metadata_patch_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &scene_payload,
                                    &now,
                                )?;
                                (
                                    "temporal_scene_chronicle",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    Some(result.before_snapshot),
                                    "patch",
                                )
                            }
                            OP_KIND_EVENT_METADATA_PATCH => {
                                let event_payload =
                                    parse_event_metadata_patch_payload(&op.payload)?;
                                let result = apply_event_metadata_patch_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &event_payload,
                                    &now,
                                )?;
                                (
                                    "temporal_event_chronicle",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    Some(result.before_snapshot),
                                    "patch",
                                )
                            }
                            OP_KIND_STORY_ORDER_MATERIALIZE => {
                                let story_order_payload =
                                    parse_story_order_materialize_payload(&op.payload)?;
                                let result = apply_story_order_materialize_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &story_order_payload,
                                    &now,
                                )?;
                                (
                                    "temporal_scene_story_order",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    Some(result.before_snapshot),
                                    "patch",
                                )
                            }
                            OP_KIND_PROJECTION_RECORD => {
                                let projection_payload =
                                    parse_projection_record_payload(&op.payload)?;
                                let result = apply_projection_record_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &projection_payload,
                                    &now,
                                )?;
                                (
                                    "temporal_projection",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    result.before_snapshot,
                                    result.op_kind,
                                )
                            }
                            OP_KIND_PLOT_THREAD_CREATE => {
                                let thread_payload =
                                    parse_plot_thread_create_payload(&op.payload)?;
                                let result = apply_plot_thread_create_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &thread_payload,
                                    &now,
                                )?;
                                commit_map.insert_plot_thread_binding(PlotThreadBinding {
                                    hypothesis_id: thread_payload.hypothesis_id.clone(),
                                    plot_thread_id: result.entity_id.clone(),
                                    source: "created".to_string(),
                                });
                                (
                                    "plot_thread",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    result.before_snapshot,
                                    result.op_kind,
                                )
                            }
                            OP_KIND_PLOT_THREAD_PATCH => {
                                let thread_payload =
                                    parse_plot_thread_patch_payload(&op.payload)?;
                                let result = apply_plot_thread_patch_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &thread_payload,
                                    &now,
                                )?;
                                commit_map.insert_plot_thread_binding(PlotThreadBinding {
                                    hypothesis_id: thread_payload.hypothesis_id.clone(),
                                    plot_thread_id: result.entity_id.clone(),
                                    source: "existing".to_string(),
                                });
                                (
                                    "plot_thread",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    result.before_snapshot,
                                    result.op_kind,
                                )
                            }
                            OP_KIND_PLOT_MARKER_CREATE => {
                                let marker_payload =
                                    parse_plot_marker_create_payload(&op.payload)?;
                                let result = apply_plot_marker_create_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &marker_payload,
                                    &commit_map,
                                    &now,
                                )?;
                                (
                                    "plot_thread_marker",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    result.before_snapshot,
                                    result.op_kind,
                                )
                            }
                            OP_KIND_PLOT_BRANCH_CREATE => {
                                let branch_payload =
                                    parse_plot_branch_create_payload(&op.payload)?;
                                let result = apply_plot_branch_create_in_tx(
                                    conn,
                                    &payload.project_id,
                                    &branch_payload,
                                    &commit_map,
                                    &now,
                                )?;
                                (
                                    "plot_thread_branch",
                                    result.entity_id,
                                    result.version,
                                    result.after_snapshot,
                                    result.before_snapshot,
                                    result.op_kind,
                                )
                            }
                            other => anyhow::bail!("unsupported commit operation kind: {other}"),
                        };

                    conn.execute(
                        "INSERT INTO narrative_apply_operations
                            (id, commit_id, operation_index, operation_kind, payload_json,
                             result_entity_kind, result_entity_id, status, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'applied', ?8)",
                        params![
                            Uuid::new_v4().to_string(),
                            commit_id,
                            index as i64,
                            op.kind,
                            serde_json::to_string(&op.payload)?,
                            entity_kind,
                            entity_id,
                            now,
                        ],
                    )?;

                    let mut entity_row = json!({
                        "entityKind": entity_kind,
                        "entityId": entity_id,
                        "version": version,
                        "opKind": op_kind,
                        "snapshot": snapshot,
                    });
                    if let Some(before) = before_snapshot {
                        entity_row["beforeSnapshot"] = before;
                    }
                    after_snapshots.push(entity_row);
                    created.push(json!({
                        "operationIndex": index,
                        "entityKind": entity_kind,
                        "entityId": entity_id,
                        "version": version,
                        "proposalId": op.proposal_id,
                        "revisionId": op.revision_id,
                    }));
                }

                for (index, application) in payload.applications.iter().enumerate() {
                    let created_row = created.get(index).ok_or_else(|| {
                        anyhow::anyhow!("application[{index}] has no matching created entity")
                    })?;
                    let entity_id = created_row
                        .get("entityId")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            anyhow::anyhow!("application[{index}] missing entityId")
                        })?;
                    let entity_kind = created_row
                        .get("entityKind")
                        .and_then(Value::as_str)
                        .unwrap_or("event");
                    conn.execute(
                        "INSERT INTO narrative_proposal_applications
                            (id, commit_id, proposal_id, revision_id,
                             applied_entity_kind, applied_entity_id, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![
                            Uuid::new_v4().to_string(),
                            commit_id,
                            application.proposal_id,
                            application.revision_id,
                            entity_kind,
                            entity_id,
                            now,
                        ],
                    )?;
                }

                if payload.applications.is_empty() {
                    for (index, op) in payload.operations.iter().enumerate() {
                        if let (Some(proposal_id), Some(revision_id)) =
                            (op.proposal_id.as_ref(), op.revision_id.as_ref())
                        {
                            let entity_id = created[index]["entityId"]
                                .as_str()
                                .expect("entity id");
                            let entity_kind = created[index]["entityKind"]
                                .as_str()
                                .unwrap_or("event");
                            conn.execute(
                                "INSERT INTO narrative_proposal_applications
                                    (id, commit_id, proposal_id, revision_id,
                                     applied_entity_kind, applied_entity_id, created_at)
                                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                                params![
                                    Uuid::new_v4().to_string(),
                                    commit_id,
                                    proposal_id,
                                    revision_id,
                                    entity_kind,
                                    entity_id,
                                    now,
                                ],
                            )?;
                        }
                    }
                }

                let after_json = json!({
                    "entities": after_snapshots,
                    "entityBindings": commit_map.to_json(),
                });
                let journal_id = Uuid::new_v4().to_string();
                conn.execute(
                    "INSERT INTO narrative_commit_journals
                        (id, commit_id, project_id, before_json, after_json, created_at)
                     VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
                    params![
                        journal_id,
                        commit_id,
                        payload.project_id,
                        after_json.to_string(),
                        now,
                    ],
                )?;

                let change_uid = Uuid::new_v4().to_string();
                let change_payload = json!({
                    "commitId": commit_id,
                    "requestId": payload.request_id,
                    "planDigest": payload.plan_digest,
                    "entityIds": created.iter().map(|row| row["entityId"].clone()).collect::<Vec<_>>(),
                    "entityBindings": commit_map.to_json(),
                });
                append_change_events_in_tx(
                    conn,
                    &payload.project_id,
                    &payload.session_id,
                    &[AppendChangeEvent {
                        event_uid: change_uid.clone(),
                        scene_id: None,
                        domain: "narrative".to_string(),
                        op_type: "narrative.commit.apply".to_string(),
                        entity_type: Some("narrative_apply_commit".to_string()),
                        entity_id: Some(commit_id.clone()),
                        payload: change_payload.to_string(),
                        timestamp,
                    }],
                )?;

                let receipt = json!({
                    "commitId": commit_id,
                    "requestId": payload.request_id,
                    "planDigest": payload.plan_digest,
                    "status": STATUS_APPLIED,
                    "journalId": journal_id,
                    "changeEventUid": change_uid,
                    "created": created,
                    "entityBindings": commit_map.to_json(),
                });

                conn.execute(
                    "UPDATE narrative_apply_commits
                        SET status = ?1,
                            receipt_json = ?2,
                            completed_at = ?3,
                            version = version + 1
                      WHERE id = ?4",
                    params![STATUS_APPLIED, receipt.to_string(), now, commit_id],
                )?;

                Ok(receipt)
            })();

            match apply_result {
                Ok(receipt) => Ok(receipt),
                Err(err) => {
                    let message = err.to_string();
                    let _ = conn.execute(
                        "UPDATE narrative_apply_commits
                            SET status = ?1,
                                error_message = ?2,
                                completed_at = ?3,
                                version = version + 1
                          WHERE id = ?4",
                        params![STATUS_FAILED, message, now, commit_id],
                    );
                    Err(err)
                }
            }
        })
    })
}

pub fn narrative_extraction_get_commit_status(
    db: &Database,
    payload: GetCommitStatusPayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        let row = if let Some(commit_id) = payload.commit_id.as_deref() {
            load_commit_by_id(conn, &payload.project_id, commit_id)?
        } else if let Some(request_id) = payload.request_id.as_deref() {
            load_commit_by_request(conn, &payload.project_id, request_id)?
        } else {
            anyhow::bail!("commitId or requestId is required");
        };
        let Some(row) = row else {
            return Ok(json!({
                "found": false,
            }));
        };
        Ok(json!({
            "found": true,
            "commitId": row.commit_id,
            "requestId": row.request_id,
            "planDigest": row.plan_digest,
            "status": row.status,
            "receipt": row.receipt_json.as_deref().and_then(|raw| serde_json::from_str::<Value>(raw).ok()),
            "errorMessage": row.error_message,
            "createdAt": row.created_at,
            "completedAt": row.completed_at,
            "version": row.version,
        }))
    })
}

pub(crate) struct CommitRow {
    pub commit_id: String,
    #[allow(dead_code)]
    pub project_id: String,
    pub request_id: String,
    pub plan_digest: String,
    pub status: String,
    pub receipt_json: Option<String>,
    pub error_message: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub version: i64,
}

pub(crate) fn load_commit_by_id(
    conn: &Connection,
    project_id: &str,
    commit_id: &str,
) -> anyhow::Result<Option<CommitRow>> {
    conn.query_row(
        "SELECT id, project_id, request_id, plan_digest, status, receipt_json,
                error_message, created_at, completed_at, version
           FROM narrative_apply_commits
          WHERE id = ?1 AND project_id = ?2",
        params![commit_id, project_id],
        map_commit_row,
    )
    .optional()
    .map_err(Into::into)
}

pub(crate) fn load_commit_by_request(
    conn: &Connection,
    project_id: &str,
    request_id: &str,
) -> anyhow::Result<Option<CommitRow>> {
    conn.query_row(
        "SELECT id, project_id, request_id, plan_digest, status, receipt_json,
                error_message, created_at, completed_at, version
           FROM narrative_apply_commits
          WHERE project_id = ?1 AND request_id = ?2
          ORDER BY created_at DESC
          LIMIT 1",
        params![project_id, request_id],
        map_commit_row,
    )
    .optional()
    .map_err(Into::into)
}

fn map_commit_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CommitRow> {
    Ok(CommitRow {
        commit_id: row.get(0)?,
        project_id: row.get(1)?,
        request_id: row.get(2)?,
        plan_digest: row.get(3)?,
        status: row.get(4)?,
        receipt_json: row.get(5)?,
        error_message: row.get(6)?,
        created_at: row.get(7)?,
        completed_at: row.get(8)?,
        version: row.get(9)?,
    })
}

fn replay_or_conflict(existing: CommitRow, plan_digest: &str) -> anyhow::Result<Value> {
    if existing.plan_digest != plan_digest {
        anyhow::bail!(
            "NEX_COMMIT_IDEMPOTENCY_CONFLICT: request id reused with different planDigest"
        );
    }
    match existing.status.as_str() {
        STATUS_APPLIED | STATUS_REDONE | STATUS_UNDONE => {
            if let Some(raw) = existing.receipt_json.as_deref() {
                let mut receipt: Value = serde_json::from_str(raw)?;
                if let Some(obj) = receipt.as_object_mut() {
                    obj.insert("idempotentReplay".to_string(), Value::Bool(true));
                    obj.insert("status".to_string(), Value::String(existing.status.clone()));
                }
                return Ok(receipt);
            }
            Ok(json!({
                "commitId": existing.commit_id,
                "requestId": existing.request_id,
                "planDigest": existing.plan_digest,
                "status": existing.status,
                "idempotentReplay": true,
            }))
        }
        STATUS_FAILED => anyhow::bail!(
            "NEX_COMMIT_PREVIOUSLY_FAILED: {}",
            existing
                .error_message
                .unwrap_or_else(|| "previous commit failed".to_string())
        ),
        other => anyhow::bail!("unexpected commit status '{other}' for idempotent replay"),
    }
}

fn validate_commit_plan(
    conn: &Connection,
    project_id: &str,
    run_id: &str,
    proposal_set_id: &str,
    operations: &[CommitOperation],
    applications: &[CommitApplicationRef],
    expected_tail_ordinal: Option<&str>,
    entity_bindings: &[EntityBindingSeed],
    expected_calendar_version: Option<i64>,
) -> anyhow::Result<()> {
    anyhow::ensure!(!operations.is_empty(), "commit requires at least one operation");
    ensure_run_project(conn, run_id, project_id)?;

    if let Some(expected_calendar_version) = expected_calendar_version {
        ensure_calendar_version(conn, project_id, expected_calendar_version)?;
    }

    let set_ok: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_proposal_sets
          WHERE id = ?1 AND run_id = ?2 AND project_id = ?3",
        params![proposal_set_id, run_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(set_ok == 1, "proposal set not found for run/project");

    let has_chronicle = operations.iter().any(|op| is_chronicle_op(&op.kind));
    if has_chronicle {
        ensure_order_neighbor(conn, project_id, expected_tail_ordinal)?;
    }

    for seed in entity_bindings {
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
            params![seed.codex_entry_id, project_id],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            exists == 1,
            "entity binding codex entry '{}' not found in project '{}'",
            seed.codex_entry_id,
            project_id
        );
    }

    for op in operations {
        ensure_operation_kind(&op.kind)?;
        match op.kind.as_str() {
            OP_KIND_EVENT_CREATE => {
                let payload = parse_event_create_payload(&op.payload)?;
                ensure_event_id_available(conn, project_id, &payload.event_id)?;
                ensure_scene_versions(conn, project_id, &payload.evidence_scene_links)?;
            }
            OP_KIND_ENTRY_CREATE => {
                let payload = parse_entry_create_payload(&op.payload)?;
                anyhow::ensure!(
                    payload.parent_id.is_none(),
                    "NEX_CODEX_PARENT_ID_FORBIDDEN: kinship must not be projected onto parentId"
                );
                ensure_entry_id_available(conn, project_id, &payload.entry_id)?;
            }
            OP_KIND_ENTRY_PATCH => {
                let payload = parse_entry_patch_payload(&op.payload)?;
                ensure_entry_version(conn, project_id, &payload.entry_id, payload.base_version)?;
            }
            OP_KIND_RELATION_CREATE => {
                let _ = parse_relation_create_payload(&op.payload)?;
            }
            OP_KIND_DETAIL_VALUE_SET => {
                let _ = parse_detail_value_set_payload(&op.payload)?;
            }
            OP_KIND_PHASE_CREATE => {
                let payload = parse_phase_create_payload(&op.payload)?;
                let exists: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM codex_entry_phases WHERE id = ?1",
                    params![payload.phase_id],
                    |row| row.get(0),
                )?;
                anyhow::ensure!(
                    exists == 0,
                    "codex phase '{}' already exists",
                    payload.phase_id
                );
            }
            OP_KIND_PHASE_PATCH => {
                let payload = parse_phase_patch_payload(&op.payload)?;
                let version: Option<i64> = conn
                    .query_row(
                        "SELECT version FROM codex_entry_phases WHERE id = ?1",
                        params![payload.phase_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                let Some(version) = version else {
                    anyhow::bail!("codex phase '{}' not found", payload.phase_id);
                };
                if version != payload.base_version {
                    anyhow::bail!(
                        "NEX_PHASE_VERSION_MISMATCH: phase '{}' expected version {}, found {}",
                        payload.phase_id,
                        payload.base_version,
                        version
                    );
                }
            }
            OP_KIND_SEMANTIC_BINDING_UPSERT => {
                let _ = parse_semantic_binding_upsert_payload(&op.payload)?;
            }
            OP_KIND_NODE_ENSURE => {
                let _ = parse_node_ensure_payload(&op.payload)?;
            }
            OP_KIND_CONSTRAINT_CREATE => {
                // Referenced nodes may be created earlier in this same commit
                // (e.g. by `temporal.node.ensure`), so existence is checked
                // at apply time, in operation order, like relation/detail ops.
                let _ = parse_constraint_create_payload(&op.payload)?;
            }
            OP_KIND_SCENE_METADATA_PATCH => {
                let _ = parse_scene_metadata_patch_payload(&op.payload)?;
            }
            OP_KIND_EVENT_METADATA_PATCH => {
                let _ = parse_event_metadata_patch_payload(&op.payload)?;
            }
            OP_KIND_STORY_ORDER_MATERIALIZE => {
                let _ = parse_story_order_materialize_payload(&op.payload)?;
            }
            OP_KIND_PROJECTION_RECORD => {
                let _ = parse_projection_record_payload(&op.payload)?;
            }
            OP_KIND_PLOT_THREAD_CREATE => {
                let payload = parse_plot_thread_create_payload(&op.payload)?;
                ensure_thread_id_available(conn, project_id, &payload.thread_id)?;
            }
            OP_KIND_PLOT_THREAD_PATCH => {
                let payload = parse_plot_thread_patch_payload(&op.payload)?;
                ensure_thread_version(
                    conn,
                    project_id,
                    &payload.thread_id,
                    payload.base_version,
                )?;
            }
            OP_KIND_PLOT_MARKER_CREATE => {
                let payload = parse_plot_marker_create_payload(&op.payload)?;
                ensure_marker_id_available(conn, &payload.marker_id)?;
            }
            OP_KIND_PLOT_BRANCH_CREATE => {
                let payload = parse_plot_branch_create_payload(&op.payload)?;
                ensure_branch_id_available(conn, &payload.branch_id)?;
            }
            other => anyhow::bail!("unsupported commit operation kind: {other}"),
        }

        if let Some(proposal_id) = op.proposal_id.as_deref() {
            ensure_proposal_approved(conn, proposal_set_id, proposal_id, op.revision_id.as_deref())?;
            ensure_proposal_not_applied(conn, proposal_id)?;
        }
    }

    for application in applications {
        ensure_proposal_approved(
            conn,
            proposal_set_id,
            &application.proposal_id,
            Some(&application.revision_id),
        )?;
        ensure_proposal_not_applied(conn, &application.proposal_id)?;
    }

    Ok(())
}

fn ensure_proposal_approved(
    conn: &Connection,
    proposal_set_id: &str,
    proposal_id: &str,
    revision_id: Option<&str>,
) -> anyhow::Result<()> {
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT status, current_revision_id
               FROM narrative_proposals
              WHERE id = ?1 AND proposal_set_id = ?2",
            params![proposal_id, proposal_set_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((status, current_revision_id)) = row else {
        anyhow::bail!("proposal '{proposal_id}' not found in set '{proposal_set_id}'");
    };
    anyhow::ensure!(
        status == "approved",
        "NEX_PROPOSAL_NOT_APPROVED: proposal '{proposal_id}' status is '{status}'"
    );
    if let Some(revision_id) = revision_id {
        anyhow::ensure!(
            current_revision_id.as_deref() == Some(revision_id),
            "NEX_PROPOSAL_REVISION_MISMATCH: proposal '{proposal_id}'"
        );
    }
    Ok(())
}

fn ensure_proposal_not_applied(conn: &Connection, proposal_id: &str) -> anyhow::Result<()> {
    let applied: i64 = conn.query_row(
        "SELECT COUNT(*) FROM narrative_proposal_applications WHERE proposal_id = ?1",
        params![proposal_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        applied == 0,
        "NEX_PROPOSAL_ALREADY_APPLIED: proposal '{proposal_id}'"
    );
    Ok(())
}

/// Stable digest helper for callers that want a canonical plan fingerprint.
#[allow(dead_code)]
pub fn digest_plan(value: &Value) -> String {
    let mut canonical = value.clone();
    canonicalize_json_value(&mut canonical);
    let body = serde_json::to_vec(&canonical).unwrap_or_default();
    hex::encode(Sha256::digest(body))
}

fn canonicalize_json_value(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                canonicalize_json_value(item);
            }
        }
        Value::Object(object) => {
            let mut entries: Vec<_> = std::mem::take(object).into_iter().collect();
            for (_, child) in &mut entries {
                canonicalize_json_value(child);
            }
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            object.extend(entries);
        }
        _ => {}
    }
}
