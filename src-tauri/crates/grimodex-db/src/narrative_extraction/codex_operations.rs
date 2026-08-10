//! Codex domain operations for narrative apply commits.

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::agent_writes::{
    apply_codex_entry_create_in_tx, apply_codex_entry_patch_in_tx, collect_codex_entry_snapshot,
    CodexEntryCreateTxInput, CodexEntryCreateTxResult, CodexEntryPatchTxInput,
    CodexEntryPatchTxResult,
};
use crate::codex_relation_keys::{
    build_codex_relation_semantic_key, normalize_relation_label,
};

use super::detail_operations::OP_KIND_DETAIL_VALUE_SET;
use super::phase_operations::{OP_KIND_PHASE_CREATE, OP_KIND_PHASE_PATCH};
use super::semantic_bindings::OP_KIND_SEMANTIC_BINDING_UPSERT;
use super::temporal_constraints::OP_KIND_CONSTRAINT_CREATE;
use super::temporal_nodes::OP_KIND_NODE_ENSURE;
use super::temporal_operations::{
    OP_KIND_EVENT_METADATA_PATCH, OP_KIND_SCENE_METADATA_PATCH, OP_KIND_STORY_ORDER_MATERIALIZE,
};
use super::temporal_projections::OP_KIND_PROJECTION_RECORD;

pub(crate) const OP_KIND_EVENT_CREATE: &str = "chronicle.event.create";
pub(crate) const OP_KIND_ENTRY_CREATE: &str = "codex.entry.create";
pub(crate) const OP_KIND_ENTRY_PATCH: &str = "codex.entry.patch";
pub(crate) const OP_KIND_ENTITY_BIND_EXISTING: &str = "codex.entity.bind-existing";
pub(crate) const OP_KIND_RELATION_CREATE: &str = "codex.relation.create";

