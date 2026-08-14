use std::time::Duration;

use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::Database;
use crate::agent_writes::{
    canonical_payload_with_authority_context, validate_renderer_authority_context,
    RendererCanonicalWriteContext, RendererMutationProvenance,
};
use crate::change_events::AppendChangeEvent;
use crate::idempotency::{
    canonical_write_payload_fingerprint, insert_idempotent_response, load_idempotent_response,
    IdempotencyRequest,
};
use crate::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, narrative_snapshot_digest,
    AppendNarrativeChangeTransactionInput, NarrativeChangeCauseKind, NarrativeChangeEventInput,
    NarrativeChangeOrigin,
};

const REPAIR_IDEMPOTENCY_DOMAIN: &str = "repair_integrity";
const REPAIR_SOURCE_DOMAIN: &str = "integrity.repair";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairIntegrityPayload {
    pub project_id: String,
    pub request_id: String,
    pub session_id: String,
    pub event_uid: String,
    pub occurred_at: String,
    pub authority_route: String,
    pub caller: String,
    pub controls: Vec<String>,
    #[serde(default)]
    pub provenance: Option<RendererMutationProvenance>,
    #[serde(default)]
    pub writes_authority_protected_field: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepairIntegrityReport {
    pub codex_sources_fixed: i64,
    pub snippet_sources_fixed: i64,
    pub snippet_scenes_fixed: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub change_event_uid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maintenance_transaction_id: Option<String>,
}

#[derive(Clone, Debug)]
struct CodexRepairTarget {
    id: String,
    version: i64,
    source_chat_message_id: String,
    updated_at: String,
}

#[derive(Clone, Debug)]
struct SnippetRepairTarget {
    id: String,
    version: i64,
    source_chat_message_id: Option<String>,
    scene_id: Option<String>,
    updated_at: String,
    repair_source: bool,
    repair_scene: bool,
}

fn require_non_empty(value: &str, name: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        !value.trim().is_empty(),
        "integrity repair {name} is required"
    );
    Ok(())
}

fn occurred_at_millis(value: &str) -> anyhow::Result<i64> {
    Ok(chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|error| anyhow::anyhow!("integrity repair occurredAt is invalid: {error}"))?
        .timestamp_millis())
}

fn integrity_authority_context(
    payload: &RepairIntegrityPayload,
) -> anyhow::Result<RendererCanonicalWriteContext> {
    let context = RendererCanonicalWriteContext {
        request_id: payload.request_id.clone(),
        event_uid: payload.event_uid.clone(),
        origin: NarrativeChangeOrigin::Restore,
        authority_route: payload.authority_route.clone(),
        caller: payload.caller.clone(),
        controls: payload.controls.clone(),
        provenance: payload.provenance.clone(),
        writes_authority_protected_field: payload.writes_authority_protected_field,
        original_transaction_id: None,
        undo_journal_id: None,
        context_mode: None,
        icon: None,
        children_budget: None,
        notes: None,
        canonical_payload: None,
    };
    validate_renderer_authority_context(&context)?;
    Ok(context)
}

fn codex_targets(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> anyhow::Result<Vec<CodexRepairTarget>> {
    let mut statement = conn.prepare(
        "SELECT entry.id, entry.version, entry.source_chat_message_id, entry.updated_at
           FROM codex_entries entry
          WHERE entry.project_id = ?1
            AND entry.source_chat_message_id IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                  FROM chat_messages message
                  JOIN chat_sessions session ON session.id = message.session_id
                 WHERE message.id = entry.source_chat_message_id
                   AND session.project_id = entry.project_id
            )
          ORDER BY entry.id",
    )?;
    let rows = statement.query_map([project_id], |row| {
        Ok(CodexRepairTarget {
            id: row.get(0)?,
            version: row.get(1)?,
            source_chat_message_id: row.get(2)?,
            updated_at: row.get(3)?,
        })
    })?;
    let targets = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(targets)
}

