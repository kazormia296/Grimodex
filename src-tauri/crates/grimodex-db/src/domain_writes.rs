//! Typed aggregate writes used by renderer features that previously assembled
//! SQL batches. Each command owns its SQL, transaction boundary, and project
//! checks here; renderer payloads contain domain data only.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::Database;
use crate::agent_writes::{
    canonical_payload_with_authority_context, canonical_payload_with_derived_authority_context,
    record_agent_field_authority_for_entity, validate_agent_field_authority_for_entity,
    validate_renderer_authority_context, validate_renderer_authority_context_for_routes,
    RendererCanonicalWriteContext, RendererMutationProvenance,
};
use crate::change_events::AppendChangeEvent;
use crate::idempotency::{
    canonical_write_payload_fingerprint, insert_idempotent_response, load_idempotent_response,
    payload_fingerprint, IdempotencyRequest,
};
use crate::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_snapshot_digest,
    require_replay_lineage_in_project, scene_text_impact, AppendNarrativeChangeTransactionInput,
    NarrativeChangeCauseKind, NarrativeChangeEventInput, NarrativeChangeOrigin,
};
use crate::narrative_extraction::{
    mint_c2zc_project_birth_epoch_in_tx, mint_c2zc_scan_publish_project_birth_epoch_in_tx,
    with_immediate_transaction,
};

fn json_pointer_segment(value: &str) -> String {
    value.replace('~', "~0").replace('/', "~1")
}

fn event_timestamp(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|value| value.timestamp_millis())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis())
}

