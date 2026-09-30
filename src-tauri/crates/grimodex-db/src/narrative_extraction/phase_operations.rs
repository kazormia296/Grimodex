//! Phase create / aggregate patch operations for narrative apply commits.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use super::codex_operations::CommitMap;

pub(crate) const OP_KIND_PHASE_CREATE: &str = "codex.phase.create";
pub(crate) const OP_KIND_PHASE_PATCH: &str = "codex.phase.patch";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhaseDetailOverrideItem {
    pub definition_id: String,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexPhaseCreatePayload {
    pub phase_id: String,
    #[serde(default)]
    pub entry_id: Option<String>,
    #[serde(default)]
    pub narrative_entity_id: Option<String>,
    #[serde(default)]
    pub anchor_node_id: Option<String>,
    pub label: String,
    #[serde(default)]
    pub summary_override: Option<String>,
    #[serde(default)]
    pub detail_overrides: Vec<PhaseDetailOverrideItem>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum PhaseSummaryPatch {
    #[default]
    Leave,
    Set {
        #[serde(default)]
        value: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexPhasePatchPayload {
    pub phase_id: String,
    pub base_version: i64,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub summary: PhaseSummaryPatch,
    /// Exact-after override collection (missing definitions are deleted).
    pub detail_overrides: Vec<PhaseDetailOverrideItem>,
}

#[derive(Debug, Clone)]
pub(crate) struct PhaseTxResult {
    pub entity_id: String,
    pub version: i64,
    pub after_snapshot: Value,
    pub before_snapshot: Option<Value>,
    pub op_kind: &'static str,
}

pub(crate) fn parse_phase_create_payload(
    payload: &Value,
) -> anyhow::Result<CodexPhaseCreatePayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid codex.phase.create payload: {err}"))
}

pub(crate) fn parse_phase_patch_payload(payload: &Value) -> anyhow::Result<CodexPhasePatchPayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid codex.phase.patch payload: {err}"))
}

fn resolve_entry_id(
    entry_id: Option<&str>,
    narrative_entity_id: Option<&str>,
    commit_map: &CommitMap,
) -> anyhow::Result<String> {
    if let Some(id) = entry_id.filter(|value| !value.is_empty()) {
        return Ok(id.to_string());
    }
    let Some(entity_id) = narrative_entity_id.filter(|value| !value.is_empty()) else {
        anyhow::bail!("codex.phase operation missing entryId / narrativeEntityId");
    };
    Ok(commit_map.resolve(entity_id)?.codex_entry_id.clone())
}

pub(crate) fn collect_phase_snapshot(conn: &Connection, phase_id: &str) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'entryId', entry_id,
            'anchorNodeId', anchor_node_id,
            'label', label,
            'summaryOverride', summary_override,
            'contentOverride', content_override,
            'contextModeOverride', context_mode_override,
            'version', version
         ) FROM codex_entry_phases WHERE id = ?1",
        params![phase_id],
        |row| row.get(0),
    )?;
    let mut snapshot: Value = serde_json::from_str(&raw)?;
    let overrides = collect_phase_overrides(conn, phase_id)?;
    if let Some(obj) = snapshot.as_object_mut() {
        obj.insert("detailOverrides".to_string(), Value::Array(overrides));
    }
    Ok(snapshot)
}