fn snippet_targets(
    conn: &rusqlite::Connection,
    project_id: &str,
) -> anyhow::Result<Vec<SnippetRepairTarget>> {
    let mut statement = conn.prepare(
        "SELECT snippet.id,
                snippet.version,
                snippet.source_chat_message_id,
                snippet.scene_id,
                snippet.updated_at,
                CASE WHEN snippet.source_chat_message_id IS NOT NULL
                       AND NOT EXISTS (
                           SELECT 1
                             FROM chat_messages message
                             JOIN chat_sessions session ON session.id = message.session_id
                            WHERE message.id = snippet.source_chat_message_id
                              AND session.project_id = snippet.project_id
                       )
                     THEN 1 ELSE 0 END AS repair_source,
                CASE WHEN snippet.scene_id IS NOT NULL
                       AND NOT EXISTS (
                           SELECT 1 FROM tree_nodes scene
                            WHERE scene.id = snippet.scene_id
                              AND scene.project_id = snippet.project_id
                       )
                     THEN 1 ELSE 0 END AS repair_scene
           FROM snippets snippet
          WHERE snippet.project_id = ?1
            AND (
                (snippet.source_chat_message_id IS NOT NULL
                 AND NOT EXISTS (
                     SELECT 1
                       FROM chat_messages message
                       JOIN chat_sessions session ON session.id = message.session_id
                      WHERE message.id = snippet.source_chat_message_id
                        AND session.project_id = snippet.project_id
                 ))
                OR
                (snippet.scene_id IS NOT NULL
                 AND NOT EXISTS (
                     SELECT 1 FROM tree_nodes scene
                      WHERE scene.id = snippet.scene_id
                        AND scene.project_id = snippet.project_id
                 ))
            )
          ORDER BY snippet.id",
    )?;
    let rows = statement.query_map([project_id], |row| {
        Ok(SnippetRepairTarget {
            id: row.get(0)?,
            version: row.get(1)?,
            source_chat_message_id: row.get(2)?,
            scene_id: row.get(3)?,
            updated_at: row.get(4)?,
            repair_source: row.get::<_, i64>(5)? != 0,
            repair_scene: row.get::<_, i64>(6)? != 0,
        })
    })?;
    let targets = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(targets)
}

