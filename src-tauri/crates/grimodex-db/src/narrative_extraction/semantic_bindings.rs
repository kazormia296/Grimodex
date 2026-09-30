//! Detail Semantic Binding upsert for narrative apply commits (optional op).

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;

pub(crate) const OP_KIND_SEMANTIC_BINDING_UPSERT: &str = "codex.semantic_binding.upsert";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SemanticBindingOcc {
    Absent,
    Version { version: i64 },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexSemanticBindingUpsertPayload {
    pub binding_id: String,
    pub definition_id: String,
    pub facet_key: String,
    pub projection_kind: String,
    pub temporal_policy: String,
    pub source: String,
    #[serde(default)]
    pub confirmed: bool,
    pub occ: SemanticBindingOcc,
}

#[derive(Debug, Clone)]
pub(crate) struct SemanticBindingTxResult {
    pub entity_id: String,
    pub version: i64,
    pub after_snapshot: Value,
    pub before_snapshot: Option<Value>,
    pub op_kind: &'static str,
}

pub(crate) fn parse_semantic_binding_upsert_payload(
    payload: &Value,
) -> anyhow::Result<CodexSemanticBindingUpsertPayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid codex.semantic_binding.upsert payload: {err}"))
}

pub(crate) fn collect_semantic_binding_snapshot(
    conn: &Connection,
    binding_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'projectId', project_id,
            'definitionId', definition_id,
            'facetKey', facet_key,
            'projectionKind', projection_kind,
            'temporalPolicy', temporal_policy,
            'source', source,
            'confirmed', confirmed,
            'version', version
         ) FROM codex_detail_semantic_bindings WHERE id = ?1",
        params![binding_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}

/// Upsert a semantic binding with absent|version OCC.
pub(crate) fn apply_semantic_binding_upsert_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &CodexSemanticBindingUpsertPayload,
    now: &str,
) -> anyhow::Result<SemanticBindingTxResult> {
    ensure_definition_in_project(conn, project_id, &payload.definition_id)?;
    validate_enums(payload)?;

    let by_id: Option<i64> = conn
        .query_row(
            "SELECT version FROM codex_detail_semantic_bindings WHERE id = ?1",
            params![payload.binding_id],
            |row| row.get(0),
        )
        .optional()?;

    match &payload.occ {
        SemanticBindingOcc::Absent => {
            if by_id.is_some() {
                anyhow::bail!(
                    "NEX_SEMANTIC_BINDING_OCC: binding '{}' already exists",
                    payload.binding_id
                );
            }
            let dup: i64 = conn.query_row(
                "SELECT COUNT(*) FROM codex_detail_semantic_bindings
                  WHERE definition_id = ?1 AND facet_key = ?2",
                params![payload.definition_id, payload.facet_key],
                |row| row.get(0),
            )?;
            anyhow::ensure!(
                dup == 0,
                "NEX_SEMANTIC_BINDING_OCC: definition/facet already bound"
            );
            conn.execute(
                "INSERT INTO codex_detail_semantic_bindings
                    (id, project_id, definition_id, facet_key, projection_kind,
                     temporal_policy, source, confirmed, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)",
                params![
                    payload.binding_id,
                    project_id,
                    payload.definition_id,
                    payload.facet_key,
                    payload.projection_kind,
                    payload.temporal_policy,
                    payload.source,
                    if payload.confirmed { 1 } else { 0 },
                    now,
                ],
            )?;
            let after_snapshot = collect_semantic_binding_snapshot(conn, &payload.binding_id)?;
            Ok(SemanticBindingTxResult {
                entity_id: payload.binding_id.clone(),
                version: 0,
                after_snapshot,
                before_snapshot: None,
                op_kind: "create",
            })
        }
        SemanticBindingOcc::Version { version } => {
            let Some(live_version) = by_id else {
                anyhow::bail!(
                    "NEX_SEMANTIC_BINDING_OCC: binding '{}' is absent",
                    payload.binding_id
                );
            };
            if live_version != *version {
                anyhow::bail!(
                    "NEX_SEMANTIC_BINDING_OCC: binding '{}' expected version {version}, found {live_version}",
                    payload.binding_id
                );
            }
            let before_snapshot = collect_semantic_binding_snapshot(conn, &payload.binding_id)?;
            let next_version = live_version
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("semantic binding version overflow"))?;
            let updated = conn.execute(
                "UPDATE codex_detail_semantic_bindings
                    SET definition_id = ?1,
                        facet_key = ?2,
                        projection_kind = ?3,
                        temporal_policy = ?4,
                        source = ?5,
                        confirmed = ?6,
                        version = ?7,
                        updated_at = ?8
                  WHERE id = ?9 AND version = ?10",
                params![
                    payload.definition_id,
                    payload.facet_key,
                    payload.projection_kind,
                    payload.temporal_policy,
                    payload.source,
                    if payload.confirmed { 1 } else { 0 },
                    next_version,
                    now,
                    payload.binding_id,
                    live_version
                ],
            )?;
            anyhow::ensure!(
                updated == 1,
                "NEX_SEMANTIC_BINDING_OCC: binding '{}' update conflict",
                payload.binding_id
            );
            let after_snapshot = collect_semantic_binding_snapshot(conn, &payload.binding_id)?;
            Ok(SemanticBindingTxResult {
                entity_id: payload.binding_id.clone(),
                version: next_version,
                after_snapshot,
                before_snapshot: Some(before_snapshot),
                op_kind: "patch",
            })
        }
    }
}

fn validate_enums(payload: &CodexSemanticBindingUpsertPayload) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(
            payload.projection_kind.as_str(),
            "scalar-text" | "summary-text" | "enum" | "entity-reference"
        ),
        "invalid projectionKind '{}'",
        payload.projection_kind
    );
    anyhow::ensure!(
        matches!(
            payload.temporal_policy.as_str(),
            "base-only" | "phase-on-durable-change" | "base-and-phase" | "derived" | "manual-only"
        ),
        "invalid temporalPolicy '{}'",
        payload.temporal_policy
    );
    anyhow::ensure!(
        matches!(payload.source.as_str(), "preset" | "user" | "reviewed-ai"),
        "invalid source '{}'",
        payload.source
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
