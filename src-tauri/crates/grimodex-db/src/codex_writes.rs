//! Native trusted writers for the human/legacy Codex surface.
//!
//! Reads remain renderer-owned projections, but every mutation of the Codex
//! aggregates crosses this module.  The payload deliberately contains data,
//! not SQL, so the renderer cannot bypass the writer boundary.

use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::codex_relation_keys::{build_codex_relation_semantic_key, normalize_relation_label};
use crate::Database;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodexMutationPayload {
    pub operation: String,
    pub project_id: String,
    pub session_id: String,
    #[serde(default)]
    pub surface: Option<String>,
    #[serde(flatten)]
    pub fields: Map<String, Value>,
}

fn required_string(fields: &Map<String, Value>, key: &str) -> anyhow::Result<String> {
    let value = fields
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("{key} is required"))?;
    Ok(value.to_string())
}

fn optional_string(fields: &Map<String, Value>, key: &str) -> anyhow::Result<Option<String>> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_str()
            .map(|value| Some(value.to_string()))
            .ok_or_else(|| anyhow::anyhow!("{key} must be a string or null")),
    }
}

fn optional_i64(fields: &Map<String, Value>, key: &str) -> anyhow::Result<Option<i64>> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("{key} must be an integer")),
        Some(_value) => Err(anyhow::anyhow!("{key} must be an integer or null")),
    }
}

fn required_i64(fields: &Map<String, Value>, key: &str) -> anyhow::Result<i64> {
    optional_i64(fields, key)?.ok_or_else(|| anyhow::anyhow!("{key} is required"))
}

fn optional_bool_int(fields: &Map<String, Value>, key: &str) -> anyhow::Result<Option<i64>> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(i64::from(*value))),
        Some(Value::Number(value)) => value
            .as_i64()
            .filter(|value| *value == 0 || *value == 1)
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("{key} must be a boolean or 0/1")),
        Some(_value) => Err(anyhow::anyhow!("{key} must be a boolean or 0/1")),
    }
}

fn nullable_sql_string(
    fields: &Map<String, Value>,
    key: &str,
    current: Option<String>,
) -> anyhow::Result<Option<String>> {
    if fields.contains_key(key) {
        optional_string(fields, key)
    } else {
        Ok(current)
    }
}

fn object_array<'a>(
    fields: &'a Map<String, Value>,
    key: &str,
) -> anyhow::Result<Vec<&'a Map<String, Value>>> {
    let Some(value) = fields.get(key) else {
        return Ok(Vec::new());
    };
    let Some(items) = value.as_array() else {
        anyhow::bail!("{key} must be an array");
    };
    items
        .iter()
        .map(|item| {
            item.as_object()
                .ok_or_else(|| anyhow::anyhow!("{key} items must be objects"))
        })
        .collect()
}

fn optional_object<'a>(
    fields: &'a Map<String, Value>,
    key: &str,
) -> anyhow::Result<Option<&'a Map<String, Value>>> {
    match fields.get(key) {
        None => Ok(None),
        Some(value) => value
            .as_object()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("{key} must be an object")),
    }
}

fn ensure_entry_in_project(
    conn: &Connection,
    entry_id: &str,
    project_id: &str,
) -> anyhow::Result<()> {
    let owned: i64 = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM codex_entries WHERE id = ?1 AND project_id = ?2
         )",
        params![entry_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        owned == 1,
        "codex entry '{entry_id}' is not in project '{project_id}'"
    );
    Ok(())
}

fn ensure_scene_in_project(
    conn: &Connection,
    scene_id: &str,
    project_id: &str,
) -> anyhow::Result<()> {
    let owned: i64 = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM tree_nodes
             WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'
         )",
        params![scene_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        owned == 1,
        "phase anchor '{scene_id}' is not a scene in project '{project_id}'"
    );
    Ok(())
}

fn ensure_definition_in_project(
    conn: &Connection,
    definition_id: &str,
    project_id: &str,
) -> anyhow::Result<()> {
    let owned: i64 = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM codex_detail_definitions
             WHERE id = ?1 AND project_id = ?2
         )",
        params![definition_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        owned == 1,
        "detail definition '{definition_id}' is not in project '{project_id}'"
    );
    Ok(())
}