impl Database {
    pub fn integrity_check(
        &self,
        project_id: &str,
    ) -> anyhow::Result<serde_json::Map<String, Value>> {
        require_non_empty(project_id, "projectId")?;
        let conn = self.lock_conn()?;
        let mut report = serde_json::Map::new();

        let orphaned_codex_sources: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM codex_entries entry
              WHERE entry.project_id = ?1
                AND entry.source_chat_message_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1
                      FROM chat_messages message
                      JOIN chat_sessions session ON session.id = message.session_id
                     WHERE message.id = entry.source_chat_message_id
                       AND session.project_id = entry.project_id
                )",
            [project_id],
            |row| row.get(0),
        )?;
        report.insert("orphanedCodexSources".into(), orphaned_codex_sources.into());

        let orphaned_snippet_sources: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM snippets snippet
              WHERE snippet.project_id = ?1
                AND snippet.source_chat_message_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1
                      FROM chat_messages message
                      JOIN chat_sessions session ON session.id = message.session_id
                     WHERE message.id = snippet.source_chat_message_id
                       AND session.project_id = snippet.project_id
                )",
            [project_id],
            |row| row.get(0),
        )?;
        report.insert(
            "orphanedSnippetSources".into(),
            orphaned_snippet_sources.into(),
        );

        let orphaned_snippet_scenes: i64 = conn.query_row(
            "SELECT COUNT(*)
               FROM snippets snippet
              WHERE snippet.project_id = ?1
                AND snippet.scene_id IS NOT NULL
                AND NOT EXISTS (
                    SELECT 1 FROM tree_nodes scene
                     WHERE scene.id = snippet.scene_id
                       AND scene.project_id = snippet.project_id
                )",
            [project_id],
            |row| row.get(0),
        )?;
        report.insert(
            "orphanedSnippetScenes".into(),
            orphaned_snippet_scenes.into(),
        );

        Ok(report)
    }

    /// Repair one project's authoritative Codex/Snippet rows and append the
    /// canonical audit event plus maintenance Feed in the same transaction.
    ///
    /// No Undo Journal is created: restoring dangling foreign identities would
    /// deliberately reintroduce corruption rather than provide a safe undo.
    pub fn repair_integrity(
        &self,
        payload: RepairIntegrityPayload,
    ) -> anyhow::Result<RepairIntegrityReport> {
        require_non_empty(&payload.project_id, "projectId")?;
        require_non_empty(&payload.request_id, "requestId")?;
        require_non_empty(&payload.session_id, "sessionId")?;
        require_non_empty(&payload.event_uid, "eventUid")?;
        require_non_empty(&payload.occurred_at, "occurredAt")?;
        let authority_context = integrity_authority_context(&payload)?;
        let timestamp = occurred_at_millis(&payload.occurred_at)?;
        // `occurredAt` is domain data and deliberately remains in the hash.
        // The renderer retains the exact materialized payload after an unknown
        // outcome; only sessionId/eventUid may change after recorder restart.
        let request_hash =
            canonical_write_payload_fingerprint(REPAIR_IDEMPOTENCY_DOMAIN, &payload)?;
        let idempotency_request = IdempotencyRequest {
            domain: REPAIR_IDEMPOTENCY_DOMAIN,
            request_id: Some(&payload.request_id),
            payload_hash: &request_hash,
            conflict_marker: "REPAIR_INTEGRITY_IDEMPOTENCY_CONFLICT",
        };

        self.with_conn(|conn| {
            conn.busy_timeout(Duration::from_secs(5))?;
            conn.execute_batch("BEGIN IMMEDIATE")?;
            let result = (|| -> anyhow::Result<RepairIntegrityReport> {
                if let Some(response) =
                    load_idempotent_response(conn, &idempotency_request)?
                {
                    let stored_project: String = conn.query_row(
                        "SELECT project_id FROM idempotency_requests
                          WHERE domain = ?1 AND request_id = ?2",
                        params![REPAIR_IDEMPOTENCY_DOMAIN, payload.request_id],
                        |row| row.get(0),
                    )?;
                    anyhow::ensure!(
                        stored_project == payload.project_id,
                        "REPAIR_INTEGRITY_IDEMPOTENCY_CONFLICT: request id reused in another project"
                    );
                    return Ok(serde_json::from_value(response)?);
                }

                let project_exists = conn
                    .query_row(
                        "SELECT 1 FROM projects WHERE id = ?1",
                        [&payload.project_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .is_some();
                anyhow::ensure!(
                    project_exists,
                    "integrity repair project '{}' does not exist",
                    payload.project_id
                );

                let codex = codex_targets(conn, &payload.project_id)?;
                let snippets = snippet_targets(conn, &payload.project_id)?;
                let codex_sources_fixed = i64::try_from(codex.len())?;
                let snippet_sources_fixed = i64::try_from(
                    snippets.iter().filter(|target| target.repair_source).count(),
                )?;
                let snippet_scenes_fixed = i64::try_from(
                    snippets.iter().filter(|target| target.repair_scene).count(),
                )?;

                for target in &codex {
                    let updated = conn.execute(
                        "UPDATE codex_entries
                            SET source_chat_message_id = NULL,
                                version = version + 1,
                                updated_at = ?1
                          WHERE id = ?2 AND project_id = ?3 AND version = ?4",
                        params![
                            payload.occurred_at,
                            target.id,
                            payload.project_id,
                            target.version
                        ],
                    )?;
                    anyhow::ensure!(updated == 1, "integrity repair Codex target changed");
                }
                for target in &snippets {
                    let updated = conn.execute(
                        "UPDATE snippets
                            SET source_chat_message_id = CASE WHEN ?1 THEN NULL ELSE source_chat_message_id END,
                                scene_id = CASE WHEN ?2 THEN NULL ELSE scene_id END,
                                version = version + 1,
                                updated_at = ?3
                          WHERE id = ?4 AND project_id = ?5 AND version = ?6",
                        params![
                            target.repair_source,
                            target.repair_scene,
                            payload.occurred_at,
                            target.id,
                            payload.project_id,
                            target.version
                        ],
                    )?;
                    anyhow::ensure!(updated == 1, "integrity repair Snippet target changed");
                }

                let changed = !codex.is_empty() || !snippets.is_empty();
                let (change_event_uid, maintenance_transaction_id) = if changed {
                    let mut events = Vec::with_capacity(codex.len() + snippets.len());
                    let epoch_before = json!({
                        "projectId": payload.project_id.clone(),
                        "semanticEpoch": "prior",
                    });
                    let epoch_after = json!({
                        "projectId": payload.project_id.clone(),
                        "semanticEpoch": "reset",
                        "requestId": payload.request_id.clone(),
                    });
                    events.push(NarrativeChangeEventInput {
                        object_key: json!({
                            "kind": "project",
                            "projectId": payload.project_id.clone(),
                        }),
                        change_kind: "schema".to_string(),
                        mutation_kind: "update".to_string(),
                        before_version: Some(0),
                        before_digest: Some(narrative_snapshot_digest(&epoch_before)?),
                        after_version: Some(1),
                        after_digest: Some(narrative_snapshot_digest(&epoch_after)?),
                        changed_paths: vec!["/integrity".to_string()],
                        text_impact: None,
                        structural_impact: Some(json!({
                            "event": "semantic-epoch-reset",
                            "requiresFullRebuild": true,
                            "changedPaths": ["/integrity"],
                        })),
                    });
                    for target in &codex {
                        let before = json!({
                            "id": target.id.clone(),
                            "sourceChatMessageId": target.source_chat_message_id.clone(),
                            "updatedAt": target.updated_at.clone(),
                            "version": target.version,
                        });
                        let after = json!({
                            "id": target.id.clone(),
                            "sourceChatMessageId": Value::Null,
                            "updatedAt": payload.occurred_at.clone(),
                            "version": target.version + 1,
                        });
                        events.push(NarrativeChangeEventInput {
                            object_key: json!({
                                "kind": "codex-entry",
                                "entryId": target.id.clone(),
                            }),
                            change_kind: "association".to_string(),
                            mutation_kind: "update".to_string(),
                            before_version: Some(target.version),
                            before_digest: Some(narrative_snapshot_digest(&before)?),
                            after_version: Some(target.version + 1),
                            after_digest: Some(narrative_snapshot_digest(&after)?),
                            changed_paths: vec!["/sourceChatMessageId".to_string()],
                            text_impact: None,
                            structural_impact: Some(json!({
                                "changedPaths": ["/sourceChatMessageId"],
                            })),
                        });
                    }
                    for target in &snippets {
                        let mut changed_paths = Vec::with_capacity(2);
                        if target.repair_scene {
                            changed_paths.push("/sceneId".to_string());
                        }
                        if target.repair_source {
                            changed_paths.push("/sourceChatMessageId".to_string());
                        }
                        let before = json!({
                            "id": target.id.clone(),
                            "sceneId": target.scene_id.clone(),
                            "sourceChatMessageId": target.source_chat_message_id.clone(),
                            "updatedAt": target.updated_at.clone(),
                            "version": target.version,
                        });
                        let after = json!({
                            "id": target.id.clone(),
                            "sceneId": if target.repair_scene {
                                Value::Null
                            } else {
                                target.scene_id.clone().map(Value::String).unwrap_or(Value::Null)
                            },
                            "sourceChatMessageId": if target.repair_source {
                                Value::Null
                            } else {
                                target
                                    .source_chat_message_id
                                    .clone()
                                    .map(Value::String)
                                    .unwrap_or(Value::Null)
                            },
                            "updatedAt": payload.occurred_at.clone(),
                            "version": target.version + 1,
                        });
                        events.push(NarrativeChangeEventInput {
                            object_key: json!({
                                "kind": "component",
                                "componentId": format!("snippet:{}", target.id),
                            }),
                            change_kind: "association".to_string(),
                            mutation_kind: "update".to_string(),
                            before_version: Some(target.version),
                            before_digest: Some(narrative_snapshot_digest(&before)?),
                            after_version: Some(target.version + 1),
                            after_digest: Some(narrative_snapshot_digest(&after)?),
                            changed_paths: changed_paths.clone(),
                            text_impact: None,
                            structural_impact: Some(json!({
                                "changedPaths": changed_paths,
                            })),
                        });
                    }
                    let canonical_payload = canonical_payload_with_authority_context(
                        &json!({
                            "codexSourcesFixed": codex_sources_fixed,
                            "projectId": payload.project_id,
                            "snippetScenesFixed": snippet_scenes_fixed,
                            "snippetSourcesFixed": snippet_sources_fixed,
                            "semanticEpochReset": true,
                            "requiresFullRebuild": true,
                        })
                        .to_string(),
                        &authority_context,
                    );
                    let append = append_canonical_and_narrative_change_in_tx(
                        conn,
                        &payload.project_id,
                        &payload.session_id,
                        &AppendChangeEvent {
                            event_uid: payload.event_uid.clone(),
                            scene_id: None,
                            domain: "integrity".to_string(),
                            op_type: REPAIR_SOURCE_DOMAIN.to_string(),
                            entity_type: Some("project".to_string()),
                            entity_id: Some(payload.project_id.clone()),
                            payload: canonical_payload,
                            timestamp,
                        },
                        &AppendNarrativeChangeTransactionInput {
                            project_id: payload.project_id.clone(),
                            request_id: payload.request_id.clone(),
                            source_domain: REPAIR_SOURCE_DOMAIN.to_string(),
                            source_change_event_uid: payload.event_uid.clone(),
                            cause_kind: NarrativeChangeCauseKind::Forward,
                            origin: NarrativeChangeOrigin::Restore,
                            original_transaction_id: None,
                            commit_id: None,
                            journal_id: None,
                            undo_journal_id: None,
                            application_ids: Vec::new(),
                            occurred_at: payload.occurred_at.clone(),
                            events,
                        },
                    )?;
                    (
                        Some(payload.event_uid.clone()),
                        Some(append.narrative.transaction_id),
                    )
                } else {
                    (None, None)
                };

                let response = RepairIntegrityReport {
                    codex_sources_fixed,
                    snippet_sources_fixed,
                    snippet_scenes_fixed,
                    change_event_uid,
                    maintenance_transaction_id,
                };
                insert_idempotent_response(
                    conn,
                    &idempotency_request,
                    &payload.project_id,
                    &serde_json::to_value(&response)?,
                )?;
                Ok(response)
            })();

            match result {
                Ok(response) => {
                    if let Err(error) = conn.execute_batch("COMMIT") {
                        let _ = conn.execute_batch("ROLLBACK");
                        return Err(error.into());
                    }
                    Ok(response)
                }
                Err(error) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(error)
                }
            }
        })
    }
}