fn require_non_empty(value: &str, field: &str) -> anyhow::Result<()> {
    if value.is_empty() {
        anyhow::bail!("domain write {field} must not be empty");
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AuthorshipOwnerLane {
    Node {
        #[serde(rename = "nodeId")]
        node_id: String,
    },
    Codex {
        #[serde(rename = "codexEntryId")]
        codex_entry_id: String,
    },
    Snippet {
        #[serde(rename = "snippetId")]
        snippet_id: String,
    },
    Detail {
        #[serde(rename = "detailValueId")]
        detail_value_id: String,
        #[serde(rename = "codexEntryId")]
        codex_entry_id: String,
    },
    Phase {
        #[serde(rename = "phaseId")]
        phase_id: String,
        #[serde(rename = "codexEntryId")]
        codex_entry_id: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorshipSpanInput {
    pub id: String,
    pub from_pos: i64,
    pub to_pos: i64,
    pub source: String,
    pub model: Option<String>,
    pub timestamp: Option<String>,
    pub chat_msg_id: Option<String>,
    pub trace_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceAuthorshipLanePayload {
    pub lane: AuthorshipOwnerLane,
    pub spans: Vec<AuthorshipSpanInput>,
}

fn validate_authorship_lane(
    tx: &Transaction<'_>,
    lane: &AuthorshipOwnerLane,
) -> anyhow::Result<()> {
    let exists = match lane {
        AuthorshipOwnerLane::Node { node_id } => {
            require_non_empty(node_id, "lane.nodeId")?;
            tx.query_row(
                "SELECT 1 FROM tree_nodes WHERE id = ?1",
                params![node_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        }
        AuthorshipOwnerLane::Codex { codex_entry_id } => {
            require_non_empty(codex_entry_id, "lane.codexEntryId")?;
            tx.query_row(
                "SELECT 1 FROM codex_entries WHERE id = ?1",
                params![codex_entry_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        }
        AuthorshipOwnerLane::Snippet { snippet_id } => {
            require_non_empty(snippet_id, "lane.snippetId")?;
            tx.query_row(
                "SELECT 1 FROM snippets WHERE id = ?1",
                params![snippet_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        }
        AuthorshipOwnerLane::Detail {
            detail_value_id,
            codex_entry_id,
        } => {
            require_non_empty(detail_value_id, "lane.detailValueId")?;
            require_non_empty(codex_entry_id, "lane.codexEntryId")?;
            tx.query_row(
                "SELECT 1
                   FROM codex_detail_values value
                  WHERE value.id = ?1 AND value.entry_id = ?2",
                params![detail_value_id, codex_entry_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        }
        AuthorshipOwnerLane::Phase {
            phase_id,
            codex_entry_id,
        } => {
            require_non_empty(phase_id, "lane.phaseId")?;
            require_non_empty(codex_entry_id, "lane.codexEntryId")?;
            tx.query_row(
                "SELECT 1
                   FROM codex_entry_phases phase
                  WHERE phase.id = ?1 AND phase.entry_id = ?2",
                params![phase_id, codex_entry_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some()
        }
    };
    if !exists {
        anyhow::bail!("authorship owner lane does not exist or crosses an aggregate boundary");
    }
    Ok(())
}

fn validate_authorship_spans(spans: &[AuthorshipSpanInput]) -> anyhow::Result<()> {
    let mut ids = HashSet::new();
    for span in spans {
        require_non_empty(&span.id, "spans[].id")?;
        if !ids.insert(span.id.as_str()) {
            anyhow::bail!("authorship span ids must be unique");
        }
        if span.from_pos < 0 || span.to_pos < span.from_pos {
            anyhow::bail!("authorship span positions are invalid");
        }
        if !matches!(span.source.as_str(), "human" | "ai" | "unknown") {
            anyhow::bail!("authorship span source must be human, ai, or unknown");
        }
    }
    Ok(())
}

pub fn replace_authorship_lane(
    db: &Database,
    payload: ReplaceAuthorshipLanePayload,
) -> anyhow::Result<()> {
    validate_authorship_spans(&payload.spans)?;
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        validate_authorship_lane(&tx, &payload.lane)?;

        let (delete_sql, owner_id): (&str, &str) = match &payload.lane {
            AuthorshipOwnerLane::Node { node_id } => {
                ("DELETE FROM authorship_spans WHERE node_id = ?1", node_id)
            }
            AuthorshipOwnerLane::Codex { codex_entry_id } => (
                "DELETE FROM authorship_spans
                  WHERE codex_entry_id = ?1 AND phase_id IS NULL
                    AND detail_value_id IS NULL",
                codex_entry_id,
            ),
            AuthorshipOwnerLane::Snippet { snippet_id } => (
                "DELETE FROM authorship_spans WHERE snippet_id = ?1",
                snippet_id,
            ),
            AuthorshipOwnerLane::Detail {
                detail_value_id, ..
            } => (
                "DELETE FROM authorship_spans WHERE detail_value_id = ?1",
                detail_value_id,
            ),
            AuthorshipOwnerLane::Phase { phase_id, .. } => {
                ("DELETE FROM authorship_spans WHERE phase_id = ?1", phase_id)
            }
        };
        tx.execute(delete_sql, params![owner_id])?;

        for span in payload.spans {
            let (node_id, codex_entry_id, snippet_id, detail_value_id, phase_id) =
                match &payload.lane {
                    AuthorshipOwnerLane::Node { node_id } => {
                        (Some(node_id.as_str()), None, None, None, None)
                    }
                    AuthorshipOwnerLane::Codex { codex_entry_id } => {
                        (None, Some(codex_entry_id.as_str()), None, None, None)
                    }
                    AuthorshipOwnerLane::Snippet { snippet_id } => {
                        (None, None, Some(snippet_id.as_str()), None, None)
                    }
                    AuthorshipOwnerLane::Detail {
                        detail_value_id, ..
                    } => (None, None, None, Some(detail_value_id.as_str()), None),
                    AuthorshipOwnerLane::Phase {
                        phase_id,
                        codex_entry_id,
                    } => (
                        None,
                        Some(codex_entry_id.as_str()),
                        None,
                        None,
                        Some(phase_id.as_str()),
                    ),
                };
            tx.execute(
                "INSERT INTO authorship_spans
                   (id, node_id, codex_entry_id, snippet_id, detail_value_id,
                    from_pos, to_pos, source, model, timestamp, chat_msg_id,
                    trace_id, phase_id)
                 VALUES
                   (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    span.id,
                    node_id,
                    codex_entry_id,
                    snippet_id,
                    detail_value_id,
                    span.from_pos,
                    span.to_pos,
                    span.source,
                    span.model,
                    span.timestamp,
                    span.chat_msg_id,
                    span.trace_id,
                    phase_id,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetEntityTagsPayload {
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    pub entity_kind: String,
    pub entity_id: String,
    pub tag_ids: Vec<String>,
    pub updated_at: Option<String>,
}

fn entity_project_id(
    tx: &Transaction<'_>,
    entity_kind: &str,
    entity_id: &str,
) -> anyhow::Result<String> {
    let sql = match entity_kind {
        "codex" => "SELECT project_id FROM codex_entries WHERE id = ?1",
        "snippet" => "SELECT project_id FROM snippets WHERE id = ?1",
        _ => anyhow::bail!("entityKind must be codex or snippet"),
    };
    tx.query_row(sql, params![entity_id], |row| row.get(0))
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("{entity_kind} entity not found"))
}

fn collect_entity_tags_snapshot(
    tx: &Transaction<'_>,
    entity_kind: &str,
    entity_id: &str,
    project_id: &str,
) -> anyhow::Result<Value> {
    let object_key = entity_tags_object_key(entity_kind, entity_id)?;
    crate::canonical_feed_snapshots::canonical_snapshot_for_object_key(tx, project_id, &object_key)?
        .ok_or_else(|| anyhow::anyhow!("{entity_kind} entity '{entity_id}' disappeared"))
}

fn entity_tags_object_key(entity_kind: &str, entity_id: &str) -> anyhow::Result<Value> {
    match entity_kind {
        "codex" => Ok(json!({ "kind": "codex-entry", "entryId": entity_id })),
        "snippet" => Ok(json!({
            "kind": "component",
            "componentId": format!("snippet:{entity_id}"),
        })),
        _ => anyhow::bail!("entityKind must be codex or snippet"),
    }
}

pub fn set_entity_tags(db: &Database, payload: SetEntityTagsPayload) -> anyhow::Result<()> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.request_id, "requestId")?;
    require_non_empty(&payload.session_id, "sessionId")?;
    require_non_empty(&payload.event_uid, "eventUid")?;
    require_non_empty(&payload.entity_id, "entityId")?;
    let replay = matches!(
        payload.origin,
        NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
    );
    let complete_lineage = payload
        .original_transaction_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        && payload
            .undo_journal_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    anyhow::ensure!(
        replay == complete_lineage
            && (replay
                || (payload.original_transaction_id.is_none()
                    && payload.undo_journal_id.is_none())),
        "undo/redo origin requires originalTransactionId and undoJournalId"
    );
    let mut unique_tag_ids = HashSet::new();
    for tag_id in &payload.tag_ids {
        require_non_empty(tag_id, "tagIds[]")?;
        if !unique_tag_ids.insert(tag_id.as_str()) {
            anyhow::bail!("tagIds must be unique");
        }
    }
    if payload.entity_kind == "codex" {
        require_non_empty(
            payload.updated_at.as_deref().unwrap_or_default(),
            "updatedAt",
        )?;
    }

    let request_hash = canonical_write_payload_fingerprint("entity_tags_set", &payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "entity_tags_set",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "ENTITY_TAGS_REQUEST_CONFLICT",
    };
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if load_idempotent_response(&tx, &idempotency_request)?.is_some() {
            tx.commit()?;
            return Ok(());
        }
        let project_id = entity_project_id(&tx, &payload.entity_kind, &payload.entity_id)?;
        anyhow::ensure!(
            project_id == payload.project_id,
            "{} entity '{}' is not in project '{}'",
            payload.entity_kind,
            payload.entity_id,
            payload.project_id
        );
        if replay {
            require_replay_lineage_in_project(
                &tx,
                &payload.project_id,
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
        let before = collect_entity_tags_snapshot(
            &tx,
            &payload.entity_kind,
            &payload.entity_id,
            &project_id,
        )?;
        let mut tags = Vec::<serde_json::Value>::new();
        for tag_id in &payload.tag_ids {
            let tag = tx
                .query_row(
                    "SELECT name, color
                       FROM codex_tags
                      WHERE id = ?1 AND project_id = ?2",
                    params![tag_id, project_id],
                    |row| {
                        Ok(serde_json::json!({
                            "name": row.get::<_, String>(0)?,
                            "color": row.get::<_, Option<String>>(1)?,
                        }))
                    },
                )
                .optional()?
                .ok_or_else(|| {
                    anyhow::anyhow!("tag '{tag_id}' is not in project '{project_id}'")
                })?;
            tags.push(tag);
        }
        tags.sort_by(|a, b| {
            a["name"]
                .as_str()
                .unwrap_or_default()
                .cmp(b["name"].as_str().unwrap_or_default())
        });
        let tags_cache = serde_json::to_string(&tags)?;

        match payload.entity_kind.as_str() {
            "codex" => {
                tx.execute(
                    "DELETE FROM codex_entry_tags WHERE entry_id = ?1",
                    params![payload.entity_id],
                )?;
                for tag_id in &payload.tag_ids {
                    tx.execute(
                        "INSERT INTO codex_entry_tags (entry_id, tag_id)
                         VALUES (?1, ?2)",
                        params![payload.entity_id, tag_id],
                    )?;
                }
                tx.execute(
                    "UPDATE codex_entries
                        SET tags_cache = ?1, updated_at = ?2
                      WHERE id = ?3 AND project_id = ?4",
                    params![
                        tags_cache,
                        payload.updated_at,
                        payload.entity_id,
                        project_id
                    ],
                )?;
            }
            "snippet" => {
                tx.execute(
                    "DELETE FROM snippet_entry_tags WHERE snippet_id = ?1",
                    params![payload.entity_id],
                )?;
                for tag_id in &payload.tag_ids {
                    tx.execute(
                        "INSERT INTO snippet_entry_tags (snippet_id, tag_id)
                         VALUES (?1, ?2)",
                        params![payload.entity_id, tag_id],
                    )?;
                }
                tx.execute(
                    "UPDATE snippets
                        SET tags_cache = ?1
                      WHERE id = ?2 AND project_id = ?3",
                    params![tags_cache, payload.entity_id, project_id],
                )?;
            }
            _ => unreachable!("entity kind was validated"),
        }
        let after = collect_entity_tags_snapshot(
            &tx,
            &payload.entity_kind,
            &payload.entity_id,
            &project_id,
        )?;
        let timestamp = payload
            .updated_at
            .as_deref()
            .map(event_timestamp)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        let occurred_at = chrono::DateTime::from_timestamp_millis(timestamp)
            .ok_or_else(|| anyhow::anyhow!("entity tags timestamp is outside the supported range"))?
            .to_rfc3339();
        let operation = format!("{}.tags.set", payload.entity_kind);
        let object_key = entity_tags_object_key(&payload.entity_kind, &payload.entity_id)?;
        append_canonical_and_narrative_change_in_tx(
            &tx,
            &project_id,
            &payload.session_id,
            &AppendChangeEvent {
                event_uid: payload.event_uid.clone(),
                scene_id: None,
                domain: payload.entity_kind.clone(),
                op_type: operation.clone(),
                entity_type: Some(format!("{}_tags", payload.entity_kind)),
                entity_id: Some(payload.entity_id.clone()),
                payload: json!({
                    "requestId": payload.request_id,
                    "tagCount": payload.tag_ids.len(),
                })
                .to_string(),
                timestamp,
            },
            &AppendNarrativeChangeTransactionInput {
                project_id: project_id.clone(),
                request_id: payload.request_id.clone(),
                source_domain: operation,
                source_change_event_uid: payload.event_uid.clone(),
                cause_kind: match payload.origin {
                    NarrativeChangeOrigin::Undo => NarrativeChangeCauseKind::Undo,
                    NarrativeChangeOrigin::Redo => NarrativeChangeCauseKind::Redo,
                    _ => NarrativeChangeCauseKind::Forward,
                },
                origin: payload.origin,
                original_transaction_id: payload.original_transaction_id.clone(),
                commit_id: None,
                journal_id: None,
                undo_journal_id: payload.undo_journal_id.clone(),
                application_ids: Vec::new(),
                occurred_at,
                events: vec![NarrativeChangeEventInput {
                    object_key,
                    change_kind: "association".to_string(),
                    mutation_kind: "update".to_string(),
                    before_version: before.get("version").and_then(Value::as_i64),
                    before_digest: Some(narrative_snapshot_digest(&before)?),
                    after_version: after.get("version").and_then(Value::as_i64),
                    after_digest: Some(narrative_snapshot_digest(&after)?),
                    changed_paths: vec!["/tags".to_string()],
                    text_impact: None,
                    structural_impact: Some(json!({ "changedPaths": ["/tags"] })),
                }],
            },
        )?;
        insert_idempotent_response(
            &tx,
            &idempotency_request,
            &project_id,
            &json!({ "eventUid": payload.event_uid }),
        )?;
        tx.commit()?;
        Ok(())
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRenameUndoUpdate {
    pub kind: String,
    pub ref_id: String,
    pub detail_definition_id: Option<String>,
    pub base_version: i64,
    pub value: String,
    pub char_count: Option<i64>,
    pub placed_beat_preview: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRenameUndoPayload {
    pub request_id: String,
    pub event_uid: String,
    pub original_transaction_id: String,
    pub undo_journal_id: String,
    pub project_id: String,
    pub updated_at: String,
    pub updates: Vec<CodexRenameUndoUpdate>,
    #[serde(default)]
    pub session_id: Option<String>,
}

fn codex_rename_update_sort_key(update: &CodexRenameUndoUpdate) -> anyhow::Result<String> {
    match update.kind.as_str() {
        "scene-body" => Ok(format!("scene:{}:content", update.ref_id)),
        "node-title" => Ok(format!("scene:{}:title", update.ref_id)),
        "node-synopsis" => Ok(format!("scene:{}:synopsis", update.ref_id)),
        "codex-summary" => Ok(format!("codex-entry:{}:/summary", update.ref_id)),
        "codex-content" => Ok(format!("codex-entry:{}:/content", update.ref_id)),
        "codex-notes" => Ok(format!("codex-entry:{}:/notes", update.ref_id)),
        "codex-detail" => Ok(format!(
            "codex-detail-value:{}:{}",
            update.ref_id,
            update
                .detail_definition_id
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("codex detail definition id is required"))?
        )),
        "codex-relation-label" => Ok(format!("codex-relation:{}", update.ref_id)),
        other => anyhow::bail!("unsupported codex rename kind '{other}'"),
    }
}

fn codex_rename_feed_contract(
    conn: &rusqlite::Connection,
    project_id: &str,
    update: &CodexRenameUndoUpdate,
) -> anyhow::Result<(Value, &'static str, Vec<String>)> {
    match update.kind.as_str() {
        "scene-body" => Ok((
            json!({ "kind": "scene", "sceneId": update.ref_id }),
            "content",
            vec![
                "/charCount".to_string(),
                "/content".to_string(),
                "/placedBeatPreview".to_string(),
            ],
        )),
        "node-title" => Ok((
            json!({ "kind": "scene", "sceneId": update.ref_id }),
            "metadata",
            vec!["/title".to_string()],
        )),
        "node-synopsis" => Ok((
            json!({ "kind": "scene", "sceneId": update.ref_id }),
            "metadata",
            vec!["/synopsis".to_string()],
        )),
        "codex-summary" | "codex-content" | "codex-notes" => {
            let path = match update.kind.as_str() {
                "codex-summary" => "/summary",
                "codex-content" => "/content",
                "codex-notes" => "/notes",
                _ => unreachable!("matched above"),
            };
            Ok((
                json!({ "kind": "codex-entry", "entryId": update.ref_id }),
                "metadata",
                vec![path.to_string()],
            ))
        }
        "codex-detail" => {
            let definition_id = update
                .detail_definition_id
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("codex detail definition id is required"))?;
            let value_id: String = conn
                .query_row(
                    "SELECT value.id FROM codex_detail_values value
                      JOIN codex_entries entry ON entry.id = value.entry_id
                      JOIN codex_detail_definitions definition
                        ON definition.id = value.definition_id
                     WHERE value.entry_id = ?1 AND value.definition_id = ?2
                       AND entry.project_id = ?3
                       AND definition.project_id = ?3",
                    params![update.ref_id, definition_id, project_id],
                    |row| row.get(0),
                )
                .optional()?
                .ok_or_else(|| anyhow::anyhow!("codex detail value is missing"))?;
            Ok((
                json!({
                    "kind": "codex-detail-value",
                    "valueId": value_id,
                }),
                "metadata",
                vec![format!("/details/{}", json_pointer_segment(definition_id))],
            ))
        }
        "codex-relation-label" => Ok((
            json!({ "kind": "codex-relation", "relationId": update.ref_id }),
            "association",
            vec!["/forwardLabel".to_string()],
        )),
        other => anyhow::bail!("unsupported codex rename kind '{other}'"),
    }
}

fn validate_codex_rename_updates(updates: &[CodexRenameUndoUpdate]) -> anyhow::Result<()> {
    let mut update_keys = HashSet::new();
    for update in updates {
        require_non_empty(&update.ref_id, "updates[].refId")?;
        anyhow::ensure!(
            update.base_version >= 0,
            "codex rename baseVersion must be non-negative"
        );
        if update.kind == "codex-detail" {
            require_non_empty(
                update.detail_definition_id.as_deref().unwrap_or_default(),
                "updates[].detailDefinitionId",
            )?;
        }
        let key = format!(
            "{}:{}:{}",
            update.kind,
            update.ref_id,
            update.detail_definition_id.as_deref().unwrap_or_default()
        );
        if !update_keys.insert(key) {
            anyhow::bail!("codex rename updates must be unique");
        }
    }
    Ok(())
}

fn codex_rename_body_snapshot_targets(
    updates: &[CodexRenameUndoUpdate],
) -> Vec<crate::timelapse::TimelapseBodySnapshotTarget> {
    updates
        .iter()
        .filter_map(|update| match update.kind.as_str() {
            "scene-body" => Some(crate::timelapse::TimelapseBodySnapshotTarget::scene(
                update.ref_id.clone(),
            )),
            "codex-content" => Some(crate::timelapse::TimelapseBodySnapshotTarget::codex(
                update.ref_id.clone(),
            )),
            _ => None,
        })
        .collect()
}

/// Apply one side (forward or undo) of a rename propagation batch inside an
/// already-open transaction. Shared by `apply_codex_rename` (forward, new
/// value) and `undo_codex_rename` (undo, old value) — both pass the target
/// value pre-selected into `update.value`.
///
/// `tree_nodes` (scene-body/node-title/node-synopsis) is not a protected
/// Narrative table, but is applied here too so the whole rename batch commits
/// atomically in one Native transaction (matching the pre-cutover
/// `agentWriteBundle` guarantee).
struct CodexRenameApplyOutcome {
    versions: Vec<Value>,
    feed_events: Vec<NarrativeChangeEventInput>,
}

fn apply_codex_rename_updates_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    updated_at: &str,
    session_id: &str,
    updates: &[CodexRenameUndoUpdate],
) -> anyhow::Result<CodexRenameApplyOutcome> {
    let mut versions = vec![Value::Null; updates.len()];
    let mut feed_events = Vec::with_capacity(updates.len());
    let mut ordered_indices = (0..updates.len()).collect::<Vec<_>>();
    let mut keyed_indices = ordered_indices
        .drain(..)
        .map(|index| Ok((codex_rename_update_sort_key(&updates[index])?, index)))
        .collect::<anyhow::Result<Vec<_>>>()?;
    keyed_indices.sort_by(|left, right| left.0.cmp(&right.0));
    let mut aggregate_versions: HashMap<String, (i64, i64)> = HashMap::new();
    for (_, index) in keyed_indices {
        let update = &updates[index];
        let (object_key, change_kind, changed_paths) =
            codex_rename_feed_contract(conn, project_id, update)?;
        let before_state = crate::canonical_feed_snapshots::canonical_snapshot_for_object_key(
            conn,
            project_id,
            &object_key,
        )?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "CODEX_RENAME_VERSION_MISMATCH: target '{}' is missing or outside project '{}'",
                update.ref_id,
                project_id
            )
        })?;
        let aggregate_key = match update.kind.as_str() {
            "scene-body" | "node-title" | "node-synopsis" => {
                format!("tree-node:{}", update.ref_id)
            }
            "codex-summary" | "codex-content" | "codex-notes" => {
                format!("codex-entry:{}", update.ref_id)
            }
            "codex-detail" => format!(
                "codex-detail-value:{}:{}",
                update.ref_id,
                update.detail_definition_id.as_deref().unwrap_or_default()
            ),
            "codex-relation-label" => format!("codex-relation:{}", update.ref_id),
            _ => anyhow::bail!("unsupported codex rename kind '{}'", update.kind),
        };
        let expected_version = if let Some((initial_version, current_version)) =
            aggregate_versions.get(&aggregate_key)
        {
            anyhow::ensure!(
                update.base_version == *initial_version,
                "CODEX_RENAME_VERSION_MISMATCH: target '{}' supplied inconsistent base versions",
                update.ref_id
            );
            *current_version
        } else {
            update.base_version
        };
        let next_version = expected_version
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("codex rename version overflow"))?;
        let initial_version = aggregate_versions
            .get(&aggregate_key)
            .map(|(initial, _)| *initial)
            .unwrap_or(update.base_version);
        aggregate_versions.insert(aggregate_key, (initial_version, next_version));
        let changed = match update.kind.as_str() {
            "scene-body" => {
                let char_count =
                    update
                        .char_count
                        .filter(|count| *count >= 0)
                        .ok_or_else(|| {
                            anyhow::anyhow!("scene-body rename requires a non-negative charCount")
                        })?;
                conn.execute(
                    "UPDATE tree_nodes
                        SET content = ?1, char_count = ?2,
                            placed_beat_preview = ?3,
                            version = ?4, updated_at = ?5
                      WHERE id = ?6 AND project_id = ?7
                        AND node_type = 'scene' AND version = ?8",
                    params![
                        update.value,
                        char_count,
                        update.placed_beat_preview,
                        next_version,
                        updated_at,
                        update.ref_id,
                        project_id,
                        expected_version
                    ],
                )?
            }
            "node-title" | "node-synopsis" => {
                let column = if update.kind == "node-title" {
                    "title"
                } else {
                    "synopsis"
                };
                conn.execute(
                    &format!(
                        "UPDATE tree_nodes SET {column} = ?1,
                                version = ?2, updated_at = ?3
                          WHERE id = ?4 AND project_id = ?5 AND version = ?6"
                    ),
                    params![
                        update.value,
                        next_version,
                        updated_at,
                        update.ref_id,
                        project_id,
                        expected_version
                    ],
                )?
            }
            "codex-summary" | "codex-content" | "codex-notes" => {
                let column = match update.kind.as_str() {
                    "codex-summary" => "summary",
                    "codex-content" => "content",
                    "codex-notes" => "notes",
                    _ => unreachable!("kind matched above"),
                };
                conn.execute(
                    &format!(
                        "UPDATE codex_entries
                            SET {column} = ?1, version = ?2, updated_at = ?3
                          WHERE id = ?4 AND project_id = ?5 AND version = ?6"
                    ),
                    params![
                        update.value,
                        next_version,
                        updated_at,
                        update.ref_id,
                        project_id,
                        expected_version
                    ],
                )?
            }
            "codex-detail" => conn.execute(
                "UPDATE codex_detail_values
                    SET value = ?1, version = ?2, updated_at = ?3
                  WHERE entry_id = ?4 AND definition_id = ?5
                    AND version = ?6
                    AND EXISTS (
                      SELECT 1 FROM codex_entries
                       WHERE id = ?4 AND project_id = ?7
                    )
                    AND EXISTS (
                      SELECT 1 FROM codex_detail_definitions
                       WHERE id = ?5 AND project_id = ?7
                    )",
                params![
                    update.value,
                    next_version,
                    updated_at,
                    update.ref_id,
                    update.detail_definition_id,
                    expected_version,
                    project_id
                ],
            )?,
            "codex-relation-label" => conn.execute(
                "UPDATE codex_relations
                    SET label = ?1, version = ?2, updated_at = ?3
                  WHERE id = ?4 AND project_id = ?5 AND version = ?6",
                params![
                    update.value,
                    next_version,
                    updated_at,
                    update.ref_id,
                    project_id,
                    expected_version
                ],
            )?,
            _ => anyhow::bail!("unsupported codex rename kind '{}'", update.kind),
        };
        if changed != 1 {
            anyhow::bail!(
                "CODEX_RENAME_VERSION_MISMATCH: target '{}' is missing, outside project '{}', or expected version {} is stale",
                update.ref_id, project_id, expected_version
            );
        }

        match update.kind.as_str() {
            "scene-body" => {
                crate::narrative_extraction::record_human_field_write(
                    conn,
                    project_id,
                    "scene",
                    &update.ref_id,
                    &["/content", "/charCount", "/placedBeatPreview"],
                    updated_at,
                )?;
                let source_key = format!("project:scene:{}", update.ref_id);
                let source_token = format!("v{next_version}@{updated_at}");
                crate::narrative_extraction::propagate_source_change_freshness_in_tx(
                    conn,
                    project_id,
                    "scene-body",
                    &source_key,
                    Some(&source_token),
                    updated_at,
                    session_id,
                )?;
            }
            "node-title" => {
                crate::narrative_extraction::record_human_field_write(
                    conn,
                    project_id,
                    "scene",
                    &update.ref_id,
                    &["/title"],
                    updated_at,
                )?;
            }
            "node-synopsis" => {
                crate::narrative_extraction::record_human_field_write(
                    conn,
                    project_id,
                    "scene",
                    &update.ref_id,
                    &["/synopsis"],
                    updated_at,
                )?;
            }
            "codex-summary" | "codex-content" | "codex-notes" => {
                let field_path = match update.kind.as_str() {
                    "codex-summary" => "/summary",
                    "codex-content" => "/content",
                    "codex-notes" => "/notes",
                    _ => unreachable!("kind matched above"),
                };
                crate::narrative_extraction::record_human_field_write(
                    conn,
                    project_id,
                    "codex-entry",
                    &update.ref_id,
                    &[field_path],
                    updated_at,
                )?;
            }
            "codex-detail" => {
                let definition_id = update
                    .detail_definition_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("codex detail definition id is required"))?;
                let field_path = format!("/details/{}", json_pointer_segment(definition_id));
                crate::narrative_extraction::record_human_field_write(
                    conn,
                    project_id,
                    "codex-entry",
                    &update.ref_id,
                    &[field_path.as_str()],
                    updated_at,
                )?;
            }
            "codex-relation-label" => {
                crate::narrative_extraction::record_human_field_write(
                    conn,
                    project_id,
                    "codex-relation",
                    &update.ref_id,
                    &["/forwardLabel"],
                    updated_at,
                )?;
            }
            _ => unreachable!("unsupported rename kind was rejected above"),
        }
        versions[index] = serde_json::json!({
            "kind": update.kind,
            "refId": update.ref_id,
            "detailDefinitionId": update.detail_definition_id,
            "version": next_version,
            "baseVersion": expected_version,
        });
        let after_state = crate::canonical_feed_snapshots::canonical_snapshot_for_object_key(
            conn,
            project_id,
            &object_key,
        )?
        .ok_or_else(|| anyhow::anyhow!("codex rename target '{}' disappeared", update.ref_id))?;
        feed_events.push(NarrativeChangeEventInput {
            object_key,
            change_kind: change_kind.to_string(),
            mutation_kind: "update".to_string(),
            before_version: before_state.get("version").and_then(Value::as_i64),
            before_digest: Some(narrative_snapshot_digest(&before_state)?),
            after_version: after_state.get("version").and_then(Value::as_i64),
            after_digest: Some(narrative_snapshot_digest(&after_state)?),
            structural_impact: Some(json!({ "changedPaths": changed_paths })),
            changed_paths,
            text_impact: None,
        });
    }
    Ok(CodexRenameApplyOutcome {
        versions,
        feed_events,
    })
}

pub fn undo_codex_rename(db: &Database, payload: CodexRenameUndoPayload) -> anyhow::Result<Value> {
    require_non_empty(&payload.request_id, "requestId")?;
    require_non_empty(&payload.event_uid, "eventUid")?;
    require_non_empty(&payload.original_transaction_id, "originalTransactionId")?;
    require_non_empty(&payload.undo_journal_id, "undoJournalId")?;
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.updated_at, "updatedAt")?;
    validate_codex_rename_updates(&payload.updates)?;
    anyhow::ensure!(
        !payload.updates.is_empty(),
        "codex rename undo requires updates"
    );
    let session_id = payload
        .session_id
        .as_deref()
        .filter(|session| !session.is_empty())
        .ok_or_else(|| anyhow::anyhow!("sessionId is required"))?;
    let request_hash = canonical_write_payload_fingerprint("codex_rename_undo", &payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "codex_rename_undo",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "CODEX_RENAME_UNDO_REQUEST_CONFLICT",
    };
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(response) = load_idempotent_response(&tx, &idempotency_request)? {
            tx.commit()?;
            return Ok(response);
        }
        let CodexRenameApplyOutcome {
            versions,
            feed_events,
        } = apply_codex_rename_updates_in_tx(
            &tx,
            &payload.project_id,
            &payload.updated_at,
            session_id,
            &payload.updates,
        )?;
        let timestamp = event_timestamp(&payload.updated_at);
        let occurred_at = chrono::DateTime::from_timestamp_millis(timestamp)
            .ok_or_else(|| {
                anyhow::anyhow!("codex rename timestamp is outside the supported range")
            })?
            .to_rfc3339();
        let append = append_canonical_and_narrative_change_in_tx(
            &tx,
            &payload.project_id,
            session_id,
            &AppendChangeEvent {
                event_uid: payload.event_uid.clone(),
                scene_id: None,
                domain: "codex".to_string(),
                op_type: "codex.renameUndo".to_string(),
                entity_type: Some("codex_rename".to_string()),
                entity_id: payload.updates.first().map(|update| update.ref_id.clone()),
                payload: json!({
                    "requestId": payload.request_id,
                    "updateCount": payload.updates.len(),
                })
                .to_string(),
                timestamp,
            },
            &AppendNarrativeChangeTransactionInput {
                project_id: payload.project_id.clone(),
                request_id: payload.request_id.clone(),
                source_domain: "codex.renameUndo".to_string(),
                source_change_event_uid: payload.event_uid.clone(),
                cause_kind: NarrativeChangeCauseKind::Undo,
                origin: NarrativeChangeOrigin::Undo,
                original_transaction_id: Some(payload.original_transaction_id.clone()),
                commit_id: None,
                journal_id: None,
                undo_journal_id: Some(payload.undo_journal_id.clone()),
                application_ids: Vec::new(),
                occurred_at,
                events: feed_events,
            },
        )?;
        crate::timelapse::append_timelapse_body_snapshots_in_tx(
            &tx,
            &payload.project_id,
            append.canonical.tail_sequence,
            timestamp,
            &codex_rename_body_snapshot_targets(&payload.updates),
        )?;
        let response = json!({
            "versions": versions,
            "changeEventUid": payload.event_uid,
            "maintenanceTransactionId": append.narrative.transaction_id,
        });
        insert_idempotent_response(&tx, &idempotency_request, &payload.project_id, &response)?;
        tx.commit()?;
        Ok(response)
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRenameApplyPayload {
    pub request_id: String,
    pub project_id: String,
    pub session_id: String,
    #[serde(default)]
    pub surface: Option<String>,
    pub entry_id: String,
    pub updated_at: String,
    pub updates: Vec<CodexRenameUndoUpdate>,
    /// JSON envelope `{entryId, oldName, newName, applied}` recorded verbatim
    /// into undo_journal.after_json and the change_event payload (TS builds
    /// this small metadata blob; it never contains protected-table SQL).
    pub event_summary: String,
    pub event_uid: String,
    pub timestamp: i64,
    #[serde(default)]
    pub redo: bool,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
}

/// Forward-apply a rename propagation batch (Native replacement for the
/// pre-cutover `agentWriteBundle` + Drizzle `.update().toSQL()` statements).
/// Runs every update in one transaction, then records undo_journal +
/// change_event exactly like `agent_write_bundle_impl` did.
pub fn apply_codex_rename(
    db: &Database,
    payload: CodexRenameApplyPayload,
) -> anyhow::Result<Value> {
    require_non_empty(&payload.request_id, "requestId")?;
    require_non_empty(&payload.session_id, "sessionId")?;
    require_non_empty(&payload.event_uid, "eventUid")?;
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.updated_at, "updatedAt")?;
    require_non_empty(&payload.entry_id, "entryId")?;
    anyhow::ensure!(
        !payload.updates.is_empty(),
        "codex rename apply requires at least one update"
    );
    validate_codex_rename_updates(&payload.updates)?;
    if payload.redo {
        require_non_empty(
            payload
                .original_transaction_id
                .as_deref()
                .unwrap_or_default(),
            "originalTransactionId",
        )?;
        require_non_empty(
            payload.undo_journal_id.as_deref().unwrap_or_default(),
            "undoJournalId",
        )?;
    } else {
        anyhow::ensure!(
            payload.original_transaction_id.is_none() && payload.undo_journal_id.is_none(),
            "originalTransactionId and undoJournalId are only valid for redo"
        );
    }
    let request_hash = canonical_write_payload_fingerprint("codex_rename_apply", &payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "codex_rename_apply",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "CODEX_RENAME_APPLY_REQUEST_CONFLICT",
    };

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            if let Some(response) = load_idempotent_response(conn, &idempotency_request)? {
                return Ok(response);
            }
            let entry_owned: i64 = conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM codex_entries WHERE id = ?1 AND project_id = ?2
                 )",
                params![payload.entry_id, payload.project_id],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                entry_owned == 1,
                "codex rename entry '{}' is not in project '{}'",
                payload.entry_id,
                payload.project_id
            );
            let CodexRenameApplyOutcome {
                versions,
                feed_events,
            } = apply_codex_rename_updates_in_tx(
                conn,
                &payload.project_id,
                &payload.updated_at,
                &payload.session_id,
                &payload.updates,
            )?;
            let undo_id = payload
                .undo_journal_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            if !payload.redo {
                crate::undo_journal::insert_undo_journal_in_tx(
                    conn,
                    crate::undo_journal::UndoJournalInsert {
                        id: &undo_id,
                        project_id: &payload.project_id,
                        surface: payload
                            .surface
                            .as_deref()
                            .unwrap_or("codex-rename-propagation"),
                        entity_kind: "codex_rename",
                        entity_id: &payload.entry_id,
                        op_kind: "codex.renamePropagate",
                        before_json: None,
                        after_json: Some(&payload.event_summary),
                        base_version: 0,
                        result_version: 1,
                        change_event_uid: Some(&payload.event_uid),
                    },
                )?;
            }
            let occurred_at = chrono::DateTime::from_timestamp_millis(payload.timestamp)
                .ok_or_else(|| {
                    anyhow::anyhow!("codex rename timestamp is outside the supported range")
                })?
                .to_rfc3339();
            let append = append_canonical_and_narrative_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &AppendChangeEvent {
                    event_uid: payload.event_uid.clone(),
                    scene_id: None,
                    domain: "codex".to_string(),
                    op_type: "codex.renamePropagate".to_string(),
                    entity_type: Some("codex_entry".to_string()),
                    entity_id: Some(payload.entry_id.clone()),
                    payload: payload.event_summary.clone(),
                    timestamp: payload.timestamp,
                },
                &AppendNarrativeChangeTransactionInput {
                    project_id: payload.project_id.clone(),
                    request_id: payload.request_id.clone(),
                    source_domain: "codex.renamePropagate".to_string(),
                    source_change_event_uid: payload.event_uid.clone(),
                    cause_kind: if payload.redo {
                        NarrativeChangeCauseKind::Redo
                    } else {
                        NarrativeChangeCauseKind::Forward
                    },
                    origin: if payload.redo {
                        NarrativeChangeOrigin::Redo
                    } else {
                        NarrativeChangeOrigin::Human
                    },
                    original_transaction_id: payload.original_transaction_id.clone(),
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: Some(undo_id.clone()),
                    application_ids: Vec::new(),
                    occurred_at,
                    events: feed_events,
                },
            )?;
            crate::timelapse::append_timelapse_body_snapshots_in_tx(
                conn,
                &payload.project_id,
                append.canonical.tail_sequence,
                payload.timestamp,
                &codex_rename_body_snapshot_targets(&payload.updates),
            )?;
            let response = json!({
                "entityId": payload.entry_id,
                "version": versions.last().and_then(|item| item.get("version")).and_then(Value::as_i64).unwrap_or(0),
                "versions": versions,
                "changeEventUid": payload.event_uid,
                "undoJournalId": undo_id,
                "maintenanceTransactionId": append.narrative.transaction_id,
            });
            insert_idempotent_response(
                conn,
                &idempotency_request,
                &payload.project_id,
                &response,
            )?;
            Ok(response)
        })();

        match result {
            Ok(value) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(value)
            }
            Err(err) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(err)
            }
        }
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateScanStagingProjectPayload {
    pub id: String,
    pub title: String,
    pub language: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStagingProjectPublishPayload {
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreatePayload {
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    pub title: String,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub pov: Option<String>,
    #[serde(default)]
    pub tense: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub style_guide: Option<String>,
    #[serde(default)]
    pub ai_instructions: Option<String>,
    #[serde(default)]
    pub outline: Option<String>,
    #[serde(default)]
    pub target_readers: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeletePayload {
    pub project_id: String,
}

const PROJECT_CREATE_BUILTIN_SLUGS: [&str; 4] = ["character", "location", "item", "lore"];

fn select_project_row(conn: &rusqlite::Connection, project_id: &str) -> anyhow::Result<Value> {
    Database::execute_with_conn(
        conn,
        "SELECT id,
                title,
                genre,
                pov,
                tense,
                language,
                style_guide AS styleGuide,
                ai_instructions AS aiInstructions,
                outline,
                target_readers AS targetReaders,
                phase_resolution_mode AS phaseResolutionMode,
                ai_policy AS aiPolicy,
                created_at AS createdAt,
                updated_at AS updatedAt
           FROM projects
          WHERE id = ?1",
        &[Value::String(project_id.to_string())],
        "get",
    )?
    .into_iter()
    .next()
    .map(Value::Object)
    .ok_or_else(|| anyhow::anyhow!("project '{project_id}' was not created"))
}

fn project_builtin_type_snapshots(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> anyhow::Result<Vec<Value>> {
    let type_ids = conn
        .prepare(
            "SELECT id FROM codex_types
              WHERE project_id = ?1 AND is_builtin = 1
                AND slug IN ('character', 'location', 'item', 'lore')
              ORDER BY CASE slug
                         WHEN 'character' THEN 0 WHEN 'location' THEN 1
                         WHEN 'item' THEN 2 WHEN 'lore' THEN 3 ELSE 4 END",
        )?
        .query_map(params![project_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let rows = type_ids
        .into_iter()
        .map(|type_id| {
            crate::canonical_feed_snapshots::canonical_codex_type_snapshot(
                conn, project_id, &type_id,
            )
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(
        rows.len() == PROJECT_CREATE_BUILTIN_SLUGS.len()
            && rows
                .iter()
                .zip(PROJECT_CREATE_BUILTIN_SLUGS)
                .all(
                    |(row, expected_slug)| row.get("slug").and_then(Value::as_str)
                        == Some(expected_slug)
                ),
        "project '{project_id}' did not seed the canonical builtin Codex catalog"
    );
    Ok(rows)
}

fn project_create_feed_events(
    builtin_types: &[Value],
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    builtin_types
        .iter()
        .map(|snapshot| {
            let type_id = snapshot
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("builtin Codex type id is missing"))?;
            Ok(NarrativeChangeEventInput {
                object_key: json!({
                    "kind": "component",
                    "componentId": format!("codex-type:{type_id}"),
                }),
                change_kind: "catalog".to_string(),
                mutation_kind: "create".to_string(),
                before_version: None,
                before_digest: None,
                after_version: None,
                after_digest: Some(narrative_snapshot_digest(snapshot)?),
                changed_paths: vec!["/".to_string()],
                text_impact: None,
                structural_impact: Some(json!({ "changedPaths": ["/"] })),
            })
        })
        .collect()
}

/// Publish a user-visible Project and its builtin Codex catalog as one
/// canonical transaction. The schema trigger still seeds the four builtin
/// rows for bootstrap/sample/import compatibility; this trusted writer owns
/// their language normalization, canonical Change Event, Feed, and replay
/// receipt before the surrounding transaction is allowed to commit.
pub fn project_create(db: &Database, payload: ProjectCreatePayload) -> anyhow::Result<Value> {
    for (value, field) in [
        (&payload.project_id, "projectId"),
        (&payload.request_id, "requestId"),
        (&payload.session_id, "sessionId"),
        (&payload.event_uid, "eventUid"),
        (&payload.title, "title"),
        (&payload.created_at, "createdAt"),
        (&payload.updated_at, "updatedAt"),
    ] {
        require_non_empty(value, field)?;
    }
    anyhow::ensure!(
        !matches!(
            payload.origin,
            NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
        ) && payload.original_transaction_id.is_none()
            && payload.undo_journal_id.is_none(),
        "project creation is a forward mutation and cannot name replay lineage"
    );
    let language = payload
        .language
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("ja")
        .to_string();
    let request_hash = canonical_write_payload_fingerprint("project_create", &payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "project_create",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "PROJECT_CREATE_REQUEST_CONFLICT",
    };

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(response) = load_idempotent_response(&tx, &idempotency_request)? {
            tx.commit()?;
            return Ok(response);
        }

        tx.execute(
            "INSERT INTO projects
               (id, title, genre, pov, tense, language, style_guide,
                ai_instructions, outline, target_readers, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                payload.project_id,
                payload.title,
                payload.genre,
                payload.pov,
                payload.tense,
                language,
                payload.style_guide,
                payload.ai_instructions,
                payload.outline,
                payload.target_readers,
                payload.created_at,
                payload.updated_at,
            ],
        )?;

        if language.starts_with("en") {
            for (slug, label) in [
                ("character", "Character"),
                ("location", "Location"),
                ("item", "Item"),
                ("lore", "Lore & Worldbuilding"),
            ] {
                let updated = tx.execute(
                    "UPDATE codex_types
                        SET label = ?1
                      WHERE project_id = ?2 AND slug = ?3 AND is_builtin = 1",
                    params![label, payload.project_id, slug],
                )?;
                anyhow::ensure!(
                    updated == 1,
                    "project '{}' did not seed builtin Codex type '{}'",
                    payload.project_id,
                    slug
                );
            }
        }

        let project = select_project_row(&tx, &payload.project_id)?;
        let builtin_types = project_builtin_type_snapshots(&tx, &payload.project_id)?;
        let timestamp = event_timestamp(&payload.created_at);
        let append = append_canonical_and_narrative_change_in_tx(
            &tx,
            &payload.project_id,
            &payload.session_id,
            &AppendChangeEvent {
                event_uid: payload.event_uid.clone(),
                scene_id: None,
                domain: "project".to_string(),
                op_type: "project.create".to_string(),
                entity_type: Some("project".to_string()),
                entity_id: Some(payload.project_id.clone()),
                payload: json!({
                    "requestId": payload.request_id,
                    "projectId": payload.project_id,
                    "builtinTypeIds": builtin_types
                        .iter()
                        .filter_map(|row| row.get("id").and_then(Value::as_str))
                        .collect::<Vec<_>>(),
                })
                .to_string(),
                timestamp,
            },
            &AppendNarrativeChangeTransactionInput {
                project_id: payload.project_id.clone(),
                request_id: payload.request_id.clone(),
                source_domain: "project.create".to_string(),
                source_change_event_uid: payload.event_uid.clone(),
                cause_kind: NarrativeChangeCauseKind::Forward,
                origin: payload.origin,
                original_transaction_id: None,
                commit_id: None,
                journal_id: None,
                undo_journal_id: None,
                application_ids: Vec::new(),
                occurred_at: payload.created_at.clone(),
                events: project_create_feed_events(&builtin_types)?,
            },
        )?;
        // A post-C2-ZC Project must be born with the Epoch that all later
        // Application writes consume.  Keep this after the canonical event
        // append so the epoch has an immutable creation-event lineage, and
        // before the idempotency receipt so the entire bootstrap is atomic.
        mint_c2zc_project_birth_epoch_in_tx(&tx, &payload.project_id, &payload.event_uid)?;
        let mut response = project;
        response
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("project create response is not an object"))?
            .insert(
                "__writeReceipt".to_string(),
                json!({
                    "changeEventUid": payload.event_uid,
                    "maintenanceTransactionId": append.narrative.transaction_id,
                    "undoJournalId": null,
                }),
            );
        insert_idempotent_response(&tx, &idempotency_request, &payload.project_id, &response)?;
        tx.commit()?;
        Ok(response)
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPatchPayload {
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    /// The renderer's last authoritative project token. Project metadata does
    /// not have a numeric version column, so `updatedAt` is the OCC token.
    pub base_updated_at: String,
    pub updated_at: String,
    pub patch: serde_json::Map<String, Value>,
}

const PROJECT_PATCH_FIELDS: [(&str, &str, &str); 11] = [
    ("title", "title", "/title"),
    ("genre", "genre", "/genre"),
    ("pov", "pov", "/pov"),
    ("tense", "tense", "/tense"),
    ("language", "language", "/language"),
    ("styleGuide", "style_guide", "/styleGuide"),
    ("aiInstructions", "ai_instructions", "/aiInstructions"),
    ("outline", "outline", "/outline"),
    ("targetReaders", "target_readers", "/targetReaders"),
    ("aiPolicy", "ai_policy", "/aiPolicy"),
    (
        "phaseResolutionMode",
        "phase_resolution_mode",
        "/phaseResolutionMode",
    ),
];

fn project_patch_field(key: &str) -> Option<(&'static str, &'static str)> {
    PROJECT_PATCH_FIELDS
        .iter()
        .find(|(wire, _, _)| *wire == key)
        .map(|(_, sql, path)| (*sql, *path))
}

fn project_patch_sql_value(value: &Value, field: &str) -> anyhow::Result<rusqlite::types::Value> {
    match value {
        Value::Null => Ok(rusqlite::types::Value::Null),
        Value::String(value) => {
            if field == "title" {
                require_non_empty(value, "patch.title")?;
            }
            Ok(rusqlite::types::Value::Text(value.clone()))
        }
        _ => anyhow::bail!("project patch field '{field}' must be a string or null"),
    }
}

/// Update Project metadata through the same Native transaction contract as
/// every other Canonical Writer. The `updatedAt` precondition is deliberately
/// checked in the SQL UPDATE so two renderer windows cannot publish divergent
/// feed states for one Project.
pub fn project_patch(db: &Database, payload: ProjectPatchPayload) -> anyhow::Result<Value> {
    for (value, field) in [
        (&payload.project_id, "projectId"),
        (&payload.request_id, "requestId"),
        (&payload.session_id, "sessionId"),
        (&payload.event_uid, "eventUid"),
        (&payload.base_updated_at, "baseUpdatedAt"),
        (&payload.updated_at, "updatedAt"),
    ] {
        require_non_empty(value, field)?;
    }
    anyhow::ensure!(
        !payload.patch.is_empty(),
        "project patch must contain at least one field"
    );
    anyhow::ensure!(
        payload
            .patch
            .keys()
            .all(|key| project_patch_field(key).is_some()),
        "project patch contains an unsupported field"
    );
    let replay = matches!(
        payload.origin,
        NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
    );
    anyhow::ensure!(
        replay == (payload.original_transaction_id.is_some() && payload.undo_journal_id.is_some())
            && (replay
                || (payload.original_transaction_id.is_none()
                    && payload.undo_journal_id.is_none())),
        "undo/redo origin requires originalTransactionId and undoJournalId"
    );
    let request_hash = canonical_write_payload_fingerprint("project_patch", &payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "project_patch",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "PROJECT_PATCH_REQUEST_CONFLICT",
    };

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(response) = load_idempotent_response(&tx, &idempotency_request)? {
            tx.commit()?;
            return Ok(response);
        }
        if replay {
            require_replay_lineage_in_project(
                &tx,
                &payload.project_id,
                payload
                    .original_transaction_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("missing originalTransactionId"))?,
                payload
                    .undo_journal_id
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("missing undoJournalId"))?,
            )?;
        }
        let before =
            crate::canonical_feed_snapshots::canonical_project_snapshot(&tx, &payload.project_id)?;
        let before_updated_at = before
            .get("updatedAt")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("project snapshot has no updatedAt"))?;
        anyhow::ensure!(
            before_updated_at == payload.base_updated_at,
            "PROJECT_VERSION_MISMATCH: project '{}' changed since {}",
            payload.project_id,
            payload.base_updated_at
        );

        let mut assignments = Vec::with_capacity(payload.patch.len() + 1);
        let mut values = Vec::with_capacity(payload.patch.len() + 3);
        let mut changed_paths = BTreeSet::new();
        for (wire, value) in &payload.patch {
            let (sql, path) = project_patch_field(wire)
                .ok_or_else(|| anyhow::anyhow!("unsupported project patch field '{wire}'"))?;
            assignments.push(format!("{sql} = ?{}", values.len() + 1));
            values.push(project_patch_sql_value(value, wire)?);
            changed_paths.insert(path.to_string());
        }
        assignments.push(format!("updated_at = ?{}", values.len() + 1));
        values.push(rusqlite::types::Value::Text(payload.updated_at.clone()));
        values.push(rusqlite::types::Value::Text(payload.project_id.clone()));
        values.push(rusqlite::types::Value::Text(
            payload.base_updated_at.clone(),
        ));
        let sql = format!(
            "UPDATE projects SET {} WHERE id = ?{} AND updated_at = ?{}",
            assignments.join(", "),
            values.len() - 1,
            values.len()
        );
        let changed = tx.execute(&sql, rusqlite::params_from_iter(values.iter()))?;
        anyhow::ensure!(
            changed == 1,
            "PROJECT_VERSION_MISMATCH: project '{}' update lost its OCC race",
            payload.project_id
        );
        let after =
            crate::canonical_feed_snapshots::canonical_project_snapshot(&tx, &payload.project_id)?;
        let changed_paths = changed_paths.into_iter().collect::<Vec<_>>();
        let before_json = serde_json::to_string(&before)?;
        let after_json = serde_json::to_string(&after)?;
        let journal_id = payload
            .undo_journal_id
            .clone()
            .unwrap_or_else(|| payload.request_id.clone());
        if !replay {
            crate::undo_journal::insert_undo_journal_in_tx(
                &tx,
                crate::undo_journal::UndoJournalInsert {
                    id: &journal_id,
                    project_id: &payload.project_id,
                    surface: "project",
                    entity_kind: "project",
                    entity_id: &payload.project_id,
                    op_kind: "update",
                    before_json: Some(&before_json),
                    after_json: Some(&after_json),
                    base_version: 0,
                    result_version: 0,
                    change_event_uid: Some(&payload.event_uid),
                },
            )?;
        }
        let cause_kind = match payload.origin {
            NarrativeChangeOrigin::Undo => NarrativeChangeCauseKind::Undo,
            NarrativeChangeOrigin::Redo => NarrativeChangeCauseKind::Redo,
            _ => NarrativeChangeCauseKind::Forward,
        };
        let change_kind = if changed_paths.iter().any(|path| path == "/aiPolicy") {
            "policy"
        } else {
            "metadata"
        };
        let maintenance = append_canonical_and_narrative_change_in_tx(
            &tx,
            &payload.project_id,
            &payload.session_id,
            &AppendChangeEvent {
                event_uid: payload.event_uid.clone(),
                scene_id: None,
                domain: "project".to_string(),
                op_type: "project.meta.update".to_string(),
                entity_type: Some("project".to_string()),
                entity_id: Some(payload.project_id.clone()),
                payload: json!({
                    "projectId": payload.project_id,
                    "fields": changed_paths.clone(),
                    "patch": payload.patch,
                })
                .to_string(),
                timestamp: event_timestamp(&payload.updated_at),
            },
            &AppendNarrativeChangeTransactionInput {
                project_id: payload.project_id.clone(),
                request_id: payload.request_id.clone(),
                source_domain: "project.meta.update".to_string(),
                source_change_event_uid: payload.event_uid.clone(),
                cause_kind,
                origin: payload.origin,
                original_transaction_id: payload.original_transaction_id.clone(),
                commit_id: None,
                journal_id: None,
                undo_journal_id: Some(journal_id.clone()),
                application_ids: Vec::new(),
                occurred_at: payload.updated_at.clone(),
                events: vec![NarrativeChangeEventInput {
                    object_key: json!({
                        "kind": "project",
                        "projectId": payload.project_id,
                    }),
                    change_kind: change_kind.to_string(),
                    mutation_kind: "update".to_string(),
                    before_version: None,
                    before_digest: Some(narrative_snapshot_digest(&before)?),
                    after_version: None,
                    after_digest: Some(narrative_snapshot_digest(&after)?),
                    changed_paths: changed_paths.clone(),
                    text_impact: None,
                    structural_impact: Some(json!({
                        "changedPaths": changed_paths,
                    })),
                }],
            },
        )?;
        let mut response = after;
        response
            .as_object_mut()
            .ok_or_else(|| anyhow::anyhow!("project patch response is not an object"))?
            .insert(
                "__writeReceipt".to_string(),
                json!({
                    "changeEventUid": payload.event_uid,
                    "maintenanceTransactionId": maintenance.narrative.transaction_id,
                    "undoJournalId": journal_id,
                }),
            );
        insert_idempotent_response(&tx, &idempotency_request, &payload.project_id, &response)?;
        tx.commit()?;
        Ok(response)
    })
}

/// Delete a project through a trusted domain writer so foreign-key cascades
/// may clean up protected Narrative tables without reopening generic renderer
/// SQL access. Durable AI audit rows intentionally have no project FK and are
/// therefore retained.
pub fn project_delete(db: &Database, payload: ProjectDeletePayload) -> anyhow::Result<()> {
    require_non_empty(&payload.project_id, "projectId")?;
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let immutable_applications: i64 = tx.query_row(
            "SELECT COUNT(*)
               FROM narrative_proposal_applications a
               INNER JOIN narrative_apply_commits c ON c.id = a.commit_id
              WHERE c.project_id = ?1",
            rusqlite::params![payload.project_id],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            immutable_applications == 0,
            "project '{}' has immutable Narrative applications; export or retain the project before deletion",
            payload.project_id
        );

        // Several provenance tables intentionally have no FK to domain rows:
        // immutable history must survive source deletion. A project delete is
        // therefore allowed only before any immutable Application exists, and
        // explicitly removes the remaining un-applied narrative graph so no
        // run/task/revision rows are orphaned behind the root project row.
        tx.execute(
            "DELETE FROM narrative_projection_freshness
              WHERE application_id IN (
                SELECT a.id
                  FROM narrative_proposal_applications a
                  INNER JOIN narrative_apply_commits c ON c.id = a.commit_id
                 WHERE c.project_id = ?1
              )",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_projection_dependencies
              WHERE application_id IN (
                SELECT a.id
                  FROM narrative_proposal_applications a
                  INNER JOIN narrative_apply_commits c ON c.id = a.commit_id
                 WHERE c.project_id = ?1
              )",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_apply_operations
              WHERE commit_id IN (
                SELECT id FROM narrative_apply_commits WHERE project_id = ?1
              )",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_proposal_decisions
              WHERE proposal_id IN (
                SELECT p.id
                  FROM narrative_proposals p
                  INNER JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                 WHERE s.project_id = ?1
              )",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_revision_source_basis
              WHERE revision_id IN (
                SELECT r.id
                  FROM narrative_proposal_revisions r
                  INNER JOIN narrative_proposals p ON p.id = r.proposal_id
                  INNER JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                 WHERE s.project_id = ?1
              )",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_proposal_revisions
              WHERE proposal_id IN (
                SELECT p.id
                  FROM narrative_proposals p
                  INNER JOIN narrative_proposal_sets s ON s.id = p.proposal_set_id
                 WHERE s.project_id = ?1
              )",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_proposals
              WHERE proposal_set_id IN (
                SELECT id FROM narrative_proposal_sets WHERE project_id = ?1
              )",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_extraction_artifacts
              WHERE run_id IN (
                SELECT id FROM narrative_extraction_runs WHERE project_id = ?1
              )",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_extraction_attempts
              WHERE task_id IN (
                SELECT t.id
                  FROM narrative_extraction_tasks t
                  INNER JOIN narrative_extraction_runs r ON r.id = t.run_id
                 WHERE r.project_id = ?1
              )",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_extraction_task_edges
              WHERE run_id IN (
                SELECT id FROM narrative_extraction_runs WHERE project_id = ?1
              )",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_extraction_tasks
              WHERE run_id IN (
                SELECT id FROM narrative_extraction_runs WHERE project_id = ?1
              )",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_field_authority WHERE project_id = ?1",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_commit_journals WHERE project_id = ?1",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_apply_commits WHERE project_id = ?1",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_proposal_sets WHERE project_id = ?1",
            rusqlite::params![payload.project_id],
        )?;
        tx.execute(
            "DELETE FROM narrative_extraction_runs WHERE project_id = ?1",
            rusqlite::params![payload.project_id],
        )?;
        // Upgraded workspaces may have received project_id through ALTER TABLE,
        // which cannot add the fresh-schema foreign key. Keep that legacy
        // cleanup inside the same trusted transaction as the root delete.
        tx.execute(
            "DELETE FROM lint_term_dictionary WHERE project_id = ?1",
            rusqlite::params![payload.project_id],
        )?;
        let deleted = tx.execute(
            "DELETE FROM projects WHERE id = ?1",
            rusqlite::params![payload.project_id],
        )?;
        anyhow::ensure!(deleted == 1, "project '{}' not found", payload.project_id);
        tx.commit()?;
        Ok(())
    })
}

pub fn create_scan_staging_project(
    db: &Database,
    payload: CreateScanStagingProjectPayload,
) -> anyhow::Result<()> {
    require_non_empty(&payload.id, "id")?;
    require_non_empty(&payload.title, "title")?;
    require_non_empty(&payload.created_at, "createdAt")?;
    if !matches!(payload.language.as_str(), "ja" | "en") {
        anyhow::bail!("scan staging language must be ja or en");
    }
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO projects
               (id, title, language, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![
                payload.id,
                payload.title,
                payload.language,
                payload.created_at
            ],
        )?;
        tx.execute(
            "INSERT INTO project_settings (project_id, key, value)
             VALUES (?1, 'scan.import.state', 'staging')
             ON CONFLICT(project_id, key)
             DO UPDATE SET value = 'staging'",
            params![payload.id],
        )?;
        tx.commit()?;
        Ok(())
    })
}

/// Publish a Scan staging Project through the one trusted import writer.
///
/// The staging marker is the visibility boundary: all audit, Narrative Change
/// Feed, C2-ZC birth Epoch, marker removal, and the retry receipt share one
/// immediate SQLite transaction. A failed marker/authority/feed check thus
/// cannot expose a partially published Project.
pub fn publish_scan_staging_project(
    db: &Database,
    payload: ScanStagingProjectPublishPayload,
) -> anyhow::Result<Value> {
    for (value, field) in [
        (&payload.project_id, "projectId"),
        (&payload.request_id, "requestId"),
        (&payload.session_id, "sessionId"),
        (&payload.event_uid, "eventUid"),
    ] {
        require_non_empty(value, field)?;
    }
    anyhow::ensure!(
        payload.origin == NarrativeChangeOrigin::Import
            && payload.original_transaction_id.is_none()
            && payload.undo_journal_id.is_none(),
        "Scan staging publish requires import origin without replay lineage"
    );
    let request_hash =
        canonical_write_payload_fingerprint("scan_staging_project_publish", &payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "scan_staging_project_publish",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "SCAN_STAGING_PROJECT_PUBLISH_REQUEST_CONFLICT",
    };

    db.with_conn(|conn| {
        with_immediate_transaction(conn, |tx| {
            if let Some(response) = load_idempotent_response(tx, &idempotency_request)? {
                return Ok(response);
            }

            let project_exists: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM projects WHERE id = ?1",
                    params![payload.project_id],
                    |row| row.get(0),
                )
                .optional()?;
            anyhow::ensure!(
                project_exists.is_some(),
                "scan staging project '{}' was not created",
                payload.project_id
            );

            let staging_marker: Option<String> = tx
                .query_row(
                    "SELECT value FROM project_settings
                  WHERE project_id = ?1 AND key = 'scan.import.state'",
                    params![payload.project_id],
                    |row| row.get(0),
                )
                .optional()?;
            match staging_marker.as_deref() {
                None => anyhow::bail!(
                "NEX_C2ZC_SCAN_PUBLISH_STAGING_MARKER_MISSING: project '{}' has no staging marker",
                payload.project_id
            ),
                Some("staging") => {}
                Some(value) => anyhow::bail!(
                "NEX_C2ZC_SCAN_PUBLISH_STAGING_MARKER_MISMATCH: project '{}' has marker '{value}'",
                payload.project_id
            ),
            }

            let timestamp = chrono::Utc::now().timestamp_millis();
            let canonical_payload = json!({
                "projectId": payload.project_id,
                "requestId": payload.request_id,
                "sessionId": payload.session_id,
            });
            let before = json!({
                "id": payload.project_id,
                "visibility": "hidden",
            });
            let after = json!({
                "id": payload.project_id,
                "visibility": "visible",
            });
            let append = append_canonical_and_narrative_change_in_tx(
                tx,
                &payload.project_id,
                &payload.session_id,
                &AppendChangeEvent {
                    event_uid: payload.event_uid.clone(),
                    scene_id: None,
                    domain: "scan".to_string(),
                    op_type: "scan.import.publish".to_string(),
                    entity_type: Some("project".to_string()),
                    entity_id: Some(payload.project_id.clone()),
                    payload: canonical_payload.to_string(),
                    timestamp,
                },
                &AppendNarrativeChangeTransactionInput {
                    project_id: payload.project_id.clone(),
                    request_id: payload.request_id.clone(),
                    source_domain: "scan.import.publish".to_string(),
                    source_change_event_uid: payload.event_uid.clone(),
                    cause_kind: NarrativeChangeCauseKind::Forward,
                    origin: payload.origin,
                    original_transaction_id: None,
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: None,
                    application_ids: Vec::new(),
                    occurred_at: chrono::Utc::now()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    events: vec![NarrativeChangeEventInput {
                        object_key: json!({
                            "kind": "project",
                            "projectId": payload.project_id,
                        }),
                        change_kind: "metadata".to_string(),
                        mutation_kind: "update".to_string(),
                        before_version: None,
                        before_digest: Some(narrative_snapshot_digest(&before)?),
                        after_version: None,
                        after_digest: Some(narrative_snapshot_digest(&after)?),
                        changed_paths: vec!["/visibility".to_string()],
                        text_impact: None,
                        structural_impact: Some(json!({
                            "changedPaths": ["/visibility"],
                        })),
                    }],
                },
            )?;
            let semantic_epoch_id = mint_c2zc_scan_publish_project_birth_epoch_in_tx(
                tx,
                &payload.project_id,
                &payload.request_id,
                &payload.session_id,
                &payload.event_uid,
            )?;
            let removed = tx.execute(
                "DELETE FROM project_settings
              WHERE project_id = ?1
                AND key = 'scan.import.state'
                AND value = 'staging'",
                params![payload.project_id],
            )?;
            anyhow::ensure!(
            removed == 1,
            "NEX_C2ZC_SCAN_PUBLISH_STAGING_MARKER_MISSING: project '{}' staging marker disappeared",
            payload.project_id
        );

            let response = json!({
                "projectId": payload.project_id,
                "semanticEpochId": semantic_epoch_id,
                "__writeReceipt": {
                    "changeEventUid": payload.event_uid,
                    "maintenanceTransactionId": append.narrative.transaction_id,
                    "undoJournalId": null,
                },
            });
            insert_idempotent_response(tx, &idempotency_request, &payload.project_id, &response)?;
            Ok(response)
        })
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNodeCreatePayload {
    pub id: String,
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    pub parent_id: Option<String>,
    pub node_type: String,
    pub title: String,
    pub sort_order: String,
    pub synopsis: Option<String>,
    pub status: Option<String>,
    pub source_uri: Option<String>,
    pub source_mtime: Option<String>,
    pub content: Option<String>,
    #[serde(default)]
    pub canonical_payload: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNodeDeletePayload {
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    pub node_id: String,
    #[serde(default)]
    pub canonical_payload: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNodePatchChangeEvent {
    pub event_uid: String,
    pub session_id: String,
    pub timestamp: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNodePatchPayload {
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub node_id: String,
    pub patch: serde_json::Map<String, Value>,
    pub base_version: Option<i64>,
    pub bump_version: bool,
    pub updated_at: String,
    pub change_event: Option<TreeNodePatchChangeEvent>,
    #[serde(default)]
    pub timelapse_doc_step_coverage: Option<crate::timelapse::TimelapseDocStepCoverageProof>,
    pub origin: NarrativeChangeOrigin,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    #[serde(default)]
    pub source_domain: Option<String>,
    #[serde(default)]
    pub op_type: Option<String>,
    #[serde(default)]
    pub canonical_payload: Option<Value>,
}

fn validate_tree_write_identity(
    request_id: &str,
    session_id: &str,
    event_uid: &str,
    origin: NarrativeChangeOrigin,
    original_transaction_id: Option<&str>,
    undo_journal_id: Option<&str>,
) -> anyhow::Result<()> {
    require_non_empty(request_id, "requestId")?;
    require_non_empty(session_id, "sessionId")?;
    require_non_empty(event_uid, "eventUid")?;
    let replay = matches!(
        origin,
        NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
    );
    let complete_lineage = original_transaction_id.is_some_and(|value| !value.trim().is_empty())
        && undo_journal_id.is_some_and(|value| !value.trim().is_empty());
    anyhow::ensure!(
        replay == complete_lineage
            && (replay || (original_transaction_id.is_none() && undo_journal_id.is_none())),
        "undo/redo origin requires originalTransactionId and undoJournalId"
    );
    Ok(())
}

fn tree_cause_kind(origin: NarrativeChangeOrigin) -> NarrativeChangeCauseKind {
    match origin {
        NarrativeChangeOrigin::Undo => NarrativeChangeCauseKind::Undo,
        NarrativeChangeOrigin::Redo => NarrativeChangeCauseKind::Redo,
        _ => NarrativeChangeCauseKind::Forward,
    }
}

fn validate_tree_replay_lineage_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    origin: NarrativeChangeOrigin,
    original_transaction_id: Option<&str>,
    undo_journal_id: Option<&str>,
) -> anyhow::Result<()> {
    if matches!(
        origin,
        NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
    ) {
        require_replay_lineage_in_project(
            conn,
            project_id,
            original_transaction_id
                .ok_or_else(|| anyhow::anyhow!("originalTransactionId is required"))?,
            undo_journal_id.ok_or_else(|| anyhow::anyhow!("undoJournalId is required"))?,
        )?;
    }
    Ok(())
}

fn validate_tree_replay_target_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    origin: NarrativeChangeOrigin,
    undo_journal_id: Option<&str>,
    node_id: &str,
    operation: &str,
) -> anyhow::Result<()> {
    let Some(undo_journal_id) = undo_journal_id else {
        return Ok(());
    };
    let expected_op_kind = match (operation, origin) {
        ("create", NarrativeChangeOrigin::Undo) => "delete",
        ("create", NarrativeChangeOrigin::Redo) => "create",
        ("delete", NarrativeChangeOrigin::Undo) => "create",
        ("delete", NarrativeChangeOrigin::Redo) => "delete",
        ("patch", NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo) => "update",
        _ => return Ok(()),
    };
    let journal_target = conn
        .query_row(
            "SELECT entity_kind, entity_id, op_kind
               FROM undo_journal
              WHERE id = ?1 AND project_id = ?2",
            params![undo_journal_id, project_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((entity_kind, entity_id, op_kind)) = journal_target else {
        anyhow::bail!(
            "tree replay Undo Journal '{}' is not in the active project",
            undo_journal_id
        );
    };
    anyhow::ensure!(
        entity_kind == "tree_node" && entity_id == node_id && op_kind == expected_op_kind,
        "tree replay target does not match the named Undo Journal"
    );
    Ok(())
}

fn tree_write_response(
    mut row: Value,
    change_event_uid: &str,
    maintenance_transaction_id: &str,
    undo_journal_id: &str,
) -> Value {
    if let Value::Object(object) = &mut row {
        object.insert(
            "__writeReceipt".to_string(),
            json!({
                "changeEventUid": change_event_uid,
                "maintenanceTransactionId": maintenance_transaction_id,
                "undoJournalId": undo_journal_id,
            }),
        );
    }
    row
}

const TREE_NODE_ROW_SELECT: &str = "
    SELECT
      id,
      project_id AS projectId,
      parent_id AS parentId,
      node_type AS nodeType,
      title,
      synopsis,
      intent,
      sort_order AS sortOrder,
      story_time_order AS storyTimeOrder,
      story_time_label AS storyTimeLabel,
      pov_character_id AS povCharacterId,
      location_id AS locationId,
      chronicle_start_time AS chronicleStartTime,
      chronicle_start_minute AS chronicleStartMinute,
      chronicle_start_granularity AS chronicleStartGranularity,
      chronicle_end_time AS chronicleEndTime,
      chronicle_end_minute AS chronicleEndMinute,
      chronicle_end_granularity AS chronicleEndGranularity,
      chronicle_precision AS chroniclePrecision,
      status,
      content,
      unplaced_beats_doc AS unplacedBeatsDoc,
      char_count AS charCount,
      unplaced_beat_preview AS unplacedBeatPreview,
      placed_beat_preview AS placedBeatPreview,
      source_uri AS sourceUri,
      source_mtime AS sourceMtime,
      archived_at AS archivedAt,
      context_mode AS contextMode,
      aliases,
      excluded_aliases AS excludedAliases,
      created_at AS createdAt,
      updated_at AS updatedAt,
      version
    FROM tree_nodes
";

fn select_tree_node(
    conn: &rusqlite::Connection,
    project_id: &str,
    node_id: &str,
) -> anyhow::Result<Value> {
    let rows = Database::execute_with_conn(
        conn,
        &format!("{TREE_NODE_ROW_SELECT} WHERE id = ?1 AND project_id = ?2"),
        &[
            Value::String(node_id.to_string()),
            Value::String(project_id.to_string()),
        ],
        "get",
    )?;
    rows.into_iter()
        .next()
        .map(Value::Object)
        .ok_or_else(|| anyhow::anyhow!("tree node '{node_id}' not found in project '{project_id}'"))
}

fn select_tree_subtree(
    conn: &rusqlite::Connection,
    project_id: &str,
    root_id: &str,
) -> anyhow::Result<Vec<Value>> {
    let mut statement = conn.prepare(
        "WITH RECURSIVE subtree(id, project_id, depth, path) AS (
           SELECT id, project_id, 0, char(31) || id || char(31)
             FROM tree_nodes
            WHERE id = ?1 AND project_id = ?2
           UNION ALL
           SELECT child.id,
                  child.project_id,
                  parent.depth + 1,
                  parent.path || child.id || char(31)
             FROM tree_nodes child
             JOIN subtree parent ON child.parent_id = parent.id
            WHERE instr(parent.path, char(31) || child.id || char(31)) = 0
         )
         SELECT id, project_id
           FROM subtree
          ORDER BY depth, id",
    )?;
    let members = statement
        .query_map(params![root_id, project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    anyhow::ensure!(
        !members.is_empty(),
        "tree node '{root_id}' not found in project '{project_id}'"
    );
    for (node_id, member_project_id) in &members {
        anyhow::ensure!(
            member_project_id == project_id,
            "TREE_SUBTREE_CROSS_PROJECT: node '{node_id}' belongs to project '{member_project_id}'"
        );
    }
    members
        .into_iter()
        .map(|(node_id, _)| select_tree_node(conn, project_id, &node_id))
        .collect()
}

fn live_scene_subtree_count(
    conn: &rusqlite::Connection,
    project_id: &str,
    root_id: &str,
) -> anyhow::Result<i64> {
    let count = conn.query_row(
        "WITH RECURSIVE subtree(id, node_type, ancestor_live, path) AS (
           SELECT id,
                  node_type,
                  (archived_at IS NULL),
                  char(31) || id || char(31)
             FROM tree_nodes
            WHERE id = ?1 AND project_id = ?2
           UNION ALL
           SELECT child.id,
                  child.node_type,
                  (subtree.ancestor_live AND child.archived_at IS NULL),
                  subtree.path || child.id || char(31)
             FROM tree_nodes child
             JOIN subtree ON child.parent_id = subtree.id
            WHERE child.project_id = ?2
              AND instr(subtree.path, char(31) || child.id || char(31)) = 0
         )
         SELECT COUNT(*)
           FROM subtree
          WHERE node_type = 'scene' AND ancestor_live",
        params![root_id, project_id],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(count)
}

fn live_scene_subtree_count_from_snapshots(root_id: &str, snapshots: &[Value]) -> i64 {
    fn visit(
        node_id: &str,
        nodes: &HashMap<String, Value>,
        children: &HashMap<String, Vec<String>>,
        parent_live: bool,
        visiting: &mut HashSet<String>,
    ) -> i64 {
        let Some(node) = nodes.get(node_id) else {
            return 0;
        };
        if !visiting.insert(node_id.to_owned()) {
            return 0;
        }
        let live = parent_live
            && node
                .get("archivedAt")
                .is_none_or(|archived_at| archived_at.is_null());
        let mut count = if live && node.get("nodeType").and_then(Value::as_str) == Some("scene") {
            1
        } else {
            0
        };
        if let Some(child_ids) = children.get(node_id) {
            for child_id in child_ids {
                count += visit(child_id, nodes, children, live, visiting);
            }
        }
        visiting.remove(node_id);
        count
    }

    let nodes = snapshots
        .iter()
        .filter_map(|snapshot| {
            snapshot
                .get("id")
                .and_then(Value::as_str)
                .map(|id| (id.to_owned(), snapshot.clone()))
        })
        .collect::<HashMap<_, _>>();
    let mut children = HashMap::<String, Vec<String>>::new();
    for snapshot in snapshots {
        let Some(node_id) = snapshot.get("id").and_then(Value::as_str) else {
            continue;
        };
        let Some(parent_id) = snapshot.get("parentId").and_then(Value::as_str) else {
            continue;
        };
        children
            .entry(parent_id.to_owned())
            .or_default()
            .push(node_id.to_owned());
    }
    visit(root_id, &nodes, &children, true, &mut HashSet::new())
}

fn tree_object_key(snapshot: &Value, node_id: &str) -> Value {
    if snapshot.get("nodeType").and_then(Value::as_str) == Some("scene") {
        json!({ "kind": "scene", "sceneId": node_id })
    } else {
        json!({
            "kind": "component",
            "componentId": format!("tree-node:{node_id}"),
        })
    }
}

fn tree_version(snapshot: Option<&Value>) -> Option<i64> {
    snapshot
        .and_then(|value| value.get("version"))
        .and_then(Value::as_i64)
}

fn tree_feed_event(
    node_id: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    change_kind: &str,
    mutation_kind: &str,
    changed_paths: Vec<String>,
    live_scene_subtree_impact: Option<(i64, i64)>,
) -> anyhow::Result<NarrativeChangeEventInput> {
    let key_source = after.or(before).ok_or_else(|| {
        anyhow::anyhow!("tree feed event '{node_id}' has neither before nor after state")
    })?;
    let node_type = key_source
        .get("nodeType")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("tree feed event '{node_id}' has no nodeType"))?;
    let mut structural_impact = json!({
        "changedPaths": changed_paths,
        "nodeType": node_type,
    });
    if let Some((before_count, after_count)) = live_scene_subtree_impact {
        structural_impact["liveSceneSubtreeImpact"] = json!({
            "beforeCount": before_count,
            "afterCount": after_count,
        });
    }
    Ok(NarrativeChangeEventInput {
        object_key: tree_object_key(key_source, node_id),
        change_kind: change_kind.to_string(),
        mutation_kind: mutation_kind.to_string(),
        before_version: tree_version(before),
        before_digest: before.map(narrative_snapshot_digest).transpose()?,
        after_version: tree_version(after),
        after_digest: after.map(narrative_snapshot_digest).transpose()?,
        changed_paths: changed_paths.clone(),
        text_impact: scene_text_impact(before, after)?,
        structural_impact: Some(structural_impact),
    })
}

struct TreeFeedAppend<'a> {
    project_id: &'a str,
    request_id: &'a str,
    session_id: &'a str,
    event_uid: &'a str,
    source_domain: &'a str,
    canonical_domain: &'a str,
    canonical_entity_type: &'a str,
    entity_id: &'a str,
    canonical_payload: String,
    scene_id: Option<String>,
    occurred_at: &'a str,
    timestamp: i64,
    cause_kind: NarrativeChangeCauseKind,
    origin: NarrativeChangeOrigin,
    original_transaction_id: Option<&'a str>,
    undo_journal_id: Option<&'a str>,
    events: Vec<NarrativeChangeEventInput>,
}

fn append_tree_feed_result(
    conn: &rusqlite::Connection,
    input: TreeFeedAppend<'_>,
) -> anyhow::Result<crate::narrative_extraction::change_feed::AppendCanonicalNarrativeChangeResult>
{
    append_canonical_and_narrative_change_in_tx(
        conn,
        input.project_id,
        input.session_id,
        &AppendChangeEvent {
            event_uid: input.event_uid.to_string(),
            scene_id: input.scene_id,
            domain: input.canonical_domain.to_string(),
            op_type: input.source_domain.to_string(),
            entity_type: Some(input.canonical_entity_type.to_string()),
            entity_id: Some(input.entity_id.to_string()),
            payload: input.canonical_payload,
            timestamp: input.timestamp,
        },
        &AppendNarrativeChangeTransactionInput {
            project_id: input.project_id.to_string(),
            request_id: input.request_id.to_string(),
            source_domain: input.source_domain.to_string(),
            source_change_event_uid: input.event_uid.to_string(),
            cause_kind: input.cause_kind,
            origin: input.origin,
            original_transaction_id: input.original_transaction_id.map(str::to_string),
            commit_id: None,
            journal_id: None,
            undo_journal_id: input.undo_journal_id.map(str::to_string),
            application_ids: Vec::new(),
            occurred_at: input.occurred_at.to_string(),
            events: input.events,
        },
    )
}

fn append_tree_feed(
    conn: &rusqlite::Connection,
    input: TreeFeedAppend<'_>,
) -> anyhow::Result<String> {
    Ok(append_tree_feed_result(conn, input)?
        .narrative
        .transaction_id)
}

fn tree_patch_path(key: &str) -> Option<&'static str> {
    match key {
        "parentId" => Some("/parentId"),
        "title" => Some("/title"),
        "synopsis" => Some("/synopsis"),
        "intent" => Some("/intent"),
        "sortOrder" => Some("/sortOrder"),
        "storyTimeOrder" => Some("/storyTimeOrder"),
        "storyTimeLabel" => Some("/storyTimeLabel"),
        "povCharacterId" => Some("/povCharacterId"),
        "locationId" => Some("/locationId"),
        "chronicleStartTime" => Some("/startTime"),
        "chronicleStartMinute" => Some("/startMinute"),
        "chronicleStartGranularity" => Some("/startGranularity"),
        "chronicleEndTime" => Some("/endTime"),
        "chronicleEndMinute" => Some("/endMinute"),
        "chronicleEndGranularity" => Some("/endGranularity"),
        "chroniclePrecision" => Some("/precision"),
        "status" => Some("/status"),
        "content" => Some("/content"),
        "unplacedBeatsDoc" => Some("/unplacedBeatsDoc"),
        "charCount" => Some("/charCount"),
        "unplacedBeatPreview" => Some("/unplacedBeatPreview"),
        "placedBeatPreview" => Some("/placedBeatPreview"),
        "sourceUri" => Some("/sourceUri"),
        "sourceMtime" => Some("/sourceMtime"),
        "archivedAt" => Some("/archivedAt"),
        "contextMode" => Some("/contextMode"),
        "aliases" => Some("/aliases"),
        "excludedAliases" => Some("/excludedAliases"),
        _ => None,
    }
}

fn tree_patch_change_kind(paths: &[String]) -> &'static str {
    if paths.iter().any(|path| path == "/content") {
        "content"
    } else if paths.iter().any(|path| {
        matches!(
            path.as_str(),
            "/startTime"
                | "/startMinute"
                | "/startGranularity"
                | "/endTime"
                | "/endMinute"
                | "/endGranularity"
                | "/precision"
        )
    }) {
        "calendar"
    } else if paths.iter().any(|path| {
        matches!(
            path.as_str(),
            "/parentId" | "/sortOrder" | "/storyTimeOrder"
        )
    }) {
        "order"
    } else {
        "metadata"
    }
}

fn ensure_tree_parent_in_project(
    conn: &rusqlite::Connection,
    project_id: &str,
    parent_id: &str,
) -> anyhow::Result<()> {
    require_non_empty(parent_id, "parentId")?;
    let node_type = conn
        .query_row(
            "SELECT node_type FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
            params![parent_id, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    anyhow::ensure!(
        node_type.is_some(),
        "tree node parent '{parent_id}' is not in project '{project_id}'"
    );
    anyhow::ensure!(
        node_type.as_deref() == Some("folder"),
        "tree node parent '{parent_id}' must be a folder"
    );
    Ok(())
}

fn ensure_tree_parent_does_not_cycle(
    conn: &rusqlite::Connection,
    project_id: &str,
    node_id: &str,
    parent_id: &str,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        node_id != parent_id,
        "tree node '{node_id}' cannot be its own parent"
    );
    let would_cycle: i64 = conn.query_row(
        "WITH RECURSIVE ancestors(id) AS (
             SELECT ?1
             UNION
             SELECT node.parent_id
               FROM tree_nodes node
               JOIN ancestors current ON current.id = node.id
              WHERE node.project_id = ?2 AND node.parent_id IS NOT NULL
         )
         SELECT EXISTS(SELECT 1 FROM ancestors WHERE id = ?3)",
        params![parent_id, project_id, node_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        would_cycle == 0,
        "tree node parent '{parent_id}' would create a cycle for '{node_id}'"
    );
    Ok(())
}

fn ensure_tree_codex_reference_in_project(
    conn: &rusqlite::Connection,
    project_id: &str,
    field: &str,
    entry_id: &str,
) -> anyhow::Result<()> {
    require_non_empty(entry_id, field)?;
    let owned = conn
        .query_row(
            "SELECT 1 FROM codex_entries WHERE id = ?1 AND project_id = ?2",
            params![entry_id, project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(
        owned,
        "tree node {field} '{entry_id}' is not in project '{project_id}'"
    );
    Ok(())
}

pub fn tree_node_create(db: &Database, payload: TreeNodeCreatePayload) -> anyhow::Result<Value> {
    tree_node_create_with_authority(db, payload, None)
}

pub fn tree_node_create_with_authority(
    db: &Database,
    payload: TreeNodeCreatePayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    for (value, field) in [
        (&payload.id, "id"),
        (&payload.project_id, "projectId"),
        (&payload.node_type, "nodeType"),
        (&payload.title, "title"),
        (&payload.sort_order, "sortOrder"),
    ] {
        require_non_empty(value, field)?;
    }
    anyhow::ensure!(
        matches!(payload.node_type.as_str(), "folder" | "scene" | "note"),
        "tree node nodeType must be folder, scene, or note"
    );
    validate_tree_write_identity(
        &payload.request_id,
        &payload.session_id,
        &payload.event_uid,
        payload.origin,
        payload.original_transaction_id.as_deref(),
        payload.undo_journal_id.as_deref(),
    )?;
    if let Some(context) = renderer_context.as_ref() {
        validate_renderer_authority_context_for_routes(
            context,
            &[
                "human-direct",
                "import-apply",
                "history-replay",
                "restore-or-migration",
            ],
        )?;
        anyhow::ensure!(
            context.request_id == payload.request_id,
            "tree node create requestId does not match canonical authority context"
        );
        anyhow::ensure!(
            context.event_uid == payload.event_uid,
            "tree node create eventUid does not match canonical authority context"
        );
        anyhow::ensure!(
            context.origin == payload.origin,
            "tree node create origin does not match canonical authority context"
        );
        anyhow::ensure!(
            context.original_transaction_id == payload.original_transaction_id,
            "tree node create originalTransactionId does not match canonical authority context"
        );
        anyhow::ensure!(
            context.undo_journal_id == payload.undo_journal_id,
            "tree node create undoJournalId does not match canonical authority context"
        );
    }
    let request_hash = canonical_write_payload_fingerprint("tree_node_create", &payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "tree_node_create",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "TREE_NODE_CREATE_REQUEST_CONFLICT",
    };

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(response) = load_idempotent_response(&tx, &idempotency_request)? {
            tx.commit()?;
            return Ok(response);
        }
        validate_tree_replay_lineage_in_tx(
            &tx,
            &payload.project_id,
            payload.origin,
            payload.original_transaction_id.as_deref(),
            payload.undo_journal_id.as_deref(),
        )?;
        validate_tree_replay_target_in_tx(
            &tx,
            &payload.project_id,
            payload.origin,
            payload.undo_journal_id.as_deref(),
            &payload.id,
            "create",
        )?;
        if let Some(parent_id) = payload.parent_id.as_deref() {
            anyhow::ensure!(
                parent_id != payload.id,
                "tree node '{}' cannot be its own parent",
                payload.id
            );
            ensure_tree_parent_in_project(&tx, &payload.project_id, parent_id)?;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let content = payload.content.clone().unwrap_or_else(|| "{}".to_string());
        let char_count = grimodex_core::pm_text::pm_doc_text_len(&content);
        Database::execute_with_conn(
            &tx,
            "INSERT INTO tree_nodes
              (id, project_id, parent_id, node_type, title, sort_order, synopsis, status,
               source_uri, source_mtime, content, char_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
            &[
                Value::String(payload.id.clone()),
                Value::String(payload.project_id.clone()),
                payload.parent_id.clone().map_or(Value::Null, Value::String),
                Value::String(payload.node_type.clone()),
                Value::String(payload.title.clone()),
                Value::String(payload.sort_order.clone()),
                payload.synopsis.clone().map_or(Value::Null, Value::String),
                payload.status.clone().map_or(Value::Null, Value::String),
                payload
                    .source_uri
                    .clone()
                    .map_or(Value::Null, Value::String),
                payload
                    .source_mtime
                    .clone()
                    .map_or(Value::Null, Value::String),
                Value::String(content),
                Value::from(char_count),
                Value::String(now.clone()),
            ],
            "run",
        )?;
        let row = select_tree_node(&tx, &payload.project_id, &payload.id)?;
        let journal_id = payload
            .undo_journal_id
            .clone()
            .unwrap_or_else(|| payload.request_id.clone());
        let after_json = serde_json::to_string(&row)?;
        if !matches!(
            payload.origin,
            NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
        ) {
            crate::undo_journal::insert_undo_journal_in_tx(
                &tx,
                crate::undo_journal::UndoJournalInsert {
                    id: &journal_id,
                    project_id: &payload.project_id,
                    surface: "tree",
                    entity_kind: "tree_node",
                    entity_id: &payload.id,
                    op_kind: "create",
                    before_json: None,
                    after_json: Some(&after_json),
                    base_version: 0,
                    result_version: tree_version(Some(&row)).unwrap_or(0),
                    change_event_uid: Some(&payload.event_uid),
                },
            )?;
        }
        let change_kind = if payload.node_type == "scene" {
            "content"
        } else {
            "metadata"
        };
        let live_scene_subtree_impact =
            if row.get("nodeType").and_then(Value::as_str) == Some("folder") {
                Some((
                    0,
                    live_scene_subtree_count(&tx, &payload.project_id, &payload.id)?,
                ))
            } else {
                None
            };
        let canonical_payload = payload
            .canonical_payload
            .clone()
            .unwrap_or_else(|| {
                json!({
                    "parentId": payload.parent_id,
                    "sortOrder": payload.sort_order,
                    "title": payload.title,
                })
            })
            .to_string();
        let canonical_payload = if let Some(context) = renderer_context.as_ref() {
            canonical_payload_with_authority_context(&canonical_payload, context)
        } else {
            canonical_payload
        };
        let maintenance_transaction_id = append_tree_feed(
            &tx,
            TreeFeedAppend {
                project_id: &payload.project_id,
                request_id: &payload.request_id,
                session_id: &payload.session_id,
                event_uid: &payload.event_uid,
                source_domain: "tree.node.create",
                canonical_domain: "tree",
                canonical_entity_type: "tree_node",
                entity_id: &payload.id,
                canonical_payload,
                scene_id: (payload.node_type == "scene").then(|| payload.id.clone()),
                occurred_at: &now,
                timestamp: event_timestamp(&now),
                cause_kind: tree_cause_kind(payload.origin),
                origin: payload.origin,
                original_transaction_id: payload.original_transaction_id.as_deref(),
                undo_journal_id: Some(&journal_id),
                events: vec![tree_feed_event(
                    &payload.id,
                    None,
                    Some(&row),
                    change_kind,
                    "create",
                    vec!["/".to_string()],
                    live_scene_subtree_impact,
                )?],
            },
        )?;
        let response = tree_write_response(
            row,
            &payload.event_uid,
            &maintenance_transaction_id,
            &journal_id,
        );
        insert_idempotent_response(&tx, &idempotency_request, &payload.project_id, &response)?;
        tx.commit()?;
        Ok(response)
    })
}

pub fn tree_node_delete(db: &Database, payload: TreeNodeDeletePayload) -> anyhow::Result<Value> {
    tree_node_delete_with_authority(db, payload, None)
}

pub fn tree_node_delete_with_authority(
    db: &Database,
    payload: TreeNodeDeletePayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.node_id, "nodeId")?;
    validate_tree_write_identity(
        &payload.request_id,
        &payload.session_id,
        &payload.event_uid,
        payload.origin,
        payload.original_transaction_id.as_deref(),
        payload.undo_journal_id.as_deref(),
    )?;
    if let Some(context) = renderer_context.as_ref() {
        validate_renderer_authority_context_for_routes(
            context,
            &["human-direct", "history-replay", "restore-or-migration"],
        )?;
        anyhow::ensure!(
            context.request_id == payload.request_id,
            "tree node delete requestId does not match canonical authority context"
        );
        anyhow::ensure!(
            context.event_uid == payload.event_uid,
            "tree node delete eventUid does not match canonical authority context"
        );
        anyhow::ensure!(
            context.origin == payload.origin,
            "tree node delete origin does not match canonical authority context"
        );
        anyhow::ensure!(
            context.original_transaction_id == payload.original_transaction_id,
            "tree node delete originalTransactionId does not match canonical authority context"
        );
        anyhow::ensure!(
            context.undo_journal_id == payload.undo_journal_id,
            "tree node delete undoJournalId does not match canonical authority context"
        );
    }
    let request_hash = canonical_write_payload_fingerprint("tree_node_delete", &payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "tree_node_delete",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "TREE_NODE_DELETE_REQUEST_CONFLICT",
    };
    let occurred_at = chrono::Utc::now().to_rfc3339();
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(response) = load_idempotent_response(&tx, &idempotency_request)? {
            tx.commit()?;
            return Ok(response);
        }
        validate_tree_replay_lineage_in_tx(
            &tx,
            &payload.project_id,
            payload.origin,
            payload.original_transaction_id.as_deref(),
            payload.undo_journal_id.as_deref(),
        )?;
        validate_tree_replay_target_in_tx(
            &tx,
            &payload.project_id,
            payload.origin,
            payload.undo_journal_id.as_deref(),
            &payload.node_id,
            "delete",
        )?;
        let before_nodes = select_tree_subtree(&tx, &payload.project_id, &payload.node_id)?;
        let before = before_nodes
            .first()
            .ok_or_else(|| anyhow::anyhow!("tree subtree snapshot is empty"))?;
        let is_scene = before.get("nodeType").and_then(Value::as_str) == Some("scene");
        let deleted_ids = before_nodes
            .iter()
            .filter_map(|node| node.get("id").and_then(Value::as_str).map(str::to_string))
            .collect::<Vec<_>>();
        anyhow::ensure!(
            deleted_ids.len() == before_nodes.len(),
            "tree subtree snapshot contains a node without an id"
        );
        for node in &before_nodes {
            if node.get("nodeType").and_then(Value::as_str) == Some("scene") {
                let node_id = node
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("tree scene snapshot has no id"))?;
                crate::narrative_extraction::propagate_source_change_freshness_in_tx(
                    &tx,
                    &payload.project_id,
                    "scene-body",
                    &format!("project:scene:{node_id}"),
                    None,
                    &occurred_at,
                    "tree-node-writer",
                )?;
            }
        }
        let deleted = tx.execute(
            "DELETE FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
            params![payload.node_id, payload.project_id],
        )?;
        anyhow::ensure!(deleted == 1, "tree node '{}' not found", payload.node_id);
        let journal_id = payload
            .undo_journal_id
            .clone()
            .unwrap_or_else(|| payload.request_id.clone());
        let before_json = serde_json::to_string(&json!({
            "rootId": payload.node_id,
            "nodes": before_nodes,
        }))?;
        if !matches!(
            payload.origin,
            NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
        ) {
            crate::undo_journal::insert_undo_journal_in_tx(
                &tx,
                crate::undo_journal::UndoJournalInsert {
                    id: &journal_id,
                    project_id: &payload.project_id,
                    surface: "tree",
                    entity_kind: "tree_node",
                    entity_id: &payload.node_id,
                    op_kind: "delete",
                    before_json: Some(&before_json),
                    after_json: None,
                    base_version: tree_version(Some(before)).unwrap_or(0),
                    result_version: 0,
                    change_event_uid: Some(&payload.event_uid),
                },
            )?;
        }
        let canonical_payload = payload
            .canonical_payload
            .clone()
            .unwrap_or_else(|| {
                json!({
                    "id": payload.node_id,
                    "deletedIds": deleted_ids,
                })
            })
            .to_string();
        let canonical_payload = if let Some(context) = renderer_context.as_ref() {
            canonical_payload_with_authority_context(&canonical_payload, context)
        } else {
            canonical_payload
        };
        let maintenance_transaction_id = append_tree_feed(
            &tx,
            TreeFeedAppend {
                project_id: &payload.project_id,
                request_id: &payload.request_id,
                session_id: &payload.session_id,
                event_uid: &payload.event_uid,
                source_domain: "tree.node.delete",
                canonical_domain: "tree",
                canonical_entity_type: "tree_node",
                entity_id: &payload.node_id,
                canonical_payload,
                scene_id: is_scene.then(|| payload.node_id.clone()),
                occurred_at: &occurred_at,
                timestamp: event_timestamp(&occurred_at),
                cause_kind: tree_cause_kind(payload.origin),
                origin: payload.origin,
                original_transaction_id: payload.original_transaction_id.as_deref(),
                undo_journal_id: Some(&journal_id),
                events: before_nodes
                    .iter()
                    .map(|node| {
                        let node_id = node
                            .get("id")
                            .and_then(Value::as_str)
                            .ok_or_else(|| anyhow::anyhow!("tree subtree snapshot has no id"))?;
                        tree_feed_event(
                            node_id,
                            Some(node),
                            None,
                            if node.get("nodeType").and_then(Value::as_str) == Some("scene") {
                                "content"
                            } else {
                                "metadata"
                            },
                            "delete",
                            vec!["/".to_string()],
                            (node.get("nodeType").and_then(Value::as_str) == Some("folder")).then(
                                || {
                                    (
                                        live_scene_subtree_count_from_snapshots(
                                            node_id,
                                            &before_nodes,
                                        ),
                                        0,
                                    )
                                },
                            ),
                        )
                    })
                    .collect::<anyhow::Result<Vec<_>>>()?,
            },
        )?;
        let response = json!({
            "entityId": payload.node_id,
            "changeEventUid": payload.event_uid,
            "maintenanceTransactionId": maintenance_transaction_id,
            "undoJournalId": journal_id,
            "deletedIds": deleted_ids,
        });
        insert_idempotent_response(&tx, &idempotency_request, &payload.project_id, &response)?;
        tx.commit()?;
        Ok(response)
    })
}

pub fn tree_node_patch(db: &Database, payload: TreeNodePatchPayload) -> anyhow::Result<Value> {
    tree_node_patch_with_authority(db, payload, None)
}

pub fn tree_node_patch_with_authority(
    db: &Database,
    payload: TreeNodePatchPayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.node_id, "nodeId")?;
    require_non_empty(&payload.updated_at, "updatedAt")?;
    validate_tree_write_identity(
        &payload.request_id,
        &payload.session_id,
        &payload.event_uid,
        payload.origin,
        payload.original_transaction_id.as_deref(),
        payload.undo_journal_id.as_deref(),
    )?;
    if let Some(context) = renderer_context.as_ref() {
        validate_renderer_authority_context_for_routes(
            context,
            &[
                "human-direct",
                "import-apply",
                "history-replay",
                "restore-or-migration",
            ],
        )?;
        anyhow::ensure!(
            context.request_id == payload.request_id,
            "tree node patch requestId does not match canonical authority context"
        );
        anyhow::ensure!(
            context.event_uid == payload.event_uid,
            "tree node patch eventUid does not match canonical authority context"
        );
        anyhow::ensure!(
            context.origin == payload.origin,
            "tree node patch origin does not match canonical authority context"
        );
        anyhow::ensure!(
            context.original_transaction_id == payload.original_transaction_id,
            "tree node patch originalTransactionId does not match canonical authority context"
        );
        anyhow::ensure!(
            context.undo_journal_id == payload.undo_journal_id,
            "tree node patch undoJournalId does not match canonical authority context"
        );
    }
    let columns = [
        ("parentId", "parent_id"),
        ("title", "title"),
        ("synopsis", "synopsis"),
        ("intent", "intent"),
        ("sortOrder", "sort_order"),
        ("storyTimeOrder", "story_time_order"),
        ("storyTimeLabel", "story_time_label"),
        ("povCharacterId", "pov_character_id"),
        ("locationId", "location_id"),
        ("chronicleStartTime", "chronicle_start_time"),
        ("chronicleStartMinute", "chronicle_start_minute"),
        ("chronicleStartGranularity", "chronicle_start_granularity"),
        ("chronicleEndTime", "chronicle_end_time"),
        ("chronicleEndMinute", "chronicle_end_minute"),
        ("chronicleEndGranularity", "chronicle_end_granularity"),
        ("chroniclePrecision", "chronicle_precision"),
        ("status", "status"),
        ("content", "content"),
        ("unplacedBeatsDoc", "unplaced_beats_doc"),
        ("charCount", "char_count"),
        ("unplacedBeatPreview", "unplaced_beat_preview"),
        ("placedBeatPreview", "placed_beat_preview"),
        ("sourceUri", "source_uri"),
        ("sourceMtime", "source_mtime"),
        ("archivedAt", "archived_at"),
        ("contextMode", "context_mode"),
        ("aliases", "aliases"),
        ("excludedAliases", "excluded_aliases"),
    ];
    let mut assignments = Vec::new();
    let mut params = Vec::new();
    for (wire_name, sql_name) in columns {
        if let Some(value) = payload.patch.get(wire_name) {
            assignments.push(format!("{sql_name} = ?{}", params.len() + 1));
            params.push(value.clone());
        }
    }
    anyhow::ensure!(
        payload
            .patch
            .keys()
            .all(|key| columns.iter().any(|(wire, _)| wire == key)),
        "tree node patch contains an unsupported field"
    );
    if let Some(event) = payload.change_event.as_ref() {
        require_non_empty(&event.event_uid, "changeEvent.eventUid")?;
        require_non_empty(&event.session_id, "changeEvent.sessionId")?;
        anyhow::ensure!(
            event.timestamp >= 0,
            "tree node changeEvent timestamp must be non-negative"
        );
        anyhow::ensure!(
            payload.base_version.is_some() && payload.bump_version,
            "tree node content event requires versioned OCC"
        );
        anyhow::ensure!(
            payload.patch.contains_key("content")
                && payload
                    .patch
                    .keys()
                    .all(|key| matches!(key.as_str(), "content" | "charCount")),
            "tree node content event requires a content-only patch"
        );
    }
    let is_restore = payload.origin == NarrativeChangeOrigin::Restore;
    if payload.source_domain.is_some() || payload.op_type.is_some() {
        anyhow::ensure!(
            is_restore
                && payload.source_domain.as_deref() == Some("revision")
                && payload.op_type.as_deref() == Some("content.restore"),
            "tree node tracked override must be revision content.restore with restore origin"
        );
        anyhow::ensure!(
            payload.change_event.is_some()
                && payload.base_version.is_some()
                && payload.bump_version
                && payload.patch.contains_key("content")
                && payload
                    .patch
                    .keys()
                    .all(|key| matches!(key.as_str(), "content" | "charCount")),
            "revision content restore requires a versioned content-only change event"
        );
    }
    assignments.push(format!("updated_at = ?{}", params.len() + 1));
    params.push(Value::String(payload.updated_at.clone()));
    if payload.bump_version {
        assignments.push("version = version + 1".to_string());
    }
    let id_param = params.len() + 1;
    params.push(Value::String(payload.node_id.clone()));
    let project_param = params.len() + 1;
    params.push(Value::String(payload.project_id.clone()));
    let mut sql = format!(
        "UPDATE tree_nodes SET {} WHERE id = ?{} AND project_id = ?{}",
        assignments.join(", "),
        id_param,
        project_param
    );
    if let Some(base_version) = payload.base_version {
        let version_param = params.len() + 1;
        params.push(Value::Number(base_version.into()));
        sql.push_str(&format!(" AND version = ?{version_param}"));
    }
    if let Some(event) = payload.change_event.as_ref() {
        anyhow::ensure!(
            event.event_uid == payload.event_uid && event.session_id == payload.session_id,
            "tree node changeEvent identity must match writer identity"
        );
    }
    // Coverage is an optimization proof, not the canonical body-write intent.
    // Normalize it out so transport retries that re-materialize or omit the
    // proof still resolve to the same receipt (while a changed body remains a
    // request conflict).
    let mut fingerprint_payload = payload.clone();
    fingerprint_payload.timelapse_doc_step_coverage = None;
    let request_hash =
        canonical_write_payload_fingerprint("tree_node_patch", &fingerprint_payload)?;
    let idempotency_request = IdempotencyRequest {
        domain: "tree_node_patch",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "TREE_NODE_PATCH_REQUEST_CONFLICT",
    };
    let timestamp = payload
        .change_event
        .as_ref()
        .map(|event| event.timestamp)
        .unwrap_or_else(|| event_timestamp(&payload.updated_at));
    let source_domain = if is_restore {
        "content.restore"
    } else if payload.change_event.is_some() {
        "scene.content_update"
    } else {
        "tree.node.patch"
    };
    db.with_conn(|conn| {
        with_immediate_transaction(conn, |tx| {
        if let Some(response) = load_idempotent_response(tx, &idempotency_request)? {
            return Ok(response);
        }
        validate_tree_replay_lineage_in_tx(
            tx,
            &payload.project_id,
            payload.origin,
            payload.original_transaction_id.as_deref(),
            payload.undo_journal_id.as_deref(),
        )?;
        validate_tree_replay_target_in_tx(
            tx,
            &payload.project_id,
            payload.origin,
            payload.undo_journal_id.as_deref(),
            &payload.node_id,
            "patch",
        )?;
        let before = select_tree_node(tx, &payload.project_id, &payload.node_id)?;
        let before_live_scene_subtree_count = if before
            .get("nodeType")
            .and_then(Value::as_str)
            == Some("folder")
        {
            Some(live_scene_subtree_count(
                tx,
                &payload.project_id,
                &payload.node_id,
            )?)
        } else {
            None
        };
        if payload.change_event.is_some() {
            let already_exists = tx
                .query_row(
                    "SELECT 1 FROM change_events WHERE project_id = ?1 AND event_uid = ?2",
                    params![payload.project_id, payload.event_uid],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .is_some();
            anyhow::ensure!(
                !already_exists,
                "tree node content event UID '{}' already exists",
                payload.event_uid
            );
        }
        if let Some(parent_id) = payload.patch.get("parentId") {
            match parent_id {
                Value::Null => {}
                Value::String(parent_id) => {
                    ensure_tree_parent_does_not_cycle(
                        tx,
                        &payload.project_id,
                        &payload.node_id,
                        parent_id,
                    )?;
                    ensure_tree_parent_in_project(tx, &payload.project_id, parent_id)?;
                }
                _ => anyhow::bail!("tree node parentId must be a string or null"),
            }
        }
        for (wire_name, field) in [
            ("povCharacterId", "povCharacterId"),
            ("locationId", "locationId"),
        ] {
            if let Some(entry_id) = payload.patch.get(wire_name) {
                match entry_id {
                    Value::Null => {}
                    Value::String(entry_id) => ensure_tree_codex_reference_in_project(
                        tx,
                        &payload.project_id,
                        field,
                        entry_id,
                    )?,
                    _ => anyhow::bail!("tree node {field} must be a string or null"),
                }
            }
        }

        Database::execute_with_conn(tx, &sql, &params, "run")?;
        let updated = tx.changes();
        if updated != 1 {
            if let Some(base_version) = payload.base_version {
                anyhow::bail!(
                    "TREE_NODE_VERSION_MISMATCH: node '{}' version conflict; expected base version {}",
                    payload.node_id,
                    base_version
                );
            }
            anyhow::bail!(
                "tree node '{}' not found in project '{}'",
                payload.node_id,
                payload.project_id
            );
        }
        let row = select_tree_node(tx, &payload.project_id, &payload.node_id)?;
        if let Some(base_version) = payload.base_version {
            let expected_version = if payload.bump_version {
                base_version
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("tree node version overflow"))?
            } else {
                base_version
            };
            anyhow::ensure!(
                row.get("version").and_then(Value::as_i64) == Some(expected_version),
                "TREE_NODE_VERSION_MISMATCH: node '{}' version conflict; expected base version {}",
                payload.node_id,
                base_version
            );
        }
        if payload.change_event.is_some() {
            anyhow::ensure!(
                row.get("nodeType").and_then(Value::as_str) == Some("scene"),
                "tree node content event target must be a scene"
            );
        }
        if row.get("nodeType").and_then(Value::as_str) == Some("scene") {
            let field_paths: Vec<&str> = payload
                .patch
                .keys()
                .filter_map(|key| tree_patch_path(key))
                .collect();
            if !field_paths.is_empty() {
                let updated_at = row
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("tree node row has no updatedAt"))?;
                let version = row
                    .get("version")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| anyhow::anyhow!("tree node row has no version"))?;
                crate::narrative_extraction::record_human_field_write(
                    tx,
                    &payload.project_id,
                    "scene",
                    &payload.node_id,
                    &field_paths,
                    updated_at,
                )?;
                let source_key = format!("project:scene:{}", payload.node_id);
                let source_token = format!("v{version}@{updated_at}");
                crate::narrative_extraction::propagate_source_change_freshness_in_tx(
                    tx,
                    &payload.project_id,
                    "scene-body",
                    &source_key,
                    Some(&source_token),
                    updated_at,
                    payload
                        .change_event
                        .as_ref()
                        .map(|event| event.session_id.as_str())
                        .unwrap_or("tree-node-writer"),
                )?;
            }
        }
        let mut changed_paths = payload
            .patch
            .keys()
            .filter_map(|key| tree_patch_path(key))
            .map(str::to_string)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        if changed_paths.is_empty() {
            changed_paths.push("/updatedAt".to_string());
        }
        let is_scene = row.get("nodeType").and_then(Value::as_str) == Some("scene");
        let append_body_snapshot = if is_scene && payload.patch.contains_key("content") {
            // Renderer coverage is deliberately not trusted as a snapshot
            // authority. The body row just written is the source of truth, so
            // retain its full snapshot for forward and history replay writes
            // until a sealed Native proof exists.
            true
        } else {
            false
        };
        let live_scene_subtree_impact = if row.get("nodeType").and_then(Value::as_str)
            == Some("folder")
        {
            Some((
                before_live_scene_subtree_count.unwrap_or(0),
                live_scene_subtree_count(tx, &payload.project_id, &payload.node_id)?,
            ))
        } else {
            None
        };
        let canonical_payload = payload
            .canonical_payload
            .clone()
            .unwrap_or_else(|| {
                json!({
                    "fields": payload.patch.keys().cloned().collect::<Vec<_>>(),
                    "before": before.clone(),
                    "after": row.clone(),
                })
            })
            .to_string();
        let canonical_payload = renderer_context.as_ref().map_or(canonical_payload.clone(), |context| {
            canonical_payload_with_authority_context(&canonical_payload, context)
        });
        let journal_id = payload
            .undo_journal_id
            .clone()
            .unwrap_or_else(|| payload.request_id.clone());
        let before_json = serde_json::to_string(&before)?;
        let after_json = serde_json::to_string(&row)?;
        if !matches!(
            payload.origin,
            NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
        ) {
            crate::undo_journal::insert_undo_journal_in_tx(
                tx,
                crate::undo_journal::UndoJournalInsert {
                    id: &journal_id,
                    project_id: &payload.project_id,
                    surface: "tree",
                    entity_kind: "tree_node",
                    entity_id: &payload.node_id,
                    op_kind: "update",
                    before_json: Some(&before_json),
                    after_json: Some(&after_json),
                    base_version: tree_version(Some(&before)).unwrap_or(0),
                    result_version: tree_version(Some(&row)).unwrap_or(0),
                    change_event_uid: Some(&payload.event_uid),
                },
            )?;
        }
        let append = append_tree_feed_result(
            tx,
            TreeFeedAppend {
                project_id: &payload.project_id,
                request_id: &payload.request_id,
                session_id: &payload.session_id,
                event_uid: &payload.event_uid,
                source_domain,
                canonical_domain: if is_restore {
                    "revision"
                } else if payload.change_event.is_some() {
                    "editor"
                } else {
                    "tree"
                },
                canonical_entity_type: if payload.change_event.is_some() {
                    "tree_batch"
                } else {
                    "tree_node"
                },
                entity_id: &payload.node_id,
                canonical_payload,
                scene_id: is_scene.then(|| payload.node_id.clone()),
                occurred_at: &payload.updated_at,
                timestamp,
                cause_kind: tree_cause_kind(payload.origin),
                events: vec![tree_feed_event(
                    &payload.node_id,
                    if is_restore { None } else { Some(&before) },
                    Some(&row),
                    tree_patch_change_kind(&changed_paths),
                    if is_restore { "restore" } else { "update" },
                    changed_paths,
                    live_scene_subtree_impact,
                )?],
                origin: payload.origin,
                original_transaction_id: payload.original_transaction_id.as_deref(),
                undo_journal_id: Some(&journal_id),
            },
        )?;
        if append_body_snapshot {
            crate::timelapse::append_timelapse_body_snapshots_in_tx(
                tx,
                &payload.project_id,
                append.canonical.tail_sequence,
                timestamp,
                &[crate::timelapse::TimelapseBodySnapshotTarget::scene(
                    payload.node_id.clone(),
                )],
            )?;
        }
        let maintenance_transaction_id = append.narrative.transaction_id;
        let response = tree_write_response(
            row,
            &payload.event_uid,
            &maintenance_transaction_id,
            &journal_id,
        );
        insert_idempotent_response(
            tx,
            &idempotency_request,
            &payload.project_id,
            &response,
        )?;
        Ok(response)
        })
    })
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTreePlanCreateInput {
    #[serde(default)]
    pub temp_id: Option<String>,
    pub id: String,
    pub parent_id: Option<String>,
    pub node_type: String,
    pub title: String,
    pub sort_order: String,
    pub synopsis: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTreePlanPlacementInput {
    pub parent_id: Option<String>,
    pub sort_order: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTreePlanUpdateInput {
    pub id: String,
    pub base_version: i64,
    pub placement: Option<AiTreePlanPlacementInput>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiTreeNodeVersionInput {
    pub id: String,
    pub version: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyAiTreePlanPayload {
    pub request_id: String,
    pub project_id: String,
    pub session_id: String,
    pub surface: String,
    pub kind: String,
    pub updated_at: String,
    pub model: Option<String>,
    pub trace_id: Option<String>,
    pub authority_route: String,
    pub caller: String,
    pub controls: Vec<String>,
    #[serde(default)]
    pub provenance: Option<RendererMutationProvenance>,
    #[serde(default)]
    pub writes_authority_protected_field: bool,
    pub creates: Vec<AiTreePlanCreateInput>,
    pub updates: Vec<AiTreePlanUpdateInput>,
    /// Original model IR. Interactive agent calls must carry this so Native
    /// can recompute the effectful creates/updates projection against the
    /// current tree snapshot instead of trusting renderer placements.
    #[serde(default)]
    pub ops: Option<Vec<Value>>,
    #[serde(default)]
    pub redo: bool,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
}

fn ai_tree_authority_context(
    payload: &ApplyAiTreePlanPayload,
) -> anyhow::Result<RendererCanonicalWriteContext> {
    let context = RendererCanonicalWriteContext {
        request_id: payload.request_id.clone(),
        event_uid: payload.request_id.clone(),
        authority_session_id: None,
        origin: if payload.redo {
            NarrativeChangeOrigin::Redo
        } else {
            NarrativeChangeOrigin::AiApply
        },
        authority_route: payload.authority_route.clone(),
        caller: payload.caller.clone(),
        controls: payload.controls.clone(),
        provenance: payload.provenance.clone(),
        writes_authority_protected_field: payload.writes_authority_protected_field,
        original_transaction_id: payload.original_transaction_id.clone(),
        undo_journal_id: payload.undo_journal_id.clone(),
        context_mode: None,
        icon: None,
        children_budget: None,
        notes: None,
        canonical_payload: None,
    };
    validate_renderer_authority_context(&context)?;
    Ok(context)
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoAiTreePlanPayload {
    pub request_id: String,
    pub project_id: String,
    pub session_id: String,
    pub updated_at: String,
    pub original_transaction_id: String,
    pub undo_journal_id: String,
    pub authority_route: String,
    pub caller: String,
    pub controls: Vec<String>,
    #[serde(default)]
    pub provenance: Option<RendererMutationProvenance>,
    #[serde(default)]
    pub writes_authority_protected_field: bool,
    pub expected_versions: Vec<AiTreeNodeVersionInput>,
}

fn ai_tree_undo_authority_context(
    payload: &UndoAiTreePlanPayload,
) -> anyhow::Result<RendererCanonicalWriteContext> {
    let context = RendererCanonicalWriteContext {
        request_id: payload.request_id.clone(),
        event_uid: payload.request_id.clone(),
        authority_session_id: None,
        origin: NarrativeChangeOrigin::Undo,
        authority_route: payload.authority_route.clone(),
        caller: payload.caller.clone(),
        controls: payload.controls.clone(),
        provenance: payload.provenance.clone(),
        writes_authority_protected_field: payload.writes_authority_protected_field,
        original_transaction_id: Some(payload.original_transaction_id.clone()),
        undo_journal_id: Some(payload.undo_journal_id.clone()),
        context_mode: None,
        icon: None,
        children_budget: None,
        notes: None,
        canonical_payload: None,
    };
    validate_renderer_authority_context(&context)?;
    Ok(context)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiTreePlanJournal {
    created_ids: Vec<String>,
    updated_before: Vec<Value>,
}

fn validate_ai_tree_lineage(
    conn: &rusqlite::Connection,
    project_id: &str,
    original_transaction_id: &str,
    undo_journal_id: &str,
) -> anyhow::Result<()> {
    let journal_owned = conn
        .query_row(
            "SELECT 1 FROM undo_journal
              WHERE id = ?1 AND project_id = ?2 AND entity_kind = 'tree_batch'",
            params![undo_journal_id, project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(
        journal_owned,
        "AI tree plan Undo Journal is not in the active project"
    );
    let transaction_owned = conn
        .query_row(
            "SELECT 1 FROM narrative_change_transactions
              WHERE id = ?1 AND project_id = ?2 AND undo_journal_id = ?3
                AND cause_kind = 'forward'",
            params![original_transaction_id, project_id, undo_journal_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    anyhow::ensure!(
        transaction_owned,
        "AI tree plan Change Feed lineage is not in the active project"
    );
    Ok(())
}

fn snapshot_field(snapshot: &Value, field: &str) -> Value {
    snapshot.get(field).cloned().unwrap_or(Value::Null)
}

fn snapshot_id<'a>(snapshot: &'a Value, label: &str) -> anyhow::Result<&'a str> {
    snapshot
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("{label} snapshot has no id"))
}

fn validate_ai_tree_redo_plan_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    undo_journal_id: &str,
    kind: &str,
    creates: &[AiTreePlanCreateInput],
    updates: &[AiTreePlanUpdateInput],
) -> anyhow::Result<()> {
    let expected_op_type = match kind {
        "scaffold" => "tree.aiScaffold",
        "reorganize" => "tree.aiReorganize",
        _ => anyhow::bail!("AI tree plan kind is invalid for redo"),
    };
    let (entity_kind, op_kind, before_json, after_json): (String, String, String, String) = conn
        .query_row(
            "SELECT entity_kind, op_kind, before_json, after_json
           FROM undo_journal
          WHERE id = ?1 AND project_id = ?2",
            params![undo_journal_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
    anyhow::ensure!(
        entity_kind == "tree_batch" && op_kind == expected_op_type,
        "AI tree plan redo journal does not match the requested kind"
    );
    let journal: AiTreePlanJournal = serde_json::from_str(&before_json)?;
    let after: Value = serde_json::from_str(&after_json)?;
    let after_object = after
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("AI tree plan redo journal after state is invalid"))?;
    let after_created_ids = after_object
        .get("createdIds")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("AI tree plan redo journal has no createdIds"))?
        .iter()
        .map(|value| {
            value.as_str().map(str::to_owned).ok_or_else(|| {
                anyhow::anyhow!("AI tree plan redo createdIds contains a non-string")
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let after_updated = after_object
        .get("updated")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow::anyhow!("AI tree plan redo journal has no updated snapshots"))?;

    let payload_created_ids = creates
        .iter()
        .map(|create| create.id.clone())
        .collect::<Vec<_>>();
    let payload_updated_ids = updates
        .iter()
        .map(|update| update.id.clone())
        .collect::<Vec<_>>();
    let sorted_unique = |mut ids: Vec<String>| {
        ids.sort();
        ids.dedup();
        ids
    };
    anyhow::ensure!(
        sorted_unique(payload_created_ids) == sorted_unique(journal.created_ids.clone())
            && sorted_unique(journal.created_ids.clone()) == sorted_unique(after_created_ids),
        "AI tree plan redo creates do not match the forward journal"
    );
    let journal_updated_ids = journal
        .updated_before
        .iter()
        .map(|snapshot| snapshot_id(snapshot, "AI tree plan before").map(str::to_owned))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let after_updated_ids = after_updated
        .iter()
        .map(|snapshot| snapshot_id(snapshot, "AI tree plan after").map(str::to_owned))
        .collect::<anyhow::Result<Vec<_>>>()?;
    anyhow::ensure!(
        sorted_unique(payload_updated_ids) == sorted_unique(journal_updated_ids.clone())
            && sorted_unique(journal_updated_ids.clone()) == sorted_unique(after_updated_ids),
        "AI tree plan redo updates do not match the forward journal"
    );

    for create in creates {
        let after_snapshot = after_updated
            .iter()
            .chain(
                after_object
                    .get("created")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten(),
            )
            .find(|snapshot| {
                snapshot_id(snapshot, "AI tree plan after").ok() == Some(create.id.as_str())
            })
            .ok_or_else(|| {
                anyhow::anyhow!("AI tree plan redo create '{}' is missing", create.id)
            })?;
        anyhow::ensure!(
            snapshot_field(after_snapshot, "parentId")
                == create.parent_id.clone().map_or(Value::Null, Value::String)
                && snapshot_field(after_snapshot, "nodeType")
                    == Value::String(create.node_type.clone())
                && snapshot_field(after_snapshot, "title") == Value::String(create.title.clone())
                && snapshot_field(after_snapshot, "sortOrder")
                    == Value::String(create.sort_order.clone())
                && snapshot_field(after_snapshot, "synopsis")
                    == create.synopsis.clone().map_or(Value::Null, Value::String),
            "AI tree plan redo create '{}' does not match the forward snapshot",
            create.id
        );
    }

    for update in updates {
        let before_snapshot = journal
            .updated_before
            .iter()
            .find(|snapshot| {
                snapshot_id(snapshot, "AI tree plan before").ok() == Some(update.id.as_str())
            })
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "AI tree plan redo update '{}' has no before snapshot",
                    update.id
                )
            })?;
        let after_snapshot = after_updated
            .iter()
            .find(|snapshot| {
                snapshot_id(snapshot, "AI tree plan after").ok() == Some(update.id.as_str())
            })
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "AI tree plan redo update '{}' has no after snapshot",
                    update.id
                )
            })?;
        if let Some(placement) = &update.placement {
            anyhow::ensure!(
                snapshot_field(after_snapshot, "parentId")
                    == placement
                        .parent_id
                        .clone()
                        .map_or(Value::Null, Value::String)
                    && snapshot_field(after_snapshot, "sortOrder")
                        == Value::String(placement.sort_order.clone()),
                "AI tree plan redo update '{}' placement does not match the forward snapshot",
                update.id
            );
        } else {
            anyhow::ensure!(
                snapshot_field(after_snapshot, "parentId")
                    == snapshot_field(before_snapshot, "parentId")
                    && snapshot_field(after_snapshot, "sortOrder")
                        == snapshot_field(before_snapshot, "sortOrder"),
                "AI tree plan redo update '{}' changes placement without a placement input",
                update.id
            );
        }
        if let Some(title) = &update.title {
            anyhow::ensure!(
                snapshot_field(after_snapshot, "title") == Value::String(title.clone()),
                "AI tree plan redo update '{}' title does not match the forward snapshot",
                update.id
            );
        } else {
            anyhow::ensure!(
                snapshot_field(after_snapshot, "title") == snapshot_field(before_snapshot, "title"),
                "AI tree plan redo update '{}' changes title without a title input",
                update.id
            );
        }
    }
    Ok(())
}

// The renderer's placement helper uses the same fractional-indexing package
// as the UI. Interactive Native calls repeat that small algorithm against the
// transaction snapshot so `creates`/`updates` cannot be altered while keeping
// the original model ops and capability alive.
const TREE_ORDER_DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

#[derive(Clone, Debug)]
enum NativeTreeAfter {
    Append,
    Prepend,
    After(String),
}

#[derive(Clone, Debug)]
struct NativeTreeInserted {
    id: String,
    after: NativeTreeAfter,
    order: usize,
}

#[derive(Clone, Debug)]
struct NativeTreeNodeSnapshot {
    id: String,
    parent_id: Option<String>,
    node_type: String,
    sort_order: String,
}

type NativeTreeExpectedUpdate = (Option<(Option<String>, NativeTreeAfter)>, Option<String>);

fn tree_order_integer_length(head: u8) -> anyhow::Result<usize> {
    match head {
        b'a'..=b'z' => Ok((head - b'a' + 2) as usize),
        b'A'..=b'Z' => Ok((b'Z' - head + 2) as usize),
        _ => anyhow::bail!("invalid tree order key head"),
    }
}

fn tree_order_integer_part(key: &str) -> anyhow::Result<&str> {
    let bytes = key.as_bytes();
    anyhow::ensure!(!bytes.is_empty(), "tree order key is empty");
    let length = tree_order_integer_length(bytes[0])?;
    anyhow::ensure!(length <= bytes.len(), "invalid tree order key");
    Ok(&key[..length])
}

fn tree_validate_order_key(key: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        key != format!("A{}", "0".repeat(26)),
        "invalid tree order key"
    );
    let integer = tree_order_integer_part(key)?;
    let fraction = &key[integer.len()..];
    anyhow::ensure!(
        !fraction.ends_with('0'),
        "tree order key has a trailing zero"
    );
    anyhow::ensure!(
        integer
            .as_bytes()
            .iter()
            .skip(1)
            .all(|digit| TREE_ORDER_DIGITS.contains(digit)),
        "tree order key contains an invalid integer digit"
    );
    anyhow::ensure!(
        key.as_bytes()
            .iter()
            .skip(integer.len())
            .all(|digit| TREE_ORDER_DIGITS.contains(digit)),
        "tree order key contains an invalid digit"
    );
    Ok(())
}

fn tree_validate_integer(integer: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        tree_order_integer_part(integer)? == integer,
        "invalid tree order integer"
    );
    anyhow::ensure!(
        integer
            .as_bytes()
            .iter()
            .skip(1)
            .all(|digit| TREE_ORDER_DIGITS.contains(digit)),
        "invalid tree order integer digit"
    );
    Ok(())
}

fn tree_increment_integer(integer: &str) -> anyhow::Result<Option<String>> {
    tree_validate_integer(integer)?;
    let mut bytes = integer.as_bytes().to_vec();
    let head = bytes[0];
    let mut carry = true;
    for index in (1..bytes.len()).rev() {
        if !carry {
            break;
        }
        let digit = TREE_ORDER_DIGITS
            .iter()
            .position(|candidate| *candidate == bytes[index])
            .ok_or_else(|| anyhow::anyhow!("invalid tree order integer digit"))?;
        if digit + 1 == TREE_ORDER_DIGITS.len() {
            bytes[index] = TREE_ORDER_DIGITS[0];
        } else {
            bytes[index] = TREE_ORDER_DIGITS[digit + 1];
            carry = false;
        }
    }
    if !carry {
        return Ok(Some(String::from_utf8(bytes)?));
    }
    if head == b'Z' {
        return Ok(Some(format!("a{}", TREE_ORDER_DIGITS[0] as char)));
    }
    if head == b'z' {
        return Ok(None);
    }
    let next_head = head + 1;
    if next_head > b'a' {
        bytes.push(TREE_ORDER_DIGITS[0]);
    } else {
        bytes.pop();
    }
    bytes[0] = next_head;
    Ok(Some(String::from_utf8(bytes)?))
}

fn tree_decrement_integer(integer: &str) -> anyhow::Result<Option<String>> {
    tree_validate_integer(integer)?;
    let mut bytes = integer.as_bytes().to_vec();
    let head = bytes[0];
    let mut borrow = true;
    for index in (1..bytes.len()).rev() {
        if !borrow {
            break;
        }
        let digit = TREE_ORDER_DIGITS
            .iter()
            .position(|candidate| *candidate == bytes[index])
            .ok_or_else(|| anyhow::anyhow!("invalid tree order integer digit"))?;
        if digit == 0 {
            bytes[index] = *TREE_ORDER_DIGITS.last().unwrap_or(&b'z');
        } else {
            bytes[index] = TREE_ORDER_DIGITS[digit - 1];
            borrow = false;
        }
    }
    if !borrow {
        return Ok(Some(String::from_utf8(bytes)?));
    }
    if head == b'a' {
        return Ok(Some(format!(
            "Z{}",
            TREE_ORDER_DIGITS.last().copied().unwrap_or(b'z') as char
        )));
    }
    if head == b'A' {
        return Ok(None);
    }
    let previous_head = head - 1;
    if previous_head < b'Z' {
        bytes.push(*TREE_ORDER_DIGITS.last().unwrap_or(&b'z'));
    } else {
        bytes.pop();
    }
    bytes[0] = previous_head;
    Ok(Some(String::from_utf8(bytes)?))
}

fn tree_midpoint(a: &str, b: Option<&str>) -> anyhow::Result<String> {
    if let Some(b) = b {
        anyhow::ensure!(a < b, "tree order midpoint bounds are invalid");
    }
    anyhow::ensure!(!a.ends_with('0'), "tree order midpoint has a trailing zero");
    if let Some(b) = b {
        anyhow::ensure!(!b.ends_with('0'), "tree order midpoint has a trailing zero");
    }
    if let Some(b) = b {
        let mut common = 0;
        while common < b.len()
            && a.as_bytes().get(common).copied().unwrap_or(b'0') == b.as_bytes()[common]
        {
            common += 1;
        }
        if common > 0 {
            return Ok(format!(
                "{}{}",
                &b[..common],
                tree_midpoint(&a[common..], Some(&b[common..]))?
            ));
        }
    }
    let digit_a = if a.is_empty() {
        0
    } else {
        TREE_ORDER_DIGITS
            .iter()
            .position(|digit| *digit == a.as_bytes()[0])
            .ok_or_else(|| anyhow::anyhow!("invalid tree order midpoint digit"))?
    };
    let digit_b = match b {
        Some(b) => TREE_ORDER_DIGITS
            .iter()
            .position(|digit| *digit == b.as_bytes()[0])
            .ok_or_else(|| anyhow::anyhow!("invalid tree order midpoint digit"))?,
        None => TREE_ORDER_DIGITS.len(),
    };
    if digit_b - digit_a > 1 {
        return Ok((TREE_ORDER_DIGITS[(digit_a + digit_b).div_ceil(2)] as char).to_string());
    }
    if b.is_some_and(|value| value.len() > 1) {
        return Ok(b.unwrap_or_default()[..1].to_string());
    }
    Ok(format!(
        "{}{}",
        TREE_ORDER_DIGITS[digit_a] as char,
        tree_midpoint(a.get(1..).unwrap_or_default(), None)?
    ))
}

fn tree_generate_key_between(a: Option<&str>, b: Option<&str>) -> anyhow::Result<String> {
    if let Some(a) = a {
        tree_validate_order_key(a)?;
    }
    if let Some(b) = b {
        tree_validate_order_key(b)?;
    }
    if let (Some(a), Some(b)) = (a, b) {
        anyhow::ensure!(a < b, "tree order bounds are invalid");
    }
    match (a, b) {
        (None, None) => Ok("a0".to_string()),
        (None, Some(b)) => {
            let integer = tree_order_integer_part(b)?;
            if integer < b {
                Ok(integer.to_string())
            } else {
                tree_decrement_integer(integer)?
                    .ok_or_else(|| anyhow::anyhow!("cannot decrement tree order key any more"))
            }
        }
        (Some(a), None) => {
            let integer = tree_order_integer_part(a)?;
            let fraction = &a[integer.len()..];
            match tree_increment_integer(integer)? {
                Some(value) => Ok(value),
                None => Ok(format!("{}{}", integer, tree_midpoint(fraction, None)?)),
            }
        }
        (Some(a), Some(b)) => {
            let integer_a = tree_order_integer_part(a)?;
            let integer_b = tree_order_integer_part(b)?;
            let fraction_a = &a[integer_a.len()..];
            let fraction_b = &b[integer_b.len()..];
            if integer_a == integer_b {
                Ok(format!(
                    "{}{}",
                    integer_a,
                    tree_midpoint(fraction_a, Some(fraction_b))?
                ))
            } else if let Some(next) = tree_increment_integer(integer_a)? {
                if next.as_str() < b {
                    Ok(next)
                } else {
                    Ok(format!("{}{}", integer_a, tree_midpoint(fraction_a, None)?))
                }
            } else {
                Ok(format!("{}{}", integer_a, tree_midpoint(fraction_a, None)?))
            }
        }
    }
}

fn tree_generate_n_keys_between(
    a: Option<&str>,
    b: Option<&str>,
    count: usize,
) -> anyhow::Result<Vec<String>> {
    if count == 0 {
        return Ok(Vec::new());
    }
    if count == 1 {
        return Ok(vec![tree_generate_key_between(a, b)?]);
    }
    if b.is_none() {
        let mut current = tree_generate_key_between(a, b)?;
        let mut result = vec![current.clone()];
        for _ in 0..count - 1 {
            current = tree_generate_key_between(Some(&current), None)?;
            result.push(current.clone());
        }
        return Ok(result);
    }
    if a.is_none() {
        let mut current = tree_generate_key_between(None, b)?;
        let mut result = vec![current.clone()];
        for _ in 0..count - 1 {
            current = tree_generate_key_between(None, Some(&current))?;
            result.push(current.clone());
        }
        result.reverse();
        return Ok(result);
    }
    let middle_count = count / 2;
    let middle = tree_generate_key_between(a, b)?;
    let mut result = tree_generate_n_keys_between(a, Some(&middle), middle_count)?;
    result.push(middle.clone());
    result.extend(tree_generate_n_keys_between(
        Some(&middle),
        b,
        count - middle_count - 1,
    )?);
    Ok(result)
}

fn native_tree_string(value: &Value, field: &str) -> anyhow::Result<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("AI tree op {field} must be a non-empty string"))
}

fn native_tree_nullable_string(value: &Value, field: &str) -> anyhow::Result<Option<String>> {
    match value.get(field) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        Some(_) => anyhow::bail!("AI tree op {field} must be a string or null"),
        None => anyhow::bail!("AI tree op {field} is missing"),
    }
}