fn ensure_phase_in_project(
    conn: &Connection,
    phase_id: &str,
    project_id: &str,
) -> anyhow::Result<()> {
    let owned: i64 = conn.query_row(
        "SELECT EXISTS(
            SELECT 1
              FROM codex_entry_phases phase
              JOIN codex_entries entry ON entry.id = phase.entry_id
             WHERE phase.id = ?1 AND entry.project_id = ?2
         )",
        params![phase_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        owned == 1,
        "phase '{phase_id}' is not in project '{project_id}'"
    );
    Ok(())
}

fn write_result(entity_id: String, version: i64, change_event_uid: String) -> Value {
    json!({
        "entityId": entity_id,
        "version": version,
        "changeEventUid": change_event_uid,
    })
}

fn record_manual_mutation_fields(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    operation: &str,
    entity_id: &str,
    updated_at: &str,
) -> anyhow::Result<()> {
    // `surface` is the trusted route selector for this legacy command. AI/MCP
    // callers may reuse the mutation implementation, but they must not become
    // human owners merely by writing a renderer-controlled field.
    if payload.surface.as_deref() != Some("manual") {
        return Ok(());
    }
    match operation {
        "relation.create" | "relation.delete" => crate::narrative_extraction::record_human_field_write(
            conn,
            &payload.project_id,
            "codex-relation",
            entity_id,
            &[
                "/fromCodexId",
                "/toCodexId",
                "/relationType",
                "/directionality",
                "/forwardLabel",
                "/inverseLabel",
                "/semanticKey",
            ],
            updated_at,
        ),
        "phase.create" | "phase.update" | "phase.aggregate" | "phase.delete" => {
            crate::narrative_extraction::record_human_field_write(
                conn,
                &payload.project_id,
                "codex-phase",
                entity_id,
                &[
                    "/label",
                    "/anchorNodeId",
                    "/summaryOverride",
                    "/contentOverride",
                    "/contextModeOverride",
                    "/detailOverrides",
                ],
                updated_at,
            )
        }
        "detail.definition.create" | "detail.definition.update" | "detail.definition.delete" => {
            crate::narrative_extraction::record_human_field_write(
                conn,
                &payload.project_id,
                "codex-detail-definition",
                entity_id,
                &[
                    "/typeSlug",
                    "/name",
                    "/fieldType",
                    "/fieldConfig",
                    "/sortOrder",
                    "/includeInContext",
                ],
                updated_at,
            )?;
            if let Some(binding) = payload.fields.get("semanticBinding").and_then(Value::as_object)
            {
                if let Some(binding_id) = binding.get("id").and_then(Value::as_str) {
                    crate::narrative_extraction::record_human_field_write(
                        conn,
                        &payload.project_id,
                        "codex-detail-semantic-binding",
                        binding_id,
                        &[
                            "/definitionId",
                            "/facetKey",
                            "/projectionKind",
                            "/temporalPolicy",
                            "/source",
                            "/confirmed",
                        ],
                        updated_at,
                    )?;
                }
            }
            Ok(())
        }
        "detail.value.upsert" => {
            let definition_id = required_string(&payload.fields, "definitionId")?;
            let path = format!("/details/{definition_id}");
            crate::narrative_extraction::record_human_field_write(
                conn,
                &payload.project_id,
                "codex-entry",
                &required_string(&payload.fields, "entryId")?,
                &[path.as_str()],
                updated_at,
            )
        }
        other => anyhow::bail!("unsupported manual Codex authority operation '{other}'"),
    }
}

