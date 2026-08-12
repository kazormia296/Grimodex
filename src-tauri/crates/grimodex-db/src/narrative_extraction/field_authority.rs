//! Native-owned field authority for narrative Apply operations.
//!
//! The renderer may describe a review decision, but it cannot create a
//! wildcard or implicit override. Native derives the actor class from the
//! trusted operation identity (`created_by`), validates the small structured
//! override vocabulary, and persists the normalized grant in dedicated
//! columns.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::models::CommitOperation;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DecisionAuthority {
    pub actor_kind: String,
    pub actor_id: String,
    pub authority_scope: String,
    pub override_field_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AffectedField {
    pub entity_kind: String,
    pub entity_id: String,
    pub field_path: String,
}

pub(crate) fn derive_decision_authority(
    created_by: &str,
    decision_json: &Value,
) -> anyhow::Result<DecisionAuthority> {
    let actor_kind = classify_actor(created_by);
    if let Some(declared) = decision_json.get("actorKind").and_then(Value::as_str) {
        anyhow::ensure!(
            declared == actor_kind,
            "NEX_AUTHORITY_ACTOR_MISMATCH: declared actorKind does not match Native actor classification"
        );
    }
    let actor_id = created_by.trim();
    anyhow::ensure!(
        !actor_id.is_empty(),
        "NEX_AUTHORITY_ACTOR_MISSING: createdBy is required"
    );
    let authority_scope = decision_json
        .get("authorityScope")
        .and_then(Value::as_str)
        .unwrap_or("narrative.review")
        .trim()
        .to_string();
    anyhow::ensure!(
        !authority_scope.is_empty() && authority_scope != "*",
        "NEX_AUTHORITY_SCOPE_INVALID: authorityScope must be a concrete scope"
    );

    if decision_json.get("override").and_then(Value::as_bool) == Some(true) {
        anyhow::bail!(
            "NEX_AUTHORITY_OVERRIDE_UNTRUSTED: boolean override is not an authority grant"
        );
    }
    let mut override_field_paths = Vec::new();
    if let Some(raw_paths) = decision_json.get("overrideFieldPaths") {
        let paths = raw_paths.as_array().ok_or_else(|| {
            anyhow::anyhow!("NEX_AUTHORITY_OVERRIDE_INVALID: overrideFieldPaths must be an array")
        })?;
        for raw_path in paths {
            let path = raw_path.as_str().ok_or_else(|| {
                anyhow::anyhow!(
                    "NEX_AUTHORITY_OVERRIDE_INVALID: overrideFieldPaths entries must be strings"
                )
            })?;
            anyhow::ensure!(
                is_exact_field_path(path),
                "NEX_AUTHORITY_OVERRIDE_INVALID: overrideFieldPaths must contain exact JSON pointers"
            );
            if !override_field_paths.iter().any(|existing| existing == path) {
                override_field_paths.push(path.to_string());
            }
        }
    }
    override_field_paths.sort();
    anyhow::ensure!(
        actor_kind == "human" || override_field_paths.is_empty(),
        "NEX_AUTHORITY_OVERRIDE_FORBIDDEN: only human decisions may carry field overrides"
    );

    Ok(DecisionAuthority {
        actor_kind,
        actor_id: actor_id.to_string(),
        authority_scope,
        override_field_paths,
    })
}