fn native_tree_optional_string(value: &Value, field: &str) -> anyhow::Result<Option<String>> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => anyhow::bail!("AI tree op {field} must be a string or null"),
    }
}

fn native_tree_after(value: &Value) -> anyhow::Result<NativeTreeAfter> {
    let Some(pos) = value.get("pos") else {
        return Ok(NativeTreeAfter::Append);
    };
    let position = pos
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("AI tree op pos must be an object"))?;
    match position.get("afterRef") {
        None => Ok(NativeTreeAfter::Append),
        Some(Value::Null) => Ok(NativeTreeAfter::Prepend),
        Some(Value::String(value)) if !value.is_empty() => {
            Ok(NativeTreeAfter::After(value.clone()))
        }
        Some(_) => anyhow::bail!("AI tree op afterRef must be a string or null"),
    }
}

fn native_tree_resolve_ref(
    value: Option<&String>,
    temp_ids: &HashMap<String, String>,
) -> anyhow::Result<Option<String>> {
    match value {
        None => Ok(None),
        Some(value) if value.starts_with("tmp:") => temp_ids
            .get(value)
            .cloned()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("AI tree op references an unknown tempId '{value}'")),
        Some(value) => Ok(Some(value.clone())),
    }
}

fn native_tree_emit_inserted(
    inserted: &NativeTreeInserted,
    after_map: &HashMap<String, Vec<NativeTreeInserted>>,
    visiting: &mut HashSet<String>,
    placed: &mut HashSet<String>,
    ordered: &mut Vec<(String, Option<String>)>,
) -> anyhow::Result<()> {
    if visiting.contains(&inserted.id) {
        anyhow::bail!("AI tree plan afterRef cycle detected")
    }
    if placed.contains(&inserted.id) {
        return Ok(());
    }
    visiting.insert(inserted.id.clone());
    ordered.push((inserted.id.clone(), None));
    for child in after_map.get(&inserted.id).into_iter().flatten() {
        native_tree_emit_inserted(child, after_map, visiting, placed, ordered)?;
    }
    visiting.remove(&inserted.id);
    placed.insert(inserted.id.clone());
    Ok(())
}