fn run_mutation<F>(
    db: &Database,
    payload: AgentCodexMutationPayload,
    operation: &'static str,
    mutate: F,
) -> anyhow::Result<Value>
where
    F: FnOnce(&Connection, &AgentCodexMutationPayload, &str) -> anyhow::Result<(String, i64)>,
{
    anyhow::ensure!(
        !payload.project_id.trim().is_empty(),
        "projectId is required"
    );
    anyhow::ensure!(
        !payload.session_id.trim().is_empty(),
        "sessionId is required"
    );
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();
    let now = chrono::Utc::now().to_rfc3339();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            let (entity_id, version) = mutate(conn, &payload, &event_uid)?;
            record_manual_mutation_fields(conn, &payload, operation, &entity_id, &now)?;
            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "codex".to_string(),
                    op_type: operation.to_string(),
                    entity_type: Some(operation.split('.').next().unwrap_or("codex").to_string()),
                    entity_id: Some(entity_id.clone()),
                    payload: json!({
                        "surface": payload.surface.as_deref().unwrap_or("manual"),
                        "operation": operation,
                    })
                    .to_string(),
                    timestamp,
                }],
            )?;
            Ok(write_result(entity_id, version, event_uid.clone()))
        })();
        match result {
            Ok(value) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

fn relation_create(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let relation_id = required_string(&payload.fields, "relationId")?;
    let from_id = required_string(&payload.fields, "fromCodexId")?;
    let to_id = required_string(&payload.fields, "toCodexId")?;
    anyhow::ensure!(from_id != to_id, "from and to must differ");
    ensure_entry_in_project(conn, &from_id, &payload.project_id)?;
    ensure_entry_in_project(conn, &to_id, &payload.project_id)?;
    let relation_type =
        optional_string(&payload.fields, "relationType")?.unwrap_or_else(|| "custom".to_string());
    let directionality = optional_string(&payload.fields, "directionality")?
        .unwrap_or_else(|| "directed".to_string());
    anyhow::ensure!(
        directionality == "directed" || directionality == "symmetric",
        "invalid directionality"
    );
    let forward =
        normalize_relation_label(&optional_string(&payload.fields, "label")?.unwrap_or_default());
    anyhow::ensure!(!forward.is_empty(), "label is required");
    let inverse = optional_string(&payload.fields, "inverseLabel")?
        .map(|value| normalize_relation_label(&value))
        .filter(|value| !value.is_empty());
    let inverse = if directionality == "symmetric" {
        let value = inverse.unwrap_or_else(|| forward.clone());
        anyhow::ensure!(value == forward, "symmetric relation labels must match");
        Some(value)
    } else {
        inverse
    };
    let semantic_key = build_codex_relation_semantic_key(
        &payload.project_id,
        &from_id,
        &to_id,
        &relation_type,
        &directionality,
        &forward,
        inverse.as_deref(),
    );
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO codex_relations
            (id, project_id, from_codex_id, to_codex_id, relation_type, label,
             directionality, inverse_label, semantic_key, version, depth_hint,
             source_map_edge_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12, ?12)",
        params![
            relation_id,
            payload.project_id,
            from_id,
            to_id,
            relation_type,
            forward,
            directionality,
            inverse,
            semantic_key,
            optional_i64(&payload.fields, "depthHint")?,
            optional_string(&payload.fields, "sourceMapEdgeId")?,
            now,
        ],
    )?;
    Ok((relation_id, 1))
}

fn relation_delete(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let relation_id = required_string(&payload.fields, "relationId")?;
    let deleted = conn.execute(
        "DELETE FROM codex_relations WHERE id = ?1 AND project_id = ?2",
        params![relation_id, payload.project_id],
    )?;
    anyhow::ensure!(deleted == 1, "codex relation '{relation_id}' not found");
    Ok((relation_id, 0))
}

fn phase_create(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let phase_id = required_string(&payload.fields, "phaseId")?;
    let entry_id = required_string(&payload.fields, "entryId")?;
    ensure_entry_in_project(conn, &entry_id, &payload.project_id)?;
    let anchor = optional_string(&payload.fields, "anchorNodeId")?;
    if let Some(anchor_id) = anchor.as_deref() {
        ensure_scene_in_project(conn, anchor_id, &payload.project_id)?;
    }
    let label = optional_string(&payload.fields, "label")?.unwrap_or_default();
    let now = optional_string(&payload.fields, "createdAt")?
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    conn.execute(
        "INSERT INTO codex_entry_phases
            (id, entry_id, anchor_node_id, label, summary_override,
             content_override, context_mode_override, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            phase_id,
            entry_id,
            anchor,
            label,
            optional_string(&payload.fields, "summaryOverride")?,
            optional_string(&payload.fields, "contentOverride")?,
            optional_string(&payload.fields, "contextModeOverride")?,
            optional_i64(&payload.fields, "version")?.unwrap_or(0),
            now,
        ],
    )?;
    replace_phase_overrides(conn, &phase_id, &payload.project_id, &payload.fields)?;
    Ok((
        phase_id,
        optional_i64(&payload.fields, "version")?.unwrap_or(0),
    ))
}

