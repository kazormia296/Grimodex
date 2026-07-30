//! Typed aggregate writes used by renderer features that previously assembled
//! SQL batches. Each command owns its SQL, transaction boundary, and project
//! checks here; renderer payloads contain domain data only.

use std::collections::HashSet;

use rusqlite::{params, OptionalExtension, Transaction};
use serde::Deserialize;

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
}

pub fn undo_codex_rename(db: &Database, payload: CodexRenameUndoPayload) -> anyhow::Result<()> {
    require_non_empty(&payload.project_id, "projectId")?;
    require_non_empty(&payload.updated_at, "updatedAt")?;
    let mut update_keys = HashSet::new();
    for update in &payload.updates {
        require_non_empty(&update.ref_id, "updates[].refId")?;
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
            anyhow::bail!("codex rename undo updates must be unique");
        }
    }

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for update in payload.updates {
            let changed = match update.kind.as_str() {
                "scene-body" => {
                    let char_count =
                        update
                            .char_count
                            .filter(|count| *count >= 0)
                            .ok_or_else(|| {
                                anyhow::anyhow!("scene-body undo requires a non-negative charCount")
                            })?;
                    tx.execute(
                        "UPDATE tree_nodes
                            SET content = ?1, char_count = ?2,
                                placed_beat_preview = ?3,
                                version = version + 1, updated_at = ?4
                          WHERE id = ?5 AND project_id = ?6
                            AND node_type = 'scene'",
                        params![
                            update.value,
                            char_count,
                            update.placed_beat_preview,
                            payload.updated_at,
                            update.ref_id,
                            payload.project_id
                        ],
                    )?
                }
                "node-title" => tx.execute(
                    "UPDATE tree_nodes SET title = ?1, updated_at = ?2
                      WHERE id = ?3 AND project_id = ?4",
                    params![
                        update.value,
                        payload.updated_at,
                        update.ref_id,
                        payload.project_id
                    ],
                )?,
                "node-synopsis" => tx.execute(
                    "UPDATE tree_nodes SET synopsis = ?1, updated_at = ?2
                      WHERE id = ?3 AND project_id = ?4",
                    params![
                        update.value,
                        payload.updated_at,
                        update.ref_id,
                        payload.project_id
                    ],
                )?,
                "codex-summary" | "codex-content" | "codex-notes" => {
                    let column = match update.kind.as_str() {
                        "codex-summary" => "summary",
                        "codex-content" => "content",
                        "codex-notes" => "notes",
                        _ => unreachable!("kind matched above"),
                    };
                    tx.execute(
                        &format!(
                            "UPDATE codex_entries
                                SET {column} = ?1, updated_at = ?2
                              WHERE id = ?3 AND project_id = ?4"
                        ),
                        params![
                            update.value,
                            payload.updated_at,
                            update.ref_id,
                            payload.project_id
                        ],
                    )?
                }
                "codex-detail" => tx.execute(
                    "UPDATE codex_detail_values
                        SET value = ?1
                      WHERE entry_id = ?2 AND definition_id = ?3
                        AND EXISTS (
                          SELECT 1 FROM codex_entries
                           WHERE id = ?2 AND project_id = ?4
                        )",
                    params![
                        update.value,
                        update.ref_id,
                        update.detail_definition_id,
                        payload.project_id
                    ],
                )?,
                "codex-relation-label" => tx.execute(
                    "UPDATE codex_relations SET label = ?1
                      WHERE id = ?2 AND project_id = ?3",
                    params![update.value, update.ref_id, payload.project_id],
                )?,
                _ => anyhow::bail!("unsupported codex rename undo kind '{}'", update.kind),
            };
            if changed != 1 {
                anyhow::bail!(
                    "codex rename undo target '{}' is not in project '{}'",
                    update.ref_id,
                    payload.project_id
                );
            }
        }
        tx.commit()?;
        Ok(())
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
}