pub(crate) const EMPTY_CODEX_CONTENT: &str = r#"{"type":"doc","content":[]}"#;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexEntryCreatePayload {
    pub entry_id: String,
    pub type_slug: String,
    pub name: String,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub narrative_entity_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PatchCollectionString {
    pub kind: String,
    #[serde(default)]
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PatchFieldString {
    pub kind: String,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexEntryPatchPayload {
    pub entry_id: String,
    pub base_version: i64,
    #[serde(default)]
    pub aliases: Option<PatchCollectionString>,
    #[serde(default)]
    pub summary: Option<PatchFieldString>,
    #[serde(default)]
    pub name: Option<PatchFieldString>,
    #[serde(default)]
    pub type_slug: Option<PatchFieldString>,
    #[serde(default)]
    pub parent_id: Option<PatchFieldString>,
    #[serde(default)]
    pub narrative_entity_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexEntityBindExistingPayload {
    pub entry_id: String,
    pub narrative_entity_id: String,
    #[serde(default)]
    pub base_version: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexRelationCreatePayload {
    pub relation_id: String,
    #[serde(default)]
    pub from_codex_id: Option<String>,
    #[serde(default)]
    pub to_codex_id: Option<String>,
    #[serde(default)]
    pub subject_entity_id: Option<String>,
    #[serde(default)]
    pub object_entity_id: Option<String>,
    pub relation_type: String,
    pub directionality: String,
    pub forward_label: String,
    #[serde(default)]
    pub inverse_label: Option<String>,
    #[serde(default)]
    pub semantic_key: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct CodexRelationCreateTxResult {
    pub entity_id: String,
    pub version: i64,
    pub after_snapshot: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct CommitMap {
    bindings: HashMap<String, CodexEntityBinding>,
}

#[derive(Debug, Clone)]
pub(crate) struct CodexEntityBinding {
    pub narrative_entity_id: String,
    pub codex_entry_id: String,
    pub source: String,
}

impl CommitMap {
    pub fn new() -> Self {
        Self {
            bindings: HashMap::new(),
        }
    }

    pub fn insert_binding(&mut self, binding: CodexEntityBinding) -> anyhow::Result<()> {
        if let Some(existing) = self.bindings.get(&binding.narrative_entity_id) {
            if existing.codex_entry_id != binding.codex_entry_id {
                anyhow::bail!(
                    "NEX_COMMIT_MAP_CONFLICT: narrative entity '{}' already bound to '{}', refusing '{}'",
                    binding.narrative_entity_id,
                    existing.codex_entry_id,
                    binding.codex_entry_id
                );
            }
            // Identical remapping is OK; keep original source.
            return Ok(());
        }
        self.bindings
            .insert(binding.narrative_entity_id.clone(), binding);
        Ok(())
    }

    pub fn resolve(&self, narrative_entity_id: &str) -> anyhow::Result<&CodexEntityBinding> {
        self.bindings.get(narrative_entity_id).ok_or_else(|| {
            anyhow::anyhow!(
                "NEX_COMMIT_MAP_MISSING: narrative entity '{narrative_entity_id}' has no CommitMap binding"
            )
        })
    }

    pub fn to_json(&self) -> Value {
        let mut obj = serde_json::Map::new();
        for (entity_id, binding) in &self.bindings {
            obj.insert(
                entity_id.clone(),
                json!({
                    "narrativeEntityId": binding.narrative_entity_id,
                    "codexEntryId": binding.codex_entry_id,
                    "source": binding.source,
                }),
            );
        }
        Value::Object(obj)
    }
}

pub(crate) fn ensure_operation_kind(kind: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        matches!(
            kind,
            OP_KIND_EVENT_CREATE
                | OP_KIND_ENTRY_CREATE
                | OP_KIND_ENTRY_PATCH
                | OP_KIND_ENTITY_BIND_EXISTING
                | OP_KIND_RELATION_CREATE
                | OP_KIND_DETAIL_VALUE_SET
                | OP_KIND_PHASE_CREATE
                | OP_KIND_PHASE_PATCH
                | OP_KIND_SEMANTIC_BINDING_UPSERT
                | OP_KIND_NODE_ENSURE
                | OP_KIND_CONSTRAINT_CREATE
                | OP_KIND_SCENE_METADATA_PATCH
                | OP_KIND_EVENT_METADATA_PATCH
                | OP_KIND_STORY_ORDER_MATERIALIZE
                | OP_KIND_PROJECTION_RECORD
        ),
        "unsupported commit operation kind: {kind}"
    );
    Ok(())
}

pub(crate) fn is_chronicle_op(kind: &str) -> bool {
    kind == OP_KIND_EVENT_CREATE
}

pub(crate) fn parse_entry_create_payload(payload: &Value) -> anyhow::Result<CodexEntryCreatePayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid codex.entry.create payload: {err}"))
}

pub(crate) fn parse_entry_patch_payload(payload: &Value) -> anyhow::Result<CodexEntryPatchPayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid codex.entry.patch payload: {err}"))
}

pub(crate) fn parse_entity_bind_existing_payload(
    payload: &Value,
) -> anyhow::Result<CodexEntityBindExistingPayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid codex.entity.bind-existing payload: {err}"))
}

pub(crate) fn parse_relation_create_payload(
    payload: &Value,
) -> anyhow::Result<CodexRelationCreatePayload> {
    serde_json::from_value(payload.clone())
        .map_err(|err| anyhow::anyhow!("invalid codex.relation.create payload: {err}"))
}

pub(crate) fn aliases_to_storage(aliases: &[String]) -> String {
    serde_json::to_string(aliases).unwrap_or_else(|_| "[]".to_string())
}

fn parse_aliases_json(raw: Option<&str>) -> anyhow::Result<Vec<String>> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    let parsed: Value = serde_json::from_str(raw)
        .map_err(|err| anyhow::anyhow!("invalid aliases json: {err}"))?;
    match parsed {
        Value::Array(items) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let Some(text) = item.as_str() else {
                    anyhow::bail!("aliases array must contain only strings");
                };
                out.push(text.to_string());
            }
            Ok(out)
        }
        _ => anyhow::bail!("aliases must be a JSON array"),
    }
}