fn replace_phase_overrides(
    conn: &Connection,
    phase_id: &str,
    project_id: &str,
    fields: &Map<String, Value>,
) -> anyhow::Result<()> {
    if !fields.contains_key("detailOverrides") {
        return Ok(());
    }
    conn.execute(
        "DELETE FROM codex_phase_detail_overrides WHERE phase_id = ?1",
        params![phase_id],
    )?;
    for item in object_array(fields, "detailOverrides")? {
        let definition_id = required_string(item, "definitionId")?;
        ensure_definition_in_project(conn, &definition_id, project_id)?;
        conn.execute(
            "INSERT INTO codex_phase_detail_overrides (phase_id, definition_id, value)
             VALUES (?1, ?2, ?3)",
            params![phase_id, definition_id, optional_string(item, "value")?],
        )?;
    }
    Ok(())
}

type PhasePatchCurrentRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    i64,
);

fn phase_patch(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let phase_id = required_string(&payload.fields, "phaseId")?;
    let base_version = required_i64(&payload.fields, "baseVersion")?;
    let current: PhasePatchCurrentRow = conn.query_row(
        "SELECT entry_id, label, anchor_node_id, summary_override, content_override,
                    context_mode_override, version
             FROM codex_entry_phases phase
             JOIN codex_entries entry ON entry.id = phase.entry_id
              AND entry.project_id = ?2
             WHERE phase.id = ?1",
        params![phase_id, payload.project_id],
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
    anyhow::ensure!(current.6 == base_version, "phase version conflict");
    let label = if payload.fields.contains_key("label") {
        optional_string(&payload.fields, "label")?.unwrap_or_default()
    } else {
        current.1
    };
    let anchor = nullable_sql_string(&payload.fields, "anchorNodeId", current.2)?;
    if let Some(anchor_id) = anchor.as_deref() {
        ensure_scene_in_project(conn, anchor_id, &payload.project_id)?;
    }
    let summary = nullable_sql_string(&payload.fields, "summaryOverride", current.3)?;
    let content = nullable_sql_string(&payload.fields, "contentOverride", current.4)?;
    let context = nullable_sql_string(&payload.fields, "contextModeOverride", current.5)?;
    let next_version = base_version + 1;
    let updated = conn.execute(
        "UPDATE codex_entry_phases
            SET label = ?1, anchor_node_id = ?2, summary_override = ?3,
                content_override = ?4, context_mode_override = ?5,
                version = ?6, updated_at = ?7
          WHERE id = ?8 AND version = ?9",
        params![
            label,
            anchor,
            summary,
            content,
            context,
            next_version,
            chrono::Utc::now().to_rfc3339(),
            phase_id,
            base_version,
        ],
    )?;
    anyhow::ensure!(updated == 1, "phase version conflict");
    replace_phase_overrides(conn, &phase_id, &payload.project_id, &payload.fields)?;
    Ok((phase_id, next_version))
}

fn phase_delete(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let phase_id = required_string(&payload.fields, "phaseId")?;
    ensure_phase_in_project(conn, &phase_id, &payload.project_id)?;
    let expected = optional_i64(&payload.fields, "expectedVersion")?;
    let deleted = match expected {
        Some(version) => conn.execute(
            "DELETE FROM codex_entry_phases
              WHERE id = ?1 AND version = ?2
                AND EXISTS (
                    SELECT 1
                      FROM codex_entries entry
                     WHERE entry.id = codex_entry_phases.entry_id
                       AND entry.project_id = ?3
                )",
            params![phase_id, version, payload.project_id],
        )?,
        None => conn.execute(
            "DELETE FROM codex_entry_phases
              WHERE id = ?1
                AND EXISTS (
                    SELECT 1
                      FROM codex_entries entry
                     WHERE entry.id = codex_entry_phases.entry_id
                       AND entry.project_id = ?2
                )",
            params![phase_id, payload.project_id],
        )?,
    };
    anyhow::ensure!(
        deleted == 1,
        "phase '{phase_id}' version conflict or not found"
    );
    Ok((phase_id, 0))
}

fn definition_create(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let definition_id = required_string(&payload.fields, "definitionId")?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO codex_detail_definitions
            (id, project_id, type_slug, name, field_type, field_config,
             sort_order, include_in_context, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)",
        params![
            definition_id,
            payload.project_id,
            required_string(&payload.fields, "typeSlug")?,
            required_string(&payload.fields, "name")?,
            optional_string(&payload.fields, "fieldType")?.unwrap_or_else(|| "text".to_string()),
            optional_string(&payload.fields, "fieldConfig")?,
            optional_f64(&payload.fields, "sortOrder")?.unwrap_or(0.0),
            optional_bool_int(&payload.fields, "includeInContext")?.unwrap_or(0),
            now,
        ],
    )?;
    if let Some(binding) = optional_object(&payload.fields, "semanticBinding")? {
        conn.execute(
            "INSERT INTO codex_detail_semantic_bindings
                (id, project_id, definition_id, facet_key, projection_kind,
                 temporal_policy, source, confirmed, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)",
            params![
                required_string(binding, "id")?,
                payload.project_id,
                definition_id,
                required_string(binding, "facetKey")?,
                required_string(binding, "projectionKind")?,
                required_string(binding, "temporalPolicy")?,
                required_string(binding, "source")?,
                optional_bool_int(binding, "confirmed")?.unwrap_or(0),
                now,
            ],
        )?;
    }
    Ok((definition_id, 0))
}