fn validate_ai_tree_native_projection_in_tx(
    conn: &rusqlite::Connection,
    payload: &ApplyAiTreePlanPayload,
) -> anyhow::Result<()> {
    let ops = payload
        .ops
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("interactive AI tree plan ops are required"))?;
    anyhow::ensure!(!ops.is_empty(), "interactive AI tree plan ops are empty");

    let mut current = Vec::new();
    let mut statement = conn.prepare(
        "SELECT id, parent_id, node_type, title, synopsis, sort_order
           FROM tree_nodes WHERE project_id = ?1",
    )?;
    for row in statement.query_map([&payload.project_id], |row| {
        Ok(NativeTreeNodeSnapshot {
            id: row.get(0)?,
            parent_id: row.get(1)?,
            node_type: row.get(2)?,
            sort_order: row.get(5)?,
        })
    })? {
        current.push(row?);
    }
    let current_by_id: HashMap<String, NativeTreeNodeSnapshot> = current
        .iter()
        .cloned()
        .map(|node| (node.id.clone(), node))
        .collect();
    for update in &payload.updates {
        anyhow::ensure!(
            current_by_id.contains_key(&update.id),
            "tree node '{}' not found in project '{}'",
            update.id,
            payload.project_id
        );
    }

    let mut create_ops = Vec::new();
    let mut move_ops = Vec::new();
    let mut rename_ops = Vec::new();
    for (order, op) in ops.iter().enumerate() {
        let kind = native_tree_string(op, "op")?;
        anyhow::ensure!(
            payload.kind != "scaffold" || kind == "create",
            "scaffold AI tree plan may contain create ops only"
        );
        match kind.as_str() {
            "create" => create_ops.push((
                order,
                native_tree_string(op, "tempId")?,
                native_tree_nullable_string(op, "parentRef")?,
                native_tree_string(op, "nodeType")?,
                native_tree_string(op, "title")?,
                native_tree_optional_string(op, "synopsis")?,
                native_tree_after(op)?,
            )),
            "move" => move_ops.push((
                order,
                native_tree_string(op, "nodeId")?,
                native_tree_nullable_string(op, "newParentRef")?,
                native_tree_after(op)?,
            )),
            "rename" => rename_ops.push((
                native_tree_string(op, "nodeId")?,
                native_tree_string(op, "title")?,
            )),
            _ => anyhow::bail!("AI tree plan contains an unsupported op '{kind}'"),
        }
    }

    let mut temp_ids = HashMap::new();
    let mut create_rows = HashMap::new();
    for create in &payload.creates {
        let temp_id = create
            .temp_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("interactive AI tree create tempId is required"))?;
        anyhow::ensure!(
            temp_id.starts_with("tmp:"),
            "interactive AI tree create tempId is invalid"
        );
        anyhow::ensure!(
            temp_ids
                .insert(temp_id.to_string(), create.id.clone())
                .is_none(),
            "interactive AI tree create tempIds must be unique"
        );
        anyhow::ensure!(
            !current_by_id.contains_key(&create.id),
            "interactive AI tree create id '{}' already exists",
            create.id
        );
        anyhow::ensure!(
            create_rows.insert(temp_id.to_string(), create).is_none(),
            "interactive AI tree create tempIds must be unique"
        );
    }
    anyhow::ensure!(
        create_ops.len() == payload.creates.len(),
        "interactive AI tree create ops do not match creates"
    );
    for (_, temp_id, parent_ref, node_type, title, synopsis, _) in &create_ops {
        let create = create_rows
            .get(temp_id)
            .ok_or_else(|| anyhow::anyhow!("interactive AI tree create '{temp_id}' is missing"))?;
        anyhow::ensure!(
            native_tree_resolve_ref(parent_ref.as_ref(), &temp_ids)? == create.parent_id,
            "interactive AI tree create '{temp_id}' parent does not match ops"
        );
        anyhow::ensure!(
            create.node_type == *node_type,
            "interactive AI tree create nodeType does not match ops"
        );
        anyhow::ensure!(
            create.title == *title,
            "interactive AI tree create title does not match ops"
        );
        anyhow::ensure!(
            create.synopsis == *synopsis,
            "interactive AI tree create synopsis does not match ops"
        );
    }

    let mut expected_updates: HashMap<String, NativeTreeExpectedUpdate> = HashMap::new();
    let mut moved_ids = HashSet::new();
    for (_, node_id, parent_ref, after) in &move_ops {
        anyhow::ensure!(
            current_by_id.contains_key(node_id),
            "tree node '{node_id}' not found in project '{}'",
            payload.project_id
        );
        anyhow::ensure!(
            moved_ids.insert(node_id.clone()),
            "AI tree move is duplicated for '{node_id}'"
        );
        expected_updates
            .entry(node_id.clone())
            .or_insert((None, None))
            .0 = Some((
            native_tree_resolve_ref(parent_ref.as_ref(), &temp_ids)?,
            after.clone(),
        ));
    }
    for (node_id, title) in &rename_ops {
        anyhow::ensure!(
            current_by_id.contains_key(node_id),
            "tree node '{node_id}' is not in project '{}'",
            payload.project_id
        );
        let entry = expected_updates
            .entry(node_id.clone())
            .or_insert((None, None));
        anyhow::ensure!(
            entry.1.is_none(),
            "AI tree rename is duplicated for '{node_id}'"
        );
        entry.1 = Some(title.clone());
    }
    anyhow::ensure!(
        expected_updates.len() == payload.updates.len(),
        "interactive AI tree update ops do not match updates"
    );
    for update in &payload.updates {
        let expected = expected_updates.get(&update.id).ok_or_else(|| {
            anyhow::anyhow!("interactive AI tree update '{}' is not in ops", update.id)
        })?;
        match (&expected.0, &update.placement) {
            (Some(_), Some(_)) => {}
            (Some(_), None) => anyhow::bail!("interactive AI tree move placement is missing"),
            (None, Some(_)) => {
                anyhow::bail!("interactive AI tree update has an unauthorized placement")
            }
            (None, None) => {}
        }
        match (&expected.1, &update.title) {
            (Some(expected), Some(actual)) => anyhow::ensure!(
                expected == actual,
                "interactive AI tree rename does not match ops"
            ),
            (Some(_), None) => anyhow::bail!("interactive AI tree rename title is missing"),
            (None, Some(_)) => {
                anyhow::bail!("interactive AI tree update has an unauthorized title")
            }
            (None, None) => {}
        }
    }

    let mut final_parent: HashMap<String, Option<String>> = current
        .iter()
        .map(|node| (node.id.clone(), node.parent_id.clone()))
        .collect();
    let mut final_type: HashMap<String, String> = current
        .iter()
        .map(|node| (node.id.clone(), node.node_type.clone()))
        .collect();
    for (temp_id, create) in &create_rows {
        let parent = native_tree_resolve_ref(create.parent_id.as_ref(), &temp_ids)?;
        final_parent.insert(create.id.clone(), parent);
        final_type.insert(create.id.clone(), create.node_type.clone());
        final_parent.insert(temp_id.clone(), final_parent[&create.id].clone());
        final_type.insert(temp_id.clone(), create.node_type.clone());
    }
    for (_, node_id, parent_ref, _) in &move_ops {
        let parent = native_tree_resolve_ref(parent_ref.as_ref(), &temp_ids)?;
        if let Some(parent_id) = parent.as_ref() {
            anyhow::ensure!(
                final_type.get(parent_id).map(String::as_str) == Some("folder"),
                "AI tree parent '{parent_id}' must be a folder"
            );
        }
        final_parent.insert(node_id.clone(), parent);
    }
    for (temp_id, create) in &create_rows {
        if let Some(parent_id) = final_parent.get(&create.id).and_then(Option::as_ref) {
            anyhow::ensure!(
                final_type.get(parent_id).map(String::as_str) == Some("folder"),
                "AI tree parent '{parent_id}' must be a folder"
            );
        }
        let _ = temp_id;
    }

    let mut children_by_parent: HashMap<Option<String>, Vec<NativeTreeNodeSnapshot>> =
        HashMap::new();
    for node in &current {
        children_by_parent
            .entry(node.parent_id.clone())
            .or_default()
            .push(node.clone());
    }
    let mut inserted_by_parent: HashMap<Option<String>, Vec<NativeTreeInserted>> = HashMap::new();
    for (order, temp_id, parent_ref, _, _, _, after) in &create_ops {
        let create = create_rows
            .get(temp_id)
            .expect("create row was checked above");
        let parent = native_tree_resolve_ref(parent_ref.as_ref(), &temp_ids)?;
        let after = match after {
            NativeTreeAfter::Append => NativeTreeAfter::Append,
            NativeTreeAfter::Prepend => NativeTreeAfter::Prepend,
            NativeTreeAfter::After(reference) => NativeTreeAfter::After(
                native_tree_resolve_ref(Some(reference), &temp_ids)?
                    .ok_or_else(|| anyhow::anyhow!("AI tree afterRef is null"))?,
            ),
        };
        inserted_by_parent
            .entry(parent)
            .or_default()
            .push(NativeTreeInserted {
                id: create.id.clone(),
                after,
                order: *order,
            });
    }
    for (order, node_id, parent_ref, after) in &move_ops {
        let parent = native_tree_resolve_ref(parent_ref.as_ref(), &temp_ids)?;
        let after = match after {
            NativeTreeAfter::Append => NativeTreeAfter::Append,
            NativeTreeAfter::Prepend => NativeTreeAfter::Prepend,
            NativeTreeAfter::After(reference) => NativeTreeAfter::After(
                native_tree_resolve_ref(Some(reference), &temp_ids)?
                    .ok_or_else(|| anyhow::anyhow!("AI tree afterRef is null"))?,
            ),
        };
        inserted_by_parent
            .entry(parent)
            .or_default()
            .push(NativeTreeInserted {
                id: node_id.clone(),
                after,
                order: *order,
            });
    }

    let mut expected_placements: HashMap<String, (Option<String>, String)> = HashMap::new();
    for (parent, mut inserted) in inserted_by_parent {
        inserted.sort_by_key(|item| item.order);
        let inserted_ids: HashSet<String> = inserted.iter().map(|item| item.id.clone()).collect();
        let mut anchors = children_by_parent.remove(&parent).unwrap_or_default();
        anchors.retain(|node| {
            !moved_ids.contains(&node.id) && tree_validate_order_key(&node.sort_order).is_ok()
        });
        anchors.sort_by(|left, right| left.sort_order.cmp(&right.sort_order));
        let anchor_ids: HashSet<String> = anchors.iter().map(|node| node.id.clone()).collect();
        let mut after_map: HashMap<String, Vec<NativeTreeInserted>> = HashMap::new();
        let mut prepend = Vec::new();
        let mut append = Vec::new();
        for item in inserted {
            match &item.after {
                NativeTreeAfter::Append => append.push(item),
                NativeTreeAfter::Prepend => prepend.push(item),
                NativeTreeAfter::After(reference) => {
                    anyhow::ensure!(
                        anchor_ids.contains(reference) || inserted_ids.contains(reference),
                        "AI tree afterRef '{reference}' is not a final sibling"
                    );
                    anyhow::ensure!(
                        final_parent.get(reference) == Some(&parent),
                        "AI tree afterRef '{reference}' has a different final parent"
                    );
                    after_map.entry(reference.clone()).or_default().push(item);
                }
            }
        }
        let mut ordered: Vec<(String, Option<String>)> = Vec::new();
        let mut visiting = HashSet::new();
        let mut placed = HashSet::new();
        for item in &prepend {
            native_tree_emit_inserted(item, &after_map, &mut visiting, &mut placed, &mut ordered)?;
        }
        for anchor in &anchors {
            ordered.push((anchor.id.clone(), Some(anchor.sort_order.clone())));
            for item in after_map.get(&anchor.id).into_iter().flatten() {
                native_tree_emit_inserted(
                    item,
                    &after_map,
                    &mut visiting,
                    &mut placed,
                    &mut ordered,
                )?;
            }
        }
        for item in &append {
            native_tree_emit_inserted(item, &after_map, &mut visiting, &mut placed, &mut ordered)?;
        }
        anyhow::ensure!(
            placed.len() == inserted_ids.len(),
            "interactive AI tree placement omitted an inserted node"
        );
        let mut index = 0;
        while index < ordered.len() {
            if ordered[index].1.is_some() {
                index += 1;
                continue;
            }
            let mut end = index;
            while end < ordered.len() && ordered[end].1.is_none() {
                end += 1;
            }
            let before = if index > 0 {
                ordered[index - 1].1.as_deref()
            } else {
                None
            };
            let after = if end < ordered.len() {
                ordered[end].1.as_deref()
            } else {
                None
            };
            let keys = tree_generate_n_keys_between(before, after, end - index)?;
            for (offset, (id, _)) in ordered[index..end].iter().enumerate() {
                expected_placements.insert(id.clone(), (parent.clone(), keys[offset].clone()));
            }
            index = end;
        }
    }
    for create in &payload.creates {
        let expected = expected_placements
            .get(&create.id)
            .ok_or_else(|| anyhow::anyhow!("interactive AI tree create placement is missing"))?;
        anyhow::ensure!(
            expected.0 == create.parent_id && expected.1 == create.sort_order,
            "interactive AI tree create placement does not match ops"
        );
    }
    for update in &payload.updates {
        if expected_updates
            .get(&update.id)
            .and_then(|value| value.0.as_ref())
            .is_some()
        {
            let expected = expected_placements
                .get(&update.id)
                .ok_or_else(|| anyhow::anyhow!("interactive AI tree move placement is missing"))?;
            let placement = update
                .placement
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("interactive AI tree move placement is missing"))?;
            anyhow::ensure!(
                expected.0.as_ref() == placement.parent_id.as_ref()
                    && expected.1 == placement.sort_order,
                "interactive AI tree update placement does not match ops"
            );
        }
    }
    Ok(())
}