pub(crate) fn collect_phase_overrides(
    conn: &Connection,
    phase_id: &str,
) -> anyhow::Result<Vec<Value>> {
    let mut stmt = conn.prepare(
        "SELECT definition_id, value FROM codex_phase_detail_overrides
          WHERE phase_id = ?1
          ORDER BY definition_id",
    )?;
    let rows = stmt.query_map(params![phase_id], |row| {
        let definition_id: String = row.get(0)?;
        let value: Option<String> = row.get(1)?;
        Ok(json!({
            "definitionId": definition_id,
            "value": value,
        }))
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn replace_phase_overrides(
    conn: &Connection,
    phase_id: &str,
    overrides: &[PhaseDetailOverrideItem],
) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM codex_phase_detail_overrides WHERE phase_id = ?1",
        params![phase_id],
    )?;
    for item in overrides {
        conn.execute(
            "INSERT INTO codex_phase_detail_overrides (phase_id, definition_id, value)
             VALUES (?1, ?2, ?3)",
            params![phase_id, item.definition_id, item.value],
        )?;
    }
    Ok(())
}

/// Create a Phase with label + optional summary + detail overrides.
/// Extraction path forces contentOverride / contextModeOverride to NULL.
pub(crate) fn apply_phase_create_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &CodexPhaseCreatePayload,
    commit_map: &CommitMap,
    now: &str,
) -> anyhow::Result<PhaseTxResult> {
    let entry_id = resolve_entry_id(
        payload.entry_id.as_deref(),
        payload.narrative_entity_id.as_deref(),
        commit_map,
    )?;
    ensure_entry_in_project(conn, project_id, &entry_id)?;

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

    for item in &payload.detail_overrides {
        ensure_definition_in_project(conn, project_id, &item.definition_id)?;
    }

    // Extraction slice: never invent content/context overrides.
    conn.execute(
        "INSERT INTO codex_entry_phases
            (id, entry_id, anchor_node_id, label, summary_override,
             content_override, context_mode_override, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, 0, ?6, ?6)",
        params![
            payload.phase_id,
            entry_id,
            payload.anchor_node_id,
            payload.label,
            payload.summary_override,
            now,
        ],
    )?;
    replace_phase_overrides(conn, &payload.phase_id, &payload.detail_overrides)?;

    let after_snapshot = collect_phase_snapshot(conn, &payload.phase_id)?;
    Ok(PhaseTxResult {
        entity_id: payload.phase_id.clone(),
        version: 0,
        after_snapshot,
        before_snapshot: None,
        op_kind: "create",
    })
}

/// Aggregate Phase patch: exact-after overrides, bump version once under OCC.
pub(crate) fn apply_phase_patch_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &CodexPhasePatchPayload,
    now: &str,
) -> anyhow::Result<PhaseTxResult> {
    let live: Option<(String, i64, String, Option<String>)> = conn
        .query_row(
            "SELECT entry_id, version, label, summary_override
               FROM codex_entry_phases WHERE id = ?1",
            params![payload.phase_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()?;
    let Some((entry_id, live_version, live_label, live_summary)) = live else {
        anyhow::bail!("codex phase '{}' not found", payload.phase_id);
    };
    let _ = entry_id;
    if live_version != payload.base_version {
        anyhow::bail!(
            "NEX_PHASE_VERSION_MISMATCH: phase '{}' expected version {}, found {}",
            payload.phase_id,
            payload.base_version,
            live_version
        );
    }

    for item in &payload.detail_overrides {
        ensure_definition_in_project(conn, project_id, &item.definition_id)?;
    }

    let before_snapshot = collect_phase_snapshot(conn, &payload.phase_id)?;
    let next_version = live_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("phase version overflow"))?;

    let next_label = payload.label.clone().unwrap_or(live_label);
    let next_summary = match &payload.summary {
        PhaseSummaryPatch::Leave => live_summary,
        PhaseSummaryPatch::Set { value } => value.clone(),
    };

    let updated = conn.execute(
        "UPDATE codex_entry_phases
            SET label = ?1,
                summary_override = ?2,
                version = ?3,
                updated_at = ?4
          WHERE id = ?5 AND version = ?6",
        params![
            next_label,
            next_summary,
            next_version,
            now,
            payload.phase_id,
            live_version
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "NEX_PHASE_VERSION_MISMATCH: phase '{}' patch conflict",
        payload.phase_id
    );

    replace_phase_overrides(conn, &payload.phase_id, &payload.detail_overrides)?;
    let after_snapshot = collect_phase_snapshot(conn, &payload.phase_id)?;
    Ok(PhaseTxResult {
        entity_id: payload.phase_id.clone(),
        version: next_version,
        after_snapshot,
        before_snapshot: Some(before_snapshot),
        op_kind: "patch",
    })
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
