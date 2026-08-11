//! Native trusted writers for the human/legacy Codex surface.
//!
//! Reads remain renderer-owned projections, but every mutation of the Codex
//! aggregates crosses this module.  The payload deliberately contains data,
//! not SQL, so the renderer cannot bypass the writer boundary.

use std::collections::HashMap;

use rusqlite::{
    params, params_from_iter,
    types::Value as SqlValue,
    Connection,
};
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
        Some(value) => Err(anyhow::anyhow!("{key} must be an integer or null")),
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
        Some(value) => Err(anyhow::anyhow!("{key} must be a boolean or 0/1")),
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

fn object_array<'a>(fields: &'a Map<String, Value>, key: &str) -> anyhow::Result<Vec<&'a Map<String, Value>>> {
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

fn write_result(
    entity_id: String,
    version: i64,
    change_event_uid: String,
) -> Value {
    json!({
        "entityId": entity_id,
        "version": version,
        "changeEventUid": change_event_uid,
    })
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
    anyhow::ensure!(!payload.project_id.trim().is_empty(), "projectId is required");
    anyhow::ensure!(!payload.session_id.trim().is_empty(), "sessionId is required");
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            let (entity_id, version) = mutate(conn, &payload, &event_uid)?;
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
                crate::commit_or_rollback(conn)?;
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
    let relation_type = optional_string(&payload.fields, "relationType")?
        .unwrap_or_else(|| "custom".to_string());
    let directionality = optional_string(&payload.fields, "directionality")?
        .unwrap_or_else(|| "directed".to_string());
    anyhow::ensure!(
        directionality == "directed" || directionality == "symmetric",
        "invalid directionality"
    );
    let forward = normalize_relation_label(&optional_string(&payload.fields, "label")?.unwrap_or_default());
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
            optional_string(&payload.fields, "anchorNodeId")?,
            label,
            optional_string(&payload.fields, "summaryOverride")?,
            optional_string(&payload.fields, "contentOverride")?,
            optional_string(&payload.fields, "contextModeOverride")?,
            optional_i64(&payload.fields, "version")?.unwrap_or(0),
            now,
        ],
    )?;
    replace_phase_overrides(conn, &phase_id, &payload.fields)?;
    Ok((
        phase_id,
        optional_i64(&payload.fields, "version")?.unwrap_or(0),
    ))
}

fn replace_phase_overrides(
    conn: &Connection,
    phase_id: &str,
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
        conn.execute(
            "INSERT INTO codex_phase_detail_overrides (phase_id, definition_id, value)
             VALUES (?1, ?2, ?3)",
            params![phase_id, definition_id, optional_string(item, "value")?],
        )?;
    }
    Ok(())
}

fn phase_patch(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let phase_id = required_string(&payload.fields, "phaseId")?;
    let base_version = required_i64(&payload.fields, "baseVersion")?;
    let current: (String, String, Option<String>, Option<String>, Option<String>, Option<String>, i64) =
        conn.query_row(
            "SELECT entry_id, label, anchor_node_id, summary_override, content_override,
                    context_mode_override, version
             FROM codex_entry_phases WHERE id = ?1",
            params![phase_id],
            |row| Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            )),
        )?;
    anyhow::ensure!(current.6 == base_version, "phase version conflict");
    let label = if payload.fields.contains_key("label") {
        optional_string(&payload.fields, "label")?.unwrap_or_default()
    } else {
        current.1
    };
    let anchor = nullable_sql_string(&payload.fields, "anchorNodeId", current.2)?;
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
    replace_phase_overrides(conn, &phase_id, &payload.fields)?;
    Ok((phase_id, next_version))
}

fn phase_delete(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let phase_id = required_string(&payload.fields, "phaseId")?;
    let expected = optional_i64(&payload.fields, "expectedVersion")?;
    let deleted = match expected {
        Some(version) => conn.execute(
            "DELETE FROM codex_entry_phases WHERE id = ?1 AND version = ?2",
            params![phase_id, version],
        )?,
        None => conn.execute(
            "DELETE FROM codex_entry_phases WHERE id = ?1",
            params![phase_id],
        )?,
    };
    anyhow::ensure!(deleted == 1, "phase '{phase_id}' version conflict or not found");
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
            optional_f64(&payload.fields, "sortOrder")?,
            optional_bool_int(&payload.fields, "includeInContext")?.unwrap_or(0),
            now,
        ],
    )?;
    Ok((definition_id, 0))
}

fn optional_f64(fields: &Map<String, Value>, key: &str) -> anyhow::Result<Option<f64>> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(value)) => value
            .as_f64()
            .map(Some)
            .ok_or_else(|| anyhow::anyhow!("{key} must be a number")),
        Some(value) => Err(anyhow::anyhow!("{key} must be a number or null")),
    }
}

fn definition_update(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let definition_id = required_string(&payload.fields, "definitionId")?;
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
    values.push(SqlValue::Integer(base_version));
    let sql = format!(
        "UPDATE codex_detail_definitions SET {} WHERE id = ? AND version = ?",
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
    anyhow::ensure!(deleted == 1, "detail definition '{definition_id}' not found");
    Ok((definition_id, 0))
}

fn value_upsert(
    conn: &Connection,
    payload: &AgentCodexMutationPayload,
    _event_uid: &str,
) -> anyhow::Result<(String, i64)> {
    let entry_id = required_string(&payload.fields, "entryId")?;
    let definition_id = required_string(&payload.fields, "definitionId")?;
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
            anyhow::ensure!(base_version == live_version, "detail value version conflict");
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
        "phase.update" | "phase.aggregate" => run_mutation(db, payload, "phase.update", phase_patch),
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