pub(crate) fn load_decision_authority(
    conn: &Connection,
    proposal_id: &str,
    revision_id: &str,
) -> anyhow::Result<DecisionAuthority> {
    let row: (String, String, String, String) = conn.query_row(
        "SELECT actor_kind, actor_id, authority_scope, override_field_paths_json
           FROM narrative_proposal_decisions
          WHERE proposal_id = ?1 AND revision_id = ?2
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1",
        params![proposal_id, revision_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )?;
    let raw_paths: Value = serde_json::from_str(&row.3).map_err(|error| {
        anyhow::anyhow!(
            "NEX_AUTHORITY_STORAGE_INVALID: override field paths are not valid JSON: {error}"
        )
    })?;
    let paths = raw_paths.as_array().ok_or_else(|| {
        anyhow::anyhow!(
            "NEX_AUTHORITY_STORAGE_INVALID: override field paths must be stored as an array"
        )
    })?;
    let mut override_field_paths = Vec::with_capacity(paths.len());
    for path in paths {
        let path = path.as_str().ok_or_else(|| {
            anyhow::anyhow!("NEX_AUTHORITY_STORAGE_INVALID: override path is not a string")
        })?;
        anyhow::ensure!(
            is_exact_field_path(path),
            "NEX_AUTHORITY_STORAGE_INVALID: stored override path is not exact"
        );
        override_field_paths.push(path.to_string());
    }
    anyhow::ensure!(
        matches!(row.0.as_str(), "human" | "ai" | "system" | "unknown"),
        "NEX_AUTHORITY_STORAGE_INVALID: actor kind is unknown"
    );
    anyhow::ensure!(
        row.1.trim() != "" && row.2.trim() != "",
        "NEX_AUTHORITY_STORAGE_INVALID: actor identity or scope is empty"
    );
    anyhow::ensure!(
        row.0 == "human" || override_field_paths.is_empty(),
        "NEX_AUTHORITY_STORAGE_INVALID: non-human actor has an override grant"
    );
    Ok(DecisionAuthority {
        actor_kind: row.0,
        actor_id: row.1,
        authority_scope: row.2,
        override_field_paths,
    })
}

pub(crate) fn affected_fields(operation: &CommitOperation) -> anyhow::Result<Vec<AffectedField>> {
    let payload = &operation.payload;
    let mut fields = Vec::new();
    match operation.kind.as_str() {
        "codex.entry.create" => {
            fields.extend(object_fields(
                "codex-entry",
                required_id(payload, "entryId")?,
                payload,
                &[
                    "name", "summary", "aliases", "typeSlug", "parentId", "content",
                ],
            ));
        }
        "codex.entry.patch" => {
            let entity_id = required_id(payload, "entryId")?;
            fields.extend(present_patch_fields(
                "codex-entry",
                entity_id,
                payload,
                &[
                    ("name", "/name"),
                    ("summary", "/summary"),
                    ("aliases", "/aliases"),
                    ("typeSlug", "/type"),
                    ("parentId", "/parentId"),
                ],
            ));
        }
        "codex.relation.create" => {
            fields.extend(object_fields(
                "codex-relation",
                required_id(payload, "relationId")?,
                payload,
                &[
                    "relationType",
                    "directionality",
                    "forwardLabel",
                    "inverseLabel",
                ],
            ));
        }
        "codex.phase.create" => {
            fields.extend(object_fields(
                "codex-phase",
                required_id(payload, "phaseId")?,
                payload,
                &["label", "summaryOverride", "detailOverrides"],
            ));
        }
        "codex.phase.patch" => {
            let entity_id = required_id(payload, "phaseId")?;
            fields.extend(present_patch_fields(
                "codex-phase",
                entity_id,
                payload,
                &[("label", "/label"), ("summary", "/summary")],
            ));
            fields.extend(detail_override_fields(
                "codex-phase",
                entity_id.to_string(),
                payload,
            ));
        }
        "codex.detail.value.set" => {
            if let Some(entity_id) = payload.get("entryId").and_then(Value::as_str) {
                fields.push(AffectedField {
                    entity_kind: "codex-entry".to_string(),
                    entity_id: entity_id.to_string(),
                    field_path: format!("/details/{}", required_id(payload, "definitionId")?),
                });
            }
        }
        "codex.semantic_binding.upsert" => {
            fields.extend(object_fields(
                "codex-detail-semantic-binding",
                required_id(payload, "bindingId")?,
                payload,
                &["projectionKind", "temporalPolicy", "source", "confirmed"],
            ));
        }
        "plot.thread.create" => {
            fields.extend(object_fields(
                "plot-thread",
                required_id(payload, "threadId")?,
                payload,
                &["name", "description", "color", "sortOrder"],
            ));
        }
        "plot.thread.patch" => {
            fields.extend(present_patch_fields(
                "plot-thread",
                required_id(payload, "threadId")?,
                payload,
                &[
                    ("name", "/name"),
                    ("description", "/description"),
                    ("color", "/color"),
                    ("sortOrder", "/sortOrder"),
                    ("startNodeId", "/startNodeId"),
                    ("endNodeId", "/endNodeId"),
                ],
            ));
        }
        "foreshadow.aggregate.create" => {
            fields.extend(object_fields(
                "foreshadow",
                required_id(payload, "foreshadowId")?,
                payload,
                &[
                    "title",
                    "intent",
                    "mechanism",
                    "secret",
                    "setups",
                    "payoffs",
                ],
            ));
        }
        "foreshadow.aggregate.patch" => {
            fields.extend(present_patch_fields(
                "foreshadow",
                required_id(payload, "foreshadowId")?,
                payload,
                &[("intent", "/intent"), ("mechanism", "/mechanism")],
            ));
            for (key, path) in [
                ("addSetups", "/setups"),
                ("addPayoffs", "/payoffs"),
                ("addSupportEdges", "/supportEdges"),
                ("addCodexEntryIds", "/codexEntryIds"),
            ] {
                if payload
                    .get(key)
                    .and_then(Value::as_array)
                    .is_some_and(|values| !values.is_empty())
                {
                    fields.push(AffectedField {
                        entity_kind: "foreshadow".to_string(),
                        entity_id: required_id(payload, "foreshadowId")?.to_string(),
                        field_path: path.to_string(),
                    });
                }
            }
        }
        "temporal.scene.metadata.patch" => {
            fields.extend(temporal_fields("scene", payload, "sceneId")?);
        }
        "temporal.event.metadata.patch" => {
            fields.extend(temporal_fields("event", payload, "eventId")?);
        }
        "temporal.story-order.materialize" => fields.push(AffectedField {
            entity_kind: "project".to_string(),
            entity_id: required_id(payload, "projectId")?.to_string(),
            field_path: "/storyOrder".to_string(),
        }),
        _ => {}
    }
    Ok(fields)
}

pub(crate) fn validate_operation_field_authority(
    conn: &Connection,
    project_id: &str,
    applications: &[(String, String)],
    operations: &[CommitOperation],
) -> anyhow::Result<()> {
    anyhow::ensure!(
        applications.len() == operations.len(),
        "NEX_FIELD_AUTHORITY_OPERATION_MISMATCH: applications and operations must align"
    );
    for (operation, (proposal_id, revision_id)) in operations.iter().zip(applications) {
        let authority = load_decision_authority(conn, proposal_id, revision_id)?;
        for field in affected_fields(operation)? {
            let owned: Option<(String, i64)> = conn
                .query_row(
                    "SELECT owner_kind, explicit_lock
                       FROM narrative_field_authority
                      WHERE project_id = ?1 AND entity_kind = ?2
                        AND entity_id = ?3 AND field_path = ?4",
                    params![
                        project_id,
                        field.entity_kind,
                        field.entity_id,
                        field.field_path
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let legacy_human = owned.is_none()
                && legacy_value_present(
                    conn,
                    project_id,
                    &field.entity_kind,
                    &field.entity_id,
                    &field.field_path,
                )?;
            let explicitly_locked = owned
                .as_ref()
                .is_some_and(|(_, explicit_lock)| *explicit_lock != 0);
            let human_owned =
                owned.as_ref().is_some_and(|(owner, _)| owner == "human") || legacy_human;
            let exact_override = authority
                .override_field_paths
                .iter()
                .any(|path| path == &field.field_path);
            let denied = (explicitly_locked
                && (authority.actor_kind != "human" || !exact_override))
                || (!explicitly_locked && human_owned && authority.actor_kind != "human");
            if denied {
                anyhow::bail!(
                    "NEX_FIELD_AUTHORITY_DENIED: '{}' on {} '{}' is human-owned or locked",
                    field.field_path,
                    field.entity_kind,
                    field.entity_id
                );
            }
        }
    }
    Ok(())
}

pub(crate) fn record_operation_field_authority(
    conn: &Connection,
    project_id: &str,
    applications: &[(String, String)],
    operations: &[CommitOperation],
    updated_at: &str,
) -> anyhow::Result<()> {
    for (operation, (proposal_id, revision_id)) in operations.iter().zip(applications) {
        let authority = load_decision_authority(conn, proposal_id, revision_id)?;
        for field in affected_fields(operation)? {
            conn.execute(
                "INSERT INTO narrative_field_authority
                    (project_id, entity_kind, entity_id, field_path, owner_kind,
                     explicit_lock, version, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6)
                 ON CONFLICT(project_id, entity_kind, entity_id, field_path)
                 DO UPDATE SET owner_kind = CASE
                         WHEN narrative_field_authority.owner_kind = 'human'
                         THEN 'human' ELSE excluded.owner_kind END,
                     version = narrative_field_authority.version + 1,
                     updated_at = excluded.updated_at",
                params![
                    project_id,
                    field.entity_kind,
                    field.entity_id,
                    field.field_path,
                    authority.actor_kind,
                    updated_at,
                ],
            )?;
        }
    }
    Ok(())
}

fn classify_actor(created_by: &str) -> String {
    let normalized = created_by.trim().to_ascii_lowercase();
    if normalized.starts_with("agent:")
        || normalized == "codex-structure-extract"
        || normalized.starts_with("background-")
    {
        "ai".to_string()
    } else if normalized.starts_with("system:") {
        "system".to_string()
    } else {
        "human".to_string()
    }
}

fn is_exact_field_path(path: &str) -> bool {
    !path.is_empty()
        && path.starts_with('/')
        && !path.contains('*')
        && !path.contains("//")
        && !path.ends_with('/')
}

fn required_id<'a>(payload: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("NEX_FIELD_AUTHORITY_PAYLOAD_INVALID: {key} is required"))
}

fn object_fields(
    entity_kind: &str,
    entity_id: &str,
    payload: &Value,
    keys: &[&str],
) -> Vec<AffectedField> {
    keys.iter()
        .filter(|key| payload.get(**key).is_some())
        .map(|key| AffectedField {
            entity_kind: entity_kind.to_string(),
            entity_id: entity_id.to_string(),
            field_path: format!("/{key}"),
        })
        .collect()
}

fn present_patch_fields(
    entity_kind: &str,
    entity_id: &str,
    payload: &Value,
    keys: &[(&str, &str)],
) -> Vec<AffectedField> {
    keys.iter()
        .filter(|(key, _)| {
            payload
                .get(*key)
                .and_then(Value::as_object)
                .and_then(|object| object.get("kind"))
                .and_then(Value::as_str)
                .is_some_and(|kind| kind != "leave")
        })
        .map(|(_, path)| AffectedField {
            entity_kind: entity_kind.to_string(),
            entity_id: entity_id.to_string(),
            field_path: (*path).to_string(),
        })
        .collect()
}

fn detail_override_fields(
    entity_kind: &str,
    entity_id: String,
    payload: &Value,
) -> Vec<AffectedField> {
    payload
        .get("detailOverrides")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("definitionId").and_then(Value::as_str))
        .map(|definition_id| AffectedField {
            entity_kind: entity_kind.to_string(),
            entity_id: entity_id.clone(),
            field_path: format!("/details/{definition_id}"),
        })
        .collect()
}

fn temporal_fields(
    entity_kind: &str,
    payload: &Value,
    id_key: &str,
) -> anyhow::Result<Vec<AffectedField>> {
    let entity_id = required_id(payload, id_key)?;
    Ok([
        "/startTime",
        "/startMinute",
        "/startGranularity",
        "/endTime",
        "/endMinute",
        "/endGranularity",
        "/precision",
    ]
    .into_iter()
    .map(|field_path| AffectedField {
        entity_kind: entity_kind.to_string(),
        entity_id: entity_id.to_string(),
        field_path: field_path.to_string(),
    })
    .collect())
}

fn legacy_value_present(
    conn: &Connection,
    project_id: &str,
    entity_kind: &str,
    entity_id: &str,
    field_path: &str,
) -> anyhow::Result<bool> {
    let column = match (entity_kind, field_path) {
        ("codex-entry", "/name") => Some("name"),
        ("codex-entry", "/summary") => Some("summary"),
        ("codex-entry", "/aliases") => Some("aliases"),
        ("codex-entry", "/type") => Some("type"),
        ("codex-entry", "/parentId") => Some("parent_id"),
        ("event", "/precision") => Some("precision"),
        ("scene", "/startTime") => Some("chronicle_start_time"),
        _ => None,
    };
    let Some(column) = column else {
        return Ok(false);
    };
    let sql = format!(
        "SELECT EXISTS(
             SELECT 1 FROM {} WHERE id = ?1 AND project_id = ?2
               AND NULLIF(TRIM(CAST({column} AS TEXT)), '') IS NOT NULL
         )",
        match entity_kind {
            "codex-entry" => "codex_entries",
            "event" => "events",
            "scene" => "tree_nodes",
            _ => return Ok(false),
        }
    );
    Ok(conn.query_row(&sql, params![entity_id, project_id], |row| row.get(0))?)
}