pub(crate) fn ensure_entry_id_available(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
) -> anyhow::Result<()> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        params![entry_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        exists == 0,
        "codex entry '{entry_id}' already exists in project '{project_id}'"
    );
    Ok(())
}

pub(crate) fn ensure_entry_version(
    conn: &Connection,
    project_id: &str,
    entry_id: &str,
    expected_version: i64,
) -> anyhow::Result<()> {
    let version: Option<i64> = conn
        .query_row(
            "SELECT version FROM codex_entries WHERE id = ?1 AND project_id = ?2",
            params![entry_id, project_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(version) = version else {
        anyhow::bail!("codex entry '{entry_id}' not found in project '{project_id}'");
    };
    if version != expected_version {
        anyhow::bail!(
            "NEX_CODEX_VERSION_MISMATCH: entry '{entry_id}' expected version {expected_version}, found {version}"
        );
    }
    Ok(())
}

pub(crate) fn apply_codex_entry_create(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
    surface: Option<&str>,
    payload: &CodexEntryCreatePayload,
    now: &str,
    timestamp: i64,
) -> anyhow::Result<CodexEntryCreateTxResult> {
    anyhow::ensure!(
        payload.parent_id.is_none(),
        "NEX_CODEX_PARENT_ID_FORBIDDEN: kinship must not be projected onto parentId"
    );
    let summary = payload.summary.clone().unwrap_or_default();
    let content = payload
        .content
        .clone()
        .unwrap_or_else(|| EMPTY_CODEX_CONTENT.to_string());
    let aliases = aliases_to_storage(&payload.aliases);
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();

    apply_codex_entry_create_in_tx(
        conn,
        CodexEntryCreateTxInput {
            project_id,
            session_id,
            surface,
            entry_id: &payload.entry_id,
            undo_id: &undo_id,
            event_uid: &event_uid,
            type_slug: &payload.type_slug,
            name: &payload.name,
            summary: &summary,
            content: &content,
            aliases: Some(aliases.as_str()),
            parent_id: None,
            source_chat_message_id: None,
            authorship_spans: &[],
            model: None,
            chat_message_id: None,
            trace_id: None,
            request_hash: None,
            now,
            timestamp,
            write_undo_journal: false,
            write_change_event: false,
        },
    )
}

pub(crate) fn apply_codex_entry_patch(
    conn: &Connection,
    project_id: &str,
    session_id: &str,
    surface: Option<&str>,
    payload: &CodexEntryPatchPayload,
    now: &str,
    timestamp: i64,
) -> anyhow::Result<CodexEntryPatchTxResult> {
    if let Some(name) = &payload.name {
        anyhow::ensure!(
            name.kind == "leave",
            "NEX_CODEX_PATCH_SCOPE: name changes are not allowed in v1"
        );
    }
    if let Some(type_slug) = &payload.type_slug {
        anyhow::ensure!(
            type_slug.kind == "leave",
            "NEX_CODEX_PATCH_SCOPE: typeSlug changes are not allowed in v1"
        );
    }
    if let Some(parent_id) = &payload.parent_id {
        anyhow::ensure!(
            parent_id.kind == "leave",
            "NEX_CODEX_PARENT_ID_FORBIDDEN: kinship must not be projected onto parentId"
        );
    }

    let (current_aliases_raw, current_summary): (Option<String>, String) = conn.query_row(
        "SELECT aliases, summary FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        params![payload.entry_id, project_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let current_aliases = parse_aliases_json(current_aliases_raw.as_deref())?;

    let aliases_json = match &payload.aliases {
        Some(collection) if collection.kind == "set" => {
            // Additive-only under narrative scope: refuse removals.
            for existing in &current_aliases {
                anyhow::ensure!(
                    collection.values.iter().any(|value| value == existing),
                    "NEX_CODEX_PATCH_ALIASES_REMOVAL: aliases.set must not remove existing aliases"
                );
            }
            Some(aliases_to_storage(&collection.values))
        }
        Some(collection) if collection.kind == "leave" => None,
        Some(collection) => anyhow::bail!("unsupported aliases patch kind '{}'", collection.kind),
        None => None,
    };

    let (summary_value, fill_if_empty) = match &payload.summary {
        Some(field) if field.kind == "leave" => (None, false),
        Some(field) if field.kind == "set" => {
            anyhow::ensure!(
                current_summary.trim().is_empty(),
                "NEX_CODEX_PATCH_SUMMARY_OVERWRITE: summary.set refused for non-empty summary; use fill-if-empty"
            );
            (
                Some(
                    field
                        .value
                        .clone()
                        .ok_or_else(|| anyhow::anyhow!("summary.set requires value"))?,
                ),
                false,
            )
        }
        Some(field) if field.kind == "fill-if-empty" => (
            Some(
                field
                    .value
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("summary.fill-if-empty requires value"))?,
            ),
            true,
        ),
        Some(field) => anyhow::bail!("unsupported summary patch kind '{}'", field.kind),
        None => (None, false),
    };

    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let summary_ref = summary_value.as_deref();

    apply_codex_entry_patch_in_tx(
        conn,
        CodexEntryPatchTxInput {
            project_id,
            session_id,
            surface,
            entry_id: &payload.entry_id,
            undo_id: &undo_id,
            event_uid: &event_uid,
            base_version: payload.base_version,
            name: None,
            summary: summary_ref,
            summary_fill_if_empty: fill_if_empty,
            content: None,
            aliases: aliases_json.as_deref(),
            authorship_spans: None,
            authorship_span_lanes: None,
            model: None,
            chat_message_id: None,
            trace_id: None,
            now,
            timestamp,
            write_undo_journal: false,
            write_change_event: false,
            aliases_and_empty_summary_only: true,
        },
    )
}

fn resolve_endpoint(
    commit_map: &CommitMap,
    concrete_id: Option<&str>,
    narrative_entity_id: Option<&str>,
    role: &str,
) -> anyhow::Result<String> {
    let Some(entity_id) = narrative_entity_id.filter(|value| !value.is_empty()) else {
        // Legacy path: concrete Codex ID without NarrativeEntityId.
        if let Some(id) = concrete_id.filter(|value| !value.is_empty()) {
            return Ok(id.to_string());
        }
        anyhow::bail!("codex.relation.create missing {role} endpoint");
    };
    let resolved = commit_map.resolve(entity_id)?.codex_entry_id.clone();
    if let Some(concrete) = concrete_id.filter(|value| !value.is_empty()) {
        anyhow::ensure!(
            concrete == resolved.as_str(),
            "NEX_COMMIT_MAP_ENDPOINT_MISMATCH: {role} concrete id '{concrete}' != CommitMap '{resolved}' for '{entity_id}'"
        );
    }
    Ok(resolved)
}

pub(crate) fn apply_codex_relation_create_in_tx(
    conn: &Connection,
    project_id: &str,
    payload: &CodexRelationCreatePayload,
    commit_map: &CommitMap,
    now: &str,
) -> anyhow::Result<CodexRelationCreateTxResult> {
    anyhow::ensure!(
        payload.directionality == "directed" || payload.directionality == "symmetric",
        "invalid directionality '{}'",
        payload.directionality
    );

    let from_codex_id = resolve_endpoint(
        commit_map,
        payload.from_codex_id.as_deref(),
        payload.subject_entity_id.as_deref(),
        "from/subject",
    )?;
    let to_codex_id = resolve_endpoint(
        commit_map,
        payload.to_codex_id.as_deref(),
        payload.object_entity_id.as_deref(),
        "to/object",
    )?;
    anyhow::ensure!(
        from_codex_id != to_codex_id,
        "NEX_CODEX_SELF_RELATION: from and to must differ"
    );

    ensure_codex_in_project(conn, project_id, &from_codex_id)?;
    ensure_codex_in_project(conn, project_id, &to_codex_id)?;

    let forward = normalize_relation_label(&payload.forward_label);
    anyhow::ensure!(!forward.is_empty(), "forwardLabel is required");
    let inverse = payload
        .inverse_label
        .as_deref()
        .map(normalize_relation_label)
        .filter(|value| !value.is_empty());
    if payload.directionality == "symmetric" {
        let inverse_label = inverse.clone().unwrap_or_else(|| forward.clone());
        anyhow::ensure!(
            inverse_label == forward,
            "symmetric relation requires matching forward/inverse labels"
        );
    }

    let semantic_key = build_codex_relation_semantic_key(
        project_id,
        &from_codex_id,
        &to_codex_id,
        &payload.relation_type,
        &payload.directionality,
        &forward,
        inverse.as_deref(),
    );
    if let Some(client_key) = payload.semantic_key.as_deref() {
        anyhow::ensure!(
            client_key == semantic_key.as_str(),
            "NEX_CODEX_RELATION_SEMANTIC_KEY_MISMATCH: client '{client_key}' != recomputed '{semantic_key}'"
        );
    }

    let duplicate: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_relations
          WHERE project_id = ?1 AND semantic_key = ?2",
        params![project_id, semantic_key],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        duplicate == 0,
        "NEX_CODEX_RELATION_SEMANTIC_DUPLICATE: semantic_key already exists"
    );

    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_relations WHERE id = ?1 AND project_id = ?2",
        params![payload.relation_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        exists == 0,
        "codex relation '{}' already exists",
        payload.relation_id
    );

    conn.execute(
        "INSERT INTO codex_relations
            (id, project_id, from_codex_id, to_codex_id, relation_type, label,
             directionality, inverse_label, semantic_key, version,
             depth_hint, source_map_edge_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, NULL, NULL, ?10, ?10)",
        params![
            payload.relation_id,
            project_id,
            from_codex_id,
            to_codex_id,
            payload.relation_type,
            forward,
            payload.directionality,
            inverse,
            semantic_key,
            now,
        ],
    )?;

    let after_snapshot = collect_codex_relation_snapshot(conn, &payload.relation_id)?;
    Ok(CodexRelationCreateTxResult {
        entity_id: payload.relation_id.clone(),
        version: 1,
        after_snapshot,
    })
}

pub(crate) fn apply_codex_entity_bind_existing(
    conn: &Connection,
    project_id: &str,
    payload: &CodexEntityBindExistingPayload,
) -> anyhow::Result<(String, i64, Value)> {
    anyhow::ensure!(
        !payload.narrative_entity_id.trim().is_empty(),
        "codex.entity.bind-existing requires narrativeEntityId"
    );
    if let Some(expected) = payload.base_version {
        ensure_entry_version(conn, project_id, &payload.entry_id, expected)?;
    } else {
        ensure_codex_in_project(conn, project_id, &payload.entry_id)?;
    }
    let snapshot = collect_codex_entry_snapshot(conn, &payload.entry_id)?;
    let version = snapshot
        .get("version")
        .and_then(Value::as_i64)
        .unwrap_or(1);
    Ok((payload.entry_id.clone(), version, snapshot))
}

fn ensure_codex_in_project(
    conn: &Connection,
    project_id: &str,
    codex_id: &str,
) -> anyhow::Result<()> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        params![codex_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        found == 1,
        "codex entry '{codex_id}' not found in project '{project_id}'"
    );
    Ok(())
}

pub(crate) fn collect_codex_relation_snapshot(
    conn: &Connection,
    relation_id: &str,
) -> anyhow::Result<Value> {
    let raw: String = conn.query_row(
        "SELECT json_object(
            'id', id,
            'projectId', project_id,
            'fromCodexId', from_codex_id,
            'toCodexId', to_codex_id,
            'relationType', relation_type,
            'label', label,
            'directionality', directionality,
            'inverseLabel', inverse_label,
            'semanticKey', semantic_key,
            'version', version
         ) FROM codex_relations WHERE id = ?1",
        params![relation_id],
        |row| row.get(0),
    )?;
    serde_json::from_str(&raw).map_err(Into::into)
}
