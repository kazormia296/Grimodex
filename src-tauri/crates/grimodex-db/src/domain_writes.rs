//! Typed aggregate writes used by renderer features that previously assembled
//! SQL batches. Each command owns its SQL, transaction boundary, and project
//! checks here; renderer payloads contain domain data only.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::Value;

use super::Database;

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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetEntityTagsPayload {
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

pub fn set_entity_tags(db: &Database, payload: SetEntityTagsPayload) -> anyhow::Result<()> {
    require_non_empty(&payload.entity_id, "entityId")?;
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

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let project_id = entity_project_id(&tx, &payload.entity_kind, &payload.entity_id)?;
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
        tx.commit()?;
        Ok(())
    })
}

#[derive(Debug, Deserialize)]
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRenameUndoPayload {
    pub project_id: String,
    pub updated_at: String,
    pub updates: Vec<CodexRenameUndoUpdate>,
    #[serde(default)]
    pub session_id: Option<String>,
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

/// Apply one side (forward or undo) of a rename propagation batch inside an
/// already-open transaction. Shared by `apply_codex_rename` (forward, new
/// value) and `undo_codex_rename` (undo, old value) — both pass the target
/// value pre-selected into `update.value`.
///
/// `tree_nodes` (scene-body/node-title/node-synopsis) is not a protected
/// Narrative table, but is applied here too so the whole rename batch commits
/// atomically in one Native transaction (matching the pre-cutover
/// `agentWriteBundle` guarantee).
fn apply_codex_rename_updates_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    updated_at: &str,
    session_id: &str,
    updates: &[CodexRenameUndoUpdate],
) -> anyhow::Result<Vec<Value>> {
    let mut versions = Vec::with_capacity(updates.len());
    let mut aggregate_versions: HashMap<String, (i64, i64)> = HashMap::new();
    for update in updates {
        let aggregate_key = match update.kind.as_str() {
            "scene-body" | "node-title" | "node-synopsis" => {
                format!("tree-node:{}", update.ref_id)
            }
            "codex-summary" | "codex-content" | "codex-notes" => {
                format!("codex-entry:{}", update.ref_id)
            }
            "codex-detail" => format!(
                "codex-detail:{}:{}",
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
                let field_path = format!("/details/{definition_id}");
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
        versions.push(serde_json::json!({
            "kind": update.kind,
            "refId": update.ref_id,
            "detailDefinitionId": update.detail_definition_id,
            "version": next_version,
            "baseVersion": expected_version,
        }));
    }
    Ok(versions)
}

pub fn undo_codex_rename(db: &Database, payload: CodexRenameUndoPayload) -> anyhow::Result<Value> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.updated_at, "updatedAt")?;
    validate_codex_rename_updates(&payload.updates)?;

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let versions = apply_codex_rename_updates_in_tx(
            &tx,
            &payload.project_id,
            &payload.updated_at,
            payload
                .session_id
                .as_deref()
                .filter(|session| !session.is_empty())
                .unwrap_or("codex-rename-undo"),
            &payload.updates,
        )?;
        if !payload.updates.is_empty() {
            let event_uid = uuid::Uuid::new_v4().to_string();
            let timestamp = chrono::DateTime::parse_from_rfc3339(&payload.updated_at)
                .map(|value| value.timestamp_millis())
                .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis());
            crate::change_events::append_change_events_in_tx(
                &tx,
                &payload.project_id,
                payload
                    .session_id
                    .as_deref()
                    .filter(|session| !session.is_empty())
                    .unwrap_or("codex-rename-undo"),
                &[crate::change_events::AppendChangeEvent {
                    event_uid,
                    scene_id: None,
                    domain: "codex".to_string(),
                    op_type: "codex.renameUndo".to_string(),
                    entity_type: Some("codex_rename".to_string()),
                    entity_id: payload.updates.first().map(|update| update.ref_id.clone()),
                    payload: serde_json::json!({
                        "updateCount": payload.updates.len(),
                    })
                    .to_string(),
                    timestamp,
                }],
            )?;
        }
        tx.commit()?;
        Ok(serde_json::json!({
            "versions": versions,
        }))
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexRenameApplyPayload {
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
}