fn ai_tree_version_rows(rows: &BTreeMap<String, Value>) -> Value {
    Value::Array(
        rows.iter()
            .filter_map(|(id, row)| {
                row.get("version")
                    .and_then(Value::as_i64)
                    .map(|version| json!({ "id": id, "version": version }))
            })
            .collect(),
    )
}

fn ai_tree_create_authority_paths() -> Vec<String> {
    [
        "/parentId",
        "/nodeType",
        "/title",
        "/sortOrder",
        "/synopsis",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn ai_tree_update_authority_paths(update: &AiTreePlanUpdateInput) -> Vec<String> {
    let mut paths = Vec::new();
    if update.placement.is_some() {
        paths.extend(["/parentId".to_string(), "/sortOrder".to_string()]);
    }
    if update.title.is_some() {
        paths.push("/title".to_string());
    }
    paths
}

pub fn apply_ai_tree_plan(db: &Database, payload: ApplyAiTreePlanPayload) -> anyhow::Result<Value> {
    for (value, field) in [
        (&payload.request_id, "requestId"),
        (&payload.project_id, "projectId"),
        (&payload.session_id, "sessionId"),
        (&payload.surface, "surface"),
        (&payload.updated_at, "updatedAt"),
    ] {
        require_non_empty(value, field)?;
    }
    anyhow::ensure!(
        matches!(payload.kind.as_str(), "scaffold" | "reorganize"),
        "AI tree plan kind must be scaffold or reorganize"
    );
    anyhow::ensure!(
        !payload.creates.is_empty() || !payload.updates.is_empty(),
        "AI tree plan must contain at least one mutation"
    );
    anyhow::ensure!(
        payload.creates.len() + payload.updates.len() <= 200,
        "AI tree plan exceeds the mutation budget"
    );
    let authority_context = ai_tree_authority_context(&payload)?;
    match (
        payload.redo,
        payload.original_transaction_id.as_deref(),
        payload.undo_journal_id.as_deref(),
    ) {
        (false, None, None) | (true, Some(_), Some(_)) => {}
        _ => anyhow::bail!(
            "AI tree plan redo requires originalTransactionId and undoJournalId only for redo"
        ),
    }
    let mut ids = HashSet::new();
    for create in &payload.creates {
        for (value, field) in [
            (&create.id, "creates[].id"),
            (&create.node_type, "creates[].nodeType"),
            (&create.title, "creates[].title"),
            (&create.sort_order, "creates[].sortOrder"),
        ] {
            require_non_empty(value, field)?;
        }
        anyhow::ensure!(
            matches!(create.node_type.as_str(), "folder" | "scene" | "note"),
            "AI tree plan nodeType must be folder, scene, or note"
        );
        anyhow::ensure!(
            ids.insert(create.id.as_str()),
            "AI tree plan ids must be unique"
        );
    }
    for update in &payload.updates {
        require_non_empty(&update.id, "updates[].id")?;
        anyhow::ensure!(
            update.base_version >= 0,
            "AI tree plan baseVersion is invalid"
        );
        anyhow::ensure!(
            update.placement.is_some() || update.title.is_some(),
            "AI tree plan update must change placement or title"
        );
        if let Some(placement) = &update.placement {
            require_non_empty(&placement.sort_order, "updates[].placement.sortOrder")?;
        }
        if let Some(title) = &update.title {
            require_non_empty(title, "updates[].title")?;
        }
        anyhow::ensure!(
            ids.insert(update.id.as_str()),
            "AI tree plan ids must be unique"
        );
    }

    let mut normalized = payload.clone();
    normalized.session_id.clear();
    let request_hash = payload_fingerprint("ai_tree_plan_apply", &normalized)?;
    let idempotency_request = IdempotencyRequest {
        domain: "ai_tree_plan_apply",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "AI_TREE_PLAN_APPLY_REQUEST_CONFLICT",
    };
    let op_type = if payload.kind == "scaffold" {
        "tree.aiScaffold"
    } else {
        "tree.aiReorganize"
    };
    let timestamp = event_timestamp(&payload.updated_at);
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(response) = load_idempotent_response(&tx, &idempotency_request)? {
            tx.commit()?;
            return Ok(response);
        }
        if let (Some(original_transaction_id), Some(undo_journal_id)) = (
            payload.original_transaction_id.as_deref(),
            payload.undo_journal_id.as_deref(),
        ) {
            validate_ai_tree_lineage(
                &tx,
                &payload.project_id,
                original_transaction_id,
                undo_journal_id,
            )?;
            if payload.redo {
                validate_ai_tree_redo_plan_in_tx(
                    &tx,
                    &payload.project_id,
                    undo_journal_id,
                    &payload.kind,
                    &payload.creates,
                    &payload.updates,
                )?;
            }
        }

        if authority_context.authority_route == "interactive-agent-command" && !payload.redo {
            validate_ai_tree_native_projection_in_tx(&tx, &payload)?;
        }

        let mut affected_authority_paths = BTreeSet::new();
        let mut authority_records = Vec::<(String, Vec<String>)>::new();
        if authority_context.authority_route == "interactive-agent-command" {
            for create in &payload.creates {
                let paths = ai_tree_create_authority_paths();
                affected_authority_paths.extend(paths.iter().cloned());
                validate_agent_field_authority_for_entity(
                    &tx,
                    &payload.project_id,
                    "tree_node",
                    &create.id,
                    &paths,
                    &payload.updated_at,
                )?;
                authority_records.push((create.id.clone(), paths));
            }
            for update in &payload.updates {
                let paths = ai_tree_update_authority_paths(update);
                affected_authority_paths.extend(paths.iter().cloned());
                validate_agent_field_authority_for_entity(
                    &tx,
                    &payload.project_id,
                    "tree_node",
                    &update.id,
                    &paths,
                    &payload.updated_at,
                )?;
                authority_records.push((update.id.clone(), paths));
            }
        }

        let mut before = BTreeMap::<String, Value>::new();
        for update in &payload.updates {
            let snapshot = select_tree_node(&tx, &payload.project_id, &update.id)?;
            anyhow::ensure!(
                snapshot.get("version").and_then(Value::as_i64) == Some(update.base_version),
                "AI_TREE_PLAN_VERSION_MISMATCH: node '{}' expected version {}",
                update.id,
                update.base_version
            );
            before.insert(update.id.clone(), snapshot);
        }
        let mut before_live_scene_subtree_counts = BTreeMap::<String, i64>::new();
        for (id, snapshot) in &before {
            if snapshot.get("nodeType").and_then(Value::as_str) == Some("folder") {
                before_live_scene_subtree_counts.insert(
                    id.clone(),
                    live_scene_subtree_count(&tx, &payload.project_id, id)?,
                );
            }
        }

        for create in &payload.creates {
            let existing_project = tx
                .query_row(
                    "SELECT project_id FROM tree_nodes WHERE id = ?1",
                    [&create.id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            anyhow::ensure!(
                existing_project.is_none(),
                "AI tree plan create id '{}' already exists{}",
                create.id,
                existing_project
                    .as_deref()
                    .map(|project| format!(" in project '{project}'"))
                    .unwrap_or_default()
            );
            if let Some(parent_id) = create.parent_id.as_deref() {
                ensure_tree_parent_in_project(&tx, &payload.project_id, parent_id)?;
            }
            tx.execute(
                "INSERT INTO tree_nodes
                   (id, project_id, parent_id, node_type, title, synopsis, sort_order,
                    content, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '{}', 1, ?8, ?8)",
                params![
                    create.id,
                    payload.project_id,
                    create.parent_id,
                    create.node_type,
                    create.title,
                    create.synopsis,
                    create.sort_order,
                    payload.updated_at,
                ],
            )?;
        }

        for update in &payload.updates {
            if let Some(placement) = &update.placement {
                if let Some(parent_id) = placement.parent_id.as_deref() {
                    ensure_tree_parent_in_project(&tx, &payload.project_id, parent_id)?;
                    ensure_tree_parent_does_not_cycle(
                        &tx,
                        &payload.project_id,
                        &update.id,
                        parent_id,
                    )?;
                }
            }
            let changed = match (&update.placement, &update.title) {
                (Some(placement), Some(title)) => tx.execute(
                    "UPDATE tree_nodes
                        SET parent_id = ?1, sort_order = ?2, title = ?3,
                            updated_at = ?4, version = version + 1
                      WHERE id = ?5 AND project_id = ?6 AND version = ?7",
                    params![
                        placement.parent_id,
                        placement.sort_order,
                        title,
                        payload.updated_at,
                        update.id,
                        payload.project_id,
                        update.base_version,
                    ],
                )?,
                (Some(placement), None) => tx.execute(
                    "UPDATE tree_nodes
                        SET parent_id = ?1, sort_order = ?2,
                            updated_at = ?3, version = version + 1
                      WHERE id = ?4 AND project_id = ?5 AND version = ?6",
                    params![
                        placement.parent_id,
                        placement.sort_order,
                        payload.updated_at,
                        update.id,
                        payload.project_id,
                        update.base_version,
                    ],
                )?,
                (None, Some(title)) => tx.execute(
                    "UPDATE tree_nodes
                        SET title = ?1, updated_at = ?2, version = version + 1
                      WHERE id = ?3 AND project_id = ?4 AND version = ?5",
                    params![
                        title,
                        payload.updated_at,
                        update.id,
                        payload.project_id,
                        update.base_version,
                    ],
                )?,
                (None, None) => unreachable!("empty updates were rejected"),
            };
            anyhow::ensure!(
                changed == 1,
                "AI_TREE_PLAN_VERSION_MISMATCH: node '{}' changed before apply",
                update.id
            );
        }

        // Authority is recorded only after the corresponding entity mutation
        // succeeds, but before the feed/journal work can commit. Keeping this
        // in the same transaction makes an AI-created node immediately
        // writable by the next AI turn and rolls the ownership rows back with
        // the tree mutation when any later append fails.
        for (entity_id, paths) in &authority_records {
            record_agent_field_authority_for_entity(
                &tx,
                &payload.project_id,
                "tree_node",
                entity_id,
                paths,
                &payload.updated_at,
            )?;
        }

        let mut after = BTreeMap::<String, Value>::new();
        for id in ids.iter().copied().collect::<BTreeSet<_>>() {
            after.insert(
                id.to_string(),
                select_tree_node(&tx, &payload.project_id, id)?,
            );
        }
        let created_ids = payload
            .creates
            .iter()
            .map(|create| create.id.clone())
            .collect::<Vec<_>>();
        let journal = AiTreePlanJournal {
            created_ids: created_ids.clone(),
            updated_before: before.values().cloned().collect(),
        };
        let undo_journal_id = payload
            .undo_journal_id
            .clone()
            .unwrap_or_else(|| payload.request_id.clone());
        if !payload.redo {
            let before_json = serde_json::to_string(&journal)?;
            let after_json = serde_json::to_string(&json!({
                "createdIds": created_ids,
                "created": payload
                    .creates
                    .iter()
                    .filter_map(|create| after.get(&create.id).cloned())
                    .collect::<Vec<_>>(),
                "updated": payload
                    .updates
                    .iter()
                    .filter_map(|update| after.get(&update.id).cloned())
                    .collect::<Vec<_>>(),
            }))?;
            crate::undo_journal::insert_undo_journal_in_tx(
                &tx,
                crate::undo_journal::UndoJournalInsert {
                    id: &undo_journal_id,
                    project_id: &payload.project_id,
                    surface: &payload.surface,
                    entity_kind: "tree_batch",
                    entity_id: payload
                        .trace_id
                        .as_deref()
                        .unwrap_or_else(|| ids.iter().copied().min().unwrap_or("tree-plan")),
                    op_kind: op_type,
                    before_json: Some(&before_json),
                    after_json: Some(&after_json),
                    base_version: 0,
                    result_version: 1,
                    change_event_uid: Some(&payload.request_id),
                },
            )?;
        }

        let mut events = Vec::new();
        for (id, after_snapshot) in &after {
            let before_snapshot = before.get(id);
            let update = payload.updates.iter().find(|update| update.id == *id);
            let (change_kind, mutation_kind, changed_paths) = if let Some(update) = update {
                let mut paths = Vec::new();
                if update.placement.is_some() {
                    paths.extend(["/parentId".to_string(), "/sortOrder".to_string()]);
                }
                if update.title.is_some() {
                    paths.push("/title".to_string());
                }
                (
                    if update.placement.is_some() {
                        "order"
                    } else {
                        "metadata"
                    },
                    "update",
                    paths,
                )
            } else {
                (
                    if after_snapshot.get("nodeType").and_then(Value::as_str) == Some("scene") {
                        "content"
                    } else {
                        "metadata"
                    },
                    if payload.redo { "restore" } else { "create" },
                    vec!["/".to_string()],
                )
            };
            let live_scene_subtree_impact = if after_snapshot
                .get("nodeType")
                .and_then(Value::as_str)
                == Some("folder")
            {
                Some((
                    before_live_scene_subtree_counts
                        .get(id)
                        .copied()
                        .unwrap_or_default(),
                    live_scene_subtree_count(&tx, &payload.project_id, id)?,
                ))
            } else {
                None
            };
            events.push(tree_feed_event(
                id,
                before_snapshot,
                Some(after_snapshot),
                change_kind,
                mutation_kind,
                changed_paths,
                live_scene_subtree_impact,
            )?);
        }
        let maintenance_transaction_id = append_tree_feed(
            &tx,
            TreeFeedAppend {
                project_id: &payload.project_id,
                request_id: &payload.request_id,
                session_id: &payload.session_id,
                event_uid: &payload.request_id,
                source_domain: op_type,
                canonical_domain: "grid",
                canonical_entity_type: "tree_batch",
                entity_id: payload
                    .trace_id
                    .as_deref()
                    .unwrap_or_else(|| ids.iter().copied().min().unwrap_or("tree-plan")),
            canonical_payload: canonical_payload_with_derived_authority_context(&json!({
                    "requestId": payload.request_id,
                    "model": payload.model,
                    "traceId": payload.trace_id,
                    "createdIds": payload.creates.iter().map(|item| &item.id).collect::<Vec<_>>(),
                    "updatedIds": payload.updates.iter().map(|item| &item.id).collect::<Vec<_>>(),
                    "redo": payload.redo,
                }).to_string(), &authority_context, &affected_authority_paths.iter().cloned().collect::<Vec<_>>()),
                scene_id: None,
                occurred_at: &payload.updated_at,
                timestamp,
                cause_kind: if payload.redo {
                    NarrativeChangeCauseKind::Redo
                } else {
                    NarrativeChangeCauseKind::Forward
                },
                origin: if payload.redo {
                    NarrativeChangeOrigin::Redo
                } else {
                    NarrativeChangeOrigin::AiApply
                },
                original_transaction_id: payload.original_transaction_id.as_deref(),
                undo_journal_id: Some(&undo_journal_id),
                events,
            },
        )?;
        let response = json!({
            "versions": ai_tree_version_rows(&after),
            "changeEventUid": payload.request_id,
            "maintenanceTransactionId": maintenance_transaction_id,
            "undoJournalId": undo_journal_id,
        });
        insert_idempotent_response(&tx, &idempotency_request, &payload.project_id, &response)?;
        tx.commit()?;
        Ok(response)
    })
}

pub fn undo_ai_tree_plan(db: &Database, payload: UndoAiTreePlanPayload) -> anyhow::Result<Value> {
    for (value, field) in [
        (&payload.request_id, "requestId"),
        (&payload.project_id, "projectId"),
        (&payload.session_id, "sessionId"),
        (&payload.updated_at, "updatedAt"),
        (&payload.original_transaction_id, "originalTransactionId"),
        (&payload.undo_journal_id, "undoJournalId"),
    ] {
        require_non_empty(value, field)?;
    }
    let authority_context = ai_tree_undo_authority_context(&payload)?;
    let mut normalized = payload.clone();
    normalized.session_id.clear();
    let request_hash = payload_fingerprint("ai_tree_plan_undo", &normalized)?;
    let idempotency_request = IdempotencyRequest {
        domain: "ai_tree_plan_undo",
        request_id: Some(&payload.request_id),
        payload_hash: &request_hash,
        conflict_marker: "AI_TREE_PLAN_UNDO_REQUEST_CONFLICT",
    };
    let expected_versions = payload
        .expected_versions
        .iter()
        .map(|entry| (entry.id.as_str(), entry.version))
        .collect::<BTreeMap<_, _>>();
    anyhow::ensure!(
        expected_versions.len() == payload.expected_versions.len(),
        "AI tree plan expectedVersions ids must be unique"
    );
    let timestamp = event_timestamp(&payload.updated_at);
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(response) = load_idempotent_response(&tx, &idempotency_request)? {
            tx.commit()?;
            return Ok(response);
        }
        validate_ai_tree_lineage(
            &tx,
            &payload.project_id,
            &payload.original_transaction_id,
            &payload.undo_journal_id,
        )?;
        let before_json: String = tx.query_row(
            "SELECT before_json FROM undo_journal WHERE id = ?1 AND project_id = ?2",
            params![payload.undo_journal_id, payload.project_id],
            |row| row.get(0),
        )?;
        let journal: AiTreePlanJournal = serde_json::from_str(&before_json)?;
        let restored_ids = journal
            .updated_before
            .iter()
            .map(|snapshot| {
                snapshot
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("AI tree plan journal snapshot has no id"))
            })
            .collect::<anyhow::Result<BTreeSet<_>>>()?;
        let affected_ids = journal
            .created_ids
            .iter()
            .map(String::as_str)
            .chain(restored_ids.iter().copied())
            .collect::<BTreeSet<_>>();
        anyhow::ensure!(
            expected_versions.keys().copied().collect::<BTreeSet<_>>() == affected_ids,
            "AI tree plan expectedVersions must cover the exact forward result"
        );
        let mut before = BTreeMap::<String, Value>::new();
        for id in &affected_ids {
            let snapshot = select_tree_node(&tx, &payload.project_id, id)?;
            anyhow::ensure!(
                snapshot.get("version").and_then(Value::as_i64)
                    == expected_versions.get(id).copied(),
                "AI_TREE_PLAN_VERSION_MISMATCH: node '{}' changed before undo",
                id
            );
            before.insert((*id).to_string(), snapshot);
        }
        let mut before_live_scene_subtree_counts = BTreeMap::<String, i64>::new();
        for (id, snapshot) in &before {
            if snapshot.get("nodeType").and_then(Value::as_str) == Some("folder") {
                before_live_scene_subtree_counts.insert(
                    id.clone(),
                    live_scene_subtree_count(&tx, &payload.project_id, id)?,
                );
            }
        }

        let mut after = BTreeMap::<String, Value>::new();
        for snapshot in &journal.updated_before {
            let id = snapshot
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("AI tree plan journal snapshot has no id"))?;
            let parent_id = match snapshot.get("parentId") {
                None | Some(Value::Null) => None,
                Some(Value::String(parent_id)) => Some(parent_id.as_str()),
                _ => anyhow::bail!("AI tree plan journal has an invalid parentId"),
            };
            if let Some(parent_id) = parent_id {
                ensure_tree_parent_in_project(&tx, &payload.project_id, parent_id)?;
            }
            let sort_order = snapshot
                .get("sortOrder")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("AI tree plan journal has no sortOrder"))?;
            let title = snapshot
                .get("title")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("AI tree plan journal has no title"))?;
            let changed = tx.execute(
                "UPDATE tree_nodes
                    SET parent_id = ?1, sort_order = ?2, title = ?3,
                        updated_at = ?4, version = version + 1
                  WHERE id = ?5 AND project_id = ?6 AND version = ?7",
                params![
                    parent_id,
                    sort_order,
                    title,
                    payload.updated_at,
                    id,
                    payload.project_id,
                    expected_versions[id],
                ],
            )?;
            anyhow::ensure!(changed == 1, "AI_TREE_PLAN_VERSION_MISMATCH during undo");
            after.insert(
                id.to_string(),
                select_tree_node(&tx, &payload.project_id, id)?,
            );
        }
        for id in journal.created_ids.iter().rev() {
            let deleted = tx.execute(
                "DELETE FROM tree_nodes WHERE id = ?1 AND project_id = ?2 AND version = ?3",
                params![id, payload.project_id, expected_versions[id.as_str()]],
            )?;
            anyhow::ensure!(
                deleted == 1,
                "AI_TREE_PLAN_VERSION_MISMATCH: created node '{}' changed before undo",
                id
            );
        }

        let mut events = Vec::new();
        for id in &affected_ids {
            match (before.get(*id), after.get(*id)) {
                (Some(before), Some(after)) => {
                    let live_scene_subtree_impact =
                        if after.get("nodeType").and_then(Value::as_str) == Some("folder") {
                            Some((
                                before_live_scene_subtree_counts
                                    .get(*id)
                                    .copied()
                                    .unwrap_or_default(),
                                live_scene_subtree_count(&tx, &payload.project_id, id)?,
                            ))
                        } else {
                            None
                        };
                    events.push(tree_feed_event(
                        id,
                        Some(before),
                        Some(after),
                        "order",
                        "update",
                        vec![
                            "/parentId".to_string(),
                            "/sortOrder".to_string(),
                            "/title".to_string(),
                        ],
                        live_scene_subtree_impact,
                    )?)
                }
                (Some(before), None) => {
                    let live_scene_subtree_impact =
                        if before.get("nodeType").and_then(Value::as_str) == Some("folder") {
                            Some((
                                before_live_scene_subtree_counts
                                    .get(*id)
                                    .copied()
                                    .unwrap_or_default(),
                                0,
                            ))
                        } else {
                            None
                        };
                    events.push(tree_feed_event(
                        id,
                        Some(before),
                        None,
                        if before.get("nodeType").and_then(Value::as_str) == Some("scene") {
                            "content"
                        } else {
                            "metadata"
                        },
                        "delete",
                        vec!["/".to_string()],
                        live_scene_subtree_impact,
                    )?)
                }
                _ => anyhow::bail!("AI tree plan undo produced an incomplete state"),
            }
        }
        let entity_id: String = tx.query_row(
            "SELECT entity_id FROM undo_journal WHERE id = ?1 AND project_id = ?2",
            params![payload.undo_journal_id, payload.project_id],
            |row| row.get(0),
        )?;
        let maintenance_transaction_id = append_tree_feed(
            &tx,
            TreeFeedAppend {
                project_id: &payload.project_id,
                request_id: &payload.request_id,
                session_id: &payload.session_id,
                event_uid: &payload.request_id,
                source_domain: "tree.aiPlanUndo",
                canonical_domain: "tree",
                canonical_entity_type: "tree_plan",
                entity_id: &entity_id,
                canonical_payload: canonical_payload_with_authority_context(
                    &json!({
                        "requestId": payload.request_id,
                        "affectedIds": affected_ids,
                    })
                    .to_string(),
                    &authority_context,
                ),
                scene_id: None,
                occurred_at: &payload.updated_at,
                timestamp,
                cause_kind: NarrativeChangeCauseKind::Undo,
                origin: NarrativeChangeOrigin::Undo,
                original_transaction_id: Some(&payload.original_transaction_id),
                undo_journal_id: Some(&payload.undo_journal_id),
                events,
            },
        )?;
        let response = json!({
            "versions": ai_tree_version_rows(&after),
            "changeEventUid": payload.request_id,
            "maintenanceTransactionId": maintenance_transaction_id,
            "undoJournalId": payload.undo_journal_id,
        });
        insert_idempotent_response(&tx, &idempotency_request, &payload.project_id, &response)?;
        tx.commit()?;
        Ok(response)
    })
}

#[cfg(test)]
mod tests {

    use crate::narrative_extraction::{discover_durable_maintenance_work, AutomaticRunKind};

    use super::*;