fn optional_f64(fields: &Map<String, Value>, key: &str) -> anyhow::Result<Option<f64>> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("{key} must be a number")),
        Some(_value) => Err(anyhow::anyhow!("{key} must be a number or null")),
    }
}

fn definition_update(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let definition_id = required_string(&payload.fields, "definitionId")?;
    ensure_definition_in_project(conn, &definition_id, &payload.project_id)?;
    let base_version = required_i64(&payload.fields, "baseVersion")?;
    let mut assignments = Vec::new();
    let mut values = Vec::new();
    for (key, column) in [
        ("name", "name"),
        ("fieldType", "field_type"),
        ("fieldConfig", "field_config"),
    ] {
        if payload.fields.contains_key(key) {
            assignments.push(format!("{column} = ?"));
            values.push(match optional_string(&payload.fields, key)? {
                Some(value) => SqlValue::Text(value),
                None => SqlValue::Null,
            });
        }
    }
    if payload.fields.contains_key("sortOrder") {
        assignments.push("sort_order = ?".to_string());
        values.push(match optional_f64(&payload.fields, "sortOrder")? {
            Some(value) => SqlValue::Real(value),
            None => SqlValue::Null,
        });
    }
    if payload.fields.contains_key("includeInContext") {
        assignments.push("include_in_context = ?".to_string());
        values.push(SqlValue::Integer(
            optional_bool_int(&payload.fields, "includeInContext")?.unwrap_or(0),
        ));
    }
    anyhow::ensure!(!assignments.is_empty(), "definition update has no fields");
    let next_version = base_version + 1;
    assignments.push("version = ?".to_string());
    values.push(SqlValue::Integer(next_version));
    assignments.push("updated_at = ?".to_string());
    values.push(SqlValue::Text(chrono::Utc::now().to_rfc3339()));
    values.push(SqlValue::Text(definition_id.clone()));
    values.push(SqlValue::Text(payload.project_id.clone()));
    values.push(SqlValue::Integer(base_version));
    let sql = format!(
        "UPDATE codex_detail_definitions
            SET {}
          WHERE id = ? AND project_id = ? AND version = ?",
        assignments.join(", ")
    );
    let updated = conn.execute(&sql, params_from_iter(values.iter()))?;
    anyhow::ensure!(updated == 1, "detail definition version conflict");
    Ok((definition_id, next_version))
}