/// Forward-apply a rename propagation batch (Native replacement for the
/// pre-cutover `agentWriteBundle` + Drizzle `.update().toSQL()` statements).
/// Runs every update in one transaction, then records undo_journal +
/// change_event exactly like `agent_write_bundle_impl` did.
pub fn apply_codex_rename(
    db: &Database,
    payload: CodexRenameApplyPayload,
) -> anyhow::Result<Value> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.updated_at, "updatedAt")?;
    require_non_empty(&payload.entry_id, "entryId")?;
    anyhow::ensure!(
        !payload.updates.is_empty(),
        "codex rename apply requires at least one update"
    );
    validate_codex_rename_updates(&payload.updates)?;

    let undo_id = uuid::Uuid::new_v4().to_string();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
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
            let versions = apply_codex_rename_updates_in_tx(
                conn,
                &payload.project_id,
                &payload.updated_at,
                &payload.session_id,
                &payload.updates,
            )?;

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

            crate::change_events::append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[crate::change_events::AppendChangeEvent {
                    event_uid: payload.event_uid.clone(),
                    scene_id: None,
                    domain: "codex".to_string(),
                    op_type: "codex.renamePropagate".to_string(),
                    entity_type: Some("codex_entry".to_string()),
                    entity_id: Some(payload.entry_id.clone()),
                    payload: payload.event_summary.clone(),
                    timestamp: payload.timestamp,
                }],
            )?;

            Ok(serde_json::json!({
                "entityId": payload.entry_id,
                "version": versions.last().and_then(|item| item.get("version")).and_then(Value::as_i64).unwrap_or(0),
                "versions": versions,
                "changeEventUid": payload.event_uid,
                "undoJournalId": undo_id,
            }))
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDeletePayload {
    pub project_id: String,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNodeCreatePayload {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub node_type: String,
    pub title: String,
    pub sort_order: String,
    pub synopsis: Option<String>,
    pub status: Option<String>,
    pub source_uri: Option<String>,
    pub source_mtime: Option<String>,
    pub content: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNodeDeletePayload {
    pub project_id: String,
    pub node_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNodePatchChangeEvent {
    pub event_uid: String,
    pub session_id: String,
    pub timestamp: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNodePatchPayload {
    pub project_id: String,
    pub node_id: String,
    pub patch: serde_json::Map<String, Value>,
    pub base_version: Option<i64>,
    pub bump_version: bool,
    pub updated_at: String,
    pub change_event: Option<TreeNodePatchChangeEvent>,
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

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(parent_id) = payload.parent_id.as_deref() {
            anyhow::ensure!(
                parent_id != payload.id,
                "tree node '{}' cannot be its own parent",
                payload.id
            );
            ensure_tree_parent_in_project(&tx, &payload.project_id, parent_id)?;
        }
        let now = chrono::Utc::now().to_rfc3339();
        Database::execute_with_conn(
            &tx,
            "INSERT INTO tree_nodes
              (id, project_id, parent_id, node_type, title, sort_order, synopsis, status,
               source_uri, source_mtime, content, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
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
                Value::String(payload.content.clone().unwrap_or_else(|| "{}".to_string())),
                Value::String(now),
            ],
            "run",
        )?;
        let row = select_tree_node(&tx, &payload.project_id, &payload.id)?;
        tx.commit()?;
        Ok(row)
    })
}

pub fn tree_node_delete(db: &Database, payload: TreeNodeDeletePayload) -> anyhow::Result<()> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.node_id, "nodeId")?;
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let node_type: Option<String> = tx
            .query_row(
                "SELECT node_type FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
                params![payload.node_id, payload.project_id],
                |row| row.get(0),
            )
            .optional()?;
        let deleted = tx.execute(
            "DELETE FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
            params![payload.node_id, payload.project_id],
        )?;
        anyhow::ensure!(deleted == 1, "tree node '{}' not found", payload.node_id);
        if node_type.as_deref() == Some("scene") {
            crate::narrative_extraction::propagate_source_change_freshness_in_tx(
                &tx,
                &payload.project_id,
                "scene-body",
                &format!("project:scene:{}", payload.node_id),
                None,
                &chrono::Utc::now().to_rfc3339(),
                "tree-node-writer",
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

pub fn tree_node_patch(db: &Database, payload: TreeNodePatchPayload) -> anyhow::Result<Value> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.node_id, "nodeId")?;
    require_non_empty(&payload.updated_at, "updatedAt")?;
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
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        if let Some(parent_id) = payload.patch.get("parentId") {
            match parent_id {
                Value::Null => {}
                Value::String(parent_id) => {
                    ensure_tree_parent_does_not_cycle(
                        &tx,
                        &payload.project_id,
                        &payload.node_id,
                        parent_id,
                    )?;
                    ensure_tree_parent_in_project(&tx, &payload.project_id, parent_id)?;
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
                        &tx,
                        &payload.project_id,
                        field,
                        entry_id,
                    )?,
                    _ => anyhow::bail!("tree node {field} must be a string or null"),
                }
            }
        }

        Database::execute_with_conn(&tx, &sql, &params, "run")?;
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
        let row = select_tree_node(&tx, &payload.project_id, &payload.node_id)?;
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
        if let Some(event) = payload.change_event.as_ref() {
            anyhow::ensure!(
                row.get("nodeType").and_then(Value::as_str) == Some("scene"),
                "tree node content event target must be a scene"
            );
            let appended = crate::change_events::append_change_events_in_tx(
                &tx,
                &payload.project_id,
                &event.session_id,
                &[crate::change_events::AppendChangeEvent {
                    event_uid: event.event_uid.clone(),
                    scene_id: Some(payload.node_id.clone()),
                    domain: "editor".to_string(),
                    op_type: "scene.content_update".to_string(),
                    entity_type: Some("tree_batch".to_string()),
                    entity_id: Some(payload.node_id.clone()),
                    payload: serde_json::json!({ "sceneId": payload.node_id }).to_string(),
                    timestamp: event.timestamp,
                }],
            )?;
            anyhow::ensure!(
                appended.inserted_count == 1,
                "tree node content event UID '{}' already exists",
                event.event_uid
            );
        }
        if row.get("nodeType").and_then(Value::as_str) == Some("scene") {
            let field_paths: Vec<&str> = payload
                .patch
                .keys()
                .filter_map(|key| match key.as_str() {
                    "parentId" => Some("/parentId"),
                    "title" => Some("/title"),
                    "synopsis" => Some("/synopsis"),
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
                })
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
                    &tx,
                    &payload.project_id,
                    "scene",
                    &payload.node_id,
                    &field_paths,
                    updated_at,
                )?;
                let source_key = format!("project:scene:{}", payload.node_id);
                let source_token = format!("v{version}@{updated_at}");
                crate::narrative_extraction::propagate_source_change_freshness_in_tx(
                    &tx,
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
        tx.commit()?;
        Ok(row)
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeBeforeState {
    pub id: String,
    pub parent_id: Option<String>,
    pub sort_order: String,
    pub title: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoTreePlanPayload {
    pub project_id: String,
    pub before_states: Vec<TreeBeforeState>,
    pub created_ids: Vec<String>,
    pub updated_at: String,
}

pub fn undo_tree_plan(db: &Database, payload: UndoTreePlanPayload) -> anyhow::Result<()> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.updated_at, "updatedAt")?;
    let mut affected_ids = HashSet::new();
    for state in &payload.before_states {
        require_non_empty(&state.id, "beforeStates[].id")?;
        require_non_empty(&state.sort_order, "beforeStates[].sortOrder")?;
        if !affected_ids.insert(state.id.as_str()) {
            anyhow::bail!("tree undo ids must be unique");
        }
    }
    for created_id in &payload.created_ids {
        require_non_empty(created_id, "createdIds[]")?;
        if !affected_ids.insert(created_id.as_str()) {
            anyhow::bail!("tree undo ids must be unique");
        }
    }

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for state in &payload.before_states {
            if let Some(parent_id) = &state.parent_id {
                let parent_exists = tx
                    .query_row(
                        "SELECT 1 FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
                        params![parent_id, payload.project_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .is_some();
                if !parent_exists {
                    anyhow::bail!("tree undo parent is not in the active project");
                }
            }
            tx.execute(
                "UPDATE tree_nodes
                    SET parent_id = ?1, sort_order = ?2, title = ?3, updated_at = ?4
                  WHERE id = ?5 AND project_id = ?6",
                params![
                    state.parent_id,
                    state.sort_order,
                    state.title,
                    payload.updated_at,
                    state.id,
                    payload.project_id
                ],
            )?;
        }
        for created_id in payload.created_ids.iter().rev() {
            tx.execute(
                "DELETE FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
                params![created_id, payload.project_id],
            )?;
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
        set_entity_tags(
            &db,
            SetEntityTagsPayload {
                entity_kind: "codex".to_string(),
                entity_id: "c1".to_string(),
                tag_ids: vec!["tag-b".to_string(), "tag-a".to_string()],
                updated_at: Some("new".to_string()),
            },
        )
        .expect("set tags");
        assert!(set_entity_tags(
            &db,
            SetEntityTagsPayload {
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
            Ok(())
        })
        .expect("read cache");
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
    fn codex_rename_undo_is_project_scoped_and_rolls_back_as_one_unit() {
        let db = fixture();
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
                project_id: "p1".to_string(),
                updated_at: "undo".to_string(),
                updates: vec![
                    update("moved", "Restored"),
                    update("foreign-node", "Leaked"),
                ],
                session_id: None,
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
                project_id: "p1".to_string(),
                updated_at: "undo".to_string(),
                updates: vec![update("moved", "Restored")],
                session_id: None,
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
        let result = undo_codex_rename(
            &db,
            CodexRenameUndoPayload {
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
                session_id: None,
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
                    update(
                        "codex-relation-label",
                        "relation-p1",
                        None,
                        1,
                        "Relation",
                    ),
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
                project_id: "p1".to_string(),
                updated_at: "undo-stale".to_string(),
                updates: vec![update("node-title", "moved", None, 0, "Stale")],
                session_id: None,
            },
        );
        assert!(stale.is_err());
    }

    #[test]
    fn tree_undo_restores_existing_nodes_before_deleting_created_parents() {
        let db = fixture();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE tree_nodes SET parent_id = 'created-parent', title = 'Renamed'
                  WHERE id = 'moved'",
                [],
            )?;
            Ok(())
        })
        .expect("apply forward state");
        undo_tree_plan(
            &db,
            UndoTreePlanPayload {
                project_id: "p1".to_string(),
                before_states: vec![TreeBeforeState {
                    id: "moved".to_string(),
                    parent_id: Some("root".to_string()),
                    sort_order: "a0".to_string(),
                    title: "Moved".to_string(),
                }],
                created_ids: vec!["created-parent".to_string()],
                updated_at: "undo".to_string(),
            },
        )
        .expect("undo tree plan");
        db.with_conn(|conn| {
            let (parent, title): (String, String) = conn.query_row(
                "SELECT parent_id, title FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!((parent, title), ("root".to_string(), "Moved".to_string()));
            assert_eq!(
                conn.query_row(
                    "SELECT COUNT(*) FROM tree_nodes WHERE id = 'created-parent'",
                    [],
                    |row| row.get::<_, i64>(0)
                )?,
                0
            );
            Ok(())
        })
        .expect("read tree");
    }

    #[test]
    fn native_tree_crud_owns_structural_and_temporal_columns() {
        let db = fixture();
        let created = tree_node_create(
            &db,
            TreeNodeCreatePayload {
                id: "native-scene".to_string(),
                project_id: "p1".to_string(),
                parent_id: Some("root".to_string()),
                node_type: "scene".to_string(),
                title: "Native scene".to_string(),
                sort_order: "a1".to_string(),
                synopsis: None,
                status: None,
                source_uri: None,
                source_mtime: None,
                content: None,
            },
        )
        .expect("create tree node");
        assert_eq!(created["id"], "native-scene");
        assert_eq!(created["sortOrder"], "a1");
        assert_eq!(created["version"], 0);

        let patch = serde_json::Map::from_iter([
            ("storyTimeOrder".to_string(), serde_json::json!("a0V")),
            ("storyTimeLabel".to_string(), serde_json::json!("Day 1")),
        ]);
        let patched = tree_node_patch(
            &db,
            TreeNodePatchPayload {
                project_id: "p1".to_string(),
                node_id: "native-scene".to_string(),
                patch,
                base_version: Some(0),
                bump_version: true,
                updated_at: "native-update".to_string(),
                change_event: None,
            },
        )
        .expect("patch tree node");
        assert_eq!(patched["storyTimeOrder"], "a0V");
        assert_eq!(patched["version"], 1);

        tree_node_delete(
            &db,
            TreeNodeDeletePayload {
                project_id: "p1".to_string(),
                node_id: "native-scene".to_string(),
            },
        )
        .expect("delete tree node");
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
                TreeNodeCreatePayload {
                    id: id.to_string(),
                    project_id: "p1".to_string(),
                    parent_id: Some("root".to_string()),
                    node_type: node_type.to_string(),
                    title: id.to_string(),
                    sort_order: sort_order.to_string(),
                    synopsis: None,
                    status: None,
                    source_uri: None,
                    source_mtime: None,
                    content: None,
                },
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
            let error = tree_node_create(
                &db,
                TreeNodeCreatePayload {
                    id: id.to_string(),
                    project_id: "p1".to_string(),
                    parent_id: Some(parent_id.to_string()),
                    node_type: "scene".to_string(),
                    title: "Must not exist".to_string(),
                    sort_order: "a9".to_string(),
                    synopsis: None,
                    status: None,
                    source_uri: None,
                    source_mtime: None,
                    content: None,
                },
            )
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
                TreeNodePatchPayload {
                    project_id: "p1".to_string(),
                    node_id: "moved".to_string(),
                    patch: serde_json::Map::from_iter([(
                        field.to_string(),
                        Value::String(value.to_string()),
                    )]),
                    base_version: Some(0),
                    bump_version: true,
                    updated_at: format!("rejected-{field}"),
                    change_event: None,
                },
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
            TreeNodeCreatePayload {
                id: "leaf-parent".to_string(),
                project_id: "p1".to_string(),
                parent_id: Some("root".to_string()),
                node_type: "note".to_string(),
                title: "Leaf".to_string(),
                sort_order: "a9".to_string(),
                synopsis: None,
                status: None,
                source_uri: None,
                source_mtime: None,
                content: None,
            },
        )
        .expect("create non-folder parent candidate");
        for (parent_id, marker) in [("leaf-parent", "must be a folder"), ("moved", "own parent")] {
            let error = tree_node_patch(
                &db,
                TreeNodePatchPayload {
                    project_id: "p1".to_string(),
                    node_id: "moved".to_string(),
                    patch: serde_json::Map::from_iter([(
                        "parentId".to_string(),
                        Value::String(parent_id.to_string()),
                    )]),
                    base_version: Some(0),
                    bump_version: true,
                    updated_at: format!("rejected-parent-{parent_id}"),
                    change_event: None,
                },
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
            TreeNodePatchPayload {
                project_id: "p1".to_string(),
                node_id: "root".to_string(),
                patch: serde_json::Map::from_iter([(
                    "parentId".to_string(),
                    Value::String("created-parent".to_string()),
                )]),
                base_version: Some(0),
                bump_version: true,
                updated_at: "rejected-cycle".to_string(),
                change_event: None,
            },
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
            TreeNodePatchPayload {
                project_id: "p1".to_string(),
                node_id: "moved".to_string(),
                patch: serde_json::Map::from_iter([(
                    "content".to_string(),
                    serde_json::json!("winner"),
                )]),
                base_version: Some(0),
                bump_version: true,
                updated_at: "winner-update".to_string(),
                change_event: None,
            },
        )
        .expect("write winning tree patch");
        assert_eq!(winner["content"], "winner");
        assert_eq!(winner["version"], 1);

        let error = tree_node_patch(
            &db,
            TreeNodePatchPayload {
                project_id: "p1".to_string(),
                node_id: "moved".to_string(),
                patch: serde_json::Map::from_iter([(
                    "content".to_string(),
                    serde_json::json!("stale"),
                )]),
                base_version: Some(0),
                bump_version: true,
                updated_at: "stale-update".to_string(),
                change_event: None,
            },
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
            tree_node_patch(
                &db,
                TreeNodePatchPayload {
                    project_id: "p1".to_string(),
                    node_id: "moved".to_string(),
                    patch: serde_json::Map::from_iter([
                        ("content".to_string(), serde_json::json!(content)),
                        ("charCount".to_string(), serde_json::json!(content.len())),
                    ]),
                    base_version: Some(base_version),
                    bump_version: true,
                    updated_at: format!("event-{timestamp}"),
                    change_event: Some(TreeNodePatchChangeEvent {
                        event_uid: event_uid.to_string(),
                        session_id: "external-product-journey".to_string(),
                        timestamp,
                    }),
                },
            )
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
            assert_eq!(rows[0].6, r#"{"sceneId":"moved"}"#);
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
            let (content, version, event_count): (String, i64, i64) = conn.query_row(
                "SELECT content, version,
                        (SELECT COUNT(*) FROM change_events WHERE project_id = 'p1')
                   FROM tree_nodes WHERE id = 'moved'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(content, "second");
            assert_eq!(version, 2);
            assert_eq!(event_count, 2);
            Ok(())
        })
        .expect("verify duplicate UID rollback");
    }
}