    fn tree_create_payload(
        id: &str,
        node_type: &str,
        sort_order: &str,
        parent_id: Option<&str>,
    ) -> TreeNodeCreatePayload {
        TreeNodeCreatePayload {
            id: id.to_string(),
            project_id: "p1".to_string(),
            request_id: format!("create-{id}-request"),
            session_id: "tree-session".to_string(),
            event_uid: format!("create-{id}-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            parent_id: parent_id.map(str::to_string),
            node_type: node_type.to_string(),
            title: id.to_string(),
            sort_order: sort_order.to_string(),
            synopsis: None,
            status: None,
            source_uri: None,
            source_mtime: None,
            content: None,
            canonical_payload: None,
        }
    }

    fn tree_patch_payload(
        node_id: &str,
        patch: serde_json::Map<String, Value>,
        base_version: Option<i64>,
        updated_at: &str,
    ) -> TreeNodePatchPayload {
        TreeNodePatchPayload {
            project_id: "p1".to_string(),
            request_id: format!("patch-{node_id}-{updated_at}-request"),
            session_id: "tree-session".to_string(),
            event_uid: format!("patch-{node_id}-{updated_at}-event"),
            node_id: node_id.to_string(),
            patch,
            base_version,
            bump_version: base_version.is_some(),
            updated_at: updated_at.to_string(),
            change_event: None,
            timelapse_doc_step_coverage: None,
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            source_domain: None,
            op_type: None,
            canonical_payload: None,
        }
    }

    fn tree_delete_payload(node_id: &str) -> TreeNodeDeletePayload {
        TreeNodeDeletePayload {
            project_id: "p1".to_string(),
            request_id: format!("delete-{node_id}-request"),
            session_id: "tree-session".to_string(),
            event_uid: format!("delete-{node_id}-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            node_id: node_id.to_string(),
            canonical_payload: None,
        }
    }

    fn fixture() -> Database {
        let db = crate::test_support::current_schema_memory().expect("current schema fixture");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects (id, title) VALUES ('p1', 'One'), ('p2', 'Two');
                 INSERT OR IGNORE INTO codex_types (id, project_id, slug, label)
                   VALUES ('type-p1', 'p1', 'character', 'Character'),
                          ('type-p2', 'p2', 'character', 'Character');
                 INSERT INTO tree_nodes
                   (id, project_id, node_type, title, sort_order)
                   VALUES
                   ('root', 'p1', 'folder', 'Root', 'a0'),
                   ('created-parent', 'p1', 'folder', 'Created parent', 'a1'),
                   ('moved', 'p1', 'scene', 'Moved', 'a0'),
                   ('foreign-node', 'p2', 'scene', 'Foreign', 'a0');
                 INSERT INTO codex_entries (id, project_id, type, name)
                   VALUES ('c1', 'p1', 'character', 'One'),
                          ('foreign-codex', 'p2', 'character', 'Foreign');
                 INSERT INTO codex_detail_definitions
                   (id, project_id, type_slug, name)
                   VALUES ('d1', 'p1', 'character', 'One detail'),
                          ('d2', 'p2', 'character', 'Foreign detail');
                 INSERT INTO codex_detail_values
                   (id, entry_id, definition_id, value)
                   VALUES ('value-cross-project', 'c1', 'd2', 'Original');
                 INSERT INTO snippets (id, project_id, title, content)
                   VALUES ('s1', 'p1', 'Snippet', '{}');
                 INSERT INTO codex_tags (id, project_id, name, color)
                   VALUES ('tag-b', 'p1', 'Beta', '#222'),
                          ('tag-a', 'p1', 'Alpha', NULL),
                          ('tag-x', 'p2', 'Foreign', NULL);",
            )?;
            Ok(())
        })
        .expect("seed database");
        db
    }

    fn seed_ai_tree_authority(db: &Database, node_id: &str) {
        db.with_conn(|conn| {
            for path in [
                "/parentId",
                "/nodeType",
                "/title",
                "/sortOrder",
                "/synopsis",
            ] {
                conn.execute(
                    "INSERT INTO narrative_field_authority
                        (project_id, entity_kind, entity_id, field_path, owner_kind,
                         explicit_lock, version, updated_at)
                     VALUES ('p1', 'tree_node', ?1, ?2, 'ai', 0, 0, 'fixture')",
                    rusqlite::params![node_id, path],
                )?;
            }
            Ok(())
        })
        .expect("seed AI tree field authority");
    }

    fn project_create_payload(project_id: &str, request_id: &str) -> ProjectCreatePayload {
        ProjectCreatePayload {
            project_id: project_id.to_string(),
            request_id: request_id.to_string(),
            session_id: "project-session".to_string(),
            event_uid: format!("{request_id}-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            title: "New project".to_string(),
            genre: Some("Fantasy".to_string()),
            pov: None,
            tense: None,
            language: Some("en".to_string()),
            style_guide: None,
            ai_instructions: None,
            outline: None,
            target_readers: None,
            created_at: "2026-08-13T00:00:00.000Z".to_string(),
            updated_at: "2026-08-13T00:00:00.000Z".to_string(),
        }
    }

    fn scan_publish_payload(
        project_id: &str,
        request_id: &str,
        event_uid: &str,
    ) -> ScanStagingProjectPublishPayload {
        ScanStagingProjectPublishPayload {
            project_id: project_id.to_string(),
            request_id: request_id.to_string(),
            session_id: "scan-session".to_string(),
            event_uid: event_uid.to_string(),
            origin: NarrativeChangeOrigin::Import,
            original_transaction_id: None,
            undo_journal_id: None,
        }
    }

    fn scan_publish_side_effect_counts(
        db: &Database,
        project_id: &str,
        request_id: &str,
    ) -> (i64, i64, i64, i64) {
        db.with_conn(|conn| {
            conn.query_row(
                "SELECT
                   (SELECT COUNT(*) FROM change_events
                     WHERE project_id = ?1 AND op_type = 'scan.import.publish'),
                   (SELECT COUNT(*) FROM narrative_change_transactions
                     WHERE project_id = ?1 AND source_domain = 'scan.import.publish'),
                   (SELECT COUNT(*) FROM narrative_semantic_epochs
                     WHERE project_id = ?1),
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE domain = 'scan_staging_project_publish' AND request_id = ?2)",
                params![project_id, request_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(Into::into)
        })
        .expect("inspect Scan publish side effects")
    }

    fn project_patch_payload(
        project_id: &str,
        request_id: &str,
        base_updated_at: &str,
        updated_at: &str,
    ) -> ProjectPatchPayload {
        ProjectPatchPayload {
            project_id: project_id.to_string(),
            request_id: request_id.to_string(),
            session_id: "project-session".to_string(),
            event_uid: format!("{request_id}-event"),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            base_updated_at: base_updated_at.to_string(),
            updated_at: updated_at.to_string(),
            patch: serde_json::Map::from_iter([
                (
                    "styleGuide".to_string(),
                    Value::String("clear and vivid".to_string()),
                ),
                (
                    "aiPolicy".to_string(),
                    Value::String("{\"preset\":\"review-only\"}".to_string()),
                ),
            ]),
        }
    }

    #[test]
    fn project_create_publishes_builtin_catalog_once_in_deterministic_order() {
        let db = fixture();
        let payload = project_create_payload("project-create", "project-create-request");
        let response = project_create(&db, payload.clone()).expect("create project");
        assert_eq!(response["id"], "project-create");
        assert_eq!(response["language"], "en");
        assert_eq!(response["title"], "New project");
        assert!(response["__writeReceipt"]["maintenanceTransactionId"]
            .as_str()
            .is_some());

        let mut retry = payload;
        retry.session_id = "project-session-after-restart".to_string();
        retry.event_uid = "project-event-after-restart".to_string();
        let replay = project_create(&db, retry).expect("retry project create");
        assert_eq!(replay, response);

        db.with_conn(|conn| {
            let project_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM projects WHERE id = 'project-create'",
                [],
                |row| row.get(0),
            )?;
            let canonical_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM change_events
                  WHERE project_id = 'project-create' AND op_type = 'project.create'",
                [],
                |row| row.get(0),
            )?;
            let transaction_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE project_id = 'project-create'
                    AND request_id = 'project-create-request'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(project_count, 1);
            assert_eq!(canonical_count, 1);
            assert_eq!(transaction_count, 1);
            let epoch_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE project_id = 'project-create'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(epoch_count, 0, "pre-cutover creation must not mint an Epoch");

            let mut statement = conn.prepare(
                "SELECT type.slug, type.label, event.event_ordinal,
                        json_extract(event.object_key_json, '$.componentId')
                   FROM narrative_change_events event
                   JOIN codex_types type
                     ON type.id = substr(
                          json_extract(event.object_key_json, '$.componentId'),
                          length('codex-type:') + 1
                        )
                  WHERE event.project_id = 'project-create'
                  ORDER BY event.event_ordinal",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(
                rows,
                vec![
                    (
                        "character".to_string(),
                        "Character".to_string(),
                        0,
                        "codex-type:project-create-character".to_string(),
                    ),
                    (
                        "location".to_string(),
                        "Location".to_string(),
                        1,
                        "codex-type:project-create-location".to_string(),
                    ),
                    (
                        "item".to_string(),
                        "Item".to_string(),
                        2,
                        "codex-type:project-create-item".to_string(),
                    ),
                    (
                        "lore".to_string(),
                        "Lore & Worldbuilding".to_string(),
                        3,
                        "codex-type:project-create-lore".to_string(),
                    ),
                ]
            );
            Ok(())
        })
        .expect("verify project history");
    }

    #[test]
    fn project_create_mints_one_event_bound_initial_epoch_after_c2zc_marker() {
        let db = fixture();
        db.with_conn(|conn| Database::record_c2zc_cutover_marker(conn, "2026-08-25T00:00:00.000Z"))
            .expect("activate marker fixture");

        let payload = project_create_payload("project-c2zc-birth", "project-c2zc-birth-request");
        let response = project_create(&db, payload.clone()).expect("create post-marker project");
        assert_eq!(response["id"], "project-c2zc-birth");

        let mut replay_payload = payload;
        replay_payload.session_id = "project-c2zc-birth-replay-session".to_string();
        replay_payload.event_uid = "project-c2zc-birth-replay-event".to_string();
        let replay = project_create(&db, replay_payload).expect("idempotent project replay");
        assert_eq!(replay, response);

        db.with_conn(|conn| {
            let epochs = conn
                .prepare(
                    "SELECT epoch_number, reason, triggered_by_change_event_uid
                       FROM narrative_semantic_epochs
                      WHERE project_id = ?1
                      ORDER BY epoch_number ASC",
                )?
                .query_map(["project-c2zc-birth"], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(
                epochs,
                vec![(
                    0,
                    "initial".to_string(),
                    Some("project-c2zc-birth-request-event".to_string()),
                )]
            );
            Ok(())
        })
        .expect("verify birth epoch");
    }

    #[test]
    fn project_create_fails_atomically_for_an_unsupported_c2zc_marker() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![
                    Database::C2_ZC_CUTOVER_MIGRATION_ID,
                    Database::C2_ZC_CUTOVER_CONTRACT_VERSION + 1,
                    "2026-08-25T00:00:00.000Z",
                ],
            )?;
            Ok(())
        })
        .expect("seed unsupported marker fixture");

        let error = project_create(
            &db,
            project_create_payload(
                "project-c2zc-unsupported",
                "project-c2zc-unsupported-request",
            ),
        )
        .expect_err("reject unsupported marker before project commit");
        assert!(error
            .to_string()
            .contains("NEX_C2ZC_PROJECT_BIRTH_MARKER_UNSUPPORTED"));

        db.with_conn(|conn| {
            let project_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM projects WHERE id = 'project-c2zc-unsupported'",
                [],
                |row| row.get(0),
            )?;
            let event_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM change_events WHERE project_id = 'project-c2zc-unsupported'",
                [],
                |row| row.get(0),
            )?;
            let epoch_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_semantic_epochs WHERE project_id = 'project-c2zc-unsupported'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!((project_count, event_count, epoch_count), (0, 0, 0));
            Ok(())
        })
        .expect("verify failed creation rolled back");
    }

    #[test]
    fn project_create_conflict_is_fail_closed() {
        let db = fixture();
        let payload = project_create_payload("project-conflict", "project-conflict-request");
        project_create(&db, payload.clone()).expect("create project");
        let mut conflicting = payload;
        conflicting.title = "Different title".to_string();
        let error = project_create(&db, conflicting).expect_err("reject request conflict");
        assert!(error
            .to_string()
            .contains("PROJECT_CREATE_REQUEST_CONFLICT"));
    }

    #[test]
    fn project_patch_is_atomic_idempotent_and_publishes_semantic_paths() {
        let db = fixture();
        let created = project_create(
            &db,
            project_create_payload("project-patch", "project-patch-create"),
        )
        .expect("create project");
        let base_updated_at = created["updatedAt"].as_str().expect("created timestamp");
        let payload = project_patch_payload(
            "project-patch",
            "project-patch-request",
            base_updated_at,
            "2026-08-13T00:00:01.000Z",
        );
        let response = project_patch(&db, payload.clone()).expect("patch project");
        assert_eq!(response["styleGuide"], "clear and vivid");
        assert_eq!(response["aiPolicy"], "{\"preset\":\"review-only\"}");

        let replay = project_patch(&db, payload).expect("replay project patch");
        assert_eq!(replay, response);

        db.with_conn(|conn| {
            let (object_key, paths, change_kind): (String, String, String) = conn.query_row(
                "SELECT object_key_json, changed_paths_json, change_kind
                   FROM narrative_change_events
                  WHERE canonical_change_event_uid = 'project-patch-request-event'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(
                serde_json::from_str::<Value>(&object_key)?,
                json!({ "kind": "project", "projectId": "project-patch" })
            );
            assert_eq!(
                serde_json::from_str::<Value>(&paths)?,
                json!(["/aiPolicy", "/styleGuide"])
            );
            assert_eq!(change_kind, "policy");
            let feed_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_events
                  WHERE canonical_change_event_uid = 'project-patch-request-event'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(feed_count, 1);
            Ok(())
        })
        .expect("inspect project patch feed");

        let stale = project_patch_payload(
            "project-patch",
            "project-patch-stale",
            base_updated_at,
            "2026-08-13T00:00:02.000Z",
        );
        let error = project_patch(&db, stale).expect_err("stale patch must fail closed");
        assert!(error.to_string().contains("PROJECT_VERSION_MISMATCH"));
    }

    #[test]
    fn project_create_feed_failure_rolls_back_project_and_trigger_rows() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_project_create_feed
                   BEFORE INSERT ON narrative_change_transactions
                   BEGIN SELECT RAISE(ABORT, 'forced project create feed failure'); END;",
            )?;
            Ok(())
        })
        .expect("install feed failure trigger");

        let result = project_create(
            &db,
            project_create_payload("project-rollback", "project-rollback-request"),
        );
        assert!(result.is_err());
        db.with_conn(|conn| {
            for (table, predicate) in [
                ("projects", "id = 'project-rollback'"),
                ("codex_types", "project_id = 'project-rollback'"),
                ("map_boards", "project_id = 'project-rollback'"),
                ("change_events", "project_id = 'project-rollback'"),
                (
                    "idempotency_requests",
                    "request_id = 'project-rollback-request'",
                ),
            ] {
                let count: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE {predicate}"),
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 0, "{table} should roll back");
            }
            Ok(())
        })
        .expect("verify project rollback");
    }

    fn seed_rename_lineage(db: &Database, suffix: &str) -> (String, String) {
        let undo_journal_id = format!("rename-journal-{suffix}");
        let change_event_uid = format!("rename-forward-event-{suffix}");
        let request_id = format!("rename-forward-request-{suffix}");
        let transaction_id = db
            .with_conn(|conn| {
                let tx = conn.unchecked_transaction()?;
                let canonical_entry =
                    crate::canonical_feed_snapshots::canonical_codex_entry_snapshot(
                        &tx, "p1", "c1",
                    )?;
                let canonical_digest = narrative_snapshot_digest(&canonical_entry)?;
                let canonical_version = canonical_entry.get("version").and_then(Value::as_i64);
                crate::undo_journal::insert_undo_journal_in_tx(
                    &tx,
                    crate::undo_journal::UndoJournalInsert {
                        id: &undo_journal_id,
                        project_id: "p1",
                        surface: "rename-test",
                        entity_kind: "codex_rename",
                        entity_id: "c1",
                        op_kind: "codex.renamePropagate",
                        before_json: None,
                        after_json: Some("{}"),
                        base_version: 0,
                        result_version: 1,
                        change_event_uid: Some(&change_event_uid),
                    },
                )?;
                let append = append_canonical_and_narrative_change_in_tx(
                    &tx,
                    "p1",
                    "rename-test",
                    &AppendChangeEvent {
                        event_uid: change_event_uid.clone(),
                        scene_id: None,
                        domain: "codex".to_string(),
                        op_type: "codex.renamePropagate".to_string(),
                        entity_type: Some("codex_entry".to_string()),
                        entity_id: Some("c1".to_string()),
                        payload: "{}".to_string(),
                        timestamp: 1,
                    },
                    &AppendNarrativeChangeTransactionInput {
                        project_id: "p1".to_string(),
                        request_id,
                        source_domain: "codex.renamePropagate".to_string(),
                        source_change_event_uid: change_event_uid,
                        cause_kind: NarrativeChangeCauseKind::Forward,
                        origin: NarrativeChangeOrigin::Human,
                        original_transaction_id: None,
                        commit_id: None,
                        journal_id: None,
                        undo_journal_id: Some(undo_journal_id.clone()),
                        application_ids: Vec::new(),
                        occurred_at: "2026-08-13T00:00:00Z".to_string(),
                        events: vec![NarrativeChangeEventInput {
                            object_key: json!({ "kind": "codex-entry", "entryId": "c1" }),
                            change_kind: "metadata".to_string(),
                            mutation_kind: "update".to_string(),
                            before_version: canonical_version,
                            before_digest: Some(canonical_digest.clone()),
                            after_version: canonical_version,
                            after_digest: Some(canonical_digest),
                            changed_paths: vec!["/name".to_string()],
                            text_impact: None,
                            structural_impact: None,
                        }],
                    },
                )?;
                tx.commit()?;
                Ok(append.narrative.transaction_id)
            })
            .expect("seed rename lineage");
        (transaction_id, undo_journal_id)
    }

    fn ai_tree_payload(request_id: &str) -> ApplyAiTreePlanPayload {
        ApplyAiTreePlanPayload {
            request_id: request_id.to_string(),
            project_id: "p1".to_string(),
            session_id: "ai-tree-session".to_string(),
            surface: "in-app-agent".to_string(),
            kind: "reorganize".to_string(),
            updated_at: "2026-08-13T01:00:00Z".to_string(),
            model: Some("model-1".to_string()),
            trace_id: Some("trace-1".to_string()),
            authority_route: "interactive-agent-command".to_string(),
            caller: "chat-tool-executor".to_string(),
            controls: vec![
                "knowledge-write-policy".to_string(),
                "stable-request-id".to_string(),
                "agent-provenance".to_string(),
                "field-authority".to_string(),
                "typed-writer".to_string(),
                "occ".to_string(),
                "undo-journal".to_string(),
                "change-event".to_string(),
                "change-feed".to_string(),
            ],
            provenance: Some(RendererMutationProvenance {
                request_id: request_id.to_string(),
                trace_id: "trace-1".to_string(),
                chat_message_id: None,
                tool_call_id: None,
                execution_id: None,
                main_owned_provenance_id: None,
            }),
            writes_authority_protected_field: false,
            creates: vec![AiTreePlanCreateInput {
                temp_id: Some("tmp:folder".to_string()),
                id: "ai-folder".to_string(),
                parent_id: Some("root".to_string()),
                node_type: "folder".to_string(),
                title: "AI Folder".to_string(),
                sort_order: "a0".to_string(),
                synopsis: None,
            }],
            updates: vec![AiTreePlanUpdateInput {
                id: "moved".to_string(),
                base_version: 0,
                placement: Some(AiTreePlanPlacementInput {
                    parent_id: Some("ai-folder".to_string()),
                    sort_order: "a0".to_string(),
                }),
                title: Some("Moved by AI".to_string()),
            }],
            ops: Some(vec![
                json!({
                    "op": "create",
                    "tempId": "tmp:folder",
                    "parentRef": "root",
                    "nodeType": "folder",
                    "title": "AI Folder",
                    "pos": {},
                }),
                json!({
                    "op": "move",
                    "nodeId": "moved",
                    "newParentRef": "tmp:folder",
                    "pos": {},
                }),
                json!({
                    "op": "rename",
                    "nodeId": "moved",
                    "title": "Moved by AI",
                }),
            ]),
            redo: false,
            original_transaction_id: None,
            undo_journal_id: None,
        }
    }

    #[test]
    fn ai_tree_plan_is_atomic_idempotent_ordered_and_preserves_undo_redo_lineage() {
        let db = fixture();
        seed_ai_tree_authority(&db, "moved");
        let payload = ai_tree_payload("ai-tree-forward-request");
        let forward = apply_ai_tree_plan(&db, payload.clone()).expect("apply AI tree plan");
        let original_transaction_id = forward["maintenanceTransactionId"]
            .as_str()
            .expect("forward transaction")
            .to_string();
        let undo_journal_id = forward["undoJournalId"]
            .as_str()
            .expect("undo journal")
            .to_string();
        assert_eq!(undo_journal_id, "ai-tree-forward-request");
        assert_eq!(forward["versions"].as_array().map(Vec::len), Some(2));

        let mut retry = payload.clone();
        retry.session_id = "session-after-restart".to_string();
        assert_eq!(
            apply_ai_tree_plan(&db, retry).expect("idempotent retry"),
            forward
        );
        db.with_conn(|conn| {
            let moved: (Option<String>, String, i64) = conn.query_row(
                "SELECT parent_id, title, version FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(moved, (Some("ai-folder".to_string()), "Moved by AI".to_string(), 1));
            let counts: (i64, i64, i64, i64) = conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM change_events WHERE event_uid = 'ai-tree-forward-request'),
                    (SELECT COUNT(*) FROM narrative_change_transactions
                      WHERE request_id = 'ai-tree-forward-request'),
                    (SELECT COUNT(*) FROM narrative_change_events event
                      JOIN narrative_change_transactions tx ON tx.id = event.transaction_id
                     WHERE tx.request_id = 'ai-tree-forward-request'),
                    (SELECT COUNT(*) FROM undo_journal WHERE id = 'ai-tree-forward-request')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(counts, (1, 1, 2, 1));
            let created_authority: (i64, i64) = conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM narrative_field_authority
                      WHERE project_id = 'p1' AND entity_kind = 'tree_node'
                        AND entity_id = 'ai-folder' AND owner_kind = 'ai'),
                    (SELECT COUNT(*) FROM narrative_field_authority
                      WHERE project_id = 'p1' AND entity_kind = 'tree_node'
                        AND entity_id = 'moved' AND owner_kind = 'ai')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(created_authority, (5, 5));
            let canonical_payload: String = conn.query_row(
                "SELECT payload FROM change_events WHERE event_uid = 'ai-tree-forward-request'",
                [],
                |row| row.get(0),
            )?;
            let canonical_payload: Value = serde_json::from_str(&canonical_payload)?;
            assert_eq!(canonical_payload["authorityRoute"], "interactive-agent-command");
            assert_eq!(canonical_payload["authorityCaller"], "chat-tool-executor");
            assert_eq!(canonical_payload["authorityEvidence"]["status"], "validated");
            let event_order = conn
                .prepare(
                    "SELECT event.object_key_json
                       FROM narrative_change_events event
                       JOIN narrative_change_transactions tx ON tx.id = event.transaction_id
                      WHERE tx.request_id = 'ai-tree-forward-request'
                      ORDER BY event.event_ordinal",
                )?
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert!(event_order[0].contains("ai-folder"));
            assert!(event_order[1].contains("moved"));
            Ok(())
        })
        .expect("verify forward state");

        let undo = undo_ai_tree_plan(
            &db,
            UndoAiTreePlanPayload {
                request_id: "ai-tree-undo-request".to_string(),
                project_id: "p1".to_string(),
                session_id: "ai-tree-session".to_string(),
                updated_at: "2026-08-13T01:01:00Z".to_string(),
                original_transaction_id: original_transaction_id.clone(),
                undo_journal_id: undo_journal_id.clone(),
                authority_route: "history-replay".to_string(),
                caller: "history-controller".to_string(),
                controls: vec![
                    "original-transaction".to_string(),
                    "journal-lineage".to_string(),
                    "typed-writer".to_string(),
                    "occ".to_string(),
                    "change-event".to_string(),
                    "change-feed".to_string(),
                ],
                provenance: None,
                writes_authority_protected_field: false,
                expected_versions: vec![
                    AiTreeNodeVersionInput {
                        id: "ai-folder".to_string(),
                        version: 1,
                    },
                    AiTreeNodeVersionInput {
                        id: "moved".to_string(),
                        version: 1,
                    },
                ],
            },
        )
        .expect("undo AI tree plan");
        assert_eq!(undo["versions"][0]["id"], "moved");
        assert_eq!(undo["versions"][0]["version"], 2);

        let mut forged_redo = payload.clone();
        forged_redo.request_id = "ai-tree-forged-redo-request".to_string();
        forged_redo.updated_at = "2026-08-13T01:01:30Z".to_string();
        forged_redo.updates[0].base_version = 2;
        forged_redo.updates[0].title = Some("Forged redo title".to_string());
        forged_redo.redo = true;
        forged_redo.original_transaction_id = Some(original_transaction_id.clone());
        forged_redo.undo_journal_id = Some(undo_journal_id.clone());
        forged_redo.authority_route = "history-replay".to_string();
        forged_redo.caller = "history-controller".to_string();
        forged_redo.controls = vec![
            "original-transaction".to_string(),
            "journal-lineage".to_string(),
            "typed-writer".to_string(),
            "occ".to_string(),
            "change-event".to_string(),
            "change-feed".to_string(),
        ];
        forged_redo.provenance = None;
        let error = apply_ai_tree_plan(&db, forged_redo)
            .expect_err("redo must replay the exact forward plan");
        assert!(error.to_string().contains("redo"));

        let mut redo = payload;
        redo.request_id = "ai-tree-redo-request".to_string();
        redo.updated_at = "2026-08-13T01:02:00Z".to_string();
        redo.updates[0].base_version = 2;
        redo.redo = true;
        redo.original_transaction_id = Some(original_transaction_id.clone());
        redo.undo_journal_id = Some(undo_journal_id);
        redo.authority_route = "history-replay".to_string();
        redo.caller = "history-controller".to_string();
        redo.controls = vec![
            "original-transaction".to_string(),
            "journal-lineage".to_string(),
            "typed-writer".to_string(),
            "occ".to_string(),
            "change-event".to_string(),
            "change-feed".to_string(),
        ];
        redo.provenance = None;
        apply_ai_tree_plan(&db, redo).expect("redo AI tree plan");

        db.with_conn(|conn| {
            let lineage = conn
                .prepare(
                    "SELECT cause_kind, origin, original_transaction_id
                       FROM narrative_change_transactions
                      WHERE request_id IN (
                        'ai-tree-forward-request', 'ai-tree-undo-request', 'ai-tree-redo-request'
                      )
                      ORDER BY source_change_event_sequence",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(
                lineage[0],
                ("forward".to_string(), "ai-apply".to_string(), None)
            );
            assert_eq!(lineage[1].0, "undo");
            assert_eq!(lineage[1].1, "undo");
            assert_eq!(lineage[2].0, "redo");
            assert_eq!(lineage[2].1, "redo");
            assert_eq!(lineage[1].2, Some(original_transaction_id.clone()));
            assert_eq!(lineage[2].2, Some(original_transaction_id.clone()));
            let moved: (Option<String>, String, i64) = conn.query_row(
                "SELECT parent_id, title, version FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(
                moved,
                (Some("ai-folder".to_string()), "Moved by AI".to_string(), 3)
            );
            Ok(())
        })
        .expect("verify undo/redo lineage");
    }

    #[test]
    fn interactive_ai_tree_plan_allows_follow_up_after_ai_create_and_denies_human_title() {
        let db = fixture();
        seed_ai_tree_authority(&db, "moved");

        let mut create = ai_tree_payload("ai-tree-create-scene");
        create.kind = "scaffold".to_string();
        create.creates[0].id = "ai-scene".to_string();
        create.creates[0].node_type = "scene".to_string();
        create.creates[0].title = "AI Scene".to_string();
        create.updates.clear();
        create.ops = Some(vec![json!({
            "op": "create",
            "tempId": "tmp:scene",
            "parentRef": "root",
            "nodeType": "scene",
            "title": "AI Scene",
            "pos": {},
        })]);
        create.creates[0].temp_id = Some("tmp:scene".to_string());
        apply_ai_tree_plan(&db, create).expect("AI scene scaffold");

        db.with_conn(|conn| {
            let rows: Vec<(String, String)> = conn
                .prepare(
                    "SELECT field_path, owner_kind
                       FROM narrative_field_authority
                      WHERE project_id = 'p1' AND entity_kind = 'tree_node'
                        AND entity_id = 'ai-scene'
                      ORDER BY field_path",
                )?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(
                rows,
                vec![
                    ("/nodeType".to_string(), "ai".to_string()),
                    ("/parentId".to_string(), "ai".to_string()),
                    ("/sortOrder".to_string(), "ai".to_string()),
                    ("/synopsis".to_string(), "ai".to_string()),
                    ("/title".to_string(), "ai".to_string()),
                ]
            );
            Ok(())
        })
        .expect("verify AI scaffold authority");

        let follow_up = ApplyAiTreePlanPayload {
            request_id: "ai-tree-follow-up".to_string(),
            project_id: "p1".to_string(),
            session_id: "ai-tree-session-follow-up".to_string(),
            surface: "in-app-agent".to_string(),
            kind: "reorganize".to_string(),
            updated_at: "2026-08-13T01:10:00Z".to_string(),
            model: Some("model-1".to_string()),
            trace_id: Some("trace-follow-up".to_string()),
            authority_route: "interactive-agent-command".to_string(),
            caller: "chat-tool-executor".to_string(),
            controls: ai_tree_payload("controls-only").controls,
            provenance: Some(RendererMutationProvenance {
                request_id: "ai-tree-follow-up".to_string(),
                trace_id: "trace-follow-up".to_string(),
                chat_message_id: None,
                tool_call_id: None,
                execution_id: None,
                main_owned_provenance_id: None,
            }),
            writes_authority_protected_field: false,
            creates: Vec::new(),
            updates: vec![AiTreePlanUpdateInput {
                id: "ai-scene".to_string(),
                base_version: 1,
                placement: Some(AiTreePlanPlacementInput {
                    parent_id: Some("created-parent".to_string()),
                    sort_order: "a0".to_string(),
                }),
                title: Some("AI Scene Renamed".to_string()),
            }],
            ops: Some(vec![
                json!({
                    "op": "move",
                    "nodeId": "ai-scene",
                    "newParentRef": "created-parent",
                    "pos": {},
                }),
                json!({
                    "op": "rename",
                    "nodeId": "ai-scene",
                    "title": "AI Scene Renamed",
                }),
            ]),
            redo: false,
            original_transaction_id: None,
            undo_journal_id: None,
        };
        apply_ai_tree_plan(&db, follow_up).expect("AI can update its created scene");

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET title = 'Human Scene', version = version + 1
                  WHERE id = 'ai-scene' AND project_id = 'p1'",
                [],
            )?;
            crate::narrative_extraction::record_human_field_write(
                conn,
                "p1",
                "tree_node",
                "ai-scene",
                &["/title"],
                "2026-08-13T01:11:00Z",
            )?;
            let owner: String = conn.query_row(
                "SELECT owner_kind FROM narrative_field_authority
                  WHERE project_id = 'p1' AND entity_kind = 'tree_node'
                    AND entity_id = 'ai-scene' AND field_path = '/title'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(owner, "human");
            Ok(())
        })
        .expect("record human title edit");

        let mut denied = ai_tree_payload("ai-tree-human-title");
        denied.creates.clear();
        denied.updates = vec![AiTreePlanUpdateInput {
            id: "ai-scene".to_string(),
            base_version: 3,
            placement: None,
            title: Some("AI Must Be Denied".to_string()),
        }];
        denied.ops = Some(vec![json!({
            "op": "rename",
            "nodeId": "ai-scene",
            "title": "AI Must Be Denied",
        })]);
        let error = apply_ai_tree_plan(&db, denied).expect_err("human title must deny AI");
        assert!(error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));
    }

    #[test]
    fn interactive_ai_tree_plan_rejects_tampered_effect_projection() {
        let db = fixture();
        let mut title_tampered = ai_tree_payload("ai-tree-tampered-title");
        title_tampered.creates[0].title = "Renderer retarget".to_string();
        let error = apply_ai_tree_plan(&db, title_tampered)
            .expect_err("creates changed without changing ops must be rejected");
        assert!(error.to_string().contains("title does not match ops"));
        assert_eq!(
            db.with_conn(|conn| Ok(conn.query_row(
                "SELECT COUNT(*) FROM tree_nodes WHERE id = 'ai-folder'",
                [],
                |row| row.get::<_, i64>(0),
            )?))
            .expect("count tree create"),
            0
        );

        let mut sort_tampered = ai_tree_payload("ai-tree-tampered-sort");
        sort_tampered.creates[0].sort_order = "a1".to_string();
        let error = apply_ai_tree_plan(&db, sort_tampered)
            .expect_err("renderer placements must be recomputed from ops");
        assert!(error.to_string().contains("placement does not match ops"));
        assert_eq!(
            db.with_conn(|conn| Ok(conn.query_row(
                "SELECT COUNT(*) FROM tree_nodes WHERE id = 'ai-folder'",
                [],
                |row| row.get::<_, i64>(0),
            )?))
            .expect("count tree create"),
            0
        );
    }

    #[test]
    fn interactive_ai_tree_plan_denies_legacy_nodes_without_authority_rows() {
        let db = fixture();
        let error = apply_ai_tree_plan(&db, ai_tree_payload("ai-tree-legacy-node"))
            .expect_err("an existing node without authority rows must be human-owned");
        assert!(error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));
        db.with_conn(|conn| {
            let moved: (Option<String>, String, i64) = conn.query_row(
                "SELECT parent_id, title, version FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(moved, (None, "Moved".to_string(), 0));
            let created: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tree_nodes WHERE id = 'ai-folder'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(created, 0);
            Ok(())
        })
        .expect("verify legacy tree denial is atomic");
    }

    #[test]
    fn ai_tree_plan_rejects_cross_project_and_rolls_back_when_feed_append_fails() {
        let db = fixture();
        seed_ai_tree_authority(&db, "moved");
        let mut cross_project = ai_tree_payload("ai-tree-cross-project");
        cross_project.updates[0].id = "foreign-node".to_string();
        let error = apply_ai_tree_plan(&db, cross_project)
            .expect_err("foreign project node must be rejected");
        assert!(error.to_string().contains("not found in project 'p1'"));
        assert_eq!(
            db.with_conn(|conn| conn
                .query_row(
                    "SELECT COUNT(*) FROM tree_nodes WHERE id = 'ai-folder'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(Into::into))
                .expect("count rolled back create"),
            0
        );

        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_ai_tree_feed
                   BEFORE INSERT ON narrative_change_transactions
                   BEGIN SELECT RAISE(ABORT, 'forced AI tree feed failure'); END;",
            )?;
            Ok(())
        })
        .expect("install feed failure trigger");
        let error = apply_ai_tree_plan(&db, ai_tree_payload("ai-tree-feed-failure"))
            .expect_err("feed failure must abort the full plan");
        assert!(error.to_string().contains("forced AI tree feed failure"));
        db.with_conn(|conn| {
            let moved: (Option<String>, String, i64) = conn.query_row(
                "SELECT parent_id, title, version FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(moved, (None, "Moved".to_string(), 0));
            let counts: (i64, i64, i64, i64) = conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM tree_nodes WHERE id = 'ai-folder'),
                    (SELECT COUNT(*) FROM undo_journal WHERE id = 'ai-tree-feed-failure'),
                    (SELECT COUNT(*) FROM idempotency_requests
                      WHERE domain = 'ai_tree_plan_apply'
                        AND request_id = 'ai-tree-feed-failure'),
                    (SELECT COUNT(*) FROM narrative_field_authority
                      WHERE project_id = 'p1' AND entity_kind = 'tree_node'
                        AND entity_id = 'ai-folder')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(counts, (0, 0, 0, 0));
            Ok(())
        })
        .expect("verify atomic rollback");
    }

    #[test]
    fn authorship_replace_is_atomic_and_owner_scoped() {
        let db = fixture();
        let payload = ReplaceAuthorshipLanePayload {
            lane: AuthorshipOwnerLane::Node {
                node_id: "moved".to_string(),
            },
            spans: vec![AuthorshipSpanInput {
                id: "span-1".to_string(),
                from_pos: 1,
                to_pos: 3,
                source: "ai".to_string(),
                model: Some("model".to_string()),
                timestamp: Some("now".to_string()),
                chat_msg_id: None,
                trace_id: None,
            }],
        };
        replace_authorship_lane(&db, payload).expect("replace spans");
        db.with_conn(|conn| {
            let owner: String = conn.query_row(
                "SELECT node_id FROM authorship_spans WHERE id = 'span-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(owner, "moved");
            Ok(())
        })
        .expect("read span");
    }

    #[test]
    fn entity_tags_are_sorted_and_cross_project_tags_roll_back() {
        let db = fixture();
        let payload = SetEntityTagsPayload {
            project_id: "p1".to_string(),
            request_id: "tags-request-1".to_string(),
            session_id: "tags-session".to_string(),
            event_uid: "tags-event-1".to_string(),
            origin: NarrativeChangeOrigin::Human,
            original_transaction_id: None,
            undo_journal_id: None,
            entity_kind: "codex".to_string(),
            entity_id: "c1".to_string(),
            tag_ids: vec!["tag-b".to_string(), "tag-a".to_string()],
            updated_at: Some("new".to_string()),
        };
        set_entity_tags(&db, payload.clone()).expect("set tags");
        let mut retry = payload;
        retry.session_id = "tags-session-after-restart".to_string();
        retry.event_uid = "tags-event-after-restart".to_string();
        set_entity_tags(&db, retry).expect("retry tags");
        assert!(set_entity_tags(
            &db,
            SetEntityTagsPayload {
                project_id: "p2".to_string(),
                request_id: "tags-request-wrong-project".to_string(),
                session_id: "tags-session".to_string(),
                event_uid: "tags-event-wrong-project".to_string(),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                entity_kind: "codex".to_string(),
                entity_id: "c1".to_string(),
                tag_ids: vec!["tag-a".to_string()],
                updated_at: Some("newer".to_string()),
            },
        )
        .is_err());
        assert!(set_entity_tags(
            &db,
            SetEntityTagsPayload {
                project_id: "p1".to_string(),
                request_id: "tags-request-2".to_string(),
                session_id: "tags-session".to_string(),
                event_uid: "tags-event-2".to_string(),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                entity_kind: "codex".to_string(),
                entity_id: "c1".to_string(),
                tag_ids: vec!["tag-x".to_string()],
                updated_at: Some("newer".to_string()),
            },
        )
        .is_err());
        db.with_conn(|conn| {
            let cache: String = conn.query_row(
                "SELECT tags_cache FROM codex_entries WHERE id = 'c1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(
                cache,
                r##"[{"name":"Alpha","color":null},{"name":"Beta","color":"#222"}]"##
            );
            let feed_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE project_id = 'p1' AND request_id = 'tags-request-1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(feed_count, 1);
            Ok(())
        })
        .expect("read cache");
    }

    #[test]
    fn entity_tags_feed_failure_rolls_back_links_and_cache() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_tags_feed
                   BEFORE INSERT ON narrative_change_transactions
                   BEGIN SELECT RAISE(ABORT, 'forced tags feed failure'); END;",
            )?;
            Ok(())
        })
        .expect("install failure trigger");
        let result = set_entity_tags(
            &db,
            SetEntityTagsPayload {
                project_id: "p1".to_string(),
                request_id: "tags-request-failure".to_string(),
                session_id: "tags-session".to_string(),
                event_uid: "tags-event-failure".to_string(),
                origin: NarrativeChangeOrigin::Human,
                original_transaction_id: None,
                undo_journal_id: None,
                entity_kind: "codex".to_string(),
                entity_id: "c1".to_string(),
                tag_ids: vec!["tag-a".to_string()],
                updated_at: Some("new".to_string()),
            },
        );
        assert!(result.is_err());
        db.with_conn(|conn| {
            let link_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM codex_entry_tags WHERE entry_id = 'c1'",
                [],
                |row| row.get(0),
            )?;
            let tags_cache: Option<String> = conn.query_row(
                "SELECT tags_cache FROM codex_entries WHERE id = 'c1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(link_count, 0);
            assert_eq!(tags_cache, None);
            Ok(())
        })
        .expect("verify rollback");
    }

    #[test]
    fn scan_staging_project_and_marker_commit_together() {
        let db = fixture();
        create_scan_staging_project(
            &db,
            CreateScanStagingProjectPayload {
                id: "scan".to_string(),
                title: "Imported".to_string(),
                language: "en".to_string(),
                created_at: "now".to_string(),
            },
        )
        .expect("create staging project");
        db.with_conn(|conn| {
            let marker: String = conn.query_row(
                "SELECT value FROM project_settings
                  WHERE project_id = 'scan' AND key = 'scan.import.state'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(marker, "staging");
            Ok(())
        })
        .expect("read marker");
    }

    #[test]
    fn scan_staging_project_publish_is_atomic_and_replays_the_same_receipt_and_epoch() {
        let db = fixture();
        create_scan_staging_project(
            &db,
            CreateScanStagingProjectPayload {
                id: "scan-pre-marker".to_string(),
                title: "Imported before cutover".to_string(),
                language: "en".to_string(),
                created_at: "2026-08-30T00:00:00.000Z".to_string(),
            },
        )
        .expect("create pre-marker staging project");
        let pre_marker = scan_publish_payload(
            "scan-pre-marker",
            "scan-pre-marker-request",
            "scan-pre-marker-event",
        );
        let pre_response = publish_scan_staging_project(&db, pre_marker.clone())
            .expect("publish pre-marker staging project");
        assert_eq!(pre_response["projectId"], "scan-pre-marker");
        assert_eq!(pre_response["semanticEpochId"], Value::Null);
        assert!(pre_response["__writeReceipt"]["maintenanceTransactionId"]
            .as_str()
            .is_some());
        let pre_replay =
            publish_scan_staging_project(&db, pre_marker).expect("replay pre-marker publish");
        assert_eq!(pre_replay, pre_response);
        assert_eq!(
            scan_publish_side_effect_counts(&db, "scan-pre-marker", "scan-pre-marker-request"),
            (1, 1, 0, 1)
        );
        let pre_work = discover_durable_maintenance_work(&db, "scan-pre-marker", "before-cutover")
            .expect("discover published pre-marker project")
            .expect("published marker removal makes Scan project eligible");
        assert_eq!(pre_work.run_kind, AutomaticRunKind::Backfill);
        assert_eq!(pre_work.semantic_epoch_id, None);

        db.with_conn(|conn| Database::record_c2zc_cutover_marker(conn, "2026-08-25T00:00:00.000Z"))
            .expect("activate C2-ZC marker");
        create_scan_staging_project(
            &db,
            CreateScanStagingProjectPayload {
                id: "scan-current".to_string(),
                title: "Imported after cutover".to_string(),
                language: "ja".to_string(),
                created_at: "2026-08-30T00:01:00.000Z".to_string(),
            },
        )
        .expect("create current-marker staging project");
        let current_marker =
            scan_publish_payload("scan-current", "scan-current-request", "scan-current-event");
        let current_response = publish_scan_staging_project(&db, current_marker.clone())
            .expect("publish current-marker staging project");
        let epoch_id = current_response["semanticEpochId"]
            .as_str()
            .expect("current-marker publish returns an Epoch");
        assert!(!epoch_id.is_empty());
        let current_replay = publish_scan_staging_project(&db, current_marker)
            .expect("replay current-marker publish");
        assert_eq!(current_replay, current_response);
        assert_eq!(
            scan_publish_side_effect_counts(&db, "scan-current", "scan-current-request"),
            (1, 1, 1, 1)
        );
        db.with_conn(|conn| {
            let marker: Option<String> = conn
                .query_row(
                    "SELECT value FROM project_settings
                      WHERE project_id = 'scan-current' AND key = 'scan.import.state'",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            assert_eq!(marker, None, "marker removal is the visibility publication");
            let (event_payload, event_entity_type, event_entity_id): (String, String, String) =
                conn.query_row(
                    "SELECT payload, entity_type, entity_id FROM change_events
                      WHERE project_id = 'scan-current'
                        AND op_type = 'scan.import.publish'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            assert_eq!(event_entity_type, "project");
            assert_eq!(event_entity_id, "scan-current");
            assert_eq!(
                serde_json::from_str::<Value>(&event_payload)?,
                json!({
                    "projectId": "scan-current",
                    "requestId": "scan-current-request",
                    "sessionId": "scan-session",
                })
            );
            Ok::<_, anyhow::Error>(())
        })
        .expect("verify Scan publish ledgers");
    }

    #[test]
    fn scan_staging_project_publish_rejects_missing_or_mismatched_marker_without_authority() {
        let db = fixture();
        create_scan_staging_project(
            &db,
            CreateScanStagingProjectPayload {
                id: "scan-marker-failure".to_string(),
                title: "Marker failure".to_string(),
                language: "ja".to_string(),
                created_at: "2026-08-30T00:00:00.000Z".to_string(),
            },
        )
        .expect("create staging project");
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM project_settings
                  WHERE project_id = 'scan-marker-failure'
                    AND key = 'scan.import.state'",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("remove marker for missing-marker case");
        let missing_error = publish_scan_staging_project(
            &db,
            scan_publish_payload(
                "scan-marker-failure",
                "scan-marker-missing-request",
                "scan-marker-missing-event",
            ),
        )
        .expect_err("missing marker must remain hidden");
        assert!(missing_error
            .to_string()
            .contains("NEX_C2ZC_SCAN_PUBLISH_STAGING_MARKER_MISSING"));
        assert_eq!(
            scan_publish_side_effect_counts(
                &db,
                "scan-marker-failure",
                "scan-marker-missing-request"
            ),
            (0, 0, 0, 0)
        );

        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO project_settings (project_id, key, value)
                 VALUES ('scan-marker-failure', 'scan.import.state', 'not-staging')",
                [],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed mismatched marker");
        let mismatch_error = publish_scan_staging_project(
            &db,
            scan_publish_payload(
                "scan-marker-failure",
                "scan-marker-mismatch-request",
                "scan-marker-mismatch-event",
            ),
        )
        .expect_err("mismatched marker must remain hidden");
        assert!(mismatch_error
            .to_string()
            .contains("NEX_C2ZC_SCAN_PUBLISH_STAGING_MARKER_MISMATCH"));
        db.with_conn(|conn| {
            let marker: String = conn.query_row(
                "SELECT value FROM project_settings
                  WHERE project_id = 'scan-marker-failure'
                    AND key = 'scan.import.state'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(marker, "not-staging");
            Ok::<_, anyhow::Error>(())
        })
        .expect("verify mismatched marker remains");
        assert_eq!(
            scan_publish_side_effect_counts(
                &db,
                "scan-marker-failure",
                "scan-marker-mismatch-request"
            ),
            (0, 0, 0, 0)
        );
    }

    #[test]
    fn scan_staging_project_publish_rolls_back_for_future_marker_epoch_conflict_and_feed_failure() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO schema_data_migrations (migration_id, contract_version, applied_at)
                 VALUES (?1, ?2, ?3)",
                params![
                    Database::C2_ZC_CUTOVER_MIGRATION_ID,
                    Database::C2_ZC_CUTOVER_CONTRACT_VERSION + 1,
                    "2026-08-30T00:00:00.000Z",
                ],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed unsupported C2-ZC marker");
        create_scan_staging_project(
            &db,
            CreateScanStagingProjectPayload {
                id: "scan-future-marker".to_string(),
                title: "Future marker".to_string(),
                language: "ja".to_string(),
                created_at: "2026-08-30T00:00:00.000Z".to_string(),
            },
        )
        .expect("create future-marker staging project");
        let future_error = publish_scan_staging_project(
            &db,
            scan_publish_payload(
                "scan-future-marker",
                "scan-future-request",
                "scan-future-event",
            ),
        )
        .expect_err("future marker must fail closed");
        assert!(future_error
            .to_string()
            .contains("NEX_C2ZC_SCAN_PUBLISH_MARKER_UNSUPPORTED"));
        assert_eq!(
            scan_publish_side_effect_counts(&db, "scan-future-marker", "scan-future-request"),
            (0, 0, 0, 0)
        );

        let db = fixture();
        db.with_conn(|conn| Database::record_c2zc_cutover_marker(conn, "2026-08-25T00:00:00.000Z"))
            .expect("activate C2-ZC marker");
        create_scan_staging_project(
            &db,
            CreateScanStagingProjectPayload {
                id: "scan-epoch-conflict".to_string(),
                title: "Epoch conflict".to_string(),
                language: "ja".to_string(),
                created_at: "2026-08-30T00:00:00.000Z".to_string(),
            },
        )
        .expect("create epoch-conflict staging project");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_semantic_epochs
                    (id, project_id, epoch_number, reason, created_at)
                 VALUES ('scan-existing-epoch', 'scan-epoch-conflict', 0, 'initial', ?1)",
                ["2026-08-30T00:00:00.000Z"],
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("seed duplicate Epoch");
        let conflict_error = publish_scan_staging_project(
            &db,
            scan_publish_payload(
                "scan-epoch-conflict",
                "scan-epoch-conflict-request",
                "scan-epoch-conflict-event",
            ),
        )
        .expect_err("duplicate Epoch must fail closed");
        assert!(conflict_error
            .to_string()
            .contains("NEX_C2ZC_SCAN_PUBLISH_EPOCH_CONFLICT"));
        assert_eq!(
            scan_publish_side_effect_counts(
                &db,
                "scan-epoch-conflict",
                "scan-epoch-conflict-request"
            ),
            (0, 0, 1, 0)
        );
        db.with_conn(|conn| {
            let marker: String = conn.query_row(
                "SELECT value FROM project_settings
                  WHERE project_id = 'scan-epoch-conflict'
                    AND key = 'scan.import.state'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(marker, "staging");
            Ok::<_, anyhow::Error>(())
        })
        .expect("verify epoch-conflict project remains hidden");

        let db = fixture();
        db.with_conn(|conn| Database::record_c2zc_cutover_marker(conn, "2026-08-25T00:00:00.000Z"))
            .expect("activate C2-ZC marker");
        create_scan_staging_project(
            &db,
            CreateScanStagingProjectPayload {
                id: "scan-feed-failure".to_string(),
                title: "Feed failure".to_string(),
                language: "ja".to_string(),
                created_at: "2026-08-30T00:00:00.000Z".to_string(),
            },
        )
        .expect("create feed-failure staging project");
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_scan_publish_feed
                   BEFORE INSERT ON narrative_change_transactions
                   BEGIN SELECT RAISE(ABORT, 'forced scan publish feed failure'); END;",
            )?;
            Ok::<_, anyhow::Error>(())
        })
        .expect("install feed failure trigger");
        let feed_error = publish_scan_staging_project(
            &db,
            scan_publish_payload(
                "scan-feed-failure",
                "scan-feed-failure-request",
                "scan-feed-failure-event",
            ),
        )
        .expect_err("feed failure must roll back Scan publish");
        assert!(feed_error
            .to_string()
            .contains("forced scan publish feed failure"));
        assert_eq!(
            scan_publish_side_effect_counts(&db, "scan-feed-failure", "scan-feed-failure-request"),
            (0, 0, 0, 0)
        );
        db.with_conn(|conn| {
            let marker: String = conn.query_row(
                "SELECT value FROM project_settings
                  WHERE project_id = 'scan-feed-failure'
                    AND key = 'scan.import.state'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(marker, "staging");
            Ok::<_, anyhow::Error>(())
        })
        .expect("verify feed-failure project remains hidden");
    }

    #[test]
    fn codex_rename_undo_is_project_scoped_and_rolls_back_as_one_unit() {
        let db = fixture();
        let (original_transaction_id, undo_journal_id) = seed_rename_lineage(&db, "scope");
        let update = |ref_id: &str, value: &str| CodexRenameUndoUpdate {
            kind: "node-title".to_string(),
            ref_id: ref_id.to_string(),
            detail_definition_id: None,
            base_version: 0,
            value: value.to_string(),
            char_count: None,
            placed_beat_preview: None,
        };
        assert!(undo_codex_rename(
            &db,
            CodexRenameUndoPayload {
                request_id: "rename-undo-request-scope-fail".to_string(),
                event_uid: "rename-undo-event-scope-fail".to_string(),
                original_transaction_id: original_transaction_id.clone(),
                undo_journal_id: undo_journal_id.clone(),
                project_id: "p1".to_string(),
                updated_at: "undo".to_string(),
                updates: vec![
                    update("moved", "Restored"),
                    update("foreign-node", "Leaked"),
                ],
                session_id: Some("rename-test".to_string()),
            },
        )
        .is_err());
        db.with_conn(|conn| {
            let title: String = conn.query_row(
                "SELECT title FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(title, "Moved");
            Ok(())
        })
        .expect("verify rollback");

        undo_codex_rename(
            &db,
            CodexRenameUndoPayload {
                request_id: "rename-undo-request-scope-ok".to_string(),
                event_uid: "rename-undo-event-scope-ok".to_string(),
                original_transaction_id,
                undo_journal_id,
                project_id: "p1".to_string(),
                updated_at: "undo".to_string(),
                updates: vec![update("moved", "Restored")],
                session_id: Some("rename-test".to_string()),
            },
        )
        .expect("undo rename");
        db.with_conn(|conn| {
            let title: String = conn.query_row(
                "SELECT title FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(title, "Restored");
            Ok(())
        })
        .expect("verify undo");
    }

    #[test]
    fn codex_rename_detail_rejects_cross_project_definition() {
        let db = fixture();
        let (original_transaction_id, undo_journal_id) = seed_rename_lineage(&db, "detail-xproj");
        let result = undo_codex_rename(
            &db,
            CodexRenameUndoPayload {
                request_id: "rename-undo-request-detail-xproj".to_string(),
                event_uid: "rename-undo-event-detail-xproj".to_string(),
                original_transaction_id,
                undo_journal_id,
                project_id: "p1".to_string(),
                updated_at: "undo".to_string(),
                updates: vec![CodexRenameUndoUpdate {
                    kind: "codex-detail".to_string(),
                    ref_id: "c1".to_string(),
                    detail_definition_id: Some("d2".to_string()),
                    base_version: 0,
                    value: "Leaked".to_string(),
                    char_count: None,
                    placed_beat_preview: None,
                }],
                session_id: Some("rename-test".to_string()),
            },
        );

        assert!(result.is_err());
        db.with_conn(|conn| {
            let value: String = conn.query_row(
                "SELECT value FROM codex_detail_values
                  WHERE id = 'value-cross-project'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(value, "Original");
            Ok(())
        })
        .expect("read detail value");
    }

    #[test]
    fn codex_rename_cas_authority_and_undo_event_cover_all_storage_lanes() {
        let db = fixture();
        let (original_transaction_id, undo_journal_id) = seed_rename_lineage(&db, "lanes");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO codex_entries (id, project_id, type, name)
                   VALUES ('c2', 'p1', 'character', 'Two');
                 INSERT INTO codex_detail_values (id, entry_id, definition_id, value)
                   VALUES ('value-p1', 'c1', 'd1', 'Original detail');
                 INSERT INTO codex_relations
                   (id, project_id, from_codex_id, to_codex_id, label)
                   VALUES ('relation-p1', 'p1', 'c1', 'c2', 'Original relation');",
            )?;
            Ok(())
        })
        .expect("seed rename lanes");

        let update = |kind: &str,
                      ref_id: &str,
                      detail_definition_id: Option<&str>,
                      base_version: i64,
                      value: &str| CodexRenameUndoUpdate {
            kind: kind.to_string(),
            ref_id: ref_id.to_string(),
            detail_definition_id: detail_definition_id.map(str::to_string),
            base_version,
            value: value.to_string(),
            char_count: (kind == "scene-body").then_some(0),
            placed_beat_preview: None,
        };

        undo_codex_rename(
            &db,
            CodexRenameUndoPayload {
                request_id: "rename-undo-request-lanes".to_string(),
                event_uid: "rename-undo-event-lanes".to_string(),
                original_transaction_id: original_transaction_id.clone(),
                undo_journal_id: undo_journal_id.clone(),
                project_id: "p1".to_string(),
                updated_at: "undo".to_string(),
                updates: vec![
                    // Two writes to one aggregate use the same snapshot base
                    // and are sequenced inside the Native transaction.
                    update("scene-body", "moved", None, 0, "{}"),
                    update("node-title", "moved", None, 0, "Renamed scene"),
                    update("codex-summary", "c1", None, 0, "Summary"),
                    update("codex-content", "c1", None, 0, "{}"),
                    update("codex-detail", "c1", Some("d1"), 0, "Detail"),
                    update("codex-relation-label", "relation-p1", None, 1, "Relation"),
                ],
                session_id: Some("rename-test".to_string()),
            },
        )
        .expect("apply rename lanes");

        db.with_conn(|conn| {
            let tree_version: i64 = conn.query_row(
                "SELECT version FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| row.get(0),
            )?;
            let entry_version: i64 = conn.query_row(
                "SELECT version FROM codex_entries WHERE id = 'c1'",
                [],
                |row| row.get(0),
            )?;
            let detail_version: i64 = conn.query_row(
                "SELECT version FROM codex_detail_values WHERE id = 'value-p1'",
                [],
                |row| row.get(0),
            )?;
            let relation_version: i64 = conn.query_row(
                "SELECT version FROM codex_relations WHERE id = 'relation-p1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(tree_version, 2);
            assert_eq!(entry_version, 2);
            assert_eq!(detail_version, 1);
            assert_eq!(relation_version, 2);

            let version_chain = conn
                .prepare(
                    "SELECT event.object_key_json, event.changed_paths_json,
                            event.before_version, event.after_version
                       FROM narrative_change_events event
                       JOIN narrative_change_transactions feed_tx
                         ON feed_tx.id = event.transaction_id
                      WHERE feed_tx.request_id = 'rename-undo-request-lanes'
                      ORDER BY event.event_ordinal",
                )?
                .query_map([], |row| {
                    Ok((
                        serde_json::from_str::<Value>(&row.get::<_, String>(0)?)
                            .expect("valid object key"),
                        serde_json::from_str::<Value>(&row.get::<_, String>(1)?)
                            .expect("valid changed paths"),
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(
                version_chain,
                vec![
                    (
                        json!({
                            "kind": "codex-detail-value",
                            "valueId": "value-p1"
                        }),
                        json!(["/details/d1"]),
                        0,
                        1,
                    ),
                    (
                        json!({"kind": "codex-entry", "entryId": "c1"}),
                        json!(["/content"]),
                        0,
                        1,
                    ),
                    (
                        json!({"kind": "codex-entry", "entryId": "c1"}),
                        json!(["/summary"]),
                        1,
                        2,
                    ),
                    (
                        json!({"kind": "codex-relation", "relationId": "relation-p1"}),
                        json!(["/forwardLabel"]),
                        1,
                        2,
                    ),
                    (
                        json!({"kind": "scene", "sceneId": "moved"}),
                        json!(["/charCount", "/content", "/placedBeatPreview"]),
                        0,
                        1,
                    ),
                    (
                        json!({"kind": "scene", "sceneId": "moved"}),
                        json!(["/title"]),
                        1,
                        2,
                    ),
                ]
            );

            for (entity_kind, entity_id, field_path) in [
                ("scene", "moved", "/content"),
                ("scene", "moved", "/title"),
                ("codex-entry", "c1", "/summary"),
                ("codex-entry", "c1", "/content"),
                ("codex-entry", "c1", "/details/d1"),
                ("codex-relation", "relation-p1", "/forwardLabel"),
            ] {
                let owner: String = conn.query_row(
                    "SELECT owner_kind FROM narrative_field_authority
                      WHERE project_id = 'p1' AND entity_kind = ?1
                        AND entity_id = ?2 AND field_path = ?3",
                    params![entity_kind, entity_id, field_path],
                    |row| row.get(0),
                )?;
                assert_eq!(owner, "human", "{entity_kind} {entity_id} {field_path}");
            }
            let undo_event_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM change_events
                  WHERE project_id = 'p1' AND op_type = 'codex.renameUndo'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(undo_event_count, 1);
            Ok(())
        })
        .expect("verify rename lanes");

        let stale = undo_codex_rename(
            &db,
            CodexRenameUndoPayload {
                request_id: "rename-undo-request-stale".to_string(),
                event_uid: "rename-undo-event-stale".to_string(),
                original_transaction_id,
                undo_journal_id,
                project_id: "p1".to_string(),
                updated_at: "undo-stale".to_string(),
                updates: vec![update("node-title", "moved", None, 0, "Stale")],
                session_id: Some("rename-test".to_string()),
            },
        );
        assert!(stale.is_err());
    }

    #[test]
    fn codex_rename_forward_undo_redo_preserve_lineage_and_retry_identity() {
        let db = fixture();
        let update = |value: &str, base_version: i64| CodexRenameUndoUpdate {
            kind: "node-title".to_string(),
            ref_id: "moved".to_string(),
            detail_definition_id: None,
            base_version,
            value: value.to_string(),
            char_count: None,
            placed_beat_preview: None,
        };
        let forward = CodexRenameApplyPayload {
            request_id: "rename-forward-request".to_string(),
            project_id: "p1".to_string(),
            session_id: "rename-session".to_string(),
            surface: Some("rename-test".to_string()),
            entry_id: "c1".to_string(),
            updated_at: "2026-08-13T00:00:01Z".to_string(),
            updates: vec![update("Renamed", 0)],
            event_summary: "{}".to_string(),
            event_uid: "rename-forward-event".to_string(),
            timestamp: 1,
            redo: false,
            original_transaction_id: None,
            undo_journal_id: None,
        };
        let forward_result = apply_codex_rename(&db, forward.clone()).expect("forward rename");
        let mut forward_retry = forward;
        forward_retry.session_id = "rename-session-after-restart".to_string();
        forward_retry.event_uid = "rename-forward-event-after-restart".to_string();
        assert_eq!(
            apply_codex_rename(&db, forward_retry).expect("retry forward rename"),
            forward_result
        );
        let original_transaction_id = forward_result["maintenanceTransactionId"]
            .as_str()
            .expect("forward maintenance transaction")
            .to_string();
        let undo_journal_id = forward_result["undoJournalId"]
            .as_str()
            .expect("forward undo journal")
            .to_string();

        let undo_result = undo_codex_rename(
            &db,
            CodexRenameUndoPayload {
                request_id: "rename-undo-request".to_string(),
                event_uid: "rename-undo-event".to_string(),
                original_transaction_id: original_transaction_id.clone(),
                undo_journal_id: undo_journal_id.clone(),
                project_id: "p1".to_string(),
                updated_at: "2026-08-13T00:00:02Z".to_string(),
                updates: vec![update("Moved", 1)],
                session_id: Some("rename-session".to_string()),
            },
        )
        .expect("undo rename");
        assert_eq!(undo_result["versions"][0]["version"], 2);

        apply_codex_rename(
            &db,
            CodexRenameApplyPayload {
                request_id: "rename-redo-request".to_string(),
                project_id: "p1".to_string(),
                session_id: "rename-session".to_string(),
                surface: Some("rename-test".to_string()),
                entry_id: "c1".to_string(),
                updated_at: "2026-08-13T00:00:03Z".to_string(),
                updates: vec![update("Renamed", 2)],
                event_summary: "{}".to_string(),
                event_uid: "rename-redo-event".to_string(),
                timestamp: 3,
                redo: true,
                original_transaction_id: Some(original_transaction_id),
                undo_journal_id: Some(undo_journal_id),
            },
        )
        .expect("redo rename");

        db.with_conn(|conn| {
            let title: String = conn.query_row(
                "SELECT title FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| row.get(0),
            )?;
            let ledger_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM undo_journal
                  WHERE project_id = 'p1' AND op_kind = 'codex.renamePropagate'",
                [],
                |row| row.get(0),
            )?;
            let lineage = conn
                .prepare(
                    "SELECT cause_kind, origin
                       FROM narrative_change_transactions
                      WHERE project_id = 'p1'
                        AND source_domain IN ('codex.renamePropagate', 'codex.renameUndo')
                      ORDER BY source_change_event_sequence",
                )?
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(title, "Renamed");
            assert_eq!(ledger_count, 1);
            assert_eq!(
                lineage,
                vec![
                    ("forward".to_string(), "human".to_string()),
                    ("undo".to_string(), "undo".to_string()),
                    ("redo".to_string(), "redo".to_string()),
                ]
            );
            Ok(())
        })
        .expect("verify rename lineage");
    }

    #[test]
    fn codex_rename_body_replacements_snapshot_scene_and_codex_on_forward_undo_redo() {
        let db = fixture();
        let scene_before = r#"{"type":"doc","content":[{"type":"text","text":"scene-old"}]}"#;
        let scene_after = r#"{"type":"doc","content":[{"type":"text","text":"scene-new😀"}]}"#;
        let codex_before = r#"{"type":"doc","content":[{"type":"text","text":"codex-old"}]}"#;
        let codex_after = r#"{"type":"doc","content":[{"type":"text","text":"codex-new"}]}"#;
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET content = ?1, char_count = 9 WHERE id = 'moved'",
                [scene_before],
            )?;
            conn.execute(
                "UPDATE codex_entries SET content = ?1 WHERE id = 'c1'",
                [codex_before],
            )?;
            Ok(())
        })
        .expect("seed rename body states");

        let updates = |scene: &str, codex: &str, base_version: i64| {
            vec![
                CodexRenameUndoUpdate {
                    kind: "scene-body".to_string(),
                    ref_id: "moved".to_string(),
                    detail_definition_id: None,
                    base_version,
                    value: scene.to_string(),
                    char_count: Some(grimodex_core::pm_text::pm_doc_text_len(scene)),
                    placed_beat_preview: None,
                },
                CodexRenameUndoUpdate {
                    kind: "codex-content".to_string(),
                    ref_id: "c1".to_string(),
                    detail_definition_id: None,
                    base_version,
                    value: codex.to_string(),
                    char_count: None,
                    placed_beat_preview: None,
                },
            ]
        };
        let forward = CodexRenameApplyPayload {
            request_id: "rename-body-forward-request".to_string(),
            project_id: "p1".to_string(),
            session_id: "rename-body-session".to_string(),
            surface: Some("rename-test".to_string()),
            entry_id: "c1".to_string(),
            updated_at: "2026-08-13T00:00:01Z".to_string(),
            updates: updates(scene_after, codex_after, 0),
            event_summary: "{}".to_string(),
            event_uid: "rename-body-forward-event".to_string(),
            timestamp: 100,
            redo: false,
            original_transaction_id: None,
            undo_journal_id: None,
        };
        let forward_result = apply_codex_rename(&db, forward.clone()).expect("forward body rename");
        let mut retry = forward;
        retry.session_id = "rename-body-session-after-restart".to_string();
        retry.event_uid = "rename-body-forward-event-after-restart".to_string();
        assert_eq!(
            apply_codex_rename(&db, retry).expect("retry forward body rename"),
            forward_result
        );
        let original_transaction_id = forward_result["maintenanceTransactionId"]
            .as_str()
            .expect("forward transaction")
            .to_string();
        let undo_journal_id = forward_result["undoJournalId"]
            .as_str()
            .expect("forward journal")
            .to_string();

        undo_codex_rename(
            &db,
            CodexRenameUndoPayload {
                request_id: "rename-body-undo-request".to_string(),
                event_uid: "rename-body-undo-event".to_string(),
                original_transaction_id: original_transaction_id.clone(),
                undo_journal_id: undo_journal_id.clone(),
                project_id: "p1".to_string(),
                updated_at: "2026-08-13T00:00:02Z".to_string(),
                updates: updates(scene_before, codex_before, 1),
                session_id: Some("rename-body-session".to_string()),
            },
        )
        .expect("undo body rename");
        apply_codex_rename(
            &db,
            CodexRenameApplyPayload {
                request_id: "rename-body-redo-request".to_string(),
                project_id: "p1".to_string(),
                session_id: "rename-body-session".to_string(),
                surface: Some("rename-test".to_string()),
                entry_id: "c1".to_string(),
                updated_at: "2026-08-13T00:00:03Z".to_string(),
                updates: updates(scene_after, codex_after, 2),
                event_summary: "{}".to_string(),
                event_uid: "rename-body-redo-event".to_string(),
                timestamp: 300,
                redo: true,
                original_transaction_id: Some(original_transaction_id),
                undo_journal_id: Some(undo_journal_id),
            },
        )
        .expect("redo body rename");

        db.with_conn(|conn| {
            let snapshots = conn
                .prepare(
                    "SELECT domain, entity_id, anchor_sequence, payload
                       FROM state_snapshots
                      WHERE project_id = 'p1' AND entity_id IN ('moved', 'c1')
                      ORDER BY anchor_sequence, domain",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(
                snapshots,
                vec![
                    (
                        "codex".to_string(),
                        "c1".to_string(),
                        1,
                        codex_after.to_string()
                    ),
                    (
                        "editor".to_string(),
                        "moved".to_string(),
                        1,
                        scene_after.to_string()
                    ),
                    (
                        "codex".to_string(),
                        "c1".to_string(),
                        2,
                        codex_before.to_string()
                    ),
                    (
                        "editor".to_string(),
                        "moved".to_string(),
                        2,
                        scene_before.to_string()
                    ),
                    (
                        "codex".to_string(),
                        "c1".to_string(),
                        3,
                        codex_after.to_string()
                    ),
                    (
                        "editor".to_string(),
                        "moved".to_string(),
                        3,
                        scene_after.to_string()
                    ),
                ]
            );
            Ok(())
        })
        .expect("inspect rename body snapshots");
    }

    #[test]
    fn codex_rename_snapshot_failure_rolls_back_bodies_and_all_ledgers() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_codex_rename_snapshot
                   BEFORE INSERT ON state_snapshots
                   BEGIN SELECT RAISE(ABORT, 'forced codex rename snapshot failure'); END;",
            )?;
            Ok(())
        })
        .expect("install snapshot failure trigger");

        let error = apply_codex_rename(
            &db,
            CodexRenameApplyPayload {
                request_id: "rename-snapshot-failure-request".to_string(),
                project_id: "p1".to_string(),
                session_id: "rename-session".to_string(),
                surface: Some("rename-test".to_string()),
                entry_id: "c1".to_string(),
                updated_at: "2026-08-13T00:00:01Z".to_string(),
                updates: vec![
                    CodexRenameUndoUpdate {
                        kind: "scene-body".to_string(),
                        ref_id: "moved".to_string(),
                        detail_definition_id: None,
                        base_version: 0,
                        value: r#"{"type":"doc","content":[]}"#.to_string(),
                        char_count: Some(0),
                        placed_beat_preview: None,
                    },
                    CodexRenameUndoUpdate {
                        kind: "codex-content".to_string(),
                        ref_id: "c1".to_string(),
                        detail_definition_id: None,
                        base_version: 0,
                        value: r#"{"type":"doc","content":[]}"#.to_string(),
                        char_count: None,
                        placed_beat_preview: None,
                    },
                ],
                event_summary: "{}".to_string(),
                event_uid: "rename-snapshot-failure-event".to_string(),
                timestamp: 1,
                redo: false,
                original_transaction_id: None,
                undo_journal_id: None,
            },
        )
        .expect_err("snapshot failure must abort the whole rename");
        assert!(error
            .to_string()
            .contains("forced codex rename snapshot failure"));

        db.with_conn(|conn| {
            let state: (String, i64, String, i64, i64, i64, i64, i64) = conn.query_row(
                "SELECT
                   (SELECT content FROM tree_nodes WHERE id = 'moved'),
                   (SELECT version FROM tree_nodes WHERE id = 'moved'),
                   (SELECT content FROM codex_entries WHERE id = 'c1'),
                   (SELECT version FROM codex_entries WHERE id = 'c1'),
                   (SELECT COUNT(*) FROM undo_journal WHERE project_id = 'p1'),
                   (SELECT COUNT(*) FROM change_events WHERE project_id = 'p1'),
                   (SELECT COUNT(*) FROM narrative_change_transactions WHERE project_id = 'p1'),
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE domain = 'codex_rename_apply')",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                    ))
                },
            )?;
            assert_eq!(
                state,
                ("{}".to_string(), 0, "{}".to_string(), 0, 0, 0, 0, 0)
            );
            Ok(())
        })
        .expect("verify snapshot rollback");
    }

    #[test]
    fn codex_rename_feed_failure_rolls_back_domain_undo_and_canonical_event() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_codex_rename_feed
                   BEFORE INSERT ON narrative_change_transactions
                   BEGIN SELECT RAISE(ABORT, 'forced codex rename feed failure'); END;",
            )?;
            Ok(())
        })
        .expect("install feed failure trigger");

        let error = apply_codex_rename(
            &db,
            CodexRenameApplyPayload {
                request_id: "rename-failure-request".to_string(),
                project_id: "p1".to_string(),
                session_id: "rename-session".to_string(),
                surface: Some("rename-test".to_string()),
                entry_id: "c1".to_string(),
                updated_at: "2026-08-13T00:00:01Z".to_string(),
                updates: vec![CodexRenameUndoUpdate {
                    kind: "node-title".to_string(),
                    ref_id: "moved".to_string(),
                    detail_definition_id: None,
                    base_version: 0,
                    value: "Must roll back".to_string(),
                    char_count: None,
                    placed_beat_preview: None,
                }],
                event_summary: "{}".to_string(),
                event_uid: "rename-failure-event".to_string(),
                timestamp: 1,
                redo: false,
                original_transaction_id: None,
                undo_journal_id: None,
            },
        )
        .expect_err("feed failure must abort the whole rename");
        assert!(error
            .to_string()
            .contains("forced codex rename feed failure"));

        db.with_conn(|conn| {
            let (title, version): (String, i64) = conn.query_row(
                "SELECT title, version FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let undo_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM undo_journal WHERE project_id = 'p1'",
                [],
                |row| row.get(0),
            )?;
            let canonical_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM change_events WHERE project_id = 'p1'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!((title, version), ("Moved".to_string(), 0));
            assert_eq!((undo_count, canonical_count), (0, 0));
            Ok(())
        })
        .expect("verify atomic rename rollback");
    }

    #[test]
    fn non_scene_tree_crud_uses_component_feed_root() {
        let db = fixture();
        let mut create = tree_create_payload("tracked-note", "note", "a8", Some("root"));
        create.request_id = "tree-create-request".to_string();
        create.event_uid = "tree-create-event".to_string();
        create.title = "Tracked note".to_string();
        create.content = Some("{}".to_string());
        tree_node_create(&db, create).expect("create tracked note");
        let mut patch = tree_patch_payload(
            "tracked-note",
            serde_json::Map::from_iter([(
                "title".to_string(),
                Value::String("Updated note".to_string()),
            )]),
            Some(0),
            "2026-08-13T00:00:01Z",
        );
        patch.request_id = "tree-patch-request".to_string();
        patch.event_uid = "tree-patch-event".to_string();
        tree_node_patch(&db, patch).expect("patch tracked note");
        let mut delete = tree_delete_payload("tracked-note");
        delete.request_id = "tree-delete-request".to_string();
        delete.event_uid = "tree-delete-event".to_string();
        tree_node_delete(&db, delete).expect("delete tracked note");

        db.with_conn(|conn| {
            let rows = conn
                .prepare(
                    "SELECT feed_tx.request_id, event.object_key_json,
                            event.mutation_kind, event.changed_paths_json
                       FROM narrative_change_transactions feed_tx
                       JOIN narrative_change_events event
                         ON event.transaction_id = feed_tx.id
                      ORDER BY feed_tx.source_change_event_sequence",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        serde_json::from_str::<Value>(&row.get::<_, String>(1)?)
                            .expect("valid object key"),
                        row.get::<_, String>(2)?,
                        serde_json::from_str::<Value>(&row.get::<_, String>(3)?)
                            .expect("valid changed paths"),
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(rows.len(), 3);
            assert_eq!(
                rows.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
                vec![
                    "tree-create-request",
                    "tree-patch-request",
                    "tree-delete-request",
                ]
            );
            assert!(rows.iter().all(|row| row.1
                == serde_json::json!({
                    "kind": "component",
                    "componentId": "tree-node:tracked-note",
                })));
            assert_eq!(
                rows.iter().map(|row| row.2.as_str()).collect::<Vec<_>>(),
                vec!["create", "update", "delete"]
            );
            assert_eq!(rows[1].3, serde_json::json!(["/title"]));
            Ok(())
        })
        .expect("inspect tracked tree CRUD feed");
    }

    #[test]
    fn tree_create_retry_ignores_transport_session_and_event_identity() {
        let db = fixture();
        let payload = tree_create_payload("retry-scene", "scene", "a8", Some("root"));
        let request_id = payload.request_id.clone();
        let original_event_uid = payload.event_uid.clone();
        let first = tree_node_create(&db, payload.clone()).expect("first tree create");

        let mut retry = payload;
        retry.session_id = "tree-session-after-restart".to_string();
        retry.event_uid = "tree-event-after-restart".to_string();
        let retry_event_uid = retry.event_uid.clone();
        let replayed = tree_node_create(&db, retry).expect("durable request replay");

        assert_eq!(replayed, first);
        db.with_conn(|conn| {
            let counts: (i64, i64, i64, i64, i64, i64) = conn.query_row(
                "SELECT
                   (SELECT COUNT(*) FROM tree_nodes WHERE id = 'retry-scene'),
                   (SELECT COUNT(*) FROM undo_journal WHERE id = ?1),
                   (SELECT COUNT(*) FROM change_events
                     WHERE project_id = 'p1' AND event_uid IN (?2, ?3)),
                   (SELECT COUNT(*) FROM narrative_change_transactions
                     WHERE project_id = 'p1' AND request_id = ?1),
                   (SELECT COUNT(*) FROM narrative_change_events event
                     JOIN narrative_change_transactions feed_tx
                       ON feed_tx.id = event.transaction_id
                    WHERE feed_tx.project_id = 'p1' AND feed_tx.request_id = ?1),
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE domain = 'tree_node_create' AND request_id = ?1)",
                params![request_id, original_event_uid, retry_event_uid],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )?;
            assert_eq!(counts, (1, 1, 1, 1, 1, 1));
            let persisted_event_uid: String = conn.query_row(
                "SELECT event_uid FROM change_events
                  WHERE project_id = 'p1' AND event_uid IN (?1, ?2)",
                params![original_event_uid, retry_event_uid],
                |row| row.get(0),
            )?;
            assert_eq!(persisted_event_uid, original_event_uid);
            Ok(())
        })
        .expect("inspect tree replay");
    }

    #[test]
    fn tree_scene_create_persists_utf16_char_count_atomically_and_replays_receipt() {
        let db = fixture();
        let rich_content = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Hello😀"}]}]}"#;
        let empty_content = r#"{"type":"doc","content":[]}"#;
        let mut rich = tree_create_payload("counted-scene", "scene", "a8", Some("root"));
        rich.content = Some(rich_content.to_string());
        let first = tree_node_create(&db, rich.clone()).expect("create counted scene");

        let mut retry = rich;
        retry.session_id = "tree-count-session-after-restart".to_string();
        retry.event_uid = "tree-count-event-after-restart".to_string();
        let replayed = tree_node_create(&db, retry).expect("replay counted scene create");
        assert_eq!(replayed, first);

        let mut empty = tree_create_payload("empty-scene", "scene", "a9", Some("root"));
        empty.content = Some(empty_content.to_string());
        tree_node_create(&db, empty).expect("create empty scene");

        db.with_conn(|conn| {
            let rich_row: (String, i64) = conn.query_row(
                "SELECT content, char_count FROM tree_nodes
                  WHERE project_id = 'p1' AND id = 'counted-scene'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let empty_row: (String, i64) = conn.query_row(
                "SELECT content, char_count FROM tree_nodes
                  WHERE project_id = 'p1' AND id = 'empty-scene'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(rich_row, (rich_content.to_string(), 7));
            assert_eq!(empty_row, (empty_content.to_string(), 0));

            let counts: (i64, i64, i64, i64) = conn.query_row(
                "SELECT
                   (SELECT COUNT(*) FROM tree_nodes WHERE id = 'counted-scene'),
                   (SELECT COUNT(*) FROM change_events
                     WHERE project_id = 'p1' AND entity_id = 'counted-scene'),
                   (SELECT COUNT(*) FROM state_snapshots
                     WHERE project_id = 'p1' AND entity_id = 'counted-scene'),
                   (SELECT COUNT(*) FROM idempotency_requests
                     WHERE domain = 'tree_node_create'
                       AND request_id = 'create-counted-scene-request')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(counts, (1, 1, 1, 1));
            Ok(())
        })
        .expect("inspect atomic scene create");
    }

    #[test]
    fn tree_replay_binds_the_target_to_the_named_undo_journal() {
        let db = fixture();
        let first = tree_node_create(
            &db,
            tree_create_payload("replay-target-a", "scene", "b0", None),
        )
        .expect("create first replay target");
        let second = tree_node_create(
            &db,
            tree_create_payload("replay-target-b", "scene", "b1", None),
        )
        .expect("create second replay target");
        let first_transaction = first["__writeReceipt"]["maintenanceTransactionId"]
            .as_str()
            .expect("first maintenance transaction")
            .to_string();
        let first_journal = first["__writeReceipt"]["undoJournalId"]
            .as_str()
            .expect("first undo journal")
            .to_string();
        let mut forged_delete = tree_delete_payload("replay-target-b");
        forged_delete.request_id = "replay-target-forged-delete".to_string();
        forged_delete.event_uid = "replay-target-forged-delete-event".to_string();
        forged_delete.origin = NarrativeChangeOrigin::Undo;
        forged_delete.original_transaction_id = Some(first_transaction);
        forged_delete.undo_journal_id = Some(first_journal);

        let error = tree_node_delete(&db, forged_delete)
            .expect_err("a replay journal must not be reusable for another node");
        assert!(error.to_string().contains("replay target"));
        let second_after = db
            .with_conn(|conn| select_tree_node(conn, "p1", "replay-target-b"))
            .expect("second target remains");
        assert_eq!(second_after["id"], second["id"]);
        let first_after = db
            .with_conn(|conn| select_tree_node(conn, "p1", "replay-target-a"))
            .expect("first target remains");
        assert_eq!(first_after["id"], "replay-target-a");
    }

    #[test]
    fn tree_subtree_delete_is_project_scoped_ordered_and_idempotent() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO tree_nodes
                   (id, project_id, parent_id, node_type, title, sort_order)
                 VALUES
                   ('delete-root', 'p1', NULL, 'folder', 'Root', 'z0'),
                   ('delete-a', 'p1', 'delete-root', 'scene', 'A', 'a0'),
                   ('delete-z', 'p1', 'delete-root', 'folder', 'Z', 'z0'),
                   ('delete-grandchild', 'p1', 'delete-z', 'scene', 'Grandchild', 'a0'),
                   ('delete-foreign', 'p2', 'delete-root', 'scene', 'Foreign', 'a0');",
            )?;
            Ok(())
        })
        .expect("seed subtree");

        let payload = tree_delete_payload("delete-root");
        let error = tree_node_delete(&db, payload.clone())
            .expect_err("cross-project descendant must reject the whole delete");
        assert!(error.to_string().contains("TREE_SUBTREE_CROSS_PROJECT"));
        db.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tree_nodes WHERE id LIKE 'delete-%'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(count, 5);
            conn.execute("DELETE FROM tree_nodes WHERE id = 'delete-foreign'", [])?;
            Ok(())
        })
        .expect("verify fail-closed scope and remove invalid fixture");

        let first = tree_node_delete(&db, payload.clone()).expect("delete subtree");
        assert_eq!(
            first["deletedIds"],
            json!(["delete-root", "delete-a", "delete-z", "delete-grandchild"])
        );
        let mut retry = payload;
        retry.session_id = "tree-delete-session-after-restart".to_string();
        retry.event_uid = "tree-delete-event-after-restart".to_string();
        let replayed = tree_node_delete(&db, retry).expect("replay subtree delete");
        assert_eq!(replayed, first);

        db.with_conn(|conn| {
            let keys = conn
                .prepare(
                    "SELECT event.object_key_json
                       FROM narrative_change_transactions feed_tx
                       JOIN narrative_change_events event
                         ON event.transaction_id = feed_tx.id
                      WHERE feed_tx.request_id = 'delete-delete-root-request'
                      ORDER BY event.event_ordinal",
                )?
                .query_map([], |row| row.get::<_, String>(0))?
                .map(|row| serde_json::from_str::<Value>(&row?).map_err(Into::into))
                .collect::<anyhow::Result<Vec<_>>>()?;
            assert_eq!(
                keys,
                vec![
                    json!({"kind": "component", "componentId": "tree-node:delete-root"}),
                    json!({"kind": "scene", "sceneId": "delete-a"}),
                    json!({"kind": "component", "componentId": "tree-node:delete-z"}),
                    json!({"kind": "scene", "sceneId": "delete-grandchild"}),
                ]
            );
            let remaining: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tree_nodes WHERE id LIKE 'delete-%'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(remaining, 0);
            let transactions: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE request_id = 'delete-delete-root-request'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(transactions, 1);
            Ok(())
        })
        .expect("inspect deterministic subtree transaction");
    }

    #[test]
    fn tree_subtree_feed_failure_rolls_back_every_node_and_ledger() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO tree_nodes
                   (id, project_id, parent_id, node_type, title, sort_order)
                 VALUES
                   ('rollback-root', 'p1', NULL, 'folder', 'Root', 'z1'),
                   ('rollback-child', 'p1', 'rollback-root', 'scene', 'Child', 'a0');
                 CREATE TRIGGER fail_tree_subtree_feed
                 BEFORE INSERT ON narrative_change_events
                 WHEN NEW.event_ordinal = 1
                 BEGIN
                   SELECT RAISE(ABORT, 'forced Tree subtree Feed failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("seed rollback subtree");

        let error = tree_node_delete(&db, tree_delete_payload("rollback-root"))
            .expect_err("Feed append must abort subtree delete");
        assert!(error
            .to_string()
            .contains("forced Tree subtree Feed failure"));
        db.with_conn(|conn| {
            let nodes: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tree_nodes WHERE id LIKE 'rollback-%'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(nodes, 2);
            for (table, predicate) in [
                ("undo_journal", "id = 'delete-rollback-root-request'"),
                ("change_events", "event_uid = 'delete-rollback-root-event'"),
                (
                    "narrative_change_transactions",
                    "request_id = 'delete-rollback-root-request'",
                ),
            ] {
                let count: i64 = conn.query_row(
                    &format!("SELECT COUNT(*) FROM {table} WHERE {predicate}"),
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 0, "{table} must roll back");
            }
            Ok(())
        })
        .expect("inspect subtree rollback");
    }

    #[test]
    fn native_tree_crud_owns_structural_and_temporal_columns() {
        let db = fixture();
        let mut create = tree_create_payload("native-scene", "scene", "a1", Some("root"));
        create.title = "Native scene".to_string();
        let created = tree_node_create(&db, create).expect("create tree node");
        assert_eq!(created["id"], "native-scene");
        assert_eq!(created["sortOrder"], "a1");
        assert_eq!(created["version"], 0);

        let patch = serde_json::Map::from_iter([
            ("storyTimeOrder".to_string(), serde_json::json!("a0V")),
            ("storyTimeLabel".to_string(), serde_json::json!("Day 1")),
        ]);
        let patched = tree_node_patch(
            &db,
            tree_patch_payload("native-scene", patch, Some(0), "native-update"),
        )
        .expect("patch tree node");
        assert_eq!(patched["storyTimeOrder"], "a0V");
        assert_eq!(patched["version"], 1);

        tree_node_delete(&db, tree_delete_payload("native-scene")).expect("delete tree node");
        db.with_conn(|conn| {
            let count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tree_nodes WHERE id = 'native-scene'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(count, 0);
            Ok(())
        })
        .expect("verify tree node deletion");
    }

    #[test]
    fn native_tree_create_persists_distinct_sort_orders() {
        let db = fixture();
        for (id, node_type, sort_order) in [
            ("ordered-folder", "folder", "a2"),
            ("ordered-scene", "scene", "a0V"),
            ("ordered-note", "note", "a1"),
        ] {
            let created = tree_node_create(
                &db,
                tree_create_payload(id, node_type, sort_order, Some("root")),
            )
            .expect("create ordered tree node");
            assert_eq!(created["sortOrder"], sort_order);
        }

        db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT id FROM tree_nodes
                  WHERE project_id = 'p1' AND id LIKE 'ordered-%'
                  ORDER BY sort_order",
            )?;
            let ordered_ids = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(
                ordered_ids,
                vec!["ordered-scene", "ordered-note", "ordered-folder"]
            );
            Ok(())
        })
        .expect("read ordered tree nodes");
    }

    #[test]
    fn native_tree_create_rejects_invalid_parents_without_inserting() {
        let db = fixture();
        for (id, parent_id, marker) in [
            ("cross-parent-create", "foreign-node", "not in project 'p1'"),
            ("non-folder-parent-create", "moved", "must be a folder"),
            ("self-parent-create", "self-parent-create", "own parent"),
        ] {
            let error =
                tree_node_create(&db, tree_create_payload(id, "scene", "a9", Some(parent_id)))
                    .expect_err("invalid parent must be rejected");
            assert!(error.to_string().contains(marker));
            db.with_conn(|conn| {
                let count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM tree_nodes WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 0);
                Ok(())
            })
            .expect("verify invalid-parent create rollback");
        }
    }

    #[test]
    fn native_tree_patch_rejects_cross_project_relations_without_mutation() {
        let db = fixture();
        for (field, value) in [
            ("parentId", "foreign-node"),
            ("povCharacterId", "foreign-codex"),
            ("locationId", "foreign-codex"),
        ] {
            let error = tree_node_patch(
                &db,
                tree_patch_payload(
                    "moved",
                    serde_json::Map::from_iter([(
                        field.to_string(),
                        Value::String(value.to_string()),
                    )]),
                    Some(0),
                    &format!("rejected-{field}"),
                ),
            )
            .expect_err("cross-project relation must be rejected");
            assert!(error.to_string().contains("not in project 'p1'"));

            db.with_conn(|conn| {
                let (parent_id, pov_id, location_id, version, updated_at): (
                    Option<String>,
                    Option<String>,
                    Option<String>,
                    i64,
                    String,
                ) = conn.query_row(
                    "SELECT parent_id, pov_character_id, location_id, version, updated_at
                       FROM tree_nodes WHERE id = 'moved'",
                    [],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )?;
                assert_eq!(parent_id, None);
                assert_eq!(pov_id, None);
                assert_eq!(location_id, None);
                assert_eq!(version, 0);
                assert_ne!(updated_at, format!("rejected-{field}"));
                Ok(())
            })
            .expect("verify cross-project patch rollback");
        }

        tree_node_create(
            &db,
            tree_create_payload("leaf-parent", "note", "a9", Some("root")),
        )
        .expect("create non-folder parent candidate");
        for (parent_id, marker) in [("leaf-parent", "must be a folder"), ("moved", "own parent")] {
            let error = tree_node_patch(
                &db,
                tree_patch_payload(
                    "moved",
                    serde_json::Map::from_iter([(
                        "parentId".to_string(),
                        Value::String(parent_id.to_string()),
                    )]),
                    Some(0),
                    &format!("rejected-parent-{parent_id}"),
                ),
            )
            .expect_err("invalid structural parent must be rejected");
            assert!(error.to_string().contains(marker));
        }

        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET parent_id = 'root' WHERE id = 'created-parent'",
                [],
            )?;
            Ok(())
        })
        .expect("seed descendant folder");
        let cycle = tree_node_patch(
            &db,
            tree_patch_payload(
                "root",
                serde_json::Map::from_iter([(
                    "parentId".to_string(),
                    Value::String("created-parent".to_string()),
                )]),
                Some(0),
                "rejected-cycle",
            ),
        )
        .expect_err("descendant parent must be rejected");
        assert!(cycle.to_string().contains("create a cycle"));

        db.with_conn(|conn| {
            let (moved_parent, moved_version): (Option<String>, i64) = conn.query_row(
                "SELECT parent_id, version FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let (root_parent, root_version): (Option<String>, i64) = conn.query_row(
                "SELECT parent_id, version FROM tree_nodes WHERE id = 'root'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(moved_parent, None);
            assert_eq!(moved_version, 0);
            assert_eq!(root_parent, None);
            assert_eq!(root_version, 0);
            Ok(())
        })
        .expect("verify structural parent rejections did not mutate nodes");
    }

    #[test]
    fn native_tree_patch_rejects_one_generation_stale_conflict_without_mutation() {
        let db = fixture();
        let winner = tree_node_patch(
            &db,
            tree_patch_payload(
                "moved",
                serde_json::Map::from_iter([("content".to_string(), serde_json::json!("winner"))]),
                Some(0),
                "winner-update",
            ),
        )
        .expect("write winning tree patch");
        assert_eq!(winner["content"], "winner");
        assert_eq!(winner["version"], 1);

        let error = tree_node_patch(
            &db,
            tree_patch_payload(
                "moved",
                serde_json::Map::from_iter([("content".to_string(), serde_json::json!("stale"))]),
                Some(0),
                "stale-update",
            ),
        )
        .expect_err("one-generation-stale patch must conflict");
        let message = error.to_string();
        assert!(message.contains("TREE_NODE_VERSION_MISMATCH"));
        assert!(message.contains("conflict"));

        db.with_conn(|conn| {
            let (content, version, updated_at): (String, i64, String) = conn.query_row(
                "SELECT content, version, updated_at FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(content, "winner");
            assert_eq!(version, 1);
            assert_eq!(updated_at, "winner-update");
            Ok(())
        })
        .expect("verify stale patch did not mutate the tree node");
    }

    #[test]
    fn native_tree_content_event_commits_with_canonical_chain_and_rolls_back_duplicate_uid() {
        let db = fixture();
        let patch = |content: &str, base_version: i64, event_uid: &str, timestamp: i64| {
            let mut payload = tree_patch_payload(
                "moved",
                serde_json::Map::from_iter([
                    ("content".to_string(), serde_json::json!(content)),
                    ("charCount".to_string(), serde_json::json!(content.len())),
                ]),
                Some(base_version),
                &format!("event-{timestamp}"),
            );
            payload.request_id = format!("request-{timestamp}");
            payload.session_id = "external-product-journey".to_string();
            payload.event_uid = event_uid.to_string();
            payload.change_event = Some(TreeNodePatchChangeEvent {
                event_uid: event_uid.to_string(),
                session_id: "external-product-journey".to_string(),
                timestamp,
            });
            tree_node_patch(&db, payload)
        };

        patch("first", 0, "event-1", 10).expect("first atomic content event");
        patch("second", 1, "event-2", 20).expect("second atomic content event");

        db.with_conn(|conn| {
            let rows = conn
                .prepare(
                    "SELECT event_uid, scene_id, domain, op_type, entity_type,
                            entity_id, payload, session_id, sequence, prev_hash, hash
                       FROM change_events WHERE project_id = 'p1' ORDER BY sequence",
                )?
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, String>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0].0, "event-1");
            assert_eq!(rows[0].1.as_deref(), Some("moved"));
            assert_eq!(rows[0].2, "editor");
            assert_eq!(rows[0].3, "scene.content_update");
            assert_eq!(rows[0].4.as_deref(), Some("tree_batch"));
            assert_eq!(rows[0].5.as_deref(), Some("moved"));
            let payload: Value = serde_json::from_str(&rows[0].6)?;
            let mut fields = payload["fields"]
                .as_array()
                .expect("canonical fields")
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>();
            fields.sort_unstable();
            assert_eq!(fields, vec!["charCount", "content"]);
            assert_eq!(payload["before"]["id"], "moved");
            assert_eq!(payload["before"]["content"], "{}");
            assert_eq!(payload["before"]["version"], 0);
            assert_eq!(payload["after"]["id"], "moved");
            assert_eq!(payload["after"]["content"], "first");
            assert_eq!(payload["after"]["charCount"], 5);
            assert_eq!(payload["after"]["version"], 1);
            assert_eq!(rows[0].7, "external-product-journey");
            assert_eq!(rows[0].8, 1);
            assert_eq!(rows[0].9, "0".repeat(64));
            assert_eq!(rows[0].10.len(), 64);
            assert_eq!(rows[1].8, 2);
            assert_eq!(rows[1].9, rows[0].10);
            assert_eq!(rows[1].10.len(), 64);
            Ok(())
        })
        .expect("read canonical content event chain");

        let error = patch("must-roll-back", 2, "event-2", 30)
            .expect_err("duplicate event UID must roll back the content patch");
        assert!(error.to_string().contains("already exists"));
        db.with_conn(|conn| {
            let state: (String, i64, i64, i64, i64, i64, i64) = conn.query_row(
                "SELECT content, version,
                        (SELECT COUNT(*) FROM change_events WHERE project_id = 'p1'),
                        (SELECT COUNT(*) FROM undo_journal WHERE project_id = 'p1'),
                        (SELECT COUNT(*) FROM narrative_change_transactions
                          WHERE project_id = 'p1'),
                        (SELECT COUNT(*) FROM narrative_change_events
                          WHERE project_id = 'p1'),
                        (SELECT COUNT(*) FROM idempotency_requests
                          WHERE domain = 'tree_node_patch')
                   FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )?;
            assert_eq!(state, ("second".to_string(), 2, 2, 2, 2, 2, 2));
            Ok(())
        })
        .expect("verify duplicate UID rollback");
    }

    #[test]
    fn native_scene_content_forward_undo_redo_feed_text_impact_is_reversible() {
        let db = fixture();
        let content_a = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"A"}]}]}"#;
        let content_b = "{}";
        let mut forward = tree_patch_payload(
            "moved",
            serde_json::Map::from_iter([
                ("content".to_string(), Value::String(content_a.to_string())),
                ("charCount".to_string(), Value::Number(1.into())),
            ]),
            Some(0),
            "scene-forward",
        );
        forward.request_id = "scene-forward-request".to_string();
        forward.event_uid = "scene-forward-event".to_string();
        let forward_result = tree_node_patch(&db, forward).expect("forward scene write");
        let root_transaction_id = forward_result["__writeReceipt"]["maintenanceTransactionId"]
            .as_str()
            .expect("forward transaction")
            .to_string();
        let undo_journal_id = forward_result["__writeReceipt"]["undoJournalId"]
            .as_str()
            .expect("forward undo journal")
            .to_string();

        let mut undo = tree_patch_payload(
            "moved",
            serde_json::Map::from_iter([
                ("content".to_string(), Value::String(content_b.to_string())),
                ("charCount".to_string(), Value::Number(2.into())),
            ]),
            Some(1),
            "scene-undo",
        );
        undo.request_id = "scene-undo-request".to_string();
        undo.event_uid = "scene-undo-event".to_string();
        undo.origin = NarrativeChangeOrigin::Undo;
        undo.original_transaction_id = Some(root_transaction_id.clone());
        undo.undo_journal_id = Some(undo_journal_id.clone());
        tree_node_patch(&db, undo).expect("undo scene write");

        let mut redo = tree_patch_payload(
            "moved",
            serde_json::Map::from_iter([
                ("content".to_string(), Value::String(content_a.to_string())),
                ("charCount".to_string(), Value::Number(1.into())),
            ]),
            Some(2),
            "scene-redo",
        );
        redo.request_id = "scene-redo-request".to_string();
        redo.event_uid = "scene-redo-event".to_string();
        redo.origin = NarrativeChangeOrigin::Redo;
        redo.original_transaction_id = Some(root_transaction_id);
        redo.undo_journal_id = Some(undo_journal_id);
        tree_node_patch(&db, redo).expect("redo scene write");

        db.with_conn(|conn| {
            let impacts = conn
                .prepare(
                    "SELECT tx.cause_kind, event.text_impact_json
                       FROM narrative_change_events event
                       JOIN narrative_change_transactions tx
                         ON tx.id = event.transaction_id
                      WHERE event.project_id = 'p1'
                        AND json_extract(event.object_key_json, '$.kind') = 'scene'
                      ORDER BY event.canonical_sequence",
                )?
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(impacts.len(), 3);
            assert_eq!(
                impacts.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
                vec!["forward", "undo", "redo"]
            );
            let parsed = impacts
                .iter()
                .map(|row| serde_json::from_str::<Value>(&row.1))
                .collect::<Result<Vec<_>, _>>()?;
            for impact in &parsed {
                assert_eq!(
                    impact["normalizerVersion"],
                    crate::narrative_extraction::change_feed::CANONICAL_TEXT_NORMALIZER_VERSION
                );
                assert_eq!(impact["mapping"]["kind"], "whole-document");
            }
            assert_eq!(
                parsed[0]["newCanonicalDigest"],
                parsed[1]["oldCanonicalDigest"]
            );
            assert_eq!(
                parsed[0]["oldCanonicalDigest"],
                parsed[1]["newCanonicalDigest"]
            );
            assert_eq!(
                parsed[1]["newCanonicalDigest"],
                parsed[2]["oldCanonicalDigest"]
            );
            assert_eq!(
                parsed[0]["oldCanonicalDigest"],
                parsed[2]["oldCanonicalDigest"]
            );
            assert_eq!(
                parsed[0]["newCanonicalDigest"],
                parsed[2]["newCanonicalDigest"]
            );
            let snapshots = conn
                .prepare(
                    "SELECT anchor_sequence, payload
                       FROM state_snapshots
                      WHERE project_id = 'p1'
                        AND domain = 'editor'
                        AND entity_type = 'scene'
                        AND entity_id = 'moved'
                      ORDER BY anchor_sequence, id",
                )?
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(
                snapshots,
                vec![
                    (1, content_a.to_string()),
                    (2, content_b.to_string()),
                    (3, content_a.to_string()),
                ],
                "forward, undo, and redo body snapshots must retain their exact canonical tails"
            );
            Ok(())
        })
        .expect("verify forward undo redo text impacts");
    }

    #[test]
    fn revision_content_restore_has_restore_feed_contract() {
        let db = fixture();
        let restored_content = r#"{"type":"doc","content":[]}"#;
        let result = tree_node_patch(
            &db,
            TreeNodePatchPayload {
                project_id: "p1".to_string(),
                request_id: "revision-restore-request".to_string(),
                session_id: "revision-session".to_string(),
                event_uid: "revision-restore-event".to_string(),
                node_id: "moved".to_string(),
                patch: serde_json::Map::from_iter([
                    (
                        "content".to_string(),
                        Value::String(restored_content.to_string()),
                    ),
                    ("charCount".to_string(), Value::Number(0.into())),
                ]),
                base_version: Some(0),
                bump_version: true,
                updated_at: "2026-08-13T00:00:01Z".to_string(),
                change_event: Some(TreeNodePatchChangeEvent {
                    event_uid: "revision-restore-event".to_string(),
                    session_id: "revision-session".to_string(),
                    timestamp: 1,
                }),
                timelapse_doc_step_coverage: None,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                undo_journal_id: None,
                source_domain: Some("revision".to_string()),
                op_type: Some("content.restore".to_string()),
                canonical_payload: None,
            },
        )
        .expect("restore scene content");
        assert_eq!(result["content"], restored_content);
        assert_eq!(result["version"], 1);

        db.with_conn(|conn| {
            let canonical: (String, String) = conn.query_row(
                "SELECT domain, op_type FROM change_events
                  WHERE event_uid = 'revision-restore-event'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let transaction: (String, String, String) = conn.query_row(
                "SELECT request_id, source_domain, origin
                   FROM narrative_change_transactions
                  WHERE source_change_event_uid = 'revision-restore-event'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            let event: (String, Option<String>, Option<String>) = conn.query_row(
                "SELECT mutation_kind, before_digest, after_digest
                   FROM narrative_change_events
                  WHERE transaction_id = (
                    SELECT id FROM narrative_change_transactions
                     WHERE source_change_event_uid = 'revision-restore-event'
                  )",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(
                canonical,
                ("revision".to_string(), "content.restore".to_string())
            );
            assert_eq!(
                transaction,
                (
                    "revision-restore-request".to_string(),
                    "content.restore".to_string(),
                    "restore".to_string(),
                )
            );
            assert_eq!(event.0, "restore");
            assert_eq!(event.1, None);
            assert!(event.2.is_some());
            Ok(())
        })
        .expect("verify restore contract");
    }

    #[test]
    fn revision_content_restore_rolls_back_when_feed_append_fails() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_revision_restore_feed
                   BEFORE INSERT ON narrative_change_transactions
                   BEGIN SELECT RAISE(ABORT, 'forced revision restore feed failure'); END;",
            )?;
            Ok(())
        })
        .expect("install feed failure trigger");

        let error = tree_node_patch(
            &db,
            TreeNodePatchPayload {
                project_id: "p1".to_string(),
                request_id: "revision-restore-failure-request".to_string(),
                session_id: "revision-session".to_string(),
                event_uid: "revision-restore-failure-event".to_string(),
                node_id: "moved".to_string(),
                patch: serde_json::Map::from_iter([
                    ("content".to_string(), Value::String("restored".to_string())),
                    ("charCount".to_string(), Value::Number(8.into())),
                ]),
                base_version: Some(0),
                bump_version: true,
                updated_at: "2026-08-13T00:00:01Z".to_string(),
                change_event: Some(TreeNodePatchChangeEvent {
                    event_uid: "revision-restore-failure-event".to_string(),
                    session_id: "revision-session".to_string(),
                    timestamp: 1,
                }),
                timelapse_doc_step_coverage: None,
                origin: NarrativeChangeOrigin::Restore,
                original_transaction_id: None,
                undo_journal_id: None,
                source_domain: Some("revision".to_string()),
                op_type: Some("content.restore".to_string()),
                canonical_payload: None,
            },
        )
        .expect_err("feed failure must abort content restore");
        assert!(error
            .to_string()
            .contains("forced revision restore feed failure"));

        db.with_conn(|conn| {
            let (content, version): (String, i64) = conn.query_row(
                "SELECT content, version FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let canonical_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM change_events
                  WHERE event_uid = 'revision-restore-failure-event'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!((content, version), ("{}".to_string(), 0));
            assert_eq!(canonical_count, 0);
            Ok(())
        })
        .expect("verify atomic restore rollback");
    }
}