fn definition_delete(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let definition_id = required_string(&payload.fields, "definitionId")?;
    let deleted = conn.execute(
        "DELETE FROM codex_detail_definitions WHERE id = ?1 AND project_id = ?2",
        params![definition_id, payload.project_id],
    )?;
    anyhow::ensure!(
        deleted == 1,
        "detail definition '{definition_id}' not found"
    );
    Ok((definition_id, 0))
}

fn value_upsert(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let entry_id = required_string(&payload.fields, "entryId")?;
    let definition_id = required_string(&payload.fields, "definitionId")?;
    ensure_entry_in_project(conn, &entry_id, &payload.project_id)?;
    ensure_definition_in_project(conn, &definition_id, &payload.project_id)?;
    let value = optional_string(&payload.fields, "value")?;
    let now = chrono::Utc::now().to_rfc3339();
    let existing: Option<(String, i64)> = conn
        .query_row(
            "SELECT id, version FROM codex_detail_values
             WHERE entry_id = ?1 AND definition_id = ?2",
            params![entry_id, definition_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (id, version) = match existing {
        None => {
            let id = optional_string(&payload.fields, "valueId")?
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            conn.execute(
                "INSERT INTO codex_detail_values
                    (id, entry_id, definition_id, value, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
                params![id, entry_id, definition_id, value, now],
            )?;
            (id, 1)
        }
        Some((id, live_version)) => {
            let base_version = required_i64(&payload.fields, "baseVersion")?;
            anyhow::ensure!(
                base_version == live_version,
                "detail value version conflict"
            );
            let version = base_version + 1;
            let updated = conn.execute(
                "UPDATE codex_detail_values
                    SET value = ?1, version = ?2, updated_at = ?3
                  WHERE id = ?4 AND version = ?5",
                params![value, version, now, id, base_version],
            )?;
            anyhow::ensure!(updated == 1, "detail value version conflict");
            (id, version)
        }
    };
    Ok((id, version))
}

pub fn agent_codex_mutate_impl(
    db: &Database,
    payload: AgentCodexMutationPayload,
) -> anyhow::Result<Value> {
    let operation = payload.operation.clone();
    match operation.as_str() {
        "relation.create" => run_mutation(db, payload, "relation.create", relation_create),
        "relation.delete" => run_mutation(db, payload, "relation.delete", relation_delete),
        "phase.create" => run_mutation(db, payload, "phase.create", phase_create),
        "phase.update" | "phase.aggregate" => {
            run_mutation(db, payload, "phase.update", phase_patch)
        }
        "phase.delete" => run_mutation(db, payload, "phase.delete", phase_delete),
        "detail.definition.create" => {
            run_mutation(db, payload, "detail.definition.create", definition_create)
        }
        "detail.definition.update" => {
            run_mutation(db, payload, "detail.definition.update", definition_update)
        }
        "detail.definition.delete" => {
            run_mutation(db, payload, "detail.definition.delete", definition_delete)
        }
        "detail.value.upsert" => run_mutation(db, payload, "detail.value.upsert", value_upsert),
        other => anyhow::bail!("unsupported Codex mutation '{other}'"),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open database");
        db.migrate().expect("migrate database");
        db.with_conn(|conn| {
            conn.execute_batch(
                "INSERT INTO projects (id, title) VALUES ('p1', 'One'), ('p2', 'Two');
                 INSERT INTO codex_types (id, project_id, slug, label)
                   VALUES ('t1', 'p1', 'person', 'Person'),
                          ('t2', 'p2', 'person', 'Person');
                 INSERT INTO codex_entries (id, project_id, type, name)
                   VALUES ('e1', 'p1', 'person', 'One'),
                          ('e2', 'p2', 'person', 'Two');
                 INSERT INTO codex_detail_definitions
                   (id, project_id, type_slug, name)
                   VALUES ('d1', 'p1', 'person', 'One detail'),
                          ('d2', 'p2', 'person', 'Two detail');
                 INSERT INTO tree_nodes (id, project_id, node_type, title)
                   VALUES ('scene1', 'p1', 'scene', 'One scene'),
                          ('folder1', 'p1', 'folder', 'One folder'),
                          ('scene2', 'p2', 'scene', 'Two scene');",
            )?;
            Ok(())
        })
        .expect("seed database");
        db
    }

    fn mutation(
        project_id: &str,
        operation: &str,
        fields: serde_json::Value,
    ) -> AgentCodexMutationPayload {
        AgentCodexMutationPayload {
            operation: operation.to_string(),
            project_id: project_id.to_string(),
            session_id: "session".to_string(),
            surface: Some("manual".to_string()),
            fields: fields.as_object().expect("object fields").clone(),
        }
    }

    #[test]
    fn relation_create_rejects_cross_project_entries() {
        let db = test_db();
        let result = agent_codex_mutate_impl(
            &db,
            mutation(
                "p1",
                "relation.create",
                json!({
                    "relationId": "r1",
                    "fromCodexId": "e1",
                    "toCodexId": "e2",
                    "label": "knows",
                }),
            ),
        );

        assert!(result.is_err());
        assert_eq!(
            db.with_conn(|conn| {
                Ok(
                    conn.query_row("SELECT COUNT(*) FROM codex_relations", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                )
            })
            .expect("count relations"),
            0
        );
    }

    #[test]
    fn phase_create_rejects_cross_project_entry() {
        let db = test_db();
        let result = agent_codex_mutate_impl(
            &db,
            mutation(
                "p1",
                "phase.create",
                json!({
                    "phaseId": "phase-2",
                    "entryId": "e2",
                    "label": "foreign",
                }),
            ),
        );

        assert!(result.is_err());
        assert_eq!(
            db.with_conn(|conn| {
                Ok(
                    conn.query_row("SELECT COUNT(*) FROM codex_entry_phases", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                )
            })
            .expect("count phases"),
            0
        );
    }

    #[test]
    fn phase_create_rejects_foreign_and_non_scene_anchors_without_side_effects() {
        let db = test_db();
        for (phase_id, anchor_id) in [("phase-foreign", "scene2"), ("phase-folder", "folder1")] {
            let result = agent_codex_mutate_impl(
                &db,
                mutation(
                    "p1",
                    "phase.create",
                    json!({
                        "phaseId": phase_id,
                        "entryId": "e1",
                        "anchorNodeId": anchor_id,
                        "label": "invalid anchor",
                    }),
                ),
            );
            assert!(result.is_err(), "anchor {anchor_id} must be rejected");
        }

        let counts = db
            .with_conn(|conn| {
                Ok((
                    conn.query_row("SELECT COUNT(*) FROM codex_entry_phases", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                    conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                ))
            })
            .expect("count phase create side effects");
        assert_eq!(counts, (0, 0));
    }

    #[test]
    fn phase_patch_rejects_foreign_and_non_scene_anchors_without_mutation() {
        let db = test_db();
        agent_codex_mutate_impl(
            &db,
            mutation(
                "p1",
                "phase.create",
                json!({
                    "phaseId": "phase-1",
                    "entryId": "e1",
                    "anchorNodeId": "scene1",
                    "label": "winner",
                    "detailOverrides": [{ "definitionId": "d1", "value": "kept" }],
                }),
            ),
        )
        .expect("create valid phase");

        for anchor_id in ["scene2", "folder1"] {
            let result = agent_codex_mutate_impl(
                &db,
                mutation(
                    "p1",
                    "phase.aggregate",
                    json!({
                        "phaseId": "phase-1",
                        "baseVersion": 0,
                        "anchorNodeId": anchor_id,
                        "label": "must roll back",
                        "detailOverrides": [{ "definitionId": "d1", "value": "changed" }],
                    }),
                ),
            );
            assert!(result.is_err(), "anchor {anchor_id} must be rejected");
        }

        let state = db
            .with_conn(|conn| {
                Ok((
                    conn.query_row(
                        "SELECT anchor_node_id, label, version FROM codex_entry_phases WHERE id = 'phase-1'",
                        [],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)),
                    )?,
                    conn.query_row(
                        "SELECT value FROM codex_phase_detail_overrides WHERE phase_id = 'phase-1' AND definition_id = 'd1'",
                        [],
                        |row| row.get::<_, Option<String>>(0),
                    )?,
                    conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                ))
            })
            .expect("read rejected patch state");
        assert_eq!(state.0, ("scene1".to_string(), "winner".to_string(), 0));
        assert_eq!(state.1.as_deref(), Some("kept"));
        assert_eq!(
            state.2, 1,
            "only the successful create emits a change event"
        );
    }

    #[test]
    fn detail_definition_create_persists_optional_semantic_binding_atomically() {
        let db = test_db();
        agent_codex_mutate_impl(
            &db,
            mutation(
                "p1",
                "detail.definition.create",
                json!({
                    "definitionId": "d-semantic",
                    "typeSlug": "person",
                    "name": "Role",
                    "includeInContext": 1,
                    "semanticBinding": {
                        "id": "binding-semantic",
                        "facetKey": "role.current",
                        "projectionKind": "enum",
                        "temporalPolicy": "base-and-phase",
                        "source": "preset",
                        "confirmed": false
                    }
                }),
            ),
        )
        .expect("create definition and semantic binding");

        assert_eq!(
            db.with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT sort_order FROM codex_detail_definitions WHERE id = 'd-semantic'",
                    [],
                    |row| row.get::<_, f64>(0),
                )?)
            })
            .expect("read default definition sort order"),
            0.0
        );

        let binding = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT project_id, definition_id, facet_key, projection_kind,
                            temporal_policy, source, confirmed, version
                       FROM codex_detail_semantic_bindings
                      WHERE id = 'binding-semantic'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, i64>(7)?,
                        ))
                    },
                )?)
            })
            .expect("read semantic binding");
        assert_eq!(
            binding,
            (
                "p1".to_string(),
                "d-semantic".to_string(),
                "role.current".to_string(),
                "enum".to_string(),
                "base-and-phase".to_string(),
                "preset".to_string(),
                0,
                0,
            )
        );

        let failed = agent_codex_mutate_impl(
            &db,
            mutation(
                "p1",
                "detail.definition.create",
                json!({
                    "definitionId": "d-rolled-back",
                    "typeSlug": "person",
                    "name": "Duplicate binding id",
                    "sortOrder": 1,
                    "includeInContext": 1,
                    "semanticBinding": {
                        "id": "binding-semantic",
                        "facetKey": "goal.active",
                        "projectionKind": "summary-text",
                        "temporalPolicy": "phase-on-durable-change",
                        "source": "preset",
                        "confirmed": false
                    }
                }),
            ),
        );
        assert!(failed.is_err());

        let counts = db
            .with_conn(|conn| {
                Ok((
                    conn.query_row(
                        "SELECT COUNT(*) FROM codex_detail_definitions
                          WHERE id = 'd-rolled-back'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                    conn.query_row(
                        "SELECT COUNT(*) FROM change_events
                          WHERE entity_id = 'd-rolled-back'",
                        [],
                        |row| row.get::<_, i64>(0),
                    )?,
                ))
            })
            .expect("read rollback state");
        assert_eq!(counts, (0, 0));
    }

    #[test]
    fn detail_definition_update_rejects_cross_project_definition() {
        let db = test_db();
        let result = agent_codex_mutate_impl(
            &db,
            mutation(
                "p1",
                "detail.definition.update",
                json!({
                    "definitionId": "d2",
                    "baseVersion": 0,
                    "name": "tampered",
                }),
            ),
        );

        assert!(result.is_err());
        assert_eq!(
            db.with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT name FROM codex_detail_definitions WHERE id = 'd2'",
                    [],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .expect("read definition"),
            "Two detail"
        );
    }

    #[test]
    fn detail_value_upsert_rejects_cross_project_entry_and_definition() {
        let db = test_db();
        let result = agent_codex_mutate_impl(
            &db,
            mutation(
                "p1",
                "detail.value.upsert",
                json!({
                    "entryId": "e1",
                    "definitionId": "d2",
                    "value": "tampered",
                }),
            ),
        );

        assert!(result.is_err());
        assert_eq!(
            db.with_conn(|conn| {
                Ok(
                    conn.query_row("SELECT COUNT(*) FROM codex_detail_values", [], |row| {
                        row.get::<_, i64>(0)
                    })?,
                )
            })
            .expect("count values"),
            0
        );
    }
}
