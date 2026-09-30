//! Base Detail Value domain operations for narrative apply commits.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

use super::codex_operations::CommitMap;

pub(crate) const OP_KIND_DETAIL_VALUE_SET: &str = "codex.detail.value.set";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum DetailValueOcc {
    Absent,
    Version { version: i64 },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexDetailValueSetPayload {
    #[serde(default)]
    pub detail_value_id: Option<String>,
    #[serde(default)]
    pub entry_id: Option<String>,
    #[serde(default)]
    pub narrative_entity_id: Option<String>,
    pub definition_id: String,
    #[serde(default)]
    pub value: Option<String>,
    pub occ: DetailValueOcc,
}

#[derive(Debug, Clone)]
pub(crate) struct DetailValueSetTxResult {
    pub entity_id: String,
    pub version: i64,
    pub after_snapshot: Value,
    pub before_snapshot: Option<Value>,
    pub op_kind: &'static str,
}

pub(crate) fn parse_detail_value_set_payload(
    payload: &Value,
) -> anyhow::Result<CodexDetailValueSetPayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid codex.detail.value.set payload: {err}"))
}

fn resolve_entry_id(
    payload: &CodexDetailValueSetPayload,
    commit_map: &CommitMap,
) -> anyhow::Result<String> {
    if let Some(entry_id) = payload
        .entry_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        return Ok(entry_id.to_string());
    }
    let Some(entity_id) = payload
        .narrative_entity_id
        .as_deref()
        .filter(|value| !value.is_empty())
    else {
        anyhow::bail!("codex.detail.value.set missing entryId / narrativeEntityId");
    };
    Ok(commit_map.resolve(entity_id)?.codex_entry_id.clone())
}

pub(crate) fn collect_detail_value_snapshot(
    conn: &Connection,
    detail_value_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'entryId', entry_id,
            'definitionId', definition_id,
            'value', value,
            'version', version
         ) FROM codex_detail_values WHERE id = ?1",
        params![detail_value_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

fn load_detail_value_row(
    conn: &Connection,
    entry_id: &str,
    definition_id: &str,
) -> anyhow::Result<Option<(String, i64, Option<String>)>> {
    conn.query_row(
        "SELECT id, version, value FROM codex_detail_values
          WHERE entry_id = ?1 AND definition_id = ?2",
        params![entry_id, definition_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .map_err(Into::into)
}

/// Apply Base Detail set with OCC:
/// - `absent`: row must not exist; insert at version 1
/// - `version`: row must exist at exactly that version; CAS bump
pub(crate) fn apply_detail_value_set_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &CodexDetailValueSetPayload,
    commit_map: &CommitMap,
    now: &str,
) -> anyhow::Result<DetailValueSetTxResult> {
    let entry_id = resolve_entry_id(payload, commit_map)?;
    ensure_entry_in_project(conn, project_id, &entry_id)?;
    ensure_definition_in_project(conn, project_id, &payload.definition_id)?;

    let existing = load_detail_value_row(conn, &entry_id, &payload.definition_id)?;

    match &payload.occ {
        DetailValueOcc::Absent => {
            if existing.is_some() {
                anyhow::bail!(
                    "NEX_DETAIL_VALUE_OCC: detail value for entry '{entry_id}' definition '{}' already exists",
                    payload.definition_id
                );
            }
            let detail_value_id = payload
                .detail_value_id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            conn.execute(
                "INSERT INTO codex_detail_values
                    (id, entry_id, definition_id, value, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)",
                params![
                    detail_value_id,
                    entry_id,
                    payload.definition_id,
                    payload.value,
                    now,
                ],
            )?;
            let after_snapshot = collect_detail_value_snapshot(conn, &detail_value_id)?;
            Ok(DetailValueSetTxResult {
                entity_id: detail_value_id,
                version: 1,
                after_snapshot,
                before_snapshot: None,
                op_kind: "create",
            })
        }
        DetailValueOcc::Version { version } => {
            let Some((id, live_version, _value)) = existing else {
                anyhow::bail!(
                    "NEX_DETAIL_VALUE_OCC: detail value for entry '{entry_id}' definition '{}' is absent",
                    payload.definition_id
                );
            };
            if live_version != *version {
                anyhow::bail!(
                    "NEX_DETAIL_VALUE_OCC: detail value '{id}' expected version {version}, found {live_version}"
                );
            }
            let before_snapshot = collect_detail_value_snapshot(conn, &id)?;
            let next_version = live_version
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("detail value version overflow"))?;
            let updated = conn.execute(
                "UPDATE codex_detail_values
                    SET value = ?1,
                        version = ?2,
                        updated_at = ?3
                  WHERE id = ?4 AND version = ?5",
                params![payload.value, next_version, now, id, live_version],
            )?;
            anyhow::ensure!(
                updated == 1,
                "NEX_DETAIL_VALUE_OCC: detail value '{id}' update conflict"
            );
            let after_snapshot = collect_detail_value_snapshot(conn, &id)?;
            Ok(DetailValueSetTxResult {
                entity_id: id,
                version: next_version,
                after_snapshot,
                before_snapshot: Some(before_snapshot),
                op_kind: "patch",
            })
        }
    }
}

fn ensure_entry_in_project(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
) -> anyhow::Result<()> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        params![entry_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        found == 1,
        "codex entry '{entry_id}' not found in project '{project_id}'"
    );
    Ok(())
}

fn ensure_definition_in_project(
    conn: &Connection,
    project_id: &str,
    definition_id: &str,
) -> anyhow::Result<()> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_detail_definitions
          WHERE id = ?1 AND project_id = ?2",
        params![definition_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        found == 1,
        "codex detail definition '{definition_id}' not found in project '{project_id}'"
    );
    Ok(())
}
