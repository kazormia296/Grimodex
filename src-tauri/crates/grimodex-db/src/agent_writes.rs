//! Atomic AI write primitives for in-app agent tools.
//!
//! Each write bundles entity mutation + authorship_spans + undo_journal +
//! change_events in a single BEGIN IMMEDIATE transaction.

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use grimodex_core::chronicle_time::{
    normalize_chronicle_timestamp, resolve_chronicle_granularity,
    validate_canonical_chronicle_date_range, validate_chronicle_date_range, ChronicleDateRange,
    ChronicleTimestamp,
};

// 実装本体は src-tauri/src/commands/agent_writes.rs から本クレートへ移動した
// (Electron 移行 Phase 3 バッチ1 — napi Backend と Tauri コマンドで共用)。
// grimodex-db は grimodex-core に依存済みなので tracked write / undo_journal を直接呼べる。
use crate::change_events::{append_change_events_in_tx, AppendChangeEvent};
use crate::idempotency::{
    insert_idempotent_response, load_idempotent_response, IdempotencyRequest,
};
use crate::undo_journal::{insert_undo_journal_in_tx, UndoJournalInsert};
use crate::{BatchStatement, Database};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorshipSpanInput {
    from_pos: i64,
    to_pos: i64,
    source: String,
    model: Option<String>,
    chat_msg_id: Option<String>,
    trace_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodexCreatePayload {
    /// Stable identity of the logical request. This is deliberately separate
    /// from `entry_id`, which remains the domain entity identity.
    #[serde(default)]
    request_id: Option<String>,
    /// Domain-owned idempotency key. New renderer callers always provide it;
    /// `None` preserves compatibility with older native clients.
    #[serde(default)]
    entry_id: Option<String>,
    project_id: String,
    session_id: String,
    type_slug: String,
    name: String,
    summary: Option<String>,
    content: Option<String>,
    aliases: Option<String>,
    parent_id: Option<String>,
    source_chat_message_id: Option<String>,
    model: Option<String>,
    chat_message_id: Option<String>,
    trace_id: Option<String>,
    authorship_spans: Vec<AuthorshipSpanInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodexUpdatePayload {
    project_id: String,
    session_id: String,
    entry_id: String,
    /// Client-observed version before this write (optimistic lock).
    base_version: i64,
    name: Option<String>,
    summary: Option<String>,
    content: Option<String>,
    aliases: Option<String>,
    model: Option<String>,
    chat_message_id: Option<String>,
    trace_id: Option<String>,
    authorship_spans: Option<Vec<AuthorshipSpanInput>>,
    /// Per-span lane for partial updates: "summary" | "content".
    authorship_span_lanes: Option<Vec<Option<String>>>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentWriteResult {
    entity_id: String,
    version: i64,
    change_event_uid: String,
    undo_journal_id: String,
}

fn idempotency_hash<T: Serialize>(domain: &str, payload: &T) -> anyhow::Result<String> {
    let mut canonical = serde_json::to_value((domain, payload))?;
    canonicalize_json_value(&mut canonical);
    let body = serde_json::to_vec(&canonical)?;
    Ok(hex::encode(Sha256::digest(body)))
}

fn canonicalize_json_value(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                canonicalize_json_value(item);
            }
        }
        Value::Object(object) => {
            let mut entries: Vec<_> = std::mem::take(object).into_iter().collect();
            for (_, child) in &mut entries {
                canonicalize_json_value(child);
            }
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            object.extend(entries);
        }
        _ => {}
    }
}

fn normalize_prosemirror_for_idempotency(raw: &str) -> String {
    fn strip_volatile_authorship_timestamp(value: &mut Value) {
        match value {
            Value::Array(items) => {
                for item in items {
                    strip_volatile_authorship_timestamp(item);
                }
            }
            Value::Object(object) => {
                if object.get("type").and_then(Value::as_str) == Some("authorship") {
                    if let Some(Value::Object(attrs)) = object.get_mut("attrs") {
                        attrs.remove("timestamp");
                    }
                }
                for child in object.values_mut() {
                    strip_volatile_authorship_timestamp(child);
                }
            }
            _ => {}
        }
    }

    let Ok(mut parsed) = serde_json::from_str::<Value>(raw) else {
        return raw.to_string();
    };
    strip_volatile_authorship_timestamp(&mut parsed);
    canonicalize_json_value(&mut parsed);
    serde_json::to_string(&parsed).unwrap_or_else(|_| raw.to_string())
}

fn codex_create_request_hash(payload: &AgentCodexCreatePayload) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.request_id = None;
    normalized.entry_id = None;
    normalized.session_id.clear();
    normalized.summary = Some(normalized.summary.unwrap_or_default());
    normalized.content = Some(normalize_prosemirror_for_idempotency(
        normalized.content.as_deref().unwrap_or("{}"),
    ));
    idempotency_hash("agent_codex_create", &normalized)
}

fn snippet_create_request_hash(payload: &AgentSnippetCreatePayload) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.request_id = None;
    normalized.snippet_id = None;
    normalized.session_id.clear();
    normalized.content = Some(normalize_prosemirror_for_idempotency(
        normalized.content.as_deref().unwrap_or("{}"),
    ));
    idempotency_hash("agent_snippet_create", &normalized)
}

fn event_create_request_hash(payload: &AgentEventCreatePayload) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.request_id = None;
    normalized.event_id = None;
    normalized.session_id.clear();
    normalized.surface = None;
    normalized.detail = normalized
        .detail
        .as_deref()
        .map(normalize_prosemirror_for_idempotency);
    normalized.title = Some(normalized.title.unwrap_or_default());
    normalized.ordinal = Some(normalized.ordinal.unwrap_or_else(|| "a0".to_string()));
    normalized.precision = Some(normalized.precision.unwrap_or_else(|| "exact".to_string()));
    normalized.kind = Some(normalized.kind.unwrap_or_else(|| "generic".to_string()));
    normalized.start_granularity = Some(
        normalized
            .start_granularity
            .unwrap_or_else(|| "none".to_string()),
    );
    normalized.end_granularity = Some(
        normalized
            .end_granularity
            .unwrap_or_else(|| "none".to_string()),
    );
    normalized.secret = Some(normalized.secret.unwrap_or(false));
    normalized.reveal_scene_id = normalized.reveal_scene_id.filter(|value| !value.is_empty());
    normalized.participant_codex_ids = Some(normalize_id_set(normalized.participant_codex_ids));
    normalized.scene_ids = Some(normalize_id_set(normalized.scene_ids));
    idempotency_hash("agent_event_create", &normalized)
}

fn normalize_id_set(ids: Option<Vec<String>>) -> Vec<String> {
    let mut ids = ids.unwrap_or_default();
    ids.sort();
    ids.dedup();
    ids
}

fn foreshadow_create_request_hash(
    payload: &AgentForeshadowCreatePayload,
) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.request_id = None;
    normalized.foreshadow_id = None;
    normalized.session_id.clear();
    idempotency_hash("agent_foreshadow_create", &normalized)
}

fn scene_event_request_hash(
    payload: &AgentSceneEventPayload,
    link: bool,
) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.request_id = None;
    normalized.session_id.clear();
    normalized.surface = None;
    idempotency_hash(
        if link {
            "agent_scene_event_link"
        } else {
            "agent_scene_event_unlink"
        },
        &normalized,
    )
}

fn event_relation_request_hash(
    payload: &AgentEventRelationPayload,
    add: bool,
) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.request_id = None;
    normalized.session_id.clear();
    normalized.surface = None;
    idempotency_hash(
        if add {
            "agent_event_relation_add"
        } else {
            "agent_event_relation_remove"
        },
        &normalized,
    )
}

fn request_hash_from_change_payload(payload: &str) -> anyhow::Result<Option<String>> {
    Ok(serde_json::from_str::<Value>(payload)?
        .get("requestHash")
        .and_then(Value::as_str)
        .map(str::to_string))
}

/// Resolve an already-committed create while holding the caller's
/// `BEGIN IMMEDIATE` lock. `table` is always a static internal literal.
fn existing_create_result(
    conn: &rusqlite::Connection,
    table: &str,
    project_id: &str,
    entity_kind: &str,
    entity_id: &str,
    request_hash: &str,
    conflict_marker: &str,
) -> anyhow::Result<Option<AgentWriteResult>> {
    let journal = conn
        .query_row(
            "SELECT uj.id, uj.result_version, uj.change_event_uid, ce.payload
             FROM undo_journal uj
             LEFT JOIN change_events ce
               ON ce.project_id = uj.project_id
              AND ce.event_uid = uj.change_event_uid
             WHERE uj.project_id = ?1
               AND uj.entity_kind = ?2
               AND uj.entity_id = ?3
               AND uj.op_kind = 'create'
             ORDER BY uj.rowid ASC
             LIMIT 1",
            rusqlite::params![project_id, entity_kind, entity_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    let entity_exists: bool = conn.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
        rusqlite::params![entity_id],
        |row| row.get(0),
    )?;

    let Some((undo_journal_id, version, change_event_uid, event_payload)) = journal else {
        if entity_exists {
            anyhow::bail!("{conflict_marker}: entity id already exists without matching request");
        }
        return Ok(None);
    };
    let stored_hash = event_payload
        .as_deref()
        .map(request_hash_from_change_payload)
        .transpose()?
        .flatten();
    if !entity_exists || stored_hash.as_deref() != Some(request_hash) {
        anyhow::bail!("{conflict_marker}: request id reused with different payload or state");
    }
    let change_event_uid = change_event_uid
        .ok_or_else(|| anyhow::anyhow!("{conflict_marker}: missing original change event"))?;
    Ok(Some(AgentWriteResult {
        entity_id: entity_id.to_string(),
        version,
        change_event_uid,
        undo_journal_id,
    }))
}

fn existing_request_result(
    conn: &rusqlite::Connection,
    request_id: &str,
    request_hash: &str,
    conflict_marker: &str,
) -> anyhow::Result<Option<AgentWriteResult>> {
    let row = conn
        .query_row(
            "SELECT uj.entity_id, uj.result_version, uj.change_event_uid, ce.payload
             FROM undo_journal uj
             LEFT JOIN change_events ce
               ON ce.project_id = uj.project_id
              AND ce.event_uid = uj.change_event_uid
             WHERE uj.id = ?1",
            rusqlite::params![request_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()?;
    let Some((entity_id, version, change_event_uid, event_payload)) = row else {
        return Ok(None);
    };
    let stored_hash = event_payload
        .as_deref()
        .map(request_hash_from_change_payload)
        .transpose()?
        .flatten();
    if stored_hash.as_deref() != Some(request_hash) {
        anyhow::bail!("{conflict_marker}: request id reused with different payload");
    }
    let change_event_uid = change_event_uid
        .ok_or_else(|| anyhow::anyhow!("{conflict_marker}: missing original change event"))?;
    Ok(Some(AgentWriteResult {
        entity_id,
        version,
        change_event_uid,
        undo_journal_id: request_id.to_string(),
    }))
}

const LANE_SUMMARY_MODEL: &str = "__lane_summary__";
const LANE_CONTENT_MODEL: &str = "__lane_content__";

fn lane_model(lane: Option<&str>, span_model: Option<&str>) -> Option<String> {
    match lane {
        Some("summary") => Some(LANE_SUMMARY_MODEL.to_string()),
        Some("content") => Some(LANE_CONTENT_MODEL.to_string()),
        _ => span_model.map(str::to_string),
    }
}

struct CodexSpanMerge<'a> {
    spans: &'a [AuthorshipSpanInput],
    lanes: Option<&'a [Option<String>]>,
    update_summary: bool,
    update_content: bool,
    model: Option<&'a str>,
    chat_msg_id: Option<&'a str>,
    trace_id: Option<&'a str>,
}

fn merge_codex_authorship_spans(
    conn: &rusqlite::Connection,
    entry_id: &str,
    merge: CodexSpanMerge<'_>,
) -> anyhow::Result<()> {
    let CodexSpanMerge {
        spans,
        lanes,
        update_summary,
        update_content,
        model,
        chat_msg_id,
        trace_id,
    } = merge;
    if update_summary && update_content {
        conn.execute(
            "DELETE FROM authorship_spans WHERE codex_entry_id = ?1",
            rusqlite::params![entry_id],
        )?;
    } else if update_summary {
        conn.execute(
            "DELETE FROM authorship_spans WHERE codex_entry_id = ?1 AND model = ?2",
            rusqlite::params![entry_id, LANE_SUMMARY_MODEL],
        )?;
    } else if update_content {
        conn.execute(
            "DELETE FROM authorship_spans WHERE codex_entry_id = ?1 AND model = ?2",
            rusqlite::params![entry_id, LANE_CONTENT_MODEL],
        )?;
    }
    let now = chrono::Utc::now().to_rfc3339();
    for (i, span) in spans.iter().enumerate() {
        let span_lane = lanes.and_then(|l| l.get(i)).and_then(|x| x.as_deref());
        let span_id = uuid::Uuid::new_v4().to_string();
        let resolved_model =
            lane_model(span_lane, span.model.as_deref()).or_else(|| model.map(str::to_string));
        conn.execute(
            "INSERT INTO authorship_spans
             (id, codex_entry_id, from_pos, to_pos, source, model, chat_msg_id, trace_id, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                span_id,
                entry_id,
                span.from_pos,
                span.to_pos,
                span.source,
                resolved_model,
                span.chat_msg_id.as_deref().or(chat_msg_id),
                span.trace_id.as_deref().or(trace_id),
                now,
            ],
        )?;
    }
    Ok(())
}

pub fn agent_codex_create_impl(
    db: &Database,
    payload: AgentCodexCreatePayload,
) -> anyhow::Result<Value> {
    let request_hash = codex_create_request_hash(&payload)?;
    let legacy_entity_request = payload.request_id.is_none() && payload.entry_id.is_some();
    let request_id = payload
        .request_id
        .clone()
        .or_else(|| payload.entry_id.clone());
    let entry_id = payload
        .entry_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let undo_id = request_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let content = payload.content.unwrap_or_else(|| "{}".to_string());
    let summary = payload.summary.unwrap_or_default();
    let aliases = payload.aliases;
    let parent_id = payload.parent_id;
    let source_chat_message_id = payload.source_chat_message_id;
    let timestamp = chrono::Utc::now().timestamp_millis();

    let mut change_payload = json!({
        "type": payload.type_slug,
        "name": payload.name,
        "parentId": parent_id,
    });
    if request_id.is_some() {
        change_payload["requestHash"] = Value::String(request_hash.clone());
    }

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            if let Some(request_id) = request_id.as_deref() {
                if let Some(existing) = existing_request_result(
                    conn,
                    request_id,
                    &request_hash,
                    "AGENT_CODEX_CREATE_IDEMPOTENCY_CONFLICT",
                )? {
                    return Ok(existing);
                }
            }
            if legacy_entity_request {
                if let Some(existing) = existing_create_result(
                    conn,
                    "codex_entries",
                    &payload.project_id,
                    "codex_entry",
                    &entry_id,
                    &request_hash,
                    "AGENT_CODEX_CREATE_IDEMPOTENCY_CONFLICT",
                )? {
                    return Ok(existing);
                }
            }
            conn.execute(
                "INSERT INTO codex_entries
                 (id, project_id, type, name, aliases, summary, content, parent_id,
                  source_chat_message_id, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)",
                rusqlite::params![
                    entry_id,
                    payload.project_id,
                    payload.type_slug,
                    payload.name,
                    aliases,
                    summary,
                    content,
                    parent_id,
                    source_chat_message_id,
                    now,
                ],
            )?;

            merge_codex_authorship_spans(
                conn,
                &entry_id,
                CodexSpanMerge {
                    spans: &payload.authorship_spans,
                    lanes: None,
                    update_summary: true,
                    update_content: true,
                    model: payload.model.as_deref(),
                    chat_msg_id: payload
                        .chat_message_id
                        .as_deref()
                        .or(source_chat_message_id.as_deref()),
                    trace_id: payload.trace_id.as_deref(),
                },
            )?;

            let after_base: String = conn.query_row(
                "SELECT json_object(
                    'id', id, 'projectId', project_id, 'type', type, 'name', name,
                    'summary', summary, 'content', content, 'aliases', aliases,
                    'parentId', parent_id, 'version', version
                 ) FROM codex_entries WHERE id = ?1",
                rusqlite::params![entry_id],
                |row| row.get(0),
            )?;
            let after_snapshot = grimodex_core::undo_journal::codex_update_after_snapshot(
                conn,
                &entry_id,
                &after_base,
            )?;

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: "in-app-agent",
                    entity_kind: "codex_entry",
                    entity_id: &entry_id,
                    op_kind: "create",
                    before_json: None,
                    after_json: Some(&after_snapshot),
                    base_version: 0,
                    result_version: 1,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "codex".to_string(),
                    op_type: "entry.create".to_string(),
                    entity_type: Some("codex_entry".to_string()),
                    entity_id: Some(entry_id.clone()),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: entry_id.clone(),
                version: 1,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

pub fn agent_codex_update_impl(
    db: &Database,
    payload: AgentCodexUpdatePayload,
) -> anyhow::Result<Value> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;

        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let (db_version, before_base): (i64, String) = conn.query_row(
                "SELECT version, json_object(
                    'id', id, 'projectId', project_id, 'type', type, 'name', name,
                    'summary', summary, 'content', content, 'aliases', aliases,
                    'parentId', parent_id, 'version', version
                 ) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.entry_id, payload.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            let before_row = grimodex_core::undo_journal::codex_update_before_snapshot(
                conn,
                &payload.entry_id,
                &before_base,
            )?;
            if db_version != payload.base_version {
                anyhow::bail!(
                    "Codex entry '{}' version conflict: expected {} but database has {}",
                    payload.entry_id,
                    payload.base_version,
                    db_version
                );
            }
            let base_version = payload.base_version;

            let mut sets = vec!["updated_at = ?1".to_string(), "version = version + 1".to_string()];
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(now.clone())];
            let mut param_idx = 2;

            if let Some(ref name) = payload.name {
                sets.push(format!("name = ?{param_idx}"));
                params.push(Box::new(name.clone()));
                param_idx += 1;
            }
            if let Some(ref summary) = payload.summary {
                sets.push(format!("summary = ?{param_idx}"));
                params.push(Box::new(summary.clone()));
                param_idx += 1;
            }
            if let Some(ref content) = payload.content {
                sets.push(format!("content = ?{param_idx}"));
                params.push(Box::new(content.clone()));
                param_idx += 1;
            }
            if let Some(ref aliases) = payload.aliases {
                sets.push(format!("aliases = ?{param_idx}"));
                params.push(Box::new(aliases.clone()));
                param_idx += 1;
            }

            let sql = format!(
                "UPDATE codex_entries SET {} WHERE id = ?{param_idx} AND project_id = ?{} AND version = ?{}",
                sets.join(", "),
                param_idx + 1,
                param_idx + 2
            );
            params.push(Box::new(payload.entry_id.clone()));
            params.push(Box::new(payload.project_id.clone()));
            params.push(Box::new(base_version));

            let updated = conn.execute(
                &sql,
                rusqlite::params_from_iter(params.iter().map(|p| p as &dyn rusqlite::types::ToSql)),
            )?;
            if updated == 0 {
                anyhow::bail!(
                    "Codex entry '{}' version conflict or not found in project '{}'",
                    payload.entry_id,
                    payload.project_id
                );
            }

            let result_version = base_version + 1;

            if let Some(ref spans) = payload.authorship_spans {
                merge_codex_authorship_spans(
                    conn,
                    &payload.entry_id,
                    CodexSpanMerge {
                        spans,
                        lanes: payload.authorship_span_lanes.as_deref(),
                        update_summary: payload.summary.is_some(),
                        update_content: payload.content.is_some(),
                        model: payload.model.as_deref(),
                        chat_msg_id: payload.chat_message_id.as_deref(),
                        trace_id: payload.trace_id.as_deref(),
                    },
                )?;
            }

            let after_base: String = conn.query_row(
                "SELECT json_object(
                    'id', id, 'projectId', project_id, 'type', type, 'name', name,
                    'summary', summary, 'content', content, 'aliases', aliases,
                    'parentId', parent_id, 'version', version
                 ) FROM codex_entries WHERE id = ?1",
                rusqlite::params![payload.entry_id],
                |row| row.get(0),
            )?;
            let after_row = grimodex_core::undo_journal::codex_update_after_snapshot(
                conn,
                &payload.entry_id,
                &after_base,
            )?;

            let fields: Vec<&str> = [
                payload.name.as_ref().map(|_| "name"),
                payload.summary.as_ref().map(|_| "summary"),
                payload.content.as_ref().map(|_| "content"),
                payload.aliases.as_ref().map(|_| "aliases"),
            ]
            .into_iter()
            .flatten()
            .collect();

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: "in-app-agent",
                    entity_kind: "codex_entry",
                    entity_id: &payload.entry_id,
                    op_kind: "update",
                    before_json: Some(&before_row),
                    after_json: Some(&after_row),
                    base_version,
                    result_version,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "codex".to_string(),
                    op_type: "entry.update".to_string(),
                    entity_type: Some("codex_entry".to_string()),
                    entity_id: Some(payload.entry_id.clone()),
                    payload: json!({ "fields": fields }).to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.entry_id.clone(),
                version: result_version,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoJournalPayload {
    pub entity_kind: String,
    pub entity_id: String,
    pub op_kind: String,
    pub before_json: Option<String>,
    pub after_json: Option<String>,
    pub base_version: i64,
    pub result_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEventPayload {
    pub event_uid: String,
    pub scene_id: Option<String>,
    pub domain: String,
    pub op_type: String,
    pub entity_type: Option<String>,
    pub entity_id: Option<String>,
    pub payload: String,
    pub timestamp: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWriteBundlePayload {
    pub project_id: String,
    pub session_id: String,
    pub surface: String,
    pub statements: Vec<BatchStatement>,
    pub undo_journal: UndoJournalPayload,
    pub change_event: ChangeEventPayload,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnippetCreatePayload {
    /// Stable identity of the logical request, independent of `snippet_id`.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Domain-owned idempotency key for create retries.
    #[serde(default)]
    pub snippet_id: Option<String>,
    pub project_id: String,
    pub session_id: String,
    pub title: String,
    pub content: Option<String>,
    pub scene_id: Option<String>,
    pub source_chat_message_id: Option<String>,
    pub model: Option<String>,
    pub chat_message_id: Option<String>,
    pub trace_id: Option<String>,
    pub authorship_spans: Vec<AuthorshipSpanInput>,
}

fn run_statements_in_tx(
    conn: &rusqlite::Connection,
    statements: &[BatchStatement],
) -> anyhow::Result<()> {
    for stmt in statements {
        Database::execute_with_conn(conn, &stmt.sql, &stmt.params, &stmt.method)?;
    }
    Ok(())
}

fn replace_snippet_authorship_spans(
    conn: &rusqlite::Connection,
    snippet_id: &str,
    spans: &[AuthorshipSpanInput],
    model: Option<&str>,
    chat_msg_id: Option<&str>,
    trace_id: Option<&str>,
) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM authorship_spans WHERE snippet_id = ?1",
        rusqlite::params![snippet_id],
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    for span in spans {
        let span_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO authorship_spans
             (id, snippet_id, from_pos, to_pos, source, model, chat_msg_id, trace_id, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                span_id,
                snippet_id,
                span.from_pos,
                span.to_pos,
                span.source,
                span.model.as_deref().or(model),
                span.chat_msg_id.as_deref().or(chat_msg_id),
                span.trace_id.as_deref().or(trace_id),
                now,
            ],
        )?;
    }
    Ok(())
}

pub fn agent_write_bundle_impl(
    db: &Database,
    payload: AgentWriteBundlePayload,
) -> anyhow::Result<Value> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            run_statements_in_tx(conn, &payload.statements)?;

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: &payload.surface,
                    entity_kind: &payload.undo_journal.entity_kind,
                    entity_id: &payload.undo_journal.entity_id,
                    op_kind: &payload.undo_journal.op_kind,
                    before_json: payload.undo_journal.before_json.as_deref(),
                    after_json: payload.undo_journal.after_json.as_deref(),
                    base_version: payload.undo_journal.base_version,
                    result_version: payload.undo_journal.result_version,
                    change_event_uid: Some(&payload.change_event.event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: payload.change_event.event_uid.clone(),
                    scene_id: payload.change_event.scene_id.clone(),
                    domain: payload.change_event.domain.clone(),
                    op_type: payload.change_event.op_type.clone(),
                    entity_type: payload.change_event.entity_type.clone(),
                    entity_id: payload.change_event.entity_id.clone(),
                    payload: payload.change_event.payload.clone(),
                    timestamp: payload.change_event.timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.undo_journal.entity_id.clone(),
                version: payload.undo_journal.result_version,
                change_event_uid: payload.change_event.event_uid.clone(),
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

pub fn agent_snippet_create_impl(
    db: &Database,
    payload: AgentSnippetCreatePayload,
) -> anyhow::Result<Value> {
    let request_hash = snippet_create_request_hash(&payload)?;
    let legacy_entity_request = payload.request_id.is_none() && payload.snippet_id.is_some();
    let request_id = payload
        .request_id
        .clone()
        .or_else(|| payload.snippet_id.clone());
    let snippet_id = payload
        .snippet_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let undo_id = request_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let content = payload.content.unwrap_or_else(|| "{}".to_string());
    let timestamp = chrono::Utc::now().timestamp_millis();

    let after_base = json!({
        "id": snippet_id,
        "projectId": payload.project_id,
        "title": payload.title,
        "content": content,
        "sceneId": payload.scene_id,
        "contentSource": "ai",
        "version": 1,
    })
    .to_string();

    let mut change_payload = json!({
        "title": payload.title,
        "sceneId": payload.scene_id,
    });
    if request_id.is_some() {
        change_payload["requestHash"] = Value::String(request_hash.clone());
    }

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            if let Some(request_id) = request_id.as_deref() {
                if let Some(existing) = existing_request_result(
                    conn,
                    request_id,
                    &request_hash,
                    "AGENT_SNIPPET_CREATE_IDEMPOTENCY_CONFLICT",
                )? {
                    return Ok(existing);
                }
            }
            if legacy_entity_request {
                if let Some(existing) = existing_create_result(
                    conn,
                    "snippets",
                    &payload.project_id,
                    "snippet",
                    &snippet_id,
                    &request_hash,
                    "AGENT_SNIPPET_CREATE_IDEMPOTENCY_CONFLICT",
                )? {
                    return Ok(existing);
                }
            }
            conn.execute(
                "INSERT INTO snippets
                 (id, project_id, title, content, scene_id, content_source,
                  source_chat_message_id, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'ai', ?6, 1, ?7, ?7)",
                rusqlite::params![
                    snippet_id,
                    payload.project_id,
                    payload.title,
                    content,
                    payload.scene_id,
                    payload.source_chat_message_id,
                    now,
                ],
            )?;

            replace_snippet_authorship_spans(
                conn,
                &snippet_id,
                &payload.authorship_spans,
                payload.model.as_deref(),
                payload
                    .chat_message_id
                    .as_deref()
                    .or(payload.source_chat_message_id.as_deref()),
                payload.trace_id.as_deref(),
            )?;

            let after_snapshot = grimodex_core::undo_journal::snippet_create_after_snapshot(
                conn,
                &snippet_id,
                &after_base,
            )?;

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: "in-app-agent",
                    entity_kind: "snippet",
                    entity_id: &snippet_id,
                    op_kind: "create",
                    before_json: None,
                    after_json: Some(&after_snapshot),
                    base_version: 0,
                    result_version: 1,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: payload.scene_id.clone(),
                    domain: "snippet".to_string(),
                    op_type: "snippet.create".to_string(),
                    entity_type: Some("snippet".to_string()),
                    entity_id: Some(snippet_id.clone()),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: snippet_id.clone(),
                version: 1,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Prose staging (Phase 5 — accept/reject body writes)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProposeSceneBodyPayload {
    pub project_id: String,
    pub session_id: String,
    pub scene_id: String,
    pub proposed_content: String,
    /// "append" | "insert" | "replace"
    pub mode: String,
    pub source_surface: String,
    pub replace_from: Option<i64>,
    pub replace_to: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProseStageIdPayload {
    pub project_id: String,
    pub session_id: String,
    pub staging_id: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProseStageResult {
    staging_id: String,
    scene_id: String,
    status: String,
}

fn is_file_backed_scene(source_uri: Option<&str>) -> bool {
    match source_uri {
        None => false,
        Some(uri) if uri.ends_with("/.mount") => false,
        Some(_) => true,
    }
}

pub fn agent_propose_scene_body_impl(
    db: &Database,
    payload: AgentProposeSceneBodyPayload,
) -> anyhow::Result<Value> {
    let staging_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();
    let now = chrono::Utc::now().to_rfc3339();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<ProseStageResult> {
            let (base_version, source_uri): (i64, Option<String>) = conn.query_row(
                "SELECT version, source_uri FROM tree_nodes
                 WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
                rusqlite::params![payload.scene_id, payload.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;

            if is_file_backed_scene(source_uri.as_deref()) {
                anyhow::bail!("file-backed scenes are excluded from headless prose staging (v1)");
            }

            let content_json = json!({
                "mode": payload.mode,
                "text": payload.proposed_content,
                "replaceFrom": payload.replace_from,
                "replaceTo": payload.replace_to,
            });

            conn.execute(
                "INSERT INTO prose_staging
                 (id, project_id, scene_id, proposed_content, base_version, status,
                  source_surface, source_session_id, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'proposed', ?6, ?7, ?8, ?8)",
                rusqlite::params![
                    staging_id,
                    payload.project_id,
                    payload.scene_id,
                    content_json.to_string(),
                    base_version,
                    payload.source_surface,
                    payload.session_id,
                    now,
                ],
            )?;

            let change_payload = json!({
                "stagingId": staging_id,
                "sceneId": payload.scene_id,
                "mode": payload.mode,
                "preview": payload.proposed_content.chars().take(200).collect::<String>(),
            });

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: Some(payload.scene_id.clone()),
                    domain: "prose".to_string(),
                    op_type: "prose.propose".to_string(),
                    entity_type: Some("prose_staging".to_string()),
                    entity_id: Some(staging_id.clone()),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;

            Ok(ProseStageResult {
                staging_id: staging_id.clone(),
                scene_id: payload.scene_id.clone(),
                status: "proposed".to_string(),
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

pub fn agent_accept_prose_stage_impl(
    db: &Database,
    payload: AgentProseStageIdPayload,
) -> anyhow::Result<Value> {
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();
    let now = chrono::Utc::now().to_rfc3339();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<ProseStageResult> {
            let (scene_id, status): (String, String) = conn.query_row(
                "SELECT scene_id, status FROM prose_staging
                 WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.staging_id, payload.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;

            if status != "proposed" {
                // NOTE: 部分文字列 "not in proposed status" に JS 側
                // (useAgentProseStaging の isRowNotProposedError) が依存。
                // 文言を変える場合は両方更新すること。
                anyhow::bail!("staging entry is not in proposed status");
            }

            conn.execute(
                "UPDATE prose_staging SET status = 'accepted', updated_at = ?1
                 WHERE id = ?2 AND project_id = ?3",
                rusqlite::params![now, payload.staging_id, payload.project_id],
            )?;

            let change_payload = json!({
                "stagingId": payload.staging_id,
                "sceneId": scene_id,
            });

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: Some(scene_id.clone()),
                    domain: "prose".to_string(),
                    op_type: "prose.accept".to_string(),
                    entity_type: Some("prose_staging".to_string()),
                    entity_id: Some(payload.staging_id.clone()),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;

            Ok(ProseStageResult {
                staging_id: payload.staging_id.clone(),
                scene_id,
                status: "accepted".to_string(),
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

pub fn agent_discard_prose_stage_impl(
    db: &Database,
    payload: AgentProseStageIdPayload,
) -> anyhow::Result<Value> {
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();
    let now = chrono::Utc::now().to_rfc3339();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<ProseStageResult> {
            let (scene_id, status): (String, String) = conn.query_row(
                "SELECT scene_id, status FROM prose_staging
                 WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.staging_id, payload.project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;

            if status != "proposed" {
                // NOTE: 部分文字列 "not in proposed status" に JS 側
                // (useAgentProseStaging の isRowNotProposedError) が依存。
                // 文言を変える場合は両方更新すること。
                anyhow::bail!("staging entry is not in proposed status");
            }

            conn.execute(
                "UPDATE prose_staging SET status = 'discarded', updated_at = ?1
                 WHERE id = ?2 AND project_id = ?3",
                rusqlite::params![now, payload.staging_id, payload.project_id],
            )?;

            let change_payload = json!({
                "stagingId": payload.staging_id,
                "sceneId": scene_id,
            });

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: Some(scene_id.clone()),
                    domain: "prose".to_string(),
                    op_type: "prose.discard".to_string(),
                    entity_type: Some("prose_staging".to_string()),
                    entity_id: Some(payload.staging_id.clone()),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;

            Ok(ProseStageResult {
                staging_id: payload.staging_id.clone(),
                scene_id,
                status: "discarded".to_string(),
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUndoJournalPayload {
    #[serde(default)]
    pub request_id: Option<String>,
    pub project_id: String,
    pub session_id: String,
    pub journal_id: String,
    /// "undo" | "redo"
    pub direction: String,
}

fn undo_journal_change_event(
    row: &grimodex_core::undo_journal::UndoJournalRow,
    direction: &str,
) -> anyhow::Result<(String, String, String, String)> {
    let (domain, entity_type, create_op, delete_op, update_op) = match row.entity_kind.as_str() {
        "codex_entry" => (
            "codex",
            "codex_entry",
            "entry.create",
            "entry.delete",
            "entry.update",
        ),
        "snippet" => (
            "snippet",
            "snippet",
            "snippet.create",
            "snippet.delete",
            "snippet.update",
        ),
        "foreshadow" => (
            "foreshadow",
            "foreshadow",
            "foreshadow.create",
            "foreshadow.delete",
            "foreshadow.update",
        ),
        "event" => (
            "event",
            "event",
            "event.create",
            "event.delete",
            "event.update",
        ),
        "chronicle_bulk" => (
            "event",
            "chronicle_bulk",
            "chronicle.bulk",
            "chronicle.bulk",
            "chronicle.bulk",
        ),
        other => anyhow::bail!("undo_journal_change_event: unsupported entity_kind '{other}'"),
    };
    let op_type = match (direction, row.op_kind.as_str()) {
        ("undo", "create") => delete_op.to_string(),
        ("redo", "create") => create_op.to_string(),
        // Tracked deletes (currently only `event`): undoing a delete re-creates,
        // redoing it deletes again.
        ("undo", "delete") => create_op.to_string(),
        ("redo", "delete") => delete_op.to_string(),
        ("undo" | "redo", "update") if row.entity_kind == "event" => {
            let raw = if direction == "undo" {
                row.before_json.as_deref()
            } else {
                row.after_json.as_deref()
            }
            .ok_or_else(|| anyhow::anyhow!("event update replay snapshot is missing"))?;
            let snap: Value = serde_json::from_str(raw)?;
            if snap.get("participants").is_some() && snap.get("eventData").is_none() {
                "event.participants".to_string()
            } else if snap.get("sceneId").is_some() {
                if snap["linked"].as_bool().unwrap_or(false) {
                    "event.stamp".to_string()
                } else {
                    "event.unstamp".to_string()
                }
            } else if snap.get("causeEventId").is_some() {
                if snap["linked"].as_bool().unwrap_or(false) {
                    "event.relation_add".to_string()
                } else {
                    "event.relation_remove".to_string()
                }
            } else {
                update_op.to_string()
            }
        }
        ("undo", "update") | ("redo", "update") => update_op.to_string(),
        (dir, op) => anyhow::bail!("undo_journal_change_event: unsupported {dir}/{op}"),
    };
    Ok((
        domain.to_string(),
        entity_type.to_string(),
        op_type,
        row.entity_id.clone(),
    ))
}

fn event_replay_snapshot_raw<'a>(
    row: &'a grimodex_core::undo_journal::UndoJournalRow,
    direction: &str,
) -> Option<&'a str> {
    match (direction, row.op_kind.as_str()) {
        ("undo" | "redo", "create") => row.after_json.as_deref(),
        ("undo" | "redo", "delete") => row.before_json.as_deref(),
        ("undo", "update") => row.before_json.as_deref(),
        ("redo", "update") => row.after_json.as_deref(),
        _ => None,
    }
}

fn event_snapshot_related_ids(snap: &Value) -> Vec<String> {
    let mut related = std::collections::BTreeSet::new();
    for key in ["asCause", "asEffect"] {
        if let Some(relations) = snap["relations"][key].as_array() {
            for relation in relations {
                for field in ["causeEventId", "effectEventId"] {
                    if let Some(id) = relation[field].as_str() {
                        related.insert(id.to_string());
                    }
                }
            }
        }
    }
    related.into_iter().collect()
}

fn enrich_event_replay_change_payload(
    row: &grimodex_core::undo_journal::UndoJournalRow,
    direction: &str,
    payload: &mut Value,
) -> anyhow::Result<()> {
    if row.entity_kind == "chronicle_bulk" {
        return crate::chronicle_bulk::enrich_replay_change_payload(row, payload);
    }
    if row.entity_kind != "event" {
        return Ok(());
    }
    let Some(raw) = event_replay_snapshot_raw(row, direction) else {
        return Ok(());
    };
    let snap: Value = serde_json::from_str(raw)?;
    let Some(object) = payload.as_object_mut() else {
        return Ok(());
    };
    if let Some(id) = snap["eventId"].as_str() {
        object.insert("eventId".to_string(), Value::from(id));
    }
    if let Some(id) = snap["sceneId"].as_str() {
        object.insert("sceneId".to_string(), Value::from(id));
    }
    if let Some(id) = snap["causeEventId"].as_str() {
        object.insert("causeEventId".to_string(), Value::from(id));
    }
    if let Some(id) = snap["effectEventId"].as_str() {
        object.insert("effectEventId".to_string(), Value::from(id));
    }
    if matches!(row.op_kind.as_str(), "create" | "delete") {
        let related = event_snapshot_related_ids(&snap);
        if !related.is_empty() {
            object.insert("relatedEventIds".to_string(), json!(related));
        }
    }
    Ok(())
}

pub fn agent_undo_journal_impl(
    db: &Database,
    payload: AgentUndoJournalPayload,
) -> anyhow::Result<Value> {
    if payload.request_id.as_deref() == Some("") {
        anyhow::bail!("undo journal requestId must not be empty");
    }
    let request_hash = payload
        .request_id
        .as_ref()
        .map(|_| {
            idempotency_hash(
                "agent_apply_undo_journal",
                &json!({
                    "projectId": payload.project_id,
                    "journalId": payload.journal_id,
                    "direction": payload.direction,
                }),
            )
        })
        .transpose()?;
    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            if let (Some(request_id), Some(payload_hash)) =
                (payload.request_id.as_deref(), request_hash.as_deref())
            {
                let request = IdempotencyRequest {
                    domain: "agent_apply_undo_journal",
                    request_id: Some(request_id),
                    payload_hash,
                    conflict_marker: "UNDO_JOURNAL_IDEMPOTENCY_CONFLICT",
                };
                if let Some(existing) = load_idempotent_response(conn, &request)? {
                    return Ok(existing);
                }
            }
            let row = grimodex_core::undo_journal::load_undo_journal(
                conn,
                &payload.project_id,
                &payload.journal_id,
            )?;
            // Chronicle events carry a composite snapshot (eventData +
            // participants + sceneLinks + relations) that the single-table
            // grimodex-core restorers don't understand, so they're handled by
            // the local event restorers; everything else delegates to core.
            if row.entity_kind == "event" {
                match payload.direction.as_str() {
                    "undo" => revert_event_undo_in_tx(conn, &payload.project_id, &row)?,
                    "redo" => apply_event_redo_in_tx(conn, &payload.project_id, &row)?,
                    other => anyhow::bail!("invalid undo direction: {other}"),
                }
            } else if row.entity_kind == "chronicle_bulk" {
                crate::chronicle_bulk::replay_chronicle_bulk_in_tx(
                    conn,
                    &payload.project_id,
                    &row,
                    &payload.direction,
                )?;
            } else {
                match payload.direction.as_str() {
                    "undo" => grimodex_core::undo_journal::revert_undo_journal_in_tx(
                        conn,
                        &payload.project_id,
                        &payload.journal_id,
                    )?,
                    "redo" => grimodex_core::undo_journal::apply_undo_journal_in_tx(
                        conn,
                        &payload.project_id,
                        &payload.journal_id,
                    )?,
                    other => anyhow::bail!("invalid undo direction: {other}"),
                }
            }
            let (domain, entity_type, op_type, entity_id) =
                undo_journal_change_event(&row, &payload.direction)?;
            let event_uid = uuid::Uuid::new_v4().to_string();
            let timestamp = chrono::Utc::now().timestamp_millis();
            let mut change_payload = json!({
                "direction": payload.direction,
                "opKind": row.op_kind,
                "journalId": payload.journal_id,
            });
            enrich_event_replay_change_payload(&row, &payload.direction, &mut change_payload)?;
            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid,
                    scene_id: None,
                    domain,
                    op_type,
                    entity_type: Some(entity_type),
                    entity_id: Some(entity_id),
                    payload: change_payload.to_string(),
                    timestamp,
                }],
            )?;
            let response = json!({ "ok": true });
            if let (Some(request_id), Some(payload_hash)) =
                (payload.request_id.as_deref(), request_hash.as_deref())
            {
                insert_idempotent_response(
                    conn,
                    &IdempotencyRequest {
                        domain: "agent_apply_undo_journal",
                        request_id: Some(request_id),
                        payload_hash,
                        conflict_marker: "UNDO_JOURNAL_IDEMPOTENCY_CONFLICT",
                    },
                    &payload.project_id,
                    &response,
                )?;
            }
            Ok(response)
        })();
        match result {
            Ok(response) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(response)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

// ---------------------------------------------------------------------------
// Foreshadow writes — thin adapters over grimodex-core's tracked writers
// (the same path the MCP foreshadow tools use, surface differs).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentForeshadowCreatePayload {
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    foreshadow_id: Option<String>,
    project_id: String,
    session_id: String,
    title: String,
    intent: Option<String>,
    notes: Option<String>,
    load_bearing: Option<String>,
    secret: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentForeshadowUpdatePayload {
    project_id: String,
    session_id: String,
    foreshadow_id: String,
    title: Option<String>,
    intent: Option<String>,
    notes: Option<String>,
    load_bearing: Option<String>,
    payoff_confirmed: Option<bool>,
    abandoned: Option<bool>,
    secret: Option<bool>,
}

pub fn agent_write_result_json(res: grimodex_core::writes::WriteResult) -> anyhow::Result<Value> {
    Ok(serde_json::to_value(AgentWriteResult {
        entity_id: res.entity_id,
        version: res.version,
        change_event_uid: res.change_event_uid,
        undo_journal_id: res.undo_journal_id,
    })?)
}

pub fn agent_foreshadow_create_impl(
    db: &Database,
    payload: AgentForeshadowCreatePayload,
) -> anyhow::Result<Value> {
    let request_hash = foreshadow_create_request_hash(&payload)?;
    let foreshadow_id = payload
        .foreshadow_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    db.with_conn(|conn| {
        let res = grimodex_core::writes::foreshadow::tracked_foreshadow_create(
            conn,
            grimodex_core::writes::foreshadow::TrackedForeshadowCreateInput {
                project_id: &payload.project_id,
                session_id: &payload.session_id,
                surface: "in-app-agent",
                foreshadow_id: &foreshadow_id,
                title: &payload.title,
                intent: payload.intent.as_deref(),
                notes: payload.notes.as_deref(),
                load_bearing: payload.load_bearing.as_deref(),
                secret: payload.secret,
                request_id: payload.request_id.as_deref(),
                request_hash: Some(&request_hash),
            },
        )
        .map_err(|error| anyhow::anyhow!("agent_foreshadow_create: {error:#}"))?;
        agent_write_result_json(res)
    })
}

pub fn agent_foreshadow_update_impl(
    db: &Database,
    payload: AgentForeshadowUpdatePayload,
) -> anyhow::Result<Value> {
    db.with_conn(|conn| {
        grimodex_core::writes::foreshadow::tracked_foreshadow_update(
            conn,
            grimodex_core::writes::foreshadow::TrackedForeshadowUpdateInput {
                project_id: &payload.project_id,
                session_id: &payload.session_id,
                surface: "in-app-agent",
                foreshadow_id: &payload.foreshadow_id,
                patch: grimodex_core::writes::foreshadow::ForeshadowPatch {
                    title: payload.title.as_deref(),
                    intent: payload.intent.as_deref(),
                    notes: payload.notes.as_deref(),
                    load_bearing: payload.load_bearing.as_deref(),
                    payoff_confirmed: payload.payoff_confirmed,
                    abandoned: payload.abandoned,
                    secret: payload.secret,
                },
            },
        )?
        .ok_or_else(|| anyhow::anyhow!("foreshadow not found in project"))
        .and_then(agent_write_result_json)
    })
}

// ---------------------------------------------------------------------------
// Chronicle (作中年表) writes — events + participants + scene links + relations.
// Mirrors the codex create/update/delete transaction shape. `events.version`
// is the aggregate OCC token for event fields + participants. Scene links and
// causal relations remain independent association writes.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventCreatePayload {
    /// Stable identity of the logical request, independent of `event_id`.
    #[serde(default)]
    request_id: Option<String>,
    /// Domain-owned idempotency key for create retries.
    #[serde(default)]
    event_id: Option<String>,
    project_id: String,
    session_id: String,
    /// 書き込み元の表面: "in-app-agent"(AI) / "mcp" / "manual"(UI手動編集)。
    /// 省略時(既存JS経路)は in-app-agent 互換。undo_journal の provenance に使う。
    surface: Option<String>,
    title: Option<String>,
    note: Option<String>,
    /// 出来事の詳細（リッチテキスト = ProseMirror JSON 文字列）。
    detail: Option<String>,
    ordinal: Option<String>,
    primary_codex_id: Option<String>,
    /// 未割当の整理用サブレーン id。
    lane_group: Option<String>,
    location_codex_id: Option<String>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    start_minute: Option<i64>,
    end_minute: Option<i64>,
    start_granularity: Option<String>,
    end_granularity: Option<String>,
    precision: Option<String>,
    kind: Option<String>,
    /// AI 秘匿（reveal アンカー方式）。省略時 false=表示。
    secret: Option<bool>,
    /// 読む順の開示アンカー（明示上書き・空/None=自動導出 or 恒久秘匿）。
    reveal_scene_id: Option<String>,
    participant_codex_ids: Option<Vec<String>>,
    scene_ids: Option<Vec<String>>,
}

/// Patch-style update. Each field is set-if-present (a missing field is left
/// untouched). Clearing a nullable column to NULL is not expressible here —
/// matches the codex update contract.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventUpdatePayload {
    project_id: String,
    session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    surface: Option<String>,
    event_id: String,
    /// Version observed when the caller loaded this Event aggregate.
    base_version: i64,
    title: Option<String>,
    note: Option<String>,
    /// 出来事の詳細（リッチテキスト = ProseMirror JSON 文字列）。set-if-present。
    detail: Option<String>,
    ordinal: Option<String>,
    primary_codex_id: Option<String>,
    /// 未割当の整理用サブレーン id（空文字は NULL=既定の未割当レーンへ）。
    lane_group: Option<String>,
    location_codex_id: Option<String>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    start_minute: Option<i64>,
    end_minute: Option<i64>,
    start_granularity: Option<String>,
    end_granularity: Option<String>,
    precision: Option<String>,
    kind: Option<String>,
    /// AI 秘匿（reveal アンカー方式）。set-if-present。
    secret: Option<bool>,
    /// 読む順の開示アンカー（set-if-present・空文字は NULL=自動導出へ戻す）。
    reveal_scene_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventIdPayload {
    project_id: String,
    session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    surface: Option<String>,
    event_id: String,
    /// Version observed when the caller loaded this Event aggregate.
    base_version: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventParticipantsPayload {
    project_id: String,
    session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    surface: Option<String>,
    event_id: String,
    /// Version observed when the caller loaded this Event aggregate.
    base_version: i64,
    codex_entry_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSceneEventPayload {
    /// Request-owned idempotency key. The association has only a natural
    /// composite key, so this key also deduplicates journal/event side effects.
    #[serde(default)]
    request_id: Option<String>,
    project_id: String,
    session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    surface: Option<String>,
    scene_id: String,
    event_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventRelationPayload {
    #[serde(default)]
    request_id: Option<String>,
    project_id: String,
    session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    surface: Option<String>,
    cause_event_id: String,
    effect_event_id: String,
}

/// Full self-contained snapshot of an event row + its participants, scene
/// links, and causal relations (both directions). Used as the undo `before`
/// for delete (cascade-restorable) and before/after for create/update.
pub(crate) fn collect_event_snapshot(
    conn: &rusqlite::Connection,
    event_id: &str,
) -> anyhow::Result<Value> {
    let event_json: String = conn.query_row(
        "SELECT json_object(
            'id', id, 'projectId', project_id, 'title', title, 'note', note,
            'detail', detail,
            'ordinal', ordinal, 'primaryCodexId', primary_codex_id,
            'laneGroup', lane_group,
            'locationCodexId', location_codex_id, 'startTime', start_time,
            'endTime', end_time, 'startMinute', start_minute,
            'endMinute', end_minute, 'startGranularity', start_granularity,
            'endGranularity', end_granularity, 'precision', precision, 'kind', kind,
            'secret', secret, 'revealSceneId', reveal_scene_id,
            'version', version,
            'createdAt', created_at, 'updatedAt', updated_at
         ) FROM events WHERE id = ?1",
        rusqlite::params![event_id],
        |row| row.get(0),
    )?;
    let event_data: Value = serde_json::from_str(&event_json)?;

    let participants = {
        let mut stmt = conn.prepare(
            "SELECT codex_entry_id, role FROM event_participants
             WHERE event_id = ?1 ORDER BY codex_entry_id",
        )?;
        let rows = stmt.query_map(rusqlite::params![event_id], |row| {
            let codex_entry_id: String = row.get(0)?;
            let role: Option<String> = row.get(1)?;
            Ok(json!({ "codexEntryId": codex_entry_id, "role": role }))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let scene_links = {
        let mut stmt = conn
            .prepare("SELECT scene_id FROM scene_events WHERE event_id = ?1 ORDER BY scene_id")?;
        let rows = stmt.query_map(rusqlite::params![event_id], |row| row.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let relations_as_cause = {
        let mut stmt = conn.prepare(
            "SELECT project_id, effect_event_id FROM event_relations
             WHERE cause_event_id = ?1 ORDER BY effect_event_id",
        )?;
        let rows = stmt.query_map(rusqlite::params![event_id], |row| {
            let project_id: String = row.get(0)?;
            let effect_event_id: String = row.get(1)?;
            Ok(json!({ "projectId": project_id, "effectEventId": effect_event_id }))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    let relations_as_effect = {
        let mut stmt = conn.prepare(
            "SELECT project_id, cause_event_id FROM event_relations
             WHERE effect_event_id = ?1 ORDER BY cause_event_id",
        )?;
        let rows = stmt.query_map(rusqlite::params![event_id], |row| {
            let project_id: String = row.get(0)?;
            let cause_event_id: String = row.get(1)?;
            Ok(json!({ "projectId": project_id, "causeEventId": cause_event_id }))
        })?;
        rows.collect::<Result<Vec<_>, _>>()?
    };

    Ok(json!({
        "eventData": event_data,
        "participants": participants,
        "sceneLinks": scene_links,
        "relations": {
            "asCause": relations_as_cause,
            "asEffect": relations_as_effect,
        },
    }))
}

fn collect_participants_json(conn: &rusqlite::Connection, event_id: &str) -> anyhow::Result<Value> {
    let version: i64 = conn.query_row(
        "SELECT version FROM events WHERE id = ?1",
        rusqlite::params![event_id],
        |row| row.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT codex_entry_id, role FROM event_participants
         WHERE event_id = ?1 ORDER BY codex_entry_id",
    )?;
    let rows = stmt.query_map(rusqlite::params![event_id], |row| {
        let codex_entry_id: String = row.get(0)?;
        let role: Option<String> = row.get(1)?;
        Ok(json!({ "codexEntryId": codex_entry_id, "role": role }))
    })?;
    let participants = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "eventId": event_id,
        "version": version,
        "participants": participants,
    }))
}

// ---------------------------------------------------------------------------
// Chronicle undo/redo restorers. The forward writers store either a composite
// snapshot (`{eventData, participants, sceneLinks, relations}` for
// create/delete/event-update) or an association-only snapshot
// (set_participants / scene link / relation). Restore is idempotent
// (DELETE → INSERT OR IGNORE) and always scoped to `project_id` (XPROJ).
// ---------------------------------------------------------------------------

/// Rows per multi-row INSERT chunk. Keeps bind variables (up to 3 per row)
/// well below SQLite's default limit of 999.
const INSERT_CHUNK_ROWS: usize = 100;

/// Bulk-insert event participants with a chunked multi-row
/// `INSERT OR IGNORE` (OR IGNORE applies per row, so semantics match the
/// former per-row loop).
fn batch_insert_event_participants(
    conn: &rusqlite::Connection,
    event_id: &str,
    rows: &[(&str, Option<&str>)],
) -> anyhow::Result<()> {
    for chunk in rows.chunks(INSERT_CHUNK_ROWS) {
        let placeholders = vec!["(?, ?, ?)"; chunk.len()].join(", ");
        let sql = format!(
            "INSERT OR IGNORE INTO event_participants (event_id, codex_entry_id, role)
             VALUES {placeholders}"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 3);
        for (codex_id, role) in chunk {
            params.push(&event_id);
            params.push(codex_id);
            params.push(role);
        }
        conn.execute(&sql, params.as_slice())?;
    }
    Ok(())
}

/// Bulk-insert scene links for one event (chunked multi-row `INSERT OR IGNORE`).
fn batch_insert_scene_events(
    conn: &rusqlite::Connection,
    event_id: &str,
    scene_ids: &[&str],
) -> anyhow::Result<()> {
    for chunk in scene_ids.chunks(INSERT_CHUNK_ROWS) {
        let placeholders = vec!["(?, ?)"; chunk.len()].join(", ");
        let sql = format!(
            "INSERT OR IGNORE INTO scene_events (scene_id, event_id) VALUES {placeholders}"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 2);
        for scene_id in chunk {
            params.push(scene_id);
            params.push(&event_id);
        }
        conn.execute(&sql, params.as_slice())?;
    }
    Ok(())
}

/// Bulk-insert event relations as `(project_id, cause_event_id, effect_event_id)`
/// tuples (chunked multi-row `INSERT OR IGNORE`).
fn batch_insert_event_relations(
    conn: &rusqlite::Connection,
    rows: &[(&str, &str, &str)],
) -> anyhow::Result<()> {
    for chunk in rows.chunks(INSERT_CHUNK_ROWS) {
        let placeholders = vec!["(?, ?, ?)"; chunk.len()].join(", ");
        let sql = format!(
            "INSERT OR IGNORE INTO event_relations
             (project_id, cause_event_id, effect_event_id) VALUES {placeholders}"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 3);
        for (proj, cause, effect) in chunk {
            params.push(proj);
            params.push(cause);
            params.push(effect);
        }
        conn.execute(&sql, params.as_slice())?;
    }
    Ok(())
}

/// Restore the Event row from a snapshot. When `restore_associations` is true
/// (create/delete journal replay), also replace participants, scene links, and
/// relations. Field-only update replay deliberately leaves associations alone:
/// scene links and relations do not bump the Event aggregate version, so they
/// may have changed legitimately after the journalled row update.
pub(crate) fn apply_event_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    snap: &Value,
    target_version: Option<i64>,
    restore_associations: bool,
) -> anyhow::Result<()> {
    use rusqlite::OptionalExtension;

    let ed = &snap["eventData"];
    let id = ed["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("event snapshot missing eventData.id"))?;
    let now = chrono::Utc::now().to_rfc3339();
    let existing_project = conn
        .query_row(
            "SELECT project_id FROM events WHERE id = ?1",
            rusqlite::params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    if existing_project.as_deref().is_some_and(|p| p != project_id) {
        anyhow::bail!(
            "event '{}' belongs to another project during journal restore",
            id
        );
    }
    let current_version = conn
        .query_row(
            "SELECT version FROM events WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![id, project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    let restored_version = target_version
        .or_else(|| ed["version"].as_i64())
        // Legacy journal snapshots did not carry a version. Preserve the
        // current migrated row's token instead of resetting it.
        .or(current_version)
        .unwrap_or(1);

    // reveal_scene_id は tree_nodes(scene) 参照。undo/redo の間に reveal シーンが
    // 削除されていると、古いスナップショットの id を UPSERT すると FK 失敗で undo が
    // bail する。参照先が無ければ NULL へフォールバック（spec §2.1・ON DELETE SET
    // NULL と同じ「自動導出へ戻す」挙動）。
    let reveal_scene_id: Option<String> = match ed["revealSceneId"].as_str() {
        Some(sid) => {
            let n: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![sid, project_id],
                |r| r.get(0),
            )?;
            if n > 0 {
                Some(sid.to_string())
            } else {
                None
            }
        }
        None => None,
    };

    conn.execute(
        "INSERT INTO events
         (id, project_id, title, note, ordinal, primary_codex_id, lane_group, location_codex_id,
          start_time, end_time, start_minute, end_minute, start_granularity,
          end_granularity, precision, kind, secret, reveal_scene_id,
          created_at, updated_at, detail, version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title, note = excluded.note, detail = excluded.detail,
            ordinal = excluded.ordinal,
            primary_codex_id = excluded.primary_codex_id,
            lane_group = excluded.lane_group,
            location_codex_id = excluded.location_codex_id,
            start_time = excluded.start_time, end_time = excluded.end_time,
            start_minute = excluded.start_minute, end_minute = excluded.end_minute,
            start_granularity = excluded.start_granularity,
            end_granularity = excluded.end_granularity,
            precision = excluded.precision, kind = excluded.kind,
            secret = excluded.secret, reveal_scene_id = excluded.reveal_scene_id,
            updated_at = excluded.updated_at, version = excluded.version",
        rusqlite::params![
            id,
            project_id,
            ed["title"].as_str().unwrap_or(""),
            ed["note"].as_str(),
            ed["ordinal"].as_str().unwrap_or("a0"),
            ed["primaryCodexId"].as_str(),
            ed["laneGroup"].as_str(),
            ed["locationCodexId"].as_str(),
            ed["startTime"].as_i64(),
            ed["endTime"].as_i64(),
            ed["startMinute"].as_i64(),
            ed["endMinute"].as_i64(),
            ed["startGranularity"].as_str().unwrap_or("none"),
            ed["endGranularity"].as_str().unwrap_or("none"),
            ed["precision"].as_str().unwrap_or("exact"),
            ed["kind"].as_str().unwrap_or("generic"),
            ed["secret"].as_i64().unwrap_or(0),
            reveal_scene_id,
            ed["createdAt"].as_str().unwrap_or(&now),
            ed["updatedAt"].as_str().unwrap_or(&now),
            ed["detail"].as_str(),
            restored_version,
        ],
    )?;

    if !restore_associations {
        return Ok(());
    }

    conn.execute(
        "DELETE FROM event_participants WHERE event_id = ?1",
        rusqlite::params![id],
    )?;
    if let Some(arr) = snap["participants"].as_array() {
        let rows: Vec<(&str, Option<&str>)> = arr
            .iter()
            .filter_map(|p| {
                p["codexEntryId"]
                    .as_str()
                    .map(|codex_id| (codex_id, p["role"].as_str()))
            })
            .collect();
        batch_insert_event_participants(conn, id, &rows)?;
    }

    conn.execute(
        "DELETE FROM scene_events WHERE event_id = ?1",
        rusqlite::params![id],
    )?;
    if let Some(arr) = snap["sceneLinks"].as_array() {
        let scene_ids: Vec<&str> = arr.iter().filter_map(|s| s.as_str()).collect();
        batch_insert_scene_events(conn, id, &scene_ids)?;
    }

    conn.execute(
        "DELETE FROM event_relations WHERE cause_event_id = ?1 OR effect_event_id = ?1",
        rusqlite::params![id],
    )?;
    if let Some(arr) = snap["relations"]["asCause"].as_array() {
        let rows: Vec<(&str, &str, &str)> = arr
            .iter()
            .filter_map(|r| {
                r["effectEventId"]
                    .as_str()
                    .map(|effect| (r["projectId"].as_str().unwrap_or(project_id), id, effect))
            })
            .collect();
        batch_insert_event_relations(conn, &rows)?;
    }
    if let Some(arr) = snap["relations"]["asEffect"].as_array() {
        let rows: Vec<(&str, &str, &str)> = arr
            .iter()
            .filter_map(|r| {
                r["causeEventId"]
                    .as_str()
                    .map(|cause| (r["projectId"].as_str().unwrap_or(project_id), cause, id))
            })
            .collect();
        batch_insert_event_relations(conn, &rows)?;
    }
    Ok(())
}

fn restore_event_participants_snapshot(
    conn: &rusqlite::Connection,
    snap: &Value,
) -> anyhow::Result<()> {
    let event_id = snap["eventId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("participants snapshot missing eventId"))?;
    conn.execute(
        "DELETE FROM event_participants WHERE event_id = ?1",
        rusqlite::params![event_id],
    )?;
    if let Some(arr) = snap["participants"].as_array() {
        let rows: Vec<(&str, Option<&str>)> = arr
            .iter()
            .filter_map(|p| {
                p["codexEntryId"]
                    .as_str()
                    .map(|codex_id| (codex_id, p["role"].as_str()))
            })
            .collect();
        batch_insert_event_participants(conn, event_id, &rows)?;
    }
    Ok(())
}

fn restore_event_scene_snapshot(conn: &rusqlite::Connection, snap: &Value) -> anyhow::Result<()> {
    let scene_id = snap["sceneId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("scene snapshot missing sceneId"))?;
    let event_id = snap["eventId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("scene snapshot missing eventId"))?;
    if snap["linked"].as_bool().unwrap_or(false) {
        conn.execute(
            "INSERT OR IGNORE INTO scene_events (scene_id, event_id) VALUES (?1, ?2)",
            rusqlite::params![scene_id, event_id],
        )?;
    } else {
        conn.execute(
            "DELETE FROM scene_events WHERE scene_id = ?1 AND event_id = ?2",
            rusqlite::params![scene_id, event_id],
        )?;
    }
    Ok(())
}

fn restore_event_relation_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    snap: &Value,
) -> anyhow::Result<()> {
    let cause = snap["causeEventId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("relation snapshot missing causeEventId"))?;
    let effect = snap["effectEventId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("relation snapshot missing effectEventId"))?;
    let proj = snap["projectId"].as_str().unwrap_or(project_id);
    if snap["linked"].as_bool().unwrap_or(false) {
        conn.execute(
            "INSERT OR IGNORE INTO event_relations
             (project_id, cause_event_id, effect_event_id) VALUES (?1, ?2, ?3)",
            rusqlite::params![proj, cause, effect],
        )?;
    } else {
        conn.execute(
            "DELETE FROM event_relations WHERE cause_event_id = ?1 AND effect_event_id = ?2",
            rusqlite::params![cause, effect],
        )?;
    }
    Ok(())
}

fn event_update_snapshot_uses_occ(snap: &Value) -> bool {
    snap.get("eventData").is_some() || snap.get("participants").is_some()
}

fn event_update_snapshot_has_occ_version(snap: &Value) -> bool {
    if snap.get("eventData").is_some() {
        snap["eventData"].get("version").is_some()
    } else if snap.get("participants").is_some() {
        snap.get("version").is_some()
    } else {
        false
    }
}

fn event_snapshot_is_legacy_occ(snap: &Value) -> bool {
    event_update_snapshot_uses_occ(snap) && !event_update_snapshot_has_occ_version(snap)
}

fn mark_legacy_event_snapshot_version(raw: Option<&str>) -> anyhow::Result<Option<String>> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let mut snap: Value = serde_json::from_str(raw)?;
    if let Some(event_data) = snap.get_mut("eventData").and_then(Value::as_object_mut) {
        event_data
            .entry("version".to_string())
            .or_insert(Value::from(0));
    } else if snap.get("participants").is_some() {
        if let Some(object) = snap.as_object_mut() {
            object
                .entry("version".to_string())
                .or_insert(Value::from(0));
        }
    }
    Ok(Some(snap.to_string()))
}

/// Legacy Event journals predate aggregate OCC and therefore carry unusable
/// placeholder base/result versions. Once a replay reaches that legacy chain,
/// attach an explicit version marker to every legacy aggregate snapshot and
/// align its journal tokens with the state that is about to be replayed.
fn normalize_legacy_event_journal_chain(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_id: &str,
    state_version: i64,
) -> anyhow::Result<usize> {
    let rows = {
        let mut stmt = conn.prepare(
            "SELECT id, before_json, after_json FROM undo_journal
             WHERE project_id = ?1 AND entity_kind = 'event' AND entity_id = ?2",
        )?;
        let mapped = stmt.query_map(rusqlite::params![project_id, event_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };

    let mut normalized = 0;
    for (journal_id, before_json, after_json) in rows {
        let legacy = [before_json.as_deref(), after_json.as_deref()]
            .into_iter()
            .flatten()
            .try_fold(false, |found, raw| {
                let snapshot: Value = serde_json::from_str(raw)?;
                Ok::<_, anyhow::Error>(found || event_snapshot_is_legacy_occ(&snapshot))
            })?;
        if !legacy {
            continue;
        }
        let before_json = mark_legacy_event_snapshot_version(before_json.as_deref())?;
        let after_json = mark_legacy_event_snapshot_version(after_json.as_deref())?;
        normalized += conn.execute(
            "UPDATE undo_journal
             SET base_version = ?1, result_version = ?1,
                 before_json = ?2, after_json = ?3
             WHERE id = ?4 AND project_id = ?5",
            rusqlite::params![
                state_version,
                before_json,
                after_json,
                journal_id,
                project_id
            ],
        )?;
    }
    Ok(normalized)
}

/// A monotonically replayed state replaces the old state token everywhere it
/// appears in the Event's journal chain. This keeps adjacent commands
/// connected across multi-level undo/redo (A.result == B.base), while an
/// external write still conflicts because it cannot update these tokens.
fn advance_event_journal_state_token(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_id: &str,
    previous_version: i64,
    replay_version: i64,
) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE undo_journal
         SET base_version = CASE WHEN base_version = ?1 THEN ?2 ELSE base_version END,
             result_version = CASE WHEN result_version = ?1 THEN ?2 ELSE result_version END
         WHERE project_id = ?3 AND entity_kind = 'event' AND entity_id = ?4
           AND (base_version = ?1 OR result_version = ?1)",
        rusqlite::params![previous_version, replay_version, project_id, event_id],
    )?;
    anyhow::ensure!(
        updated > 0,
        "event undo journal chain for '{}' lost state version {}",
        event_id,
        previous_version
    );
    Ok(())
}

fn next_event_replay_version(version: i64, direction: &str) -> anyhow::Result<i64> {
    version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("event version overflow during {direction}"))
}

/// Restore an `update` op (event-update / participants / scene / relation) to a
/// target snapshot, discriminating by snapshot shape.
fn restore_event_update_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    snap: &Value,
    expected_current_version: i64,
    target_version: i64,
) -> anyhow::Result<()> {
    if snap.get("eventData").is_some() {
        ensure_event_version(
            conn,
            project_id,
            snap["eventData"]["id"].as_str().unwrap_or(""),
            expected_current_version,
        )?;
        apply_event_snapshot(conn, project_id, snap, Some(target_version), false)
    } else if snap.get("causeEventId").is_some() {
        restore_event_relation_snapshot(conn, project_id, snap)
    } else if snap.get("sceneId").is_some() {
        restore_event_scene_snapshot(conn, snap)
    } else if snap.get("participants").is_some() {
        let event_id = snap["eventId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("participants snapshot missing eventId"))?;
        ensure_event_version(conn, project_id, event_id, expected_current_version)?;
        conn.execute(
            "UPDATE events SET version = ?1 WHERE id = ?2 AND project_id = ?3",
            rusqlite::params![target_version, event_id, project_id],
        )?;
        restore_event_participants_snapshot(conn, snap)
    } else {
        anyhow::bail!("restore_event_update_snapshot: unrecognized event snapshot shape")
    }
}

fn replay_event_update_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    row: &grimodex_core::undo_journal::UndoJournalRow,
    snap: &Value,
    direction: &str,
) -> anyhow::Result<()> {
    if !event_update_snapshot_uses_occ(snap) {
        return restore_event_update_snapshot(
            conn,
            project_id,
            snap,
            row.base_version,
            row.result_version,
        );
    }

    // Legacy Event journals did not embed a version. Their migrated row starts
    // with placeholder tokens; the first replay normalizes the whole legacy
    // chain so subsequent stacked undo/redo can share the fresh state token.
    let legacy_snapshot = event_snapshot_is_legacy_occ(snap);
    let (expected_version, target_state_version) = if legacy_snapshot {
        (0, 0)
    } else {
        match direction {
            "undo" => (row.result_version, row.base_version),
            "redo" => (row.base_version, row.result_version),
            other => anyhow::bail!("invalid event replay direction: {other}"),
        }
    };
    let replay_version = next_event_replay_version(expected_version, direction)?;

    restore_event_update_snapshot(conn, project_id, snap, expected_version, replay_version)?;
    if legacy_snapshot || target_state_version == 0 {
        normalize_legacy_event_journal_chain(
            conn,
            project_id,
            &row.entity_id,
            target_state_version,
        )?;
    }
    advance_event_journal_state_token(
        conn,
        project_id,
        &row.entity_id,
        target_state_version,
        replay_version,
    )
}

fn ensure_event_version(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_id: &str,
    expected_version: i64,
) -> anyhow::Result<()> {
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM events
         WHERE id = ?1 AND project_id = ?2 AND version = ?3",
        rusqlite::params![event_id, project_id, expected_version],
        |row| row.get(0),
    )?;
    if found == 0 {
        anyhow::bail!(
            "event '{}' version {} conflict during journal restore",
            event_id,
            expected_version
        );
    }
    Ok(())
}

pub(crate) fn delete_event_cascade(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_id: &str,
    expected_version: Option<i64>,
) -> anyhow::Result<()> {
    let deleted = match expected_version {
        Some(version) => conn.execute(
            "DELETE FROM events WHERE id = ?1 AND project_id = ?2 AND version = ?3",
            rusqlite::params![event_id, project_id, version],
        )?,
        None => conn.execute(
            "DELETE FROM events WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![event_id, project_id],
        )?,
    };
    if deleted == 0 {
        if let Some(version) = expected_version {
            anyhow::bail!(
                "event '{}' version {} conflict during journal restore",
                event_id,
                version
            );
        }
        anyhow::bail!("event '{event_id}' not found in project '{project_id}' during restore");
    }
    Ok(())
}

/// Undo path (global-history): invert the recorded op.
fn revert_event_undo_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    row: &grimodex_core::undo_journal::UndoJournalRow,
) -> anyhow::Result<()> {
    match row.op_kind.as_str() {
        "create" => {
            let after: Value = serde_json::from_str(
                row.after_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("revert event create: missing after_json"))?,
            )?;
            let legacy_snapshot = event_snapshot_is_legacy_occ(&after);
            let expected_version = if legacy_snapshot {
                normalize_legacy_event_journal_chain(conn, project_id, &row.entity_id, 0)?;
                0
            } else {
                row.result_version
            };
            delete_event_cascade(conn, project_id, &row.entity_id, Some(expected_version))
        }
        "delete" => {
            let before = row
                .before_json
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("revert event delete: missing before_json"))?;
            let snap: Value = serde_json::from_str(before)?;
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1",
                rusqlite::params![row.entity_id],
                |r| r.get(0),
            )?;
            if exists != 0 {
                anyhow::bail!(
                    "event '{}' version conflict during journal restore",
                    row.entity_id
                );
            }
            let legacy_snapshot = event_snapshot_is_legacy_occ(&snap);
            let previous_state_version = if legacy_snapshot { 0 } else { row.base_version };
            let replay_version = next_event_replay_version(previous_state_version, "undo delete")?;
            apply_event_snapshot(conn, project_id, &snap, Some(replay_version), true)?;
            if legacy_snapshot || previous_state_version == 0 {
                normalize_legacy_event_journal_chain(
                    conn,
                    project_id,
                    &row.entity_id,
                    previous_state_version,
                )?;
            }
            advance_event_journal_state_token(
                conn,
                project_id,
                &row.entity_id,
                previous_state_version,
                replay_version,
            )
        }
        "update" => {
            let before = row
                .before_json
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("revert event update: missing before_json"))?;
            let snap: Value = serde_json::from_str(before)?;
            replay_event_update_snapshot(conn, project_id, row, &snap, "undo")
        }
        other => anyhow::bail!("revert event: unsupported op_kind '{other}'"),
    }
}

/// Redo path (global-history): re-apply the recorded op.
fn apply_event_redo_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    row: &grimodex_core::undo_journal::UndoJournalRow,
) -> anyhow::Result<()> {
    match row.op_kind.as_str() {
        "create" => {
            let after = row
                .after_json
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("apply event create: missing after_json"))?;
            let snap: Value = serde_json::from_str(after)?;
            let exists: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1",
                rusqlite::params![row.entity_id],
                |r| r.get(0),
            )?;
            if exists != 0 {
                anyhow::bail!(
                    "event '{}' version conflict during journal restore",
                    row.entity_id
                );
            }
            let legacy_snapshot = event_snapshot_is_legacy_occ(&snap);
            let previous_state_version = if legacy_snapshot {
                0
            } else {
                row.result_version
            };
            let replay_version = next_event_replay_version(previous_state_version, "redo create")?;
            apply_event_snapshot(conn, project_id, &snap, Some(replay_version), true)?;
            if legacy_snapshot || previous_state_version == 0 {
                normalize_legacy_event_journal_chain(
                    conn,
                    project_id,
                    &row.entity_id,
                    previous_state_version,
                )?;
            }
            advance_event_journal_state_token(
                conn,
                project_id,
                &row.entity_id,
                previous_state_version,
                replay_version,
            )
        }
        "delete" => {
            let before: Value = serde_json::from_str(
                row.before_json
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("apply event delete: missing before_json"))?,
            )?;
            let legacy_snapshot = event_snapshot_is_legacy_occ(&before);
            let expected_version = if legacy_snapshot {
                normalize_legacy_event_journal_chain(conn, project_id, &row.entity_id, 0)?;
                0
            } else {
                row.base_version
            };
            delete_event_cascade(conn, project_id, &row.entity_id, Some(expected_version))
        }
        "update" => {
            let after = row
                .after_json
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("apply event update: missing after_json"))?;
            let snap: Value = serde_json::from_str(after)?;
            replay_event_update_snapshot(conn, project_id, row, &snap, "redo")
        }
        other => anyhow::bail!("apply event: unsupported op_kind '{other}'"),
    }
}

/// Verify a codex entry belongs to `project_id`; bail otherwise. Prevents a
/// caller (AI agent / MCP / renderer) from planting a cross-project row in
/// `event_participants` — a project-A event pointing at a project-B codex entry.
/// Mirrors the scope guard already enforced by `agent_scene_event_mutate_impl`
/// and `agent_event_relation_mutate_impl` for their FK targets.
fn ensure_codex_in_project(
    conn: &rusqlite::Connection,
    project_id: &str,
    codex_id: &str,
) -> anyhow::Result<()> {
    let ok: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        rusqlite::params![codex_id, project_id],
        |r| r.get(0),
    )?;
    if ok == 0 {
        anyhow::bail!("codex entry '{codex_id}' not found in project '{project_id}'");
    }
    Ok(())
}

/// Verify a scene tree-node belongs to `project_id`; bail otherwise. Prevents a
/// caller from planting a cross-project row in `scene_events` — a project-A event
/// linked to a project-B scene. Mirrors `agent_scene_event_mutate_impl`'s guard.
fn ensure_scene_in_project(
    conn: &rusqlite::Connection,
    project_id: &str,
    scene_id: &str,
) -> anyhow::Result<()> {
    let ok: i64 = conn.query_row(
        "SELECT COUNT(*) FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
        rusqlite::params![scene_id, project_id],
        |r| r.get(0),
    )?;
    if ok == 0 {
        anyhow::bail!("scene '{scene_id}' not found in project '{project_id}'");
    }
    Ok(())
}

/// Inputs for the shared in-transaction event create primitive.
/// Used by both `agent_event_create_impl` and narrative commit apply.
#[derive(Debug, Clone)]
pub(crate) struct EventCreateTxInput<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub surface: Option<&'a str>,
    pub event_id: &'a str,
    pub undo_id: &'a str,
    pub event_uid: &'a str,
    pub title: &'a str,
    pub note: Option<&'a str>,
    pub detail: Option<&'a str>,
    pub ordinal: &'a str,
    pub primary_codex_id: Option<&'a str>,
    pub lane_group: Option<&'a str>,
    pub location_codex_id: Option<&'a str>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub start_minute: Option<i64>,
    pub end_minute: Option<i64>,
    pub start_granularity: &'a str,
    pub end_granularity: &'a str,
    pub precision: &'a str,
    pub kind: &'a str,
    pub secret: bool,
    pub reveal_scene_id: Option<&'a str>,
    pub participants: &'a [String],
    pub scene_ids: &'a [String],
    pub request_hash: Option<&'a str>,
    pub now: &'a str,
    pub timestamp: i64,
    pub write_undo_journal: bool,
    pub write_change_event: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct EventCreateTxResult {
    pub entity_id: String,
    pub version: i64,
    pub change_event_uid: String,
    pub undo_journal_id: String,
    pub after_snapshot: Value,
}

/// Shared event-create body that runs inside a caller-owned transaction.
pub(crate) fn apply_event_create_in_tx(
    conn: &rusqlite::Connection,
    input: EventCreateTxInput<'_>,
) -> anyhow::Result<EventCreateTxResult> {
    let canonical_start = normalize_chronicle_timestamp(ChronicleTimestamp {
        day: input.start_time,
        minute: input.start_minute,
        granularity: input.start_granularity,
    });
    let canonical_end = normalize_chronicle_timestamp(ChronicleTimestamp {
        day: input.end_time,
        minute: input.end_minute,
        granularity: input.end_granularity,
    });
    validate_canonical_chronicle_date_range(ChronicleDateRange {
        start: canonical_start,
        end: canonical_end,
    })?;
    if let Some(codex_id) = input.primary_codex_id {
        ensure_codex_in_project(conn, input.project_id, codex_id)?;
    }
    if let Some(codex_id) = input.location_codex_id {
        ensure_codex_in_project(conn, input.project_id, codex_id)?;
    }
    if let Some(scene_id) = input.reveal_scene_id {
        ensure_scene_in_project(conn, input.project_id, scene_id)?;
    }

    conn.execute(
        "INSERT INTO events
         (id, project_id, title, note, detail, ordinal, primary_codex_id,
          location_codex_id, start_time, end_time, start_minute, end_minute,
          start_granularity, end_granularity, precision, kind,
          secret, reveal_scene_id, lane_group, created_at, updated_at, version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20, 1)",
        rusqlite::params![
            input.event_id,
            input.project_id,
            input.title,
            input.note,
            input.detail,
            input.ordinal,
            input.primary_codex_id,
            input.location_codex_id,
            canonical_start.day,
            canonical_end.day,
            canonical_start.minute,
            canonical_end.minute,
            input.start_granularity,
            input.end_granularity,
            input.precision,
            input.kind,
            input.secret,
            input.reveal_scene_id,
            input.lane_group,
            input.now,
        ],
    )?;

    for codex_id in input.participants {
        // Scope guard: reject participants from another project so the
        // event↔codex link can never cross the project boundary. The
        // transaction rolls back the already-inserted event row on bail.
        ensure_codex_in_project(conn, input.project_id, codex_id)?;
    }
    for scene_id in input.scene_ids {
        // Scope guard: reject scenes from another project (see above).
        ensure_scene_in_project(conn, input.project_id, scene_id)?;
    }
    let participant_rows: Vec<(&str, Option<&str>)> = input
        .participants
        .iter()
        .map(|c| (c.as_str(), None))
        .collect();
    batch_insert_event_participants(conn, input.event_id, &participant_rows)?;
    let scene_id_refs: Vec<&str> = input.scene_ids.iter().map(String::as_str).collect();
    batch_insert_scene_events(conn, input.event_id, &scene_id_refs)?;

    let after_snapshot = collect_event_snapshot(conn, input.event_id)?;
    let after = after_snapshot.to_string();

    if input.write_undo_journal {
        insert_undo_journal_in_tx(
            conn,
            UndoJournalInsert {
                id: input.undo_id,
                project_id: input.project_id,
                surface: input.surface.unwrap_or("in-app-agent"),
                entity_kind: "event",
                entity_id: input.event_id,
                op_kind: "create",
                before_json: None,
                after_json: Some(&after),
                base_version: 0,
                result_version: 1,
                change_event_uid: Some(input.event_uid),
            },
        )?;
    }

    if input.write_change_event {
        let mut change_payload = json!({ "title": input.title, "kind": input.kind });
        if let Some(request_hash) = input.request_hash {
            change_payload["requestHash"] = Value::String(request_hash.to_string());
        }
        append_change_events_in_tx(
            conn,
            input.project_id,
            input.session_id,
            &[AppendChangeEvent {
                event_uid: input.event_uid.to_string(),
                scene_id: None,
                domain: "event".to_string(),
                op_type: "event.create".to_string(),
                entity_type: Some("event".to_string()),
                entity_id: Some(input.event_id.to_string()),
                payload: change_payload.to_string(),
                timestamp: input.timestamp,
            }],
        )?;
    }

    Ok(EventCreateTxResult {
        entity_id: input.event_id.to_string(),
        version: 1,
        change_event_uid: input.event_uid.to_string(),
        undo_journal_id: input.undo_id.to_string(),
        after_snapshot,
    })
}

pub fn agent_event_create_impl(
    db: &Database,
    payload: AgentEventCreatePayload,
) -> anyhow::Result<Value> {
    let request_hash = event_create_request_hash(&payload)?;
    let legacy_entity_request = payload.request_id.is_none() && payload.event_id.is_some();
    let request_id = payload
        .request_id
        .clone()
        .or_else(|| payload.event_id.clone());
    let event_id = payload
        .event_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let undo_id = request_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    let title = payload.title.clone().unwrap_or_default();
    let ordinal = payload
        .ordinal
        .clone()
        .unwrap_or_else(|| "a0".to_string());
    let precision = payload
        .precision
        .clone()
        .unwrap_or_else(|| "exact".to_string());
    let kind = payload.kind.clone().unwrap_or_else(|| "generic".to_string());
    let start_granularity = resolve_chronicle_granularity(
        payload.start_granularity.as_deref(),
        "none",
        payload.start_time.is_some(),
        payload.start_minute.is_some(),
    )
    .to_string();
    let end_granularity = resolve_chronicle_granularity(
        payload.end_granularity.as_deref(),
        "none",
        payload.end_time.is_some(),
        payload.end_minute.is_some(),
    )
    .to_string();
    let participants = payload.participant_codex_ids.clone().unwrap_or_default();
    let scene_ids = payload.scene_ids.clone().unwrap_or_default();
    let secret = payload.secret.unwrap_or(false);
    // 空文字の reveal は NULL（自動導出/恒久秘匿）に正規化。
    let reveal_scene_id = payload
        .reveal_scene_id
        .clone()
        .filter(|s| !s.is_empty());

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            if let Some(request_id) = request_id.as_deref() {
                if let Some(existing) = existing_request_result(
                    conn,
                    request_id,
                    &request_hash,
                    "AGENT_EVENT_CREATE_IDEMPOTENCY_CONFLICT",
                )? {
                    return Ok(existing);
                }
            }
            if legacy_entity_request {
                if let Some(existing) = existing_create_result(
                    conn,
                    "events",
                    &payload.project_id,
                    "event",
                    &event_id,
                    &request_hash,
                    "AGENT_EVENT_CREATE_IDEMPOTENCY_CONFLICT",
                )? {
                    return Ok(existing);
                }
            }

            let created = apply_event_create_in_tx(
                conn,
                EventCreateTxInput {
                    project_id: &payload.project_id,
                    session_id: &payload.session_id,
                    surface: payload.surface.as_deref(),
                    event_id: &event_id,
                    undo_id: &undo_id,
                    event_uid: &event_uid,
                    title: &title,
                    note: payload.note.as_deref(),
                    detail: payload.detail.as_deref(),
                    ordinal: &ordinal,
                    primary_codex_id: payload.primary_codex_id.as_deref(),
                    lane_group: payload.lane_group.as_deref(),
                    location_codex_id: payload.location_codex_id.as_deref(),
                    start_time: payload.start_time,
                    end_time: payload.end_time,
                    start_minute: payload.start_minute,
                    end_minute: payload.end_minute,
                    start_granularity: &start_granularity,
                    end_granularity: &end_granularity,
                    precision: &precision,
                    kind: &kind,
                    secret,
                    reveal_scene_id: reveal_scene_id.as_deref(),
                    participants: &participants,
                    scene_ids: &scene_ids,
                    request_hash: request_id.as_ref().map(|_| request_hash.as_str()),
                    now: &now,
                    timestamp,
                    write_undo_journal: true,
                    write_change_event: true,
                },
            )?;

            Ok(AgentWriteResult {
                entity_id: created.entity_id,
                version: created.version,
                change_event_uid: created.change_event_uid,
                undo_journal_id: created.undo_journal_id,
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

pub fn agent_event_update_impl(
    db: &Database,
    payload: AgentEventUpdatePayload,
) -> anyhow::Result<Value> {
    struct CurrentChronicleRange {
        version: i64,
        start_time: Option<i64>,
        end_time: Option<i64>,
        start_minute: Option<i64>,
        end_minute: Option<i64>,
        start_granularity: String,
        end_granularity: String,
    }

    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        use rusqlite::OptionalExtension;

        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let current: Option<CurrentChronicleRange> = conn
                .query_row(
                    "SELECT version, start_time, end_time, start_minute, end_minute,
                            start_granularity, end_granularity
                     FROM events WHERE id = ?1 AND project_id = ?2",
                    rusqlite::params![payload.event_id, payload.project_id],
                    |row| {
                        Ok(CurrentChronicleRange {
                            version: row.get(0)?,
                            start_time: row.get(1)?,
                            end_time: row.get(2)?,
                            start_minute: row.get(3)?,
                            end_minute: row.get(4)?,
                            start_granularity: row.get(5)?,
                            end_granularity: row.get(6)?,
                        })
                    },
                )
                .optional()?;
            let Some(CurrentChronicleRange {
                version: current_version,
                start_time: current_start_time,
                end_time: current_end_time,
                start_minute: current_start_minute,
                end_minute: current_end_minute,
                start_granularity: current_start_granularity,
                end_granularity: current_end_granularity,
            }) = current
            else {
                anyhow::bail!(
                    "event '{}' not found in project '{}'",
                    payload.event_id,
                    payload.project_id
                );
            };
            let base_version = payload.base_version;
            if current_version != base_version {
                anyhow::bail!(
                    "event '{}' version conflict: expected {}, found {}",
                    payload.event_id,
                    base_version,
                    current_version
                );
            }
            let touches_chronicle_date = payload.start_time.is_some()
                || payload.end_time.is_some()
                || payload.start_minute.is_some()
                || payload.end_minute.is_some()
                || payload.start_granularity.is_some()
                || payload.end_granularity.is_some();
            let start_granularity = resolve_chronicle_granularity(
                payload.start_granularity.as_deref(),
                &current_start_granularity,
                payload.start_time.is_some(),
                payload.start_minute.is_some(),
            );
            let end_granularity = resolve_chronicle_granularity(
                payload.end_granularity.as_deref(),
                &current_end_granularity,
                payload.end_time.is_some(),
                payload.end_minute.is_some(),
            );
            let merged_start = ChronicleTimestamp {
                day: payload.start_time.or(current_start_time),
                minute: payload.start_minute.or(current_start_minute),
                granularity: start_granularity,
            };
            let merged_end = ChronicleTimestamp {
                day: payload.end_time.or(current_end_time),
                minute: payload.end_minute.or(current_end_minute),
                granularity: end_granularity,
            };
            let (canonical_start, canonical_end) = if touches_chronicle_date {
                let start = normalize_chronicle_timestamp(merged_start);
                let end = normalize_chronicle_timestamp(merged_end);
                validate_canonical_chronicle_date_range(ChronicleDateRange { start, end })?;
                (start, end)
            } else {
                // Legacy rows may carry a minute at a coarse granularity. An
                // unrelated update must not wedge them, but still retains the
                // established range/minute safety checks.
                validate_chronicle_date_range(ChronicleDateRange {
                    start: merged_start,
                    end: merged_end,
                })?;
                (merged_start, merged_end)
            };
            let result_version = base_version + 1;

            // Scalar FKs are globally keyed, so SQLite can prove existence but
            // not project ownership. Validate non-empty patch values before any
            // row, journal, or change-event mutation. Empty strings remain the
            // existing explicit "clear to NULL" convention.
            if let Some(codex_id) = payload.primary_codex_id.as_deref() {
                if !codex_id.is_empty() {
                    ensure_codex_in_project(conn, &payload.project_id, codex_id)?;
                }
            }
            if let Some(codex_id) = payload.location_codex_id.as_deref() {
                if !codex_id.is_empty() {
                    ensure_codex_in_project(conn, &payload.project_id, codex_id)?;
                }
            }
            if let Some(scene_id) = payload.reveal_scene_id.as_deref() {
                if !scene_id.is_empty() {
                    ensure_scene_in_project(conn, &payload.project_id, scene_id)?;
                }
            }

            let before = collect_event_snapshot(conn, &payload.event_id)?.to_string();

            let mut sets = vec!["updated_at = ?1".to_string(), "version = ?2".to_string()];
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> =
                vec![Box::new(now.clone()), Box::new(result_version)];
            let mut param_idx = 3;
            let mut fields: Vec<&str> = Vec::new();

            if let Some(ref v) = payload.title {
                sets.push(format!("title = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("title");
            }
            if let Some(ref v) = payload.note {
                sets.push(format!("note = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("note");
            }
            if let Some(ref v) = payload.detail {
                sets.push(format!("detail = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("detail");
            }
            if let Some(ref v) = payload.ordinal {
                sets.push(format!("ordinal = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("ordinal");
            }
            if let Some(ref v) = payload.primary_codex_id {
                // 空文字は NULL（未割当へ戻す）に正規化。Option<String> では null と
                // 未指定を区別できないため、UI は未割当化に "" を送る（reveal_scene_id と同流儀）。
                let val: Option<String> = if v.is_empty() { None } else { Some(v.clone()) };
                sets.push(format!("primary_codex_id = ?{param_idx}"));
                params.push(Box::new(val));
                param_idx += 1;
                fields.push("primaryCodexId");
            }
            if let Some(ref v) = payload.lane_group {
                // 空文字は NULL（既定の未割当レーンへ）に正規化。
                let val: Option<String> = if v.is_empty() { None } else { Some(v.clone()) };
                sets.push(format!("lane_group = ?{param_idx}"));
                params.push(Box::new(val));
                param_idx += 1;
                fields.push("laneGroup");
            }
            if let Some(ref v) = payload.location_codex_id {
                // 空文字は NULL（場所なし）に正規化。
                let val: Option<String> = if v.is_empty() { None } else { Some(v.clone()) };
                sets.push(format!("location_codex_id = ?{param_idx}"));
                params.push(Box::new(val));
                param_idx += 1;
                fields.push("locationCodexId");
            }
            if touches_chronicle_date {
                if canonical_start.day != current_start_time {
                    if let Some(v) = canonical_start.day {
                        sets.push(format!("start_time = ?{param_idx}"));
                        params.push(Box::new(v));
                        param_idx += 1;
                    } else {
                        sets.push("start_time = NULL".to_string());
                    }
                    fields.push("startTime");
                }
                if canonical_end.day != current_end_time {
                    if let Some(v) = canonical_end.day {
                        sets.push(format!("end_time = ?{param_idx}"));
                        params.push(Box::new(v));
                        param_idx += 1;
                    } else {
                        sets.push("end_time = NULL".to_string());
                    }
                    fields.push("endTime");
                }
                if canonical_start.minute != current_start_minute {
                    if let Some(v) = canonical_start.minute {
                        sets.push(format!("start_minute = ?{param_idx}"));
                        params.push(Box::new(v));
                        param_idx += 1;
                    } else {
                        sets.push("start_minute = NULL".to_string());
                    }
                    fields.push("startMinute");
                }
                if canonical_end.minute != current_end_minute {
                    if let Some(v) = canonical_end.minute {
                        sets.push(format!("end_minute = ?{param_idx}"));
                        params.push(Box::new(v));
                        param_idx += 1;
                    } else {
                        sets.push("end_minute = NULL".to_string());
                    }
                    fields.push("endMinute");
                }
            }
            if payload.start_granularity.is_some()
                || start_granularity != current_start_granularity
            {
                sets.push(format!("start_granularity = ?{param_idx}"));
                params.push(Box::new(start_granularity.to_string()));
                param_idx += 1;
                fields.push("startGranularity");
            }
            if payload.end_granularity.is_some()
                || end_granularity != current_end_granularity
            {
                sets.push(format!("end_granularity = ?{param_idx}"));
                params.push(Box::new(end_granularity.to_string()));
                param_idx += 1;
                fields.push("endGranularity");
            }
            if let Some(ref v) = payload.precision {
                sets.push(format!("precision = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("precision");
            }
            if let Some(ref v) = payload.kind {
                sets.push(format!("kind = ?{param_idx}"));
                params.push(Box::new(v.clone()));
                param_idx += 1;
                fields.push("kind");
            }
            if let Some(v) = payload.secret {
                sets.push(format!("secret = ?{param_idx}"));
                params.push(Box::new(v));
                param_idx += 1;
                fields.push("secret");
            }
            if let Some(ref v) = payload.reveal_scene_id {
                // 空文字は NULL（自動導出/恒久秘匿）に正規化。
                let val: Option<String> = if v.is_empty() { None } else { Some(v.clone()) };
                sets.push(format!("reveal_scene_id = ?{param_idx}"));
                params.push(Box::new(val));
                param_idx += 1;
                fields.push("revealSceneId");
            }

            let sql = format!(
                "UPDATE events SET {} WHERE id = ?{param_idx} AND project_id = ?{} AND version = ?{}",
                sets.join(", "),
                param_idx + 1,
                param_idx + 2
            );
            params.push(Box::new(payload.event_id.clone()));
            params.push(Box::new(payload.project_id.clone()));
            params.push(Box::new(base_version));

            let updated = conn.execute(
                &sql,
                rusqlite::params_from_iter(params.iter().map(|p| p as &dyn rusqlite::types::ToSql)),
            )?;
            if updated == 0 {
                anyhow::bail!(
                    "event '{}' version conflict: expected {}",
                    payload.event_id,
                    base_version
                );
            }

            let after = collect_event_snapshot(conn, &payload.event_id)?.to_string();

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: payload.surface.as_deref().unwrap_or("in-app-agent"),
                    entity_kind: "event",
                    entity_id: &payload.event_id,
                    op_kind: "update",
                    before_json: Some(&before),
                    after_json: Some(&after),
                    base_version,
                    result_version,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "event".to_string(),
                    op_type: "event.update".to_string(),
                    entity_type: Some("event".to_string()),
                    entity_id: Some(payload.event_id.clone()),
                    payload: json!({ "fields": fields }).to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.event_id.clone(),
                version: result_version,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

pub fn agent_event_delete_impl(
    db: &Database,
    payload: AgentEventIdPayload,
) -> anyhow::Result<Value> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let current_version: i64 = conn
                .query_row(
                    "SELECT version FROM events WHERE id = ?1 AND project_id = ?2",
                    rusqlite::params![payload.event_id, payload.project_id],
                    |r| r.get(0),
                )
                .map_err(|_| {
                    anyhow::anyhow!(
                        "event '{}' not found in project '{}'",
                        payload.event_id,
                        payload.project_id
                    )
                })?;
            let base_version = payload.base_version;
            if current_version != base_version {
                anyhow::bail!(
                    "event '{}' version conflict: expected {}, found {}",
                    payload.event_id,
                    base_version,
                    current_version
                );
            }

            // Capture the full cascade snapshot BEFORE the DELETE fires the
            // ON DELETE CASCADE on participants / scene_events / relations.
            let before_value = collect_event_snapshot(conn, &payload.event_id)?;
            let title = before_value["eventData"]["title"]
                .as_str()
                .unwrap_or("")
                .to_string();
            let related_event_ids = event_snapshot_related_ids(&before_value);
            let before = before_value.to_string();

            let deleted = conn.execute(
                "DELETE FROM events WHERE id = ?1 AND project_id = ?2 AND version = ?3",
                rusqlite::params![payload.event_id, payload.project_id, base_version],
            )?;
            if deleted == 0 {
                anyhow::bail!(
                    "event '{}' version conflict: expected {}",
                    payload.event_id,
                    base_version
                );
            }

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: payload.surface.as_deref().unwrap_or("in-app-agent"),
                    entity_kind: "event",
                    entity_id: &payload.event_id,
                    op_kind: "delete",
                    before_json: Some(&before),
                    after_json: None,
                    base_version,
                    result_version: 0,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "event".to_string(),
                    op_type: "event.delete".to_string(),
                    entity_type: Some("event".to_string()),
                    entity_id: Some(payload.event_id.clone()),
                    payload: json!({
                        "title": title,
                        "relatedEventIds": related_event_ids,
                    })
                    .to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.event_id.clone(),
                version: 0,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

pub fn agent_event_set_participants_impl(
    db: &Database,
    payload: AgentEventParticipantsPayload,
) -> anyhow::Result<Value> {
    let undo_id = uuid::Uuid::new_v4().to_string();
    let event_uid = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            use rusqlite::OptionalExtension;

            let current_version: Option<i64> = conn
                .query_row(
                    "SELECT version FROM events WHERE id = ?1 AND project_id = ?2",
                    rusqlite::params![payload.event_id, payload.project_id],
                    |r| r.get(0),
                )
                .optional()?;
            let Some(current_version) = current_version else {
                anyhow::bail!(
                    "event '{}' not found in project '{}'",
                    payload.event_id,
                    payload.project_id
                );
            };
            let base_version = payload.base_version;
            if current_version != base_version {
                anyhow::bail!(
                    "event '{}' version conflict: expected {}, found {}",
                    payload.event_id,
                    base_version,
                    current_version
                );
            }
            let result_version = base_version + 1;

            let before = collect_participants_json(conn, &payload.event_id)?.to_string();

            let bumped = conn.execute(
                "UPDATE events SET version = ?1, updated_at = ?2
                 WHERE id = ?3 AND project_id = ?4 AND version = ?5",
                rusqlite::params![
                    result_version,
                    now,
                    payload.event_id,
                    payload.project_id,
                    base_version
                ],
            )?;
            if bumped == 0 {
                anyhow::bail!(
                    "event '{}' version conflict: expected {}",
                    payload.event_id,
                    base_version
                );
            }
            conn.execute(
                "DELETE FROM event_participants WHERE event_id = ?1",
                rusqlite::params![payload.event_id],
            )?;
            for codex_id in &payload.codex_entry_ids {
                // Scope guard: the event is already confirmed in this project
                // above, but each participant must be too — otherwise a P1 event
                // could be linked to a P2 codex entry. Bail rolls back the tx.
                ensure_codex_in_project(conn, &payload.project_id, codex_id)?;
            }
            let participant_rows: Vec<(&str, Option<&str>)> = payload
                .codex_entry_ids
                .iter()
                .map(|c| (c.as_str(), None))
                .collect();
            batch_insert_event_participants(conn, &payload.event_id, &participant_rows)?;

            let after = collect_participants_json(conn, &payload.event_id)?.to_string();

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: payload.surface.as_deref().unwrap_or("in-app-agent"),
                    entity_kind: "event",
                    entity_id: &payload.event_id,
                    op_kind: "update",
                    before_json: Some(&before),
                    after_json: Some(&after),
                    base_version,
                    result_version,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "event".to_string(),
                    op_type: "event.participants".to_string(),
                    entity_type: Some("event".to_string()),
                    entity_id: Some(payload.event_id.clone()),
                    payload: json!({
                        "eventId": payload.event_id,
                        "codexEntryIds": payload.codex_entry_ids,
                    })
                    .to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.event_id.clone(),
                version: result_version,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

pub fn agent_scene_event_mutate_impl(
    db: &Database,
    payload: AgentSceneEventPayload,
    link: bool,
) -> anyhow::Result<Value> {
    let request_hash = scene_event_request_hash(&payload, link)?;
    let undo_id = payload
        .request_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let existing_request = payload
                .request_id
                .as_deref()
                .map(|request_id| {
                    existing_request_result(
                        conn,
                        request_id,
                        &request_hash,
                        "AGENT_SCENE_EVENT_IDEMPOTENCY_CONFLICT",
                    )
                })
                .transpose()?
                .flatten();
            let scene_ok: i64 = conn.query_row(
                "SELECT COUNT(*) FROM tree_nodes WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.scene_id, payload.project_id],
                |r| r.get(0),
            )?;
            if scene_ok == 0 {
                anyhow::bail!(
                    "scene '{}' not found in project '{}'",
                    payload.scene_id,
                    payload.project_id
                );
            }
            let event_version: i64 = conn
                .query_row(
                    "SELECT version FROM events WHERE id = ?1 AND project_id = ?2",
                    rusqlite::params![payload.event_id, payload.project_id],
                    |r| r.get(0),
                )
                .map_err(|_| {
                    anyhow::anyhow!(
                        "event '{}' not found in project '{}'",
                        payload.event_id,
                        payload.project_id
                    )
                })?;

            let existed: i64 = conn.query_row(
                "SELECT COUNT(*) FROM scene_events WHERE scene_id = ?1 AND event_id = ?2",
                rusqlite::params![payload.scene_id, payload.event_id],
                |r| r.get(0),
            )?;
            let before = json!({
                "sceneId": payload.scene_id,
                "eventId": payload.event_id,
                "linked": existed > 0,
            })
            .to_string();
            if let Some(existing) = existing_request {
                if (existed > 0) == link {
                    return Ok(existing);
                }
                anyhow::bail!(
                    "AGENT_SCENE_EVENT_IDEMPOTENCY_CONFLICT: association state changed after original request"
                );
            }

            if link {
                conn.execute(
                    "INSERT OR IGNORE INTO scene_events (scene_id, event_id) VALUES (?1, ?2)",
                    rusqlite::params![payload.scene_id, payload.event_id],
                )?;
            } else {
                conn.execute(
                    "DELETE FROM scene_events WHERE scene_id = ?1 AND event_id = ?2",
                    rusqlite::params![payload.scene_id, payload.event_id],
                )?;
            }

            let after = json!({
                "sceneId": payload.scene_id,
                "eventId": payload.event_id,
                "linked": link,
            })
            .to_string();

            let op_type = if link { "event.stamp" } else { "event.unstamp" };

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: payload.surface.as_deref().unwrap_or("in-app-agent"),
                    entity_kind: "event",
                    entity_id: &payload.event_id,
                    op_kind: "update",
                    before_json: Some(&before),
                    after_json: Some(&after),
                    base_version: event_version,
                    result_version: event_version,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: Some(payload.scene_id.clone()),
                    domain: "event".to_string(),
                    op_type: op_type.to_string(),
                    entity_type: Some("event".to_string()),
                    entity_id: Some(payload.event_id.clone()),
                    payload: json!({
                        "sceneId": payload.scene_id,
                        "eventId": payload.event_id,
                        "requestHash": request_hash,
                    })
                    .to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.event_id.clone(),
                version: event_version,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

pub fn agent_event_relation_mutate_impl(
    db: &Database,
    payload: AgentEventRelationPayload,
    add: bool,
) -> anyhow::Result<Value> {
    let request_hash = event_relation_request_hash(&payload, add)?;
    let undo_id = payload
        .request_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = uuid::Uuid::new_v4().to_string();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let existing_request = payload
                .request_id
                .as_deref()
                .map(|request_id| {
                    existing_request_result(
                        conn,
                        request_id,
                        &request_hash,
                        "AGENT_EVENT_RELATION_IDEMPOTENCY_CONFLICT",
                    )
                })
                .transpose()?
                .flatten();
            if payload.cause_event_id == payload.effect_event_id {
                anyhow::bail!("self-loop event relation forbidden");
            }
            let cause_version: i64 = conn
                .query_row(
                    "SELECT version FROM events WHERE id = ?1 AND project_id = ?2",
                    rusqlite::params![payload.cause_event_id, payload.project_id],
                    |r| r.get(0),
                )
                .map_err(|_| {
                    anyhow::anyhow!(
                        "cause event '{}' not found in project '{}'",
                        payload.cause_event_id,
                        payload.project_id
                    )
                })?;
            let effect_ok: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.effect_event_id, payload.project_id],
                |r| r.get(0),
            )?;
            if effect_ok == 0 {
                anyhow::bail!(
                    "effect event '{}' not found in project '{}'",
                    payload.effect_event_id,
                    payload.project_id
                );
            }

            let existed: i64 = conn.query_row(
                "SELECT COUNT(*) FROM event_relations
                 WHERE cause_event_id = ?1 AND effect_event_id = ?2",
                rusqlite::params![payload.cause_event_id, payload.effect_event_id],
                |r| r.get(0),
            )?;
            let before = json!({
                "projectId": payload.project_id,
                "causeEventId": payload.cause_event_id,
                "effectEventId": payload.effect_event_id,
                "linked": existed > 0,
            })
            .to_string();
            if let Some(existing) = existing_request {
                if (existed > 0) == add {
                    return Ok(existing);
                }
                anyhow::bail!(
                    "AGENT_EVENT_RELATION_IDEMPOTENCY_CONFLICT: association state changed after original request"
                );
            }

            if add {
                conn.execute(
                    "INSERT OR IGNORE INTO event_relations
                     (project_id, cause_event_id, effect_event_id) VALUES (?1, ?2, ?3)",
                    rusqlite::params![
                        payload.project_id,
                        payload.cause_event_id,
                        payload.effect_event_id
                    ],
                )?;
            } else {
                conn.execute(
                    "DELETE FROM event_relations
                     WHERE cause_event_id = ?1 AND effect_event_id = ?2",
                    rusqlite::params![payload.cause_event_id, payload.effect_event_id],
                )?;
            }

            let after = json!({
                "projectId": payload.project_id,
                "causeEventId": payload.cause_event_id,
                "effectEventId": payload.effect_event_id,
                "linked": add,
            })
            .to_string();

            let op_type = if add {
                "event.relation_add"
            } else {
                "event.relation_remove"
            };

            insert_undo_journal_in_tx(
                conn,
                UndoJournalInsert {
                    id: &undo_id,
                    project_id: &payload.project_id,
                    surface: payload.surface.as_deref().unwrap_or("in-app-agent"),
                    entity_kind: "event",
                    entity_id: &payload.cause_event_id,
                    op_kind: "update",
                    before_json: Some(&before),
                    after_json: Some(&after),
                    base_version: cause_version,
                    result_version: cause_version,
                    change_event_uid: Some(&event_uid),
                },
            )?;

            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &[AppendChangeEvent {
                    event_uid: event_uid.clone(),
                    scene_id: None,
                    domain: "event".to_string(),
                    op_type: op_type.to_string(),
                    entity_type: Some("event".to_string()),
                    entity_id: Some(payload.cause_event_id.clone()),
                    payload: json!({
                        "causeEventId": payload.cause_event_id,
                        "effectEventId": payload.effect_event_id,
                        "requestHash": request_hash,
                    })
                    .to_string(),
                    timestamp,
                }],
            )?;

            Ok(AgentWriteResult {
                entity_id: payload.cause_event_id.clone(),
                version: cause_version,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            })
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                Ok(serde_json::to_value(res)?)
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Database;
    use std::path::Path;

    /// Same contract snapshots the grimodex-core (MCP path) tests assert —
    /// this is the in-app mirror side of the parity gate.
    const CODEX_FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../src/features/agent-writes/parity/codexCreate.fixture.json"
    ));
    const PROSE_FIXTURE: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../src/features/agent-writes/parity/proseStaging.fixture.json"
    ));

    fn test_db() -> Database {
        let db = Database::new(Path::new(":memory:")).expect("open in-memory db");
        db.migrate().expect("migrate");
        db
    }

    fn insert_project(db: &Database) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO projects (id, title) VALUES (?, 'Test')",
            &[Value::String(id.clone())],
            "run",
        )
        .expect("insert project");
        id
    }

    fn insert_scene(db: &Database, project_id: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order)
             VALUES (?, ?, 'scene', 'Scene', '{}', 'a0')",
            &[
                Value::String(id.clone()),
                Value::String(project_id.to_string()),
            ],
            "run",
        )
        .expect("insert scene");
        id
    }

    fn table_count(db: &Database, table: &str) -> i64 {
        db.with_conn(|conn| {
            Ok(
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?,
            )
        })
        .expect("count rows")
    }

    fn json_keys(v: &serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }

    fn fixture_keys(v: &serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> = v
            .as_array()
            .unwrap()
            .iter()
            .map(|k| k.as_str().unwrap().to_string())
            .collect();
        keys.sort();
        keys
    }

    #[test]
    fn codex_create_matches_parity_fixture_in_app() {
        let fixture: serde_json::Value = serde_json::from_str(CODEX_FIXTURE).unwrap();
        let db = test_db();
        let project_id = insert_project(&db);

        agent_codex_create_impl(
            &db,
            AgentCodexCreatePayload {
                request_id: None,
                entry_id: None,
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                type_slug: "character".to_string(),
                name: "Alice".to_string(),
                summary: Some("summary".to_string()),
                content: None,
                aliases: None,
                parent_id: None,
                source_chat_message_id: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: vec![AuthorshipSpanInput {
                    from_pos: 0,
                    to_pos: 7,
                    source: fixture["authorshipSpan"]["source"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                    model: None,
                    chat_msg_id: None,
                    trace_id: None,
                }],
            },
        )
        .unwrap();

        db.with_conn(|conn| {
            // changeEvent contract
            let ce = &fixture["changeEvent"];
            let (domain, op_type, entity_type, payload): (String, String, String, String) = conn
                .query_row(
                    "SELECT domain, op_type, entity_type, payload FROM change_events",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;
            assert_eq!(domain, ce["domain"].as_str().unwrap());
            assert_eq!(op_type, ce["opType"].as_str().unwrap());
            assert_eq!(entity_type, ce["entityType"].as_str().unwrap());
            let payload: serde_json::Value = serde_json::from_str(&payload)?;
            assert_eq!(
                json_keys(&payload),
                fixture_keys(&ce["payloadKeys"]),
                "in-app change_event payload keys drifted from the parity fixture"
            );

            // undoJournal contract
            let uj = &fixture["undoJournal"];
            let (entity_kind, op_kind, before, after): (String, String, Option<String>, String) =
                conn.query_row(
                    "SELECT entity_kind, op_kind, before_json, after_json FROM undo_journal",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;
            assert_eq!(entity_kind, uj["entityKind"].as_str().unwrap());
            assert_eq!(op_kind, uj["opKind"].as_str().unwrap());
            assert!(uj["beforeJson"].is_null() == before.is_none());
            let after: serde_json::Value = serde_json::from_str(&after)?;
            for key in fixture_keys(&uj["afterJsonKeys"]) {
                assert!(
                    after.get(&key).is_some(),
                    "in-app after_json is missing fixture key '{key}'"
                );
            }

            // authorshipSpan contract
            let span_fixture = &fixture["authorshipSpan"];
            let owner_lane = span_fixture["ownerLane"].as_str().unwrap();
            let owner: Option<String> = conn.query_row(
                &format!("SELECT {owner_lane} FROM authorship_spans"),
                [],
                |r| r.get(0),
            )?;
            assert!(owner.is_some(), "in-app span owner lane drifted");
            let source: String =
                conn.query_row("SELECT source FROM authorship_spans", [], |r| r.get(0))?;
            assert_eq!(source, span_fixture["source"].as_str().unwrap());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn codex_create_retries_return_original_result_and_conflict_on_payload_change() {
        let db = test_db();
        let project_id = insert_project(&db);
        let payload = AgentCodexCreatePayload {
            request_id: Some("agent-tool:codex-request-1".to_string()),
            entry_id: None,
            project_id,
            session_id: "sess".to_string(),
            type_slug: "character".to_string(),
            name: "Alice".to_string(),
            summary: None,
            content: Some(
                json!({
                    "type": "doc",
                    "content": [{
                        "type": "text",
                        "text": "AI prose",
                        "marks": [{
                            "type": "authorship",
                            "attrs": { "source": "ai", "timestamp": "first-attempt" }
                        }]
                    }]
                })
                .to_string(),
            ),
            aliases: None,
            parent_id: None,
            source_chat_message_id: None,
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: vec![],
        };
        let first = agent_codex_create_impl(&db, payload.clone()).expect("first create");
        assert_ne!(first["entityId"], "agent-tool:codex-request-1");
        assert_eq!(first["undoJournalId"], "agent-tool:codex-request-1");
        let mut retry_payload = payload.clone();
        retry_payload.session_id = "sess-after-restart".to_string();
        retry_payload.summary = Some(String::new());
        retry_payload.content = Some(
            json!({
                "content": [{
                    "marks": [{
                        "attrs": { "timestamp": "retry-attempt", "source": "ai" },
                        "type": "authorship"
                    }],
                    "text": "AI prose",
                    "type": "text"
                }],
                "type": "doc"
            })
            .to_string(),
        );
        let retry = agent_codex_create_impl(&db, retry_payload)
            .expect("retry ignores session, JSON key order, and authorship timestamp");
        assert_eq!(retry, first);
        assert_eq!(table_count(&db, "codex_entries"), 1);
        assert_eq!(table_count(&db, "undo_journal"), 1);
        assert_eq!(table_count(&db, "change_events"), 1);

        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM codex_entries WHERE id = ?1",
                rusqlite::params![first["entityId"].as_str().expect("entity id")],
            )?;
            Ok(())
        })
        .unwrap();
        let deleted_retry =
            agent_codex_create_impl(&db, payload.clone()).expect("deleted request replay");
        assert_eq!(deleted_retry, first);
        assert_eq!(table_count(&db, "codex_entries"), 0);

        let mut conflicting = payload;
        conflicting.name = "Mallory".to_string();
        let error = agent_codex_create_impl(&db, conflicting).expect_err("payload conflict");
        assert!(error
            .to_string()
            .contains("AGENT_CODEX_CREATE_IDEMPOTENCY_CONFLICT"));
        assert_eq!(table_count(&db, "codex_entries"), 0);
    }

    #[test]
    fn snippet_create_retries_return_original_result_and_conflict_on_payload_change() {
        let db = test_db();
        let project_id = insert_project(&db);
        let payload = AgentSnippetCreatePayload {
            request_id: Some("agent-tool:snippet-request-1".to_string()),
            snippet_id: None,
            project_id,
            session_id: "sess".to_string(),
            title: "Excerpt".to_string(),
            content: None,
            scene_id: None,
            source_chat_message_id: None,
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: vec![],
        };
        let first = agent_snippet_create_impl(&db, payload.clone()).expect("first create");
        assert_ne!(first["entityId"], "agent-tool:snippet-request-1");
        assert_eq!(first["undoJournalId"], "agent-tool:snippet-request-1");
        let mut retry_payload = payload.clone();
        retry_payload.session_id = "sess-after-restart".to_string();
        retry_payload.content = Some("{ }".to_string());
        let retry = agent_snippet_create_impl(&db, retry_payload)
            .expect("retry ignores session and JSON whitespace");
        assert_eq!(retry, first);
        assert_eq!(table_count(&db, "snippets"), 1);
        assert_eq!(table_count(&db, "undo_journal"), 1);
        assert_eq!(table_count(&db, "change_events"), 1);

        let mut conflicting = payload;
        conflicting.title = "Changed".to_string();
        let error = agent_snippet_create_impl(&db, conflicting).expect_err("payload conflict");
        assert!(error
            .to_string()
            .contains("AGENT_SNIPPET_CREATE_IDEMPOTENCY_CONFLICT"));
        assert_eq!(table_count(&db, "snippets"), 1);
    }

    #[test]
    fn prose_propose_matches_parity_fixture_in_app() {
        let fixture: serde_json::Value = serde_json::from_str(PROSE_FIXTURE).unwrap();
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_id = insert_scene(&db, &project_id);

        let surface = "in-app-agent";
        assert!(
            fixture["sourceSurfaces"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s.as_str() == Some(surface)),
            "surface '{surface}' must be declared in the parity fixture"
        );

        agent_propose_scene_body_impl(
            &db,
            AgentProposeSceneBodyPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                scene_id: scene_id.clone(),
                proposed_content: "new prose".to_string(),
                mode: "append".to_string(),
                source_surface: surface.to_string(),
                replace_from: None,
                replace_to: None,
            },
        )
        .unwrap();

        db.with_conn(|conn| {
            let (status, source_surface, content): (String, String, String) = conn.query_row(
                "SELECT status, source_surface, proposed_content FROM prose_staging",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            assert_eq!(status, fixture["status"].as_str().unwrap());
            assert_eq!(source_surface, surface);

            // proposed_content keys: required keys present, every key known.
            let content: serde_json::Value = serde_json::from_str(&content)?;
            let keys = json_keys(&content);
            let required = fixture_keys(&fixture["proposedContent"]["requiredKeys"]);
            let optional = fixture_keys(&fixture["proposedContent"]["optionalKeys"]);
            for key in &required {
                assert!(keys.contains(key), "required key '{key}' missing: {keys:?}");
            }
            for key in &keys {
                assert!(
                    required.contains(key) || optional.contains(key),
                    "in-app proposed_content emits unknown key '{key}' — \
                     update the parity fixture AND the MCP consumer contract together"
                );
            }

            // changeEvent contract
            let ce = &fixture["changeEvent"];
            let (domain, op_type, entity_type, payload): (String, String, String, String) = conn
                .query_row(
                    "SELECT domain, op_type, entity_type, payload FROM change_events",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )?;
            assert_eq!(domain, ce["domain"].as_str().unwrap());
            assert_eq!(op_type, ce["opType"].as_str().unwrap());
            assert_eq!(entity_type, ce["entityType"].as_str().unwrap());
            let payload: serde_json::Value = serde_json::from_str(&payload)?;
            assert_eq!(json_keys(&payload), fixture_keys(&ce["payloadKeys"]));
            Ok(())
        })
        .unwrap();
    }

    fn journal_row(
        entity_kind: &str,
        op_kind: &str,
    ) -> grimodex_core::undo_journal::UndoJournalRow {
        grimodex_core::undo_journal::UndoJournalRow {
            id: "j1".to_string(),
            project_id: "p1".to_string(),
            entity_kind: entity_kind.to_string(),
            entity_id: "f1".to_string(),
            op_kind: op_kind.to_string(),
            before_json: None,
            after_json: None,
            base_version: 0,
            result_version: 1,
        }
    }

    #[test]
    fn undo_journal_change_event_supports_foreshadow() {
        // Undoing a create emits a delete-shaped event; redo re-emits create.
        let (domain, entity_type, op_type, entity_id) =
            undo_journal_change_event(&journal_row("foreshadow", "create"), "undo").unwrap();
        assert_eq!(domain, "foreshadow");
        assert_eq!(entity_type, "foreshadow");
        assert_eq!(op_type, "foreshadow.delete");
        assert_eq!(entity_id, "f1");

        let (_, _, op_type, _) =
            undo_journal_change_event(&journal_row("foreshadow", "create"), "redo").unwrap();
        assert_eq!(op_type, "foreshadow.create");

        let (_, _, op_type, _) =
            undo_journal_change_event(&journal_row("foreshadow", "update"), "undo").unwrap();
        assert_eq!(op_type, "foreshadow.update");
    }

    #[test]
    fn undo_journal_change_event_preserves_event_association_operations() {
        let cases = [
            (
                json!({ "sceneId": "s1", "eventId": "e1", "linked": true }),
                "event.stamp",
            ),
            (
                json!({ "sceneId": "s1", "eventId": "e1", "linked": false }),
                "event.unstamp",
            ),
            (
                json!({
                    "causeEventId": "e1",
                    "effectEventId": "e2",
                    "linked": true
                }),
                "event.relation_add",
            ),
            (
                json!({
                    "causeEventId": "e1",
                    "effectEventId": "e2",
                    "linked": false
                }),
                "event.relation_remove",
            ),
            (
                json!({ "eventId": "e1", "participants": [], "version": 2 }),
                "event.participants",
            ),
        ];

        for (snapshot, expected) in cases {
            let mut row = journal_row("event", "update");
            row.before_json = Some(snapshot.to_string());
            let (_, _, op_type, _) = undo_journal_change_event(&row, "undo").unwrap();
            assert_eq!(op_type, expected);
        }
    }

    #[test]
    fn foreshadow_create_in_app_is_tracked() {
        let db = test_db();
        let project_id = insert_project(&db);

        let res = agent_foreshadow_create_impl(
            &db,
            AgentForeshadowCreatePayload {
                request_id: None,
                foreshadow_id: None,
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                title: "刻印の謎".to_string(),
                intent: Some("後段で回収".to_string()),
                notes: None,
                load_bearing: Some("critical".to_string()),
                secret: true,
            },
        )
        .unwrap();
        // camelCase AgentWriteResult shape (same contract codex/snippet return).
        let entity_id = res["entityId"].as_str().expect("entityId").to_string();
        assert!(res["undoJournalId"].as_str().is_some());
        assert!(res["changeEventUid"].as_str().is_some());

        db.with_conn(|conn| {
            let (title, secret): (String, i64) = conn.query_row(
                "SELECT title, secret FROM foreshadows WHERE id = ?1",
                rusqlite::params![entity_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!(title, "刻印の謎");
            assert_eq!(secret, 1);
            let (domain, op_type, session): (String, String, String) = conn.query_row(
                "SELECT domain, op_type, session_id FROM change_events",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )?;
            assert_eq!(domain, "foreshadow");
            assert_eq!(op_type, "foreshadow.create");
            assert_eq!(session, "sess");
            let surface: String =
                conn.query_row("SELECT surface FROM undo_journal", [], |r| r.get(0))?;
            assert_eq!(surface, "in-app-agent");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn agent_foreshadow_create_retries_return_original_result_and_conflict() {
        let db = test_db();
        let project_id = insert_project(&db);
        let payload = AgentForeshadowCreatePayload {
            request_id: Some("agent-tool:foreshadow-request-1".to_string()),
            foreshadow_id: None,
            project_id,
            session_id: "sess".to_string(),
            title: "刻印の謎".to_string(),
            intent: Some("後段で回収".to_string()),
            notes: None,
            load_bearing: Some("critical".to_string()),
            secret: true,
        };
        let first = agent_foreshadow_create_impl(&db, payload.clone()).expect("first create");
        assert_ne!(first["entityId"], "agent-tool:foreshadow-request-1");
        assert_eq!(first["undoJournalId"], "agent-tool:foreshadow-request-1");
        let mut retry_payload = payload.clone();
        retry_payload.session_id = "sess-after-restart".to_string();
        let retry = agent_foreshadow_create_impl(&db, retry_payload)
            .expect("retry ignores recorder session");
        assert_eq!(retry, first);
        assert_eq!(table_count(&db, "foreshadows"), 1);
        assert_eq!(table_count(&db, "undo_journal"), 1);
        assert_eq!(table_count(&db, "change_events"), 1);

        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM foreshadows WHERE id = ?1",
                rusqlite::params![first["entityId"].as_str().expect("entity id")],
            )?;
            Ok(())
        })
        .unwrap();
        let deleted_retry =
            agent_foreshadow_create_impl(&db, payload.clone()).expect("deleted request replay");
        assert_eq!(deleted_retry, first);
        assert_eq!(table_count(&db, "foreshadows"), 0);

        let mut conflicting = payload;
        conflicting.title = "別の伏線".to_string();
        let error = agent_foreshadow_create_impl(&db, conflicting).expect_err("payload conflict");
        assert!(error
            .to_string()
            .contains("AGENT_FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT"));
        assert_eq!(table_count(&db, "foreshadows"), 0);
    }

    #[test]
    fn foreshadow_update_in_app_patches_and_tracks() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow_row(&db, &project_id);

        agent_foreshadow_update_impl(
            &db,
            AgentForeshadowUpdatePayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                foreshadow_id: foreshadow_id.clone(),
                title: None,
                intent: None,
                notes: None,
                load_bearing: None,
                payoff_confirmed: Some(true),
                abandoned: None,
                secret: None,
            },
        )
        .unwrap();

        db.with_conn(|conn| {
            let payoff: i64 = conn.query_row(
                "SELECT payoff_confirmed FROM foreshadows WHERE id = ?1",
                rusqlite::params![foreshadow_id],
                |r| r.get(0),
            )?;
            assert_eq!(payoff, 1);
            let op_type: String =
                conn.query_row("SELECT op_type FROM change_events", [], |r| r.get(0))?;
            assert_eq!(op_type, "foreshadow.update");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn foreshadow_update_in_app_not_found_errors_and_writes_nothing() {
        let db = test_db();
        let project_id = insert_project(&db);

        let res = agent_foreshadow_update_impl(
            &db,
            AgentForeshadowUpdatePayload {
                project_id,
                session_id: "sess".to_string(),
                foreshadow_id: "ghost".to_string(),
                title: Some("x".to_string()),
                intent: None,
                notes: None,
                load_bearing: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
            },
        );
        assert!(res.is_err());
        db.with_conn(|conn| {
            let n: i64 = conn.query_row("SELECT COUNT(*) FROM change_events", [], |r| r.get(0))?;
            assert_eq!(n, 0);
            Ok(())
        })
        .unwrap();
    }

    fn insert_foreshadow_row(db: &Database, project_id: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        db.execute(
            "INSERT INTO foreshadows (id, project_id, title, payoff_confirmed, abandoned, secret, created_at, updated_at)
             VALUES (?, ?, 'Seed', 0, 0, 0, ?, ?)",
            &[
                Value::String(id.clone()),
                Value::String(project_id.to_string()),
                Value::Number(now.into()),
                Value::Number(now.into()),
            ],
            "run",
        )
        .expect("insert foreshadow");
        id
    }

    // ---- Chronicle (event) round-trip helpers -----------------------------

    fn insert_codex(db: &Database, project_id: &str, name: &str) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO codex_entries
             (id, project_id, type, name, summary, content, version, created_at, updated_at)
             VALUES (?, ?, 'character', ?, '', '{}', 1, datetime('now'), datetime('now'))",
            &[
                Value::String(id.clone()),
                Value::String(project_id.to_string()),
                Value::String(name.to_string()),
            ],
            "run",
        )
        .expect("insert codex");
        id
    }

    fn undo_payload(
        project_id: &str,
        journal_id: &str,
        direction: &str,
    ) -> AgentUndoJournalPayload {
        AgentUndoJournalPayload {
            request_id: None,
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            journal_id: journal_id.to_string(),
            direction: direction.to_string(),
        }
    }

    fn relation_payload(project_id: &str, cause: &str, effect: &str) -> AgentEventRelationPayload {
        AgentEventRelationPayload {
            request_id: None,
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            surface: None,
            cause_event_id: cause.to_string(),
            effect_event_id: effect.to_string(),
        }
    }

    fn scene_payload(project_id: &str, scene_id: &str, event_id: &str) -> AgentSceneEventPayload {
        AgentSceneEventPayload {
            request_id: None,
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            surface: None,
            scene_id: scene_id.to_string(),
            event_id: event_id.to_string(),
        }
    }

    fn empty_update(project_id: &str, event_id: &str) -> AgentEventUpdatePayload {
        AgentEventUpdatePayload {
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            surface: None,
            event_id: event_id.to_string(),
            base_version: 1,
            title: None,
            note: None,
            detail: None,
            ordinal: None,
            primary_codex_id: None,
            lane_group: None,
            location_codex_id: None,
            start_time: None,
            end_time: None,
            start_minute: None,
            end_minute: None,
            start_granularity: None,
            end_granularity: None,
            precision: None,
            kind: None,
            secret: None,
            reveal_scene_id: None,
        }
    }

    fn empty_create(project_id: &str, title: &str) -> AgentEventCreatePayload {
        AgentEventCreatePayload {
            request_id: None,
            event_id: None,
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            surface: None,
            title: Some(title.to_string()),
            note: None,
            detail: None,
            ordinal: None,
            primary_codex_id: None,
            lane_group: None,
            location_codex_id: None,
            start_time: None,
            end_time: None,
            start_minute: None,
            end_minute: None,
            start_granularity: None,
            end_granularity: None,
            precision: None,
            kind: None,
            secret: None,
            reveal_scene_id: None,
            participant_codex_ids: None,
            scene_ids: None,
        }
    }

    /// Create an event and return (event_id, undo_journal_id).
    fn create_event(
        db: &Database,
        project_id: &str,
        title: &str,
        participants: Vec<String>,
        scenes: Vec<String>,
    ) -> (String, String) {
        let res = agent_event_create_impl(
            db,
            AgentEventCreatePayload {
                request_id: None,
                event_id: None,
                project_id: project_id.to_string(),
                session_id: "sess".to_string(),
                surface: None,
                title: Some(title.to_string()),
                note: None,
                detail: None,
                ordinal: None,
                primary_codex_id: None,
                lane_group: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                precision: None,
                kind: None,
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: (!participants.is_empty()).then_some(participants),
                scene_ids: (!scenes.is_empty()).then_some(scenes),
            },
        )
        .expect("create event");
        (
            res["entityId"].as_str().expect("entityId").to_string(),
            res["undoJournalId"]
                .as_str()
                .expect("undoJournalId")
                .to_string(),
        )
    }

    #[test]
    fn event_create_retries_return_original_result_and_conflict_on_payload_change() {
        let db = test_db();
        let project_id = insert_project(&db);
        let participant_a = insert_codex(&db, &project_id, "Alice");
        let participant_b = insert_codex(&db, &project_id, "Bob");
        let scene_a = insert_scene(&db, &project_id);
        let scene_b = insert_scene(&db, &project_id);
        let mut payload = empty_create(&project_id, "Arrival");
        payload.request_id = Some("agent-tool:event-request-1".to_string());
        payload.participant_codex_ids = Some(vec![
            participant_b.clone(),
            participant_a.clone(),
            participant_a.clone(),
        ]);
        payload.scene_ids = Some(vec![scene_b.clone(), scene_a.clone(), scene_a.clone()]);

        let first = agent_event_create_impl(&db, payload.clone()).expect("first create");
        assert_ne!(first["entityId"], "agent-tool:event-request-1");
        assert_eq!(first["undoJournalId"], "agent-tool:event-request-1");
        let mut retry_payload = payload.clone();
        retry_payload.session_id = "sess-after-restart".to_string();
        retry_payload.surface = Some("manual".to_string());
        retry_payload.ordinal = Some("a0".to_string());
        retry_payload.precision = Some("exact".to_string());
        retry_payload.kind = Some("generic".to_string());
        retry_payload.start_granularity = Some("none".to_string());
        retry_payload.end_granularity = Some("none".to_string());
        retry_payload.secret = Some(false);
        retry_payload.reveal_scene_id = Some(String::new());
        retry_payload.participant_codex_ids = Some(vec![participant_a, participant_b]);
        retry_payload.scene_ids = Some(vec![scene_a, scene_b]);
        let retry = agent_event_create_impl(&db, retry_payload)
            .expect("retry canonicalizes defaults, provenance, and set-like inputs");
        assert_eq!(retry, first);
        assert_eq!(table_count(&db, "events"), 1);
        assert_eq!(table_count(&db, "undo_journal"), 1);
        assert_eq!(table_count(&db, "change_events"), 1);

        let mut conflicting = payload;
        conflicting.title = Some("Departure".to_string());
        let error = agent_event_create_impl(&db, conflicting).expect_err("payload conflict");
        assert!(error
            .to_string()
            .contains("AGENT_EVENT_CREATE_IDEMPOTENCY_CONFLICT"));
        assert_eq!(table_count(&db, "events"), 1);
    }

    #[test]
    fn association_request_ids_deduplicate_journal_and_event_side_effects() {
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_a = insert_scene(&db, &project_id);
        let scene_b = insert_scene(&db, &project_id);
        let (event_a, _) = create_event(&db, &project_id, "A", vec![], vec![]);
        let (event_b, _) = create_event(&db, &project_id, "B", vec![], vec![]);
        let (event_c, _) = create_event(&db, &project_id, "C", vec![], vec![]);

        let mut link = scene_payload(&project_id, &scene_a, &event_a);
        link.request_id = Some("scene-link-request-1".to_string());
        let journal_before = table_count(&db, "undo_journal");
        let events_before = table_count(&db, "change_events");
        let first_link =
            agent_scene_event_mutate_impl(&db, link.clone(), true).expect("first link");
        let mut retried_link = link.clone();
        retried_link.session_id = "sess-after-restart".to_string();
        retried_link.surface = Some("manual".to_string());
        let retry_link =
            agent_scene_event_mutate_impl(&db, retried_link, true).expect("link retry");
        assert_eq!(retry_link, first_link);
        assert_eq!(table_count(&db, "undo_journal"), journal_before + 1);
        assert_eq!(table_count(&db, "change_events"), events_before + 1);

        let mut conflicting_link = link;
        conflicting_link.scene_id = scene_b;
        let error = agent_scene_event_mutate_impl(&db, conflicting_link, true)
            .expect_err("link request conflict");
        assert!(error
            .to_string()
            .contains("AGENT_SCENE_EVENT_IDEMPOTENCY_CONFLICT"));

        let mut relation = relation_payload(&project_id, &event_a, &event_b);
        relation.request_id = Some("event-relation-request-1".to_string());
        let journal_before = table_count(&db, "undo_journal");
        let events_before = table_count(&db, "change_events");
        let first_relation =
            agent_event_relation_mutate_impl(&db, relation.clone(), true).expect("first relation");
        let mut retried_relation = relation.clone();
        retried_relation.session_id = "sess-after-restart".to_string();
        retried_relation.surface = Some("manual".to_string());
        let retry_relation =
            agent_event_relation_mutate_impl(&db, retried_relation, true).expect("relation retry");
        assert_eq!(retry_relation, first_relation);
        assert_eq!(table_count(&db, "undo_journal"), journal_before + 1);
        assert_eq!(table_count(&db, "change_events"), events_before + 1);

        let mut conflicting_relation = relation;
        conflicting_relation.effect_event_id = event_c;
        let error = agent_event_relation_mutate_impl(&db, conflicting_relation, true)
            .expect_err("relation request conflict");
        assert!(error
            .to_string()
            .contains("AGENT_EVENT_RELATION_IDEMPOTENCY_CONFLICT"));
    }

    fn legacy_event_snapshot(db: &Database, event_id: &str) -> Value {
        db.with_conn(|conn| {
            let mut snapshot = collect_event_snapshot(conn, event_id)?;
            snapshot["eventData"]
                .as_object_mut()
                .expect("eventData object")
                .remove("version");
            Ok(snapshot)
        })
        .expect("legacy snapshot")
    }

    fn legacy_participants_snapshot(db: &Database, event_id: &str) -> Value {
        db.with_conn(|conn| {
            let mut snapshot = collect_participants_json(conn, event_id)?;
            snapshot
                .as_object_mut()
                .expect("participants snapshot object")
                .remove("version");
            Ok(snapshot)
        })
        .expect("legacy participants snapshot")
    }

    fn insert_legacy_event_journal(
        db: &Database,
        project_id: &str,
        event_id: &str,
        op_kind: &str,
        before: Option<&Value>,
        after: Option<&Value>,
    ) -> String {
        let journal_id = uuid::Uuid::new_v4().to_string();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO undo_journal
                 (id, project_id, surface, entity_kind, entity_id, op_kind,
                  before_json, after_json, base_version, result_version)
                 VALUES (?1, ?2, 'legacy', 'event', ?3, ?4, ?5, ?6, 1, 1)",
                rusqlite::params![
                    journal_id,
                    project_id,
                    event_id,
                    op_kind,
                    before.map(Value::to_string),
                    after.map(Value::to_string),
                ],
            )?;
            Ok(())
        })
        .expect("insert legacy journal");
        journal_id
    }

    fn journal_surface(db: &Database, journal_id: &str) -> String {
        db.with_conn(|conn| {
            let s: String = conn.query_row(
                "SELECT surface FROM undo_journal WHERE id = ?1",
                rusqlite::params![journal_id],
                |r| r.get(0),
            )?;
            Ok(s)
        })
        .expect("journal_surface")
    }

    #[test]
    fn event_write_records_surface_from_payload() {
        let db = test_db();
        let project_id = insert_project(&db);

        // surface 省略（既存 AI/JS 経路）→ in-app-agent 互換にフォールバック。
        let (_id, journal_default) = create_event(&db, &project_id, "auto", vec![], vec![]);
        assert_eq!(journal_surface(&db, &journal_default), "in-app-agent");

        // surface = "manual"（UI 手動編集）→ そのまま undo_journal へ記録される
        // （AI 書き込みと混同されない provenance）。
        let res = agent_event_create_impl(
            &db,
            AgentEventCreatePayload {
                request_id: None,
                event_id: None,
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: Some("manual".to_string()),
                title: Some("手動作成".to_string()),
                note: None,
                detail: None,
                ordinal: None,
                primary_codex_id: None,
                lane_group: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                precision: None,
                kind: None,
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: None,
                scene_ids: None,
            },
        )
        .expect("create with manual surface");
        let journal_manual = res["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(journal_surface(&db, &journal_manual), "manual");
    }

    fn scalar_count(db: &Database, sql: &str, a: &str, b: Option<&str>) -> i64 {
        db.with_conn(|conn| {
            let n: i64 = match b {
                Some(b) => conn.query_row(sql, rusqlite::params![a, b], |r| r.get(0))?,
                None => conn.query_row(sql, rusqlite::params![a], |r| r.get(0))?,
            };
            Ok(n)
        })
        .expect("scalar_count")
    }

    fn event_count(db: &Database, event_id: &str) -> i64 {
        scalar_count(
            db,
            "SELECT COUNT(*) FROM events WHERE id = ?1",
            event_id,
            None,
        )
    }

    fn participant_count(db: &Database, event_id: &str) -> i64 {
        scalar_count(
            db,
            "SELECT COUNT(*) FROM event_participants WHERE event_id = ?1",
            event_id,
            None,
        )
    }

    fn scene_link_count(db: &Database, event_id: &str) -> i64 {
        scalar_count(
            db,
            "SELECT COUNT(*) FROM scene_events WHERE event_id = ?1",
            event_id,
            None,
        )
    }

    fn relation_count(db: &Database, cause: &str, effect: &str) -> i64 {
        scalar_count(
            db,
            "SELECT COUNT(*) FROM event_relations WHERE cause_event_id = ?1 AND effect_event_id = ?2",
            cause,
            Some(effect),
        )
    }

    fn participant_has(db: &Database, event_id: &str, codex_id: &str) -> bool {
        scalar_count(
            db,
            "SELECT COUNT(*) FROM event_participants WHERE event_id = ?1 AND codex_entry_id = ?2",
            event_id,
            Some(codex_id),
        ) > 0
    }

    fn participant_role(db: &Database, event_id: &str, codex_id: &str) -> Option<String> {
        db.with_conn(|conn| {
            let r: Option<String> = conn.query_row(
                "SELECT role FROM event_participants WHERE event_id = ?1 AND codex_entry_id = ?2",
                rusqlite::params![event_id, codex_id],
                |row| row.get(0),
            )?;
            Ok(r)
        })
        .expect("participant_role")
    }

    fn event_title(db: &Database, event_id: &str) -> Option<String> {
        db.with_conn(|conn| {
            match conn.query_row(
                "SELECT title FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get::<_, String>(0),
            ) {
                Ok(t) => Ok(Some(t)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.into()),
            }
        })
        .expect("event_title")
    }

    fn event_start(db: &Database, event_id: &str) -> Option<i64> {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT start_time FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get::<_, Option<i64>>(0),
            )?)
        })
        .expect("event_start")
    }

    fn event_end(db: &Database, event_id: &str) -> Option<i64> {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT end_time FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get::<_, Option<i64>>(0),
            )?)
        })
        .expect("event_end")
    }

    fn event_primary_codex(db: &Database, event_id: &str) -> Option<String> {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT primary_codex_id FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get::<_, Option<String>>(0),
            )?)
        })
        .expect("event_primary_codex")
    }

    fn event_scalar_references(
        db: &Database,
        event_id: &str,
    ) -> (Option<String>, Option<String>, Option<String>) {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT primary_codex_id, location_codex_id, reveal_scene_id
                 FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("event_scalar_references")
    }

    fn event_detail(db: &Database, event_id: &str) -> Option<String> {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT detail FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get::<_, Option<String>>(0),
            )?)
        })
        .expect("event_detail")
    }

    fn event_version(db: &Database, event_id: &str) -> i64 {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT version FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| row.get(0),
            )?)
        })
        .expect("event_version")
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct EventDateState {
        start_time: Option<i64>,
        end_time: Option<i64>,
        start_minute: Option<i64>,
        end_minute: Option<i64>,
        start_granularity: String,
        end_granularity: String,
        version: i64,
    }

    fn event_date_state(db: &Database, event_id: &str) -> EventDateState {
        db.with_conn(|conn| {
            Ok(conn.query_row(
                "SELECT start_time, end_time, start_minute, end_minute,
                        start_granularity, end_granularity, version
                 FROM events WHERE id = ?1",
                rusqlite::params![event_id],
                |row| {
                    Ok(EventDateState {
                        start_time: row.get(0)?,
                        end_time: row.get(1)?,
                        start_minute: row.get(2)?,
                        end_minute: row.get(3)?,
                        start_granularity: row.get(4)?,
                        end_granularity: row.get(5)?,
                        version: row.get(6)?,
                    })
                },
            )?)
        })
        .expect("event_date_state")
    }

    fn latest_change_payload(db: &Database, op_type: &str) -> Value {
        db.with_conn(|conn| {
            let raw: String = conn.query_row(
                "SELECT payload FROM change_events
                 WHERE op_type = ?1 ORDER BY sequence DESC LIMIT 1",
                rusqlite::params![op_type],
                |row| row.get(0),
            )?;
            Ok(serde_json::from_str(&raw)?)
        })
        .expect("latest_change_payload")
    }

    #[test]
    fn event_mutation_payloads_require_base_version() {
        let shared = json!({
            "projectId": "p1",
            "sessionId": "s1",
            "eventId": "e1",
        });
        assert!(
            serde_json::from_value::<AgentEventUpdatePayload>(shared.clone()).is_err(),
            "update must reject a missing baseVersion"
        );
        assert!(
            serde_json::from_value::<AgentEventIdPayload>(shared.clone()).is_err(),
            "delete must reject a missing baseVersion"
        );
        let mut participants = shared;
        participants["codexEntryIds"] = json!([]);
        assert!(
            serde_json::from_value::<AgentEventParticipantsPayload>(participants).is_err(),
            "participant replacement must reject a missing baseVersion"
        );
    }

    #[test]
    fn event_update_rejects_stale_base_without_journal_or_change_event() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "seed", vec![], vec![]);

        let mut first = empty_update(&project_id, &event_id);
        first.base_version = 1;
        first.title = Some("fresh".to_string());
        let result = agent_event_update_impl(&db, first).expect("fresh update");
        assert_eq!(result["version"], 2);

        let journals_before = scalar_count(
            &db,
            "SELECT COUNT(*) FROM undo_journal WHERE entity_id = ?1",
            &event_id,
            None,
        );
        let changes_before = scalar_count(
            &db,
            "SELECT COUNT(*) FROM change_events WHERE entity_id = ?1",
            &event_id,
            None,
        );
        let mut stale = empty_update(&project_id, &event_id);
        stale.base_version = 1;
        stale.title = Some("stale".to_string());
        let error = agent_event_update_impl(&db, stale).expect_err("stale update");

        assert!(error.to_string().contains("version conflict"));
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("fresh"));
        assert_eq!(event_version(&db, &event_id), 2);
        assert_eq!(
            scalar_count(
                &db,
                "SELECT COUNT(*) FROM undo_journal WHERE entity_id = ?1",
                &event_id,
                None,
            ),
            journals_before,
        );
        assert_eq!(
            scalar_count(
                &db,
                "SELECT COUNT(*) FROM change_events WHERE entity_id = ?1",
                &event_id,
                None,
            ),
            changes_before,
        );
    }

    #[test]
    fn event_create_rejects_invalid_chronicle_dates_without_side_effects() {
        let db = test_db();
        let project_id = insert_project(&db);

        let mut negative_minute = empty_create(&project_id, "negative minute");
        negative_minute.start_time = Some(10);
        negative_minute.start_minute = Some(-1);
        negative_minute.start_granularity = Some("time".to_string());

        let mut overflow_minute = empty_create(&project_id, "overflow minute");
        overflow_minute.start_time = Some(10);
        overflow_minute.start_minute = Some(0);
        overflow_minute.start_granularity = Some("time".to_string());
        overflow_minute.end_time = Some(11);
        overflow_minute.end_minute = Some(1440);
        overflow_minute.end_granularity = Some("time".to_string());

        let mut reversed = empty_create(&project_id, "reversed");
        reversed.start_time = Some(10);
        reversed.start_minute = Some(18 * 60);
        reversed.start_granularity = Some("time".to_string());
        reversed.end_time = Some(10);
        reversed.end_minute = Some(12 * 60);
        reversed.end_granularity = Some("time".to_string());

        let mut coarse_without_day = empty_create(&project_id, "coarse without day");
        coarse_without_day.start_granularity = Some("day".to_string());

        let mut end_without_start = empty_create(&project_id, "end without start");
        end_without_start.end_time = Some(10);
        end_without_start.end_granularity = Some("day".to_string());

        for (payload, expected) in [
            (negative_minute, "minute must be between 0 and 1439"),
            (overflow_minute, "minute must be between 0 and 1439"),
            (reversed, "must not precede start timestamp"),
            (coarse_without_day, "granularity 'day' requires a day"),
            (end_without_start, "end endpoint requires a start endpoint"),
        ] {
            let error = agent_event_create_impl(&db, payload).expect_err("invalid date must fail");
            assert!(error.to_string().contains(expected), "{error:#}");
            assert_eq!(table_count(&db, "events"), 0);
            assert_eq!(table_count(&db, "undo_journal"), 0);
            assert_eq!(table_count(&db, "change_events"), 0);
        }
    }

    #[test]
    fn event_create_normalizes_non_time_endpoint_components() {
        let db = test_db();
        let project_id = insert_project(&db);
        let mut payload = empty_create(&project_id, "canonical");
        payload.start_time = Some(10);
        payload.start_minute = Some(18 * 60);
        payload.start_granularity = Some("day".to_string());
        payload.end_time = Some(11);
        payload.end_minute = Some(20 * 60);
        payload.end_granularity = Some("none".to_string());

        let created = agent_event_create_impl(&db, payload).expect("canonical create");
        let event_id = created["entityId"].as_str().expect("entity id");
        assert_eq!(
            event_date_state(&db, event_id),
            EventDateState {
                start_time: Some(10),
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: "day".to_string(),
                end_granularity: "none".to_string(),
                version: 1,
            }
        );
    }

    #[test]
    fn event_update_time_to_day_clears_minute() {
        let db = test_db();
        let project_id = insert_project(&db);
        let mut seed = empty_create(&project_id, "timed");
        seed.start_time = Some(10);
        seed.start_minute = Some(18 * 60);
        seed.start_granularity = Some("time".to_string());
        let created = agent_event_create_impl(&db, seed).expect("timed create");
        let event_id = created["entityId"].as_str().expect("entity id");

        let mut patch = empty_update(&project_id, event_id);
        patch.start_granularity = Some("day".to_string());
        let updated = agent_event_update_impl(&db, patch).expect("time to day");
        assert_eq!(updated["version"], 2);
        assert_eq!(
            event_date_state(&db, event_id),
            EventDateState {
                start_time: Some(10),
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: "day".to_string(),
                end_granularity: "none".to_string(),
                version: 2,
            }
        );
    }

    #[test]
    fn event_update_omitted_granularity_promotes_minute_to_time() {
        let db = test_db();
        let project_id = insert_project(&db);
        let mut seed = empty_create(&project_id, "coarse");
        seed.start_time = Some(10);
        seed.start_granularity = Some("day".to_string());
        let created = agent_event_create_impl(&db, seed).expect("coarse create");
        let event_id = created["entityId"].as_str().expect("entity id");

        let mut patch = empty_update(&project_id, event_id);
        patch.start_minute = Some(18 * 60);
        let updated = agent_event_update_impl(&db, patch).expect("minute promotion");
        assert_eq!(updated["version"], 2);
        assert_eq!(
            event_date_state(&db, event_id),
            EventDateState {
                start_time: Some(10),
                end_time: None,
                start_minute: Some(18 * 60),
                end_minute: None,
                start_granularity: "time".to_string(),
                end_granularity: "none".to_string(),
                version: 2,
            }
        );
    }

    #[test]
    fn event_unrelated_update_preserves_legacy_coarse_minute() {
        let db = test_db();
        let project_id = insert_project(&db);
        let mut seed = empty_create(&project_id, "legacy");
        seed.start_time = Some(10);
        seed.start_granularity = Some("day".to_string());
        seed.end_time = Some(10);
        seed.end_granularity = Some("day".to_string());
        let created = agent_event_create_impl(&db, seed).expect("coarse create");
        let event_id = created["entityId"].as_str().expect("entity id").to_string();
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE events
                 SET start_minute = ?1, end_minute = ?2
                 WHERE id = ?3",
                rusqlite::params![18 * 60, 12 * 60, event_id],
            )?;
            Ok(())
        })
        .expect("seed legacy minute");

        let mut patch = empty_update(&project_id, &event_id);
        patch.title = Some("renamed".to_string());
        let updated = agent_event_update_impl(&db, patch).expect("unrelated title update");
        assert_eq!(updated["version"], 2);
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("renamed"));
        assert_eq!(
            event_date_state(&db, &event_id),
            EventDateState {
                start_time: Some(10),
                end_time: Some(10),
                start_minute: Some(18 * 60),
                end_minute: Some(12 * 60),
                start_granularity: "day".to_string(),
                end_granularity: "day".to_string(),
                version: 2,
            }
        );
    }

    #[test]
    fn event_update_validates_merged_chronicle_dates_without_mutation() {
        let db = test_db();
        let project_id = insert_project(&db);
        let mut seed = empty_create(&project_id, "interval");
        seed.start_time = Some(10);
        seed.start_minute = Some(18 * 60);
        seed.start_granularity = Some("time".to_string());
        seed.end_time = Some(10);
        seed.end_minute = Some(20 * 60);
        seed.end_granularity = Some("time".to_string());
        let created = agent_event_create_impl(&db, seed).expect("valid interval");
        let event_id = created["entityId"].as_str().expect("entity id").to_string();
        let before = event_date_state(&db, &event_id);
        let journals_before = table_count(&db, "undo_journal");
        let changes_before = table_count(&db, "change_events");

        let mut negative_minute = empty_update(&project_id, &event_id);
        negative_minute.start_minute = Some(-1);

        let mut overflow_minute = empty_update(&project_id, &event_id);
        overflow_minute.end_minute = Some(1440);

        let mut reversed = empty_update(&project_id, &event_id);
        reversed.end_minute = Some(12 * 60);

        for (payload, expected) in [
            (negative_minute, "minute must be between 0 and 1439"),
            (overflow_minute, "minute must be between 0 and 1439"),
            (reversed, "must not precede start timestamp"),
        ] {
            let error = agent_event_update_impl(&db, payload).expect_err("invalid date must fail");
            assert!(error.to_string().contains(expected), "{error:#}");
            assert_eq!(event_date_state(&db, &event_id), before);
            assert_eq!(table_count(&db, "undo_journal"), journals_before);
            assert_eq!(table_count(&db, "change_events"), changes_before);
        }
    }

    #[test]
    fn event_participants_reject_stale_base_and_preserve_aggregate() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex_a = insert_codex(&db, &project_id, "A");
        let codex_b = insert_codex(&db, &project_id, "B");
        let (event_id, _) = create_event(&db, &project_id, "seed", vec![], vec![]);

        let first = agent_event_set_participants_impl(
            &db,
            AgentEventParticipantsPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: event_id.clone(),
                base_version: 1,
                codex_entry_ids: vec![codex_a.clone()],
            },
        )
        .expect("fresh participants");
        assert_eq!(first["version"], 2);

        let stale = agent_event_set_participants_impl(
            &db,
            AgentEventParticipantsPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: event_id.clone(),
                base_version: 1,
                codex_entry_ids: vec![codex_b.clone()],
            },
        )
        .expect_err("stale participants");

        assert!(stale.to_string().contains("version conflict"));
        assert!(participant_has(&db, &event_id, &codex_a));
        assert!(!participant_has(&db, &event_id, &codex_b));
        assert_eq!(event_version(&db, &event_id), 2);
    }

    #[test]
    fn event_detail_create_update_and_undo_round_trip() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "e", vec![], vec![]);
        // 新規作成時は detail 未指定 → NULL。
        assert_eq!(event_detail(&db, &event_id), None);

        // 詳細をセット（ProseMirror JSON 文字列）。
        let doc_a = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"詳細A"}]}]}"#;
        let mut p1 = empty_update(&project_id, &event_id);
        p1.detail = Some(doc_a.to_string());
        agent_event_update_impl(&db, p1).unwrap();
        assert_eq!(event_detail(&db, &event_id).as_deref(), Some(doc_a));

        // 別の詳細へ更新し、戻りスナップショットで undo すると detailA に戻る。
        let doc_b = r#"{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"詳細B"}]}]}"#;
        let mut p2 = empty_update(&project_id, &event_id);
        p2.base_version = 2;
        p2.detail = Some(doc_b.to_string());
        let res = agent_event_update_impl(&db, p2).unwrap();
        assert_eq!(event_detail(&db, &event_id).as_deref(), Some(doc_b));

        let journal_id = res["undoJournalId"].as_str().unwrap().to_string();
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        assert_eq!(event_detail(&db, &event_id).as_deref(), Some(doc_a));
    }

    #[test]
    fn event_update_empty_primary_codex_clears_to_null() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex = insert_codex(&db, &project_id, "Alice");
        let (event_id, _) = create_event(&db, &project_id, "e", vec![], vec![]);
        // レーン割当。
        let mut p1 = empty_update(&project_id, &event_id);
        p1.primary_codex_id = Some(codex.clone());
        agent_event_update_impl(&db, p1).unwrap();
        assert_eq!(event_primary_codex(&db, &event_id), Some(codex));
        // "" で未割当へ戻す（D&D で未割当レーンへ移動）。NULL クリアされる。
        let mut p2 = empty_update(&project_id, &event_id);
        p2.base_version = 2;
        p2.primary_codex_id = Some(String::new());
        agent_event_update_impl(&db, p2).unwrap();
        assert_eq!(event_primary_codex(&db, &event_id), None);
    }

    #[test]
    fn event_create_rejects_cross_project_scalar_references_atomically() {
        let db = test_db();
        let local_project = insert_project(&db);
        let foreign_project = insert_project(&db);
        let foreign_codex = insert_codex(&db, &foreign_project, "Foreign");
        let foreign_scene = insert_scene(&db, &foreign_project);

        let mut primary = empty_create(&local_project, "foreign primary");
        primary.primary_codex_id = Some(foreign_codex.clone());
        let error =
            agent_event_create_impl(&db, primary).expect_err("foreign primary must be rejected");
        assert!(error.to_string().contains("not found in project"));

        let mut location = empty_create(&local_project, "foreign location");
        location.location_codex_id = Some(foreign_codex);
        let error =
            agent_event_create_impl(&db, location).expect_err("foreign location must be rejected");
        assert!(error.to_string().contains("not found in project"));

        let mut reveal = empty_create(&local_project, "foreign reveal");
        reveal.reveal_scene_id = Some(foreign_scene);
        let error =
            agent_event_create_impl(&db, reveal).expect_err("foreign reveal must be rejected");
        assert!(error.to_string().contains("not found in project"));

        db.with_conn(|conn| {
            let events: i64 = conn.query_row(
                "SELECT COUNT(*) FROM events WHERE project_id = ?1",
                rusqlite::params![local_project],
                |row| row.get(0),
            )?;
            let journals: i64 =
                conn.query_row("SELECT COUNT(*) FROM undo_journal", [], |row| row.get(0))?;
            let changes: i64 =
                conn.query_row("SELECT COUNT(*) FROM change_events", [], |row| row.get(0))?;
            assert_eq!(events, 0, "invalid creates must not leave an event row");
            assert_eq!(journals, 0, "invalid creates must not leave a journal row");
            assert_eq!(changes, 0, "invalid creates must not emit a change event");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn event_create_allows_same_project_and_null_scalar_references() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex = insert_codex(&db, &project_id, "Local");
        let scene = insert_scene(&db, &project_id);

        let mut local = empty_create(&project_id, "local references");
        local.primary_codex_id = Some(codex.clone());
        local.location_codex_id = Some(codex.clone());
        local.reveal_scene_id = Some(scene.clone());
        let local_result = agent_event_create_impl(&db, local).expect("local references");
        let local_id = local_result["entityId"].as_str().expect("entityId");
        assert_eq!(
            event_scalar_references(&db, local_id),
            (Some(codex.clone()), Some(codex), Some(scene))
        );

        let null_result =
            agent_event_create_impl(&db, empty_create(&project_id, "null references"))
                .expect("null references");
        let null_id = null_result["entityId"].as_str().expect("entityId");
        assert_eq!(event_scalar_references(&db, null_id), (None, None, None));
    }

    #[test]
    fn event_update_rejects_cross_project_scalar_references_atomically() {
        let db = test_db();
        let local_project = insert_project(&db);
        let foreign_project = insert_project(&db);
        let local_codex = insert_codex(&db, &local_project, "Local");
        let foreign_codex = insert_codex(&db, &foreign_project, "Foreign");
        let local_scene = insert_scene(&db, &local_project);
        let foreign_scene = insert_scene(&db, &foreign_project);
        let (event_id, _) = create_event(&db, &local_project, "unchanged", vec![], vec![]);

        let journals_before = scalar_count(
            &db,
            "SELECT COUNT(*) FROM undo_journal WHERE entity_id = ?1",
            &event_id,
            None,
        );
        let changes_before = scalar_count(
            &db,
            "SELECT COUNT(*) FROM change_events WHERE entity_id = ?1",
            &event_id,
            None,
        );

        let mut primary = empty_update(&local_project, &event_id);
        primary.base_version = 1;
        primary.title = Some("invalid primary".to_string());
        primary.primary_codex_id = Some(foreign_codex.clone());
        let error =
            agent_event_update_impl(&db, primary).expect_err("foreign primary must be rejected");
        assert!(error.to_string().contains("not found in project"));

        let mut location = empty_update(&local_project, &event_id);
        location.base_version = 1;
        location.title = Some("invalid location".to_string());
        location.location_codex_id = Some(foreign_codex);
        let error =
            agent_event_update_impl(&db, location).expect_err("foreign location must be rejected");
        assert!(error.to_string().contains("not found in project"));

        let mut reveal = empty_update(&local_project, &event_id);
        reveal.base_version = 1;
        reveal.title = Some("invalid reveal".to_string());
        reveal.reveal_scene_id = Some(foreign_scene);
        let error =
            agent_event_update_impl(&db, reveal).expect_err("foreign reveal must be rejected");
        assert!(error.to_string().contains("not found in project"));

        assert_eq!(event_title(&db, &event_id).as_deref(), Some("unchanged"));
        assert_eq!(event_version(&db, &event_id), 1);
        assert_eq!(event_scalar_references(&db, &event_id), (None, None, None));
        assert_eq!(
            scalar_count(
                &db,
                "SELECT COUNT(*) FROM undo_journal WHERE entity_id = ?1",
                &event_id,
                None,
            ),
            journals_before
        );
        assert_eq!(
            scalar_count(
                &db,
                "SELECT COUNT(*) FROM change_events WHERE entity_id = ?1",
                &event_id,
                None,
            ),
            changes_before
        );

        let mut local = empty_update(&local_project, &event_id);
        local.base_version = 1;
        local.primary_codex_id = Some(local_codex.clone());
        local.location_codex_id = Some(local_codex.clone());
        local.reveal_scene_id = Some(local_scene.clone());
        let local_result = agent_event_update_impl(&db, local).expect("local references");
        assert_eq!(local_result["version"], 2);
        assert_eq!(
            event_scalar_references(&db, &event_id),
            (
                Some(local_codex.clone()),
                Some(local_codex),
                Some(local_scene)
            )
        );

        let mut clear = empty_update(&local_project, &event_id);
        clear.base_version = 2;
        clear.primary_codex_id = Some(String::new());
        clear.location_codex_id = Some(String::new());
        clear.reveal_scene_id = Some(String::new());
        let clear_result = agent_event_update_impl(&db, clear).expect("clear references");
        assert_eq!(clear_result["version"], 3);
        assert_eq!(event_scalar_references(&db, &event_id), (None, None, None));
    }

    #[test]
    fn event_update_end_granularity_none_clears_end_time() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "interval", vec![], vec![]);
        // 期間化: start/end に値を入れる。
        let mut mk = empty_update(&project_id, &event_id);
        mk.start_time = Some(100);
        mk.start_granularity = Some("day".to_string());
        mk.end_time = Some(160);
        mk.end_granularity = Some("day".to_string());
        agent_event_update_impl(&db, mk).unwrap();
        assert_eq!(event_end(&db, &event_id), Some(160));
        // 「点にする」: UI と同じく end_time:null(=None) ＋ end_granularity:"none"。
        // Option<i64> では null と未指定を区別できないが、粒度 none をシグナルに end_time を
        // クリアする（期間→点が永続し、点へ変更後に期間へ戻らない）。
        let mut pt = empty_update(&project_id, &event_id);
        pt.base_version = 2;
        pt.end_time = None;
        pt.end_granularity = Some("none".to_string());
        agent_event_update_impl(&db, pt).unwrap();
        assert_eq!(event_end(&db, &event_id), None);
    }

    fn set_role(db: &Database, event_id: &str, codex_id: &str, role: &str) {
        db.execute(
            "UPDATE event_participants SET role = ? WHERE event_id = ? AND codex_entry_id = ?",
            &[
                Value::String(role.to_string()),
                Value::String(event_id.to_string()),
                Value::String(codex_id.to_string()),
            ],
            "run",
        )
        .expect("set role");
    }

    // ---- Round-trip tests -------------------------------------------------

    #[test]
    fn event_create_undo_redo_round_trip() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex_id = insert_codex(&db, &project_id, "Alice");
        let scene_id = insert_scene(&db, &project_id);

        let (event_id, journal_id) = create_event(
            &db,
            &project_id,
            "戦い",
            vec![codex_id.clone()],
            vec![scene_id.clone()],
        );
        assert_eq!(event_count(&db, &event_id), 1);
        assert_eq!(event_version(&db, &event_id), 1);
        assert_eq!(participant_count(&db, &event_id), 1);
        assert_eq!(scene_link_count(&db, &event_id), 1);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        assert_eq!(event_count(&db, &event_id), 0, "undo create deletes event");
        assert_eq!(
            participant_count(&db, &event_id),
            0,
            "cascade clears participants"
        );
        assert_eq!(
            scene_link_count(&db, &event_id),
            0,
            "cascade clears scene links"
        );

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo")).unwrap();
        assert_eq!(event_count(&db, &event_id), 1, "redo recreates event");
        assert_eq!(
            event_version(&db, &event_id),
            2,
            "redo create must not reuse the pre-undo version"
        );
        assert_eq!(participant_count(&db, &event_id), 1);
        assert_eq!(scene_link_count(&db, &event_id), 1);

        let mut stale = empty_update(&project_id, &event_id);
        stale.base_version = 1;
        stale.title = Some("stale editor".to_string());
        assert!(
            agent_event_update_impl(&db, stale).is_err(),
            "a pre-undo editor token must not pass after redo create"
        );

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo")).unwrap();
        assert_eq!(
            event_version(&db, &event_id),
            3,
            "repeated create replay must remain monotonic"
        );
    }

    #[test]
    fn event_delete_undo_restores_full_cascade() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex_a = insert_codex(&db, &project_id, "A");
        let scene_id = insert_scene(&db, &project_id);

        let (main_id, _) = create_event(
            &db,
            &project_id,
            "main",
            vec![codex_a.clone()],
            vec![scene_id.clone()],
        );
        let (other_id, _) = create_event(&db, &project_id, "other", vec![], vec![]);
        set_role(&db, &main_id, &codex_a, "hero");

        agent_event_relation_mutate_impl(
            &db,
            relation_payload(&project_id, &main_id, &other_id),
            true,
        )
        .unwrap();
        agent_event_relation_mutate_impl(
            &db,
            relation_payload(&project_id, &other_id, &main_id),
            true,
        )
        .unwrap();
        assert_eq!(relation_count(&db, &main_id, &other_id), 1);
        assert_eq!(relation_count(&db, &other_id, &main_id), 1);

        let del = agent_event_delete_impl(
            &db,
            AgentEventIdPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: main_id.clone(),
                base_version: 1,
            },
        )
        .unwrap();
        let journal_id = del["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(
            latest_change_payload(&db, "event.delete")["relatedEventIds"],
            json!([other_id.clone()]),
            "delete notification must name relation counterparts"
        );

        assert_eq!(event_count(&db, &main_id), 0);
        assert_eq!(event_count(&db, &other_id), 1, "sibling event survives");
        assert_eq!(participant_count(&db, &main_id), 0);
        assert_eq!(scene_link_count(&db, &main_id), 0);
        assert_eq!(relation_count(&db, &main_id, &other_id), 0);
        assert_eq!(relation_count(&db, &other_id, &main_id), 0);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        assert_eq!(
            latest_change_payload(&db, "event.create")["relatedEventIds"],
            json!([other_id.clone()]),
            "undo delete notification must name restored relation counterparts"
        );
        assert_eq!(event_count(&db, &main_id), 1, "undo delete restores event");
        assert_eq!(participant_count(&db, &main_id), 1);
        assert_eq!(
            participant_role(&db, &main_id, &codex_a),
            Some("hero".to_string()),
            "participant role restored from cascade snapshot"
        );
        assert_eq!(scene_link_count(&db, &main_id), 1);
        assert_eq!(
            relation_count(&db, &main_id, &other_id),
            1,
            "asCause relation restored"
        );
        assert_eq!(
            relation_count(&db, &other_id, &main_id),
            1,
            "asEffect relation restored"
        );

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo")).unwrap();
        assert_eq!(
            latest_change_payload(&db, "event.delete")["relatedEventIds"],
            json!([other_id.clone()]),
            "redo delete notification must name cascaded relation counterparts"
        );
        assert_eq!(event_count(&db, &main_id), 0, "redo delete removes again");
        assert_eq!(relation_count(&db, &main_id, &other_id), 0);
        assert_eq!(relation_count(&db, &other_id, &main_id), 0);
    }

    #[test]
    fn event_delete_undo_redo_uses_fresh_versions_and_rejects_stale_editor() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "tracked", vec![], vec![]);
        let deleted = agent_event_delete_impl(
            &db,
            AgentEventIdPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: event_id.clone(),
                base_version: 1,
            },
        )
        .expect("delete event");
        let journal_id = deleted["undoJournalId"]
            .as_str()
            .expect("undoJournalId")
            .to_string();

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect("undo delete");
        assert_eq!(
            event_version(&db, &event_id),
            2,
            "undo delete must restore with a fresh version"
        );
        let mut stale = empty_update(&project_id, &event_id);
        stale.base_version = 1;
        stale.title = Some("stale editor".to_string());
        assert!(
            agent_event_update_impl(&db, stale).is_err(),
            "a pre-delete editor token must not pass after undo delete"
        );

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo"))
            .expect("redo delete");
        assert_eq!(event_count(&db, &event_id), 0);
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect("second undo delete");
        assert_eq!(
            event_version(&db, &event_id),
            3,
            "repeated delete replay must remain monotonic"
        );
    }

    #[test]
    fn stacked_event_update_and_delete_replay_keep_the_journal_chain_connected() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "seed", vec![], vec![]);
        let mut update = empty_update(&project_id, &event_id);
        update.base_version = 1;
        update.title = Some("edited".to_string());
        let updated = agent_event_update_impl(&db, update).expect("update event");
        let update_journal = updated["undoJournalId"]
            .as_str()
            .expect("update undoJournalId")
            .to_string();
        let deleted = agent_event_delete_impl(
            &db,
            AgentEventIdPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: event_id.clone(),
                base_version: 2,
            },
        )
        .expect("delete event");
        let delete_journal = deleted["undoJournalId"]
            .as_str()
            .expect("delete undoJournalId")
            .to_string();

        agent_undo_journal_impl(&db, undo_payload(&project_id, &delete_journal, "undo"))
            .expect("undo delete");
        assert_eq!(event_version(&db, &event_id), 3);
        agent_undo_journal_impl(&db, undo_payload(&project_id, &update_journal, "undo"))
            .expect("undo update before delete");
        assert_eq!(event_version(&db, &event_id), 4);
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("seed"));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &update_journal, "redo"))
            .expect("redo update before delete");
        assert_eq!(event_version(&db, &event_id), 5);
        agent_undo_journal_impl(&db, undo_payload(&project_id, &delete_journal, "redo"))
            .expect("redo delete after replayed update");
        assert_eq!(event_count(&db, &event_id), 0);
    }

    #[test]
    fn event_delete_undo_rejects_recreated_id_non_destructively() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "tracked", vec![], vec![]);

        let deleted = agent_event_delete_impl(
            &db,
            AgentEventIdPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: event_id.clone(),
                base_version: 1,
            },
        )
        .expect("delete event");
        let journal_id = deleted["undoJournalId"]
            .as_str()
            .expect("undoJournalId")
            .to_string();

        db.execute(
            "INSERT INTO events (id, project_id, title, version) VALUES (?, ?, ?, 7)",
            &[
                Value::String(event_id.clone()),
                Value::String(project_id.clone()),
                Value::String("external".to_string()),
            ],
            "run",
        )
        .expect("recreate event externally");

        let error = agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect_err("stale delete undo");
        assert!(error.to_string().contains("version conflict"));
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("external"));
        assert_eq!(event_version(&db, &event_id), 7);
    }

    #[test]
    fn event_delete_rejects_stale_base_without_journal_or_change_event() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "seed", vec![], vec![]);

        let mut update = empty_update(&project_id, &event_id);
        update.base_version = 1;
        update.title = Some("fresh".to_string());
        agent_event_update_impl(&db, update).expect("fresh update");

        let error = agent_event_delete_impl(
            &db,
            AgentEventIdPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: event_id.clone(),
                base_version: 1,
            },
        )
        .expect_err("stale delete");
        assert!(error.to_string().contains("version conflict"));
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("fresh"));
        assert_eq!(event_version(&db, &event_id), 2);

        let delete_journals = db
            .execute(
                "SELECT COUNT(*) AS n FROM undo_journal
                 WHERE entity_id = ? AND op_kind = 'delete'",
                &[Value::String(event_id.clone())],
                "all",
            )
            .expect("journal count");
        assert_eq!(delete_journals[0]["n"], Value::Number(0.into()));
        let delete_events = db
            .execute(
                "SELECT COUNT(*) AS n FROM change_events
                 WHERE entity_id = ? AND op_type = 'event.delete'",
                &[Value::String(event_id)],
                "all",
            )
            .expect("change event count");
        assert_eq!(delete_events[0]["n"], Value::Number(0.into()));
    }

    #[test]
    fn event_update_undo_restores_old_values() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "seed", vec![], vec![]);

        let mut p1 = empty_update(&project_id, &event_id);
        p1.title = Some("old".to_string());
        p1.start_time = Some(100);
        p1.start_granularity = Some("day".to_string());
        agent_event_update_impl(&db, p1).unwrap();

        let mut p2 = empty_update(&project_id, &event_id);
        p2.base_version = 2;
        p2.title = Some("new".to_string());
        p2.start_time = Some(200);
        let res = agent_event_update_impl(&db, p2).unwrap();
        let journal_id = res["undoJournalId"].as_str().unwrap().to_string();

        assert_eq!(event_title(&db, &event_id), Some("new".to_string()));
        assert_eq!(event_start(&db, &event_id), Some(200));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        assert_eq!(event_title(&db, &event_id), Some("old".to_string()));
        assert_eq!(event_start(&db, &event_id), Some(100));
        assert_eq!(
            event_version(&db, &event_id),
            4,
            "undo must allocate a fresh version instead of restoring version 2"
        );

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo")).unwrap();
        assert_eq!(event_title(&db, &event_id), Some("new".to_string()));
        assert_eq!(event_start(&db, &event_id), Some(200));
        assert_eq!(
            event_version(&db, &event_id),
            5,
            "redo must allocate another fresh version instead of restoring version 3"
        );

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        assert_eq!(event_title(&db, &event_id), Some("old".to_string()));
        assert_eq!(
            event_version(&db, &event_id),
            6,
            "repeated replay must remain monotonic"
        );
    }

    #[test]
    fn stacked_event_field_and_participant_replay_share_monotonic_state_tokens() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex_a = insert_codex(&db, &project_id, "A");
        let codex_b = insert_codex(&db, &project_id, "B");
        let (event_id, _) = create_event(&db, &project_id, "seed", vec![codex_a.clone()], vec![]);

        let mut field_update = empty_update(&project_id, &event_id);
        field_update.base_version = 1;
        field_update.title = Some("edited".to_string());
        let field_result =
            agent_event_update_impl(&db, field_update).expect("field update succeeds");
        let field_journal = field_result["undoJournalId"]
            .as_str()
            .expect("field undoJournalId")
            .to_string();

        let participants_result = agent_event_set_participants_impl(
            &db,
            AgentEventParticipantsPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: event_id.clone(),
                base_version: 2,
                codex_entry_ids: vec![codex_b.clone()],
            },
        )
        .expect("participant update succeeds");
        let participants_journal = participants_result["undoJournalId"]
            .as_str()
            .expect("participants undoJournalId")
            .to_string();
        assert_eq!(event_version(&db, &event_id), 3);

        agent_undo_journal_impl(
            &db,
            undo_payload(&project_id, &participants_journal, "undo"),
        )
        .expect("undo participants");
        assert_eq!(event_version(&db, &event_id), 4);
        assert!(participant_has(&db, &event_id, &codex_a));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &field_journal, "undo"))
            .expect("undo preceding field update");
        assert_eq!(event_version(&db, &event_id), 5);
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("seed"));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &field_journal, "redo"))
            .expect("redo field update");
        assert_eq!(event_version(&db, &event_id), 6);
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("edited"));

        agent_undo_journal_impl(
            &db,
            undo_payload(&project_id, &participants_journal, "redo"),
        )
        .expect("redo participants");
        assert_eq!(event_version(&db, &event_id), 7);
        assert!(participant_has(&db, &event_id, &codex_b));
        assert!(!participant_has(&db, &event_id, &codex_a));
    }

    #[test]
    fn event_update_undo_rejects_version_drift_non_destructively() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "seed", vec![], vec![]);

        let mut update = empty_update(&project_id, &event_id);
        update.base_version = 1;
        update.title = Some("tracked".to_string());
        let result = agent_event_update_impl(&db, update).expect("tracked update");
        let journal_id = result["undoJournalId"].as_str().unwrap().to_string();

        db.execute(
            "UPDATE events SET title = ?, version = 3 WHERE id = ?",
            &[
                Value::String("external".to_string()),
                Value::String(event_id.clone()),
            ],
            "run",
        )
        .expect("external write");

        let error = agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect_err("stale undo");
        assert!(error.to_string().contains("version 2 conflict"));
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("external"));
        assert_eq!(event_version(&db, &event_id), 3);
    }

    #[test]
    fn event_update_undo_preserves_later_scene_links_and_relations() {
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_id = insert_scene(&db, &project_id);
        let (event_id, _) = create_event(&db, &project_id, "seed", vec![], vec![]);
        let (other_id, _) = create_event(&db, &project_id, "other", vec![], vec![]);

        let mut update = empty_update(&project_id, &event_id);
        update.base_version = 1;
        update.title = Some("tracked".to_string());
        let updated = agent_event_update_impl(&db, update).expect("tracked update");
        let journal_id = updated["undoJournalId"]
            .as_str()
            .expect("undoJournalId")
            .to_string();

        let linked = agent_scene_event_mutate_impl(
            &db,
            scene_payload(&project_id, &scene_id, &event_id),
            true,
        )
        .expect("link scene");
        let related = agent_event_relation_mutate_impl(
            &db,
            relation_payload(&project_id, &event_id, &other_id),
            true,
        )
        .expect("add relation");
        assert_eq!(linked["version"], 2);
        assert_eq!(related["version"], 2);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect("undo row update");

        assert_eq!(event_title(&db, &event_id).as_deref(), Some("seed"));
        assert_eq!(event_version(&db, &event_id), 3);
        assert_eq!(
            scene_link_count(&db, &event_id),
            1,
            "row update undo must not remove a later scene link"
        );
        assert_eq!(
            relation_count(&db, &event_id, &other_id),
            1,
            "row update undo must not remove a later relation"
        );
    }

    #[test]
    fn legacy_event_update_journal_modernizes_monotonically_and_rejects_drift() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "before", vec![], vec![]);
        db.execute(
            "UPDATE events SET version = 0 WHERE id = ?",
            &[Value::String(event_id.clone())],
            "run",
        )
        .expect("simulate migrated legacy event");
        let before = legacy_event_snapshot(&db, &event_id);

        db.execute(
            "UPDATE events SET title = 'legacy-after' WHERE id = ?",
            &[Value::String(event_id.clone())],
            "run",
        )
        .expect("simulate legacy update");
        let after = legacy_event_snapshot(&db, &event_id);
        let journal_id = insert_legacy_event_journal(
            &db,
            &project_id,
            &event_id,
            "update",
            Some(&before),
            Some(&after),
        );

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect("legacy undo");
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("before"));
        assert_eq!(event_version(&db, &event_id), 1);
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo"))
            .expect("legacy redo");
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("legacy-after"));
        assert_eq!(event_version(&db, &event_id), 2);

        let mut v2_update = empty_update(&project_id, &event_id);
        v2_update.base_version = 2;
        v2_update.title = Some("fresh-v2".to_string());
        agent_event_update_impl(&db, v2_update).expect("v2 update");

        let error = agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect_err("legacy replay after v2 drift");
        assert!(error.to_string().contains("version 2 conflict"));
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("fresh-v2"));
        assert_eq!(event_version(&db, &event_id), 3);
    }

    #[test]
    fn stacked_legacy_event_field_and_participant_replay_modernizes_as_a_chain() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex_a = insert_codex(&db, &project_id, "A");
        let codex_b = insert_codex(&db, &project_id, "B");
        let event_id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO events (id, project_id, title, version) VALUES (?, ?, 'seed', 0)",
            &[
                Value::String(event_id.clone()),
                Value::String(project_id.clone()),
            ],
            "run",
        )
        .expect("insert legacy event");
        db.execute(
            "INSERT INTO event_participants (event_id, codex_entry_id) VALUES (?, ?)",
            &[
                Value::String(event_id.clone()),
                Value::String(codex_a.clone()),
            ],
            "run",
        )
        .expect("insert legacy participant");

        let before_field = legacy_event_snapshot(&db, &event_id);
        db.execute(
            "UPDATE events SET title = 'edited' WHERE id = ?",
            &[Value::String(event_id.clone())],
            "run",
        )
        .expect("simulate legacy field update");
        let after_field = legacy_event_snapshot(&db, &event_id);
        let field_journal = insert_legacy_event_journal(
            &db,
            &project_id,
            &event_id,
            "update",
            Some(&before_field),
            Some(&after_field),
        );

        let before_participants = legacy_participants_snapshot(&db, &event_id);
        db.execute(
            "DELETE FROM event_participants WHERE event_id = ?",
            &[Value::String(event_id.clone())],
            "run",
        )
        .expect("clear legacy participants");
        db.execute(
            "INSERT INTO event_participants (event_id, codex_entry_id) VALUES (?, ?)",
            &[
                Value::String(event_id.clone()),
                Value::String(codex_b.clone()),
            ],
            "run",
        )
        .expect("replace legacy participant");
        let after_participants = legacy_participants_snapshot(&db, &event_id);
        let participants_journal = insert_legacy_event_journal(
            &db,
            &project_id,
            &event_id,
            "update",
            Some(&before_participants),
            Some(&after_participants),
        );

        agent_undo_journal_impl(
            &db,
            undo_payload(&project_id, &participants_journal, "undo"),
        )
        .expect("undo legacy participants");
        assert_eq!(event_version(&db, &event_id), 1);
        assert!(participant_has(&db, &event_id, &codex_a));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &field_journal, "undo"))
            .expect("undo preceding legacy field update");
        assert_eq!(event_version(&db, &event_id), 2);
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("seed"));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &field_journal, "redo"))
            .expect("redo legacy field update");
        assert_eq!(event_version(&db, &event_id), 3);
        agent_undo_journal_impl(
            &db,
            undo_payload(&project_id, &participants_journal, "redo"),
        )
        .expect("redo legacy participants");
        assert_eq!(event_version(&db, &event_id), 4);
        assert!(participant_has(&db, &event_id, &codex_b));
    }

    #[test]
    fn legacy_event_create_replay_allocates_fresh_versions() {
        let db = test_db();
        let project_id = insert_project(&db);
        let event_id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO events (id, project_id, title, version)
             VALUES (?, ?, 'legacy create', 0)",
            &[
                Value::String(event_id.clone()),
                Value::String(project_id.clone()),
            ],
            "run",
        )
        .expect("insert legacy event");
        let after = legacy_event_snapshot(&db, &event_id);
        let journal_id =
            insert_legacy_event_journal(&db, &project_id, &event_id, "create", None, Some(&after));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect("undo legacy create");
        assert_eq!(event_count(&db, &event_id), 0);
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo"))
            .expect("redo legacy create");
        assert_eq!(event_version(&db, &event_id), 1);
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect("second undo legacy create");
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo"))
            .expect("second redo legacy create");
        assert_eq!(event_version(&db, &event_id), 2);
    }

    #[test]
    fn legacy_event_delete_replay_allocates_fresh_versions() {
        let db = test_db();
        let project_id = insert_project(&db);
        let event_id = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO events (id, project_id, title, version)
             VALUES (?, ?, 'legacy delete', 0)",
            &[
                Value::String(event_id.clone()),
                Value::String(project_id.clone()),
            ],
            "run",
        )
        .expect("insert legacy event");
        let before = legacy_event_snapshot(&db, &event_id);
        db.execute(
            "DELETE FROM events WHERE id = ?",
            &[Value::String(event_id.clone())],
            "run",
        )
        .expect("simulate legacy delete");
        let journal_id =
            insert_legacy_event_journal(&db, &project_id, &event_id, "delete", Some(&before), None);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect("undo legacy delete");
        assert_eq!(event_version(&db, &event_id), 1);
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo"))
            .expect("redo legacy delete");
        assert_eq!(event_count(&db, &event_id), 0);
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect("second undo legacy delete");
        assert_eq!(event_version(&db, &event_id), 2);
    }

    #[test]
    fn legacy_event_delete_undo_rejects_cross_project_id_reuse() {
        let db = test_db();
        let project_id = insert_project(&db);
        let other_project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "deleted", vec![], vec![]);
        db.execute(
            "UPDATE events SET version = 0 WHERE id = ?",
            &[Value::String(event_id.clone())],
            "run",
        )
        .expect("simulate migrated legacy event");
        let before = legacy_event_snapshot(&db, &event_id);
        db.execute(
            "DELETE FROM events WHERE id = ?",
            &[Value::String(event_id.clone())],
            "run",
        )
        .expect("simulate legacy delete");
        let journal_id =
            insert_legacy_event_journal(&db, &project_id, &event_id, "delete", Some(&before), None);

        db.execute(
            "INSERT INTO events (id, project_id, title, version) VALUES (?, ?, 'external', 0)",
            &[
                Value::String(event_id.clone()),
                Value::String(other_project_id),
            ],
            "run",
        )
        .expect("reuse id in another project");

        let error = agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect_err("legacy delete undo must not overwrite reused id");
        assert!(error.to_string().contains("version conflict"));
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("external"));
    }

    #[test]
    fn event_set_participants_undo_restores_set_and_roles() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex_a = insert_codex(&db, &project_id, "A");
        let codex_b = insert_codex(&db, &project_id, "B");
        let codex_c = insert_codex(&db, &project_id, "C");
        let (event_id, _) = create_event(&db, &project_id, "e", vec![codex_a.clone()], vec![]);
        set_role(&db, &event_id, &codex_a, "hero");

        let res = agent_event_set_participants_impl(
            &db,
            AgentEventParticipantsPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: event_id.clone(),
                base_version: 1,
                codex_entry_ids: vec![codex_b.clone(), codex_c.clone()],
            },
        )
        .unwrap();
        let journal_id = res["undoJournalId"].as_str().unwrap().to_string();

        assert_eq!(participant_count(&db, &event_id), 2);
        assert!(participant_has(&db, &event_id, &codex_b));
        assert!(participant_has(&db, &event_id, &codex_c));
        assert!(!participant_has(&db, &event_id, &codex_a));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        assert_eq!(participant_count(&db, &event_id), 1);
        assert!(participant_has(&db, &event_id, &codex_a));
        assert_eq!(
            participant_role(&db, &event_id, &codex_a),
            Some("hero".to_string()),
            "old role restored"
        );

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo")).unwrap();
        assert_eq!(participant_count(&db, &event_id), 2);
        assert!(participant_has(&db, &event_id, &codex_b));
        assert!(!participant_has(&db, &event_id, &codex_a));
    }

    #[test]
    fn batched_inserts_chunk_past_100_rows() {
        // Multi-row INSERT batching must stay correct across the
        // INSERT_CHUNK_ROWS (=100) boundary on every write path.
        let db = test_db();
        let project_id = insert_project(&db);
        let codex_ids: Vec<String> = (0..120)
            .map(|i| insert_codex(&db, &project_id, &format!("C{i}")))
            .collect();
        let scene_ids: Vec<String> = (0..120).map(|_| insert_scene(&db, &project_id)).collect();

        // create path (participants + scene links).
        let (event_id, journal_id) = create_event(
            &db,
            &project_id,
            "big",
            codex_ids.clone(),
            scene_ids.clone(),
        );
        assert_eq!(participant_count(&db, &event_id), 120);
        assert_eq!(scene_link_count(&db, &event_id), 120);

        // undo → redo (composite snapshot restore path).
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo")).unwrap();
        assert_eq!(participant_count(&db, &event_id), 0);
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo")).unwrap();
        assert_eq!(participant_count(&db, &event_id), 120);
        assert_eq!(scene_link_count(&db, &event_id), 120);

        // set_participants → undo (restore_event_participants_snapshot path).
        let res = agent_event_set_participants_impl(
            &db,
            AgentEventParticipantsPayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: event_id.clone(),
                base_version: 2,
                codex_entry_ids: codex_ids[..3].to_vec(),
            },
        )
        .unwrap();
        let set_journal = res["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(participant_count(&db, &event_id), 3);
        agent_undo_journal_impl(&db, undo_payload(&project_id, &set_journal, "undo")).unwrap();
        assert_eq!(
            participant_count(&db, &event_id),
            120,
            "chunked participants snapshot fully restored"
        );
    }

    #[test]
    fn event_create_rejects_cross_project_participant_and_writes_nothing() {
        let db = test_db();
        let p1 = insert_project(&db);
        let p2 = insert_project(&db);
        // A codex entry that lives in a *different* project.
        let foreign_codex = insert_codex(&db, &p2, "Foreign");

        // Attempt to create a P1 event whose participant belongs to P2.
        let res = agent_event_create_impl(
            &db,
            AgentEventCreatePayload {
                request_id: None,
                event_id: None,
                project_id: p1.clone(),
                session_id: "sess".to_string(),
                surface: None,
                title: Some("xproj".to_string()),
                note: None,
                detail: None,
                ordinal: None,
                primary_codex_id: None,
                lane_group: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                precision: None,
                kind: None,
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: Some(vec![foreign_codex.clone()]),
                scene_ids: None,
            },
        );

        assert!(res.is_err(), "cross-project participant must be rejected");
        // Transaction rolled back: no event row, no cross-project link, no
        // change-event side effects leaked.
        assert_eq!(
            scalar_count(
                &db,
                "SELECT COUNT(*) FROM events WHERE project_id = ?1",
                &p1,
                None
            ),
            0,
            "event row rolled back"
        );
        assert_eq!(
            scalar_count(
                &db,
                "SELECT COUNT(*) FROM event_participants WHERE codex_entry_id = ?1",
                &foreign_codex,
                None
            ),
            0,
            "no cross-project participant link written"
        );
        db.with_conn(|conn| {
            let changes: i64 =
                conn.query_row("SELECT COUNT(*) FROM change_events", [], |r| r.get(0))?;
            assert_eq!(changes, 0, "no change events leaked");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn event_create_rejects_cross_project_scene_link() {
        let db = test_db();
        let p1 = insert_project(&db);
        let p2 = insert_project(&db);
        let foreign_scene = insert_scene(&db, &p2);

        let res = agent_event_create_impl(
            &db,
            AgentEventCreatePayload {
                request_id: None,
                event_id: None,
                project_id: p1.clone(),
                session_id: "sess".to_string(),
                surface: None,
                title: Some("xproj-scene".to_string()),
                note: None,
                detail: None,
                ordinal: None,
                primary_codex_id: None,
                lane_group: None,
                location_codex_id: None,
                start_time: None,
                end_time: None,
                start_minute: None,
                end_minute: None,
                start_granularity: None,
                end_granularity: None,
                precision: None,
                kind: None,
                secret: None,
                reveal_scene_id: None,
                participant_codex_ids: None,
                scene_ids: Some(vec![foreign_scene.clone()]),
            },
        );

        assert!(res.is_err(), "cross-project scene link must be rejected");
        assert_eq!(
            scalar_count(
                &db,
                "SELECT COUNT(*) FROM events WHERE project_id = ?1",
                &p1,
                None
            ),
            0,
            "event row rolled back"
        );
        assert_eq!(
            scalar_count(
                &db,
                "SELECT COUNT(*) FROM scene_events WHERE scene_id = ?1",
                &foreign_scene,
                None
            ),
            0,
            "no cross-project scene link written"
        );
    }

    #[test]
    fn set_participants_rejects_cross_project_codex_and_preserves_existing() {
        let db = test_db();
        let p1 = insert_project(&db);
        let p2 = insert_project(&db);
        let local = insert_codex(&db, &p1, "Local");
        let foreign = insert_codex(&db, &p2, "Foreign");
        let (event_id, _) = create_event(&db, &p1, "e", vec![local.clone()], vec![]);

        // Replace the participant set with one containing a foreign-project codex.
        let res = agent_event_set_participants_impl(
            &db,
            AgentEventParticipantsPayload {
                project_id: p1.clone(),
                session_id: "sess".to_string(),
                surface: None,
                event_id: event_id.clone(),
                base_version: 1,
                codex_entry_ids: vec![foreign.clone()],
            },
        );

        assert!(res.is_err(), "cross-project participant must be rejected");
        // Rollback preserves the pre-existing valid participant — the DELETE that
        // precedes the re-insert is inside the same rolled-back transaction.
        assert_eq!(
            participant_count(&db, &event_id),
            1,
            "existing set preserved on rollback"
        );
        assert!(participant_has(&db, &event_id, &local));
        assert!(!participant_has(&db, &event_id, &foreign));
    }

    #[test]
    fn scene_event_link_and_unlink_round_trip() {
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_id = insert_scene(&db, &project_id);
        let (event_id, _) = create_event(&db, &project_id, "e", vec![], vec![]);

        let res = agent_scene_event_mutate_impl(
            &db,
            scene_payload(&project_id, &scene_id, &event_id),
            true,
        )
        .unwrap();
        let link_journal = res["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(scene_link_count(&db, &event_id), 1);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &link_journal, "undo")).unwrap();
        assert_eq!(scene_link_count(&db, &event_id), 0, "undo link removes");
        agent_undo_journal_impl(&db, undo_payload(&project_id, &link_journal, "redo")).unwrap();
        assert_eq!(scene_link_count(&db, &event_id), 1, "redo link restores");

        // Now unlink and round-trip the unlink.
        let res2 = agent_scene_event_mutate_impl(
            &db,
            scene_payload(&project_id, &scene_id, &event_id),
            false,
        )
        .unwrap();
        let unlink_journal = res2["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(scene_link_count(&db, &event_id), 0);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &unlink_journal, "undo")).unwrap();
        assert_eq!(
            scene_link_count(&db, &event_id),
            1,
            "undo unlink restores link"
        );
        agent_undo_journal_impl(&db, undo_payload(&project_id, &unlink_journal, "redo")).unwrap();
        assert_eq!(
            scene_link_count(&db, &event_id),
            0,
            "redo unlink removes again"
        );
    }

    #[test]
    fn event_relation_add_and_remove_round_trip() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (e1, _) = create_event(&db, &project_id, "e1", vec![], vec![]);
        let (e2, _) = create_event(&db, &project_id, "e2", vec![], vec![]);

        let res =
            agent_event_relation_mutate_impl(&db, relation_payload(&project_id, &e1, &e2), true)
                .unwrap();
        let add_journal = res["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(relation_count(&db, &e1, &e2), 1);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &add_journal, "undo")).unwrap();
        assert_eq!(
            relation_count(&db, &e1, &e2),
            0,
            "undo add removes relation"
        );
        agent_undo_journal_impl(&db, undo_payload(&project_id, &add_journal, "redo")).unwrap();
        assert_eq!(
            relation_count(&db, &e1, &e2),
            1,
            "redo add restores relation"
        );

        let res2 =
            agent_event_relation_mutate_impl(&db, relation_payload(&project_id, &e1, &e2), false)
                .unwrap();
        let remove_journal = res2["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(relation_count(&db, &e1, &e2), 0);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &remove_journal, "undo")).unwrap();
        assert_eq!(
            relation_count(&db, &e1, &e2),
            1,
            "undo remove restores relation"
        );
        agent_undo_journal_impl(&db, undo_payload(&project_id, &remove_journal, "redo")).unwrap();
        assert_eq!(
            relation_count(&db, &e1, &e2),
            0,
            "redo remove removes again"
        );
    }

    #[test]
    fn event_writes_enforce_xproj_and_self_loop() {
        let db = test_db();
        let p1 = insert_project(&db);
        let p2 = insert_project(&db);
        let (event_p1, _) = create_event(&db, &p1, "p1-event", vec![], vec![]);
        let scene_p2 = insert_scene(&db, &p2);
        let (event_p2, _) = create_event(&db, &p2, "p2-event", vec![], vec![]);

        // Update claiming the wrong project: error, no mutation.
        let mut bad_update = empty_update(&p2, &event_p1);
        bad_update.title = Some("hacked".to_string());
        assert!(agent_event_update_impl(&db, bad_update).is_err());
        assert_eq!(event_title(&db, &event_p1), Some("p1-event".to_string()));

        // Scene link with a scene from another project: error, no link.
        let cross =
            agent_scene_event_mutate_impl(&db, scene_payload(&p1, &scene_p2, &event_p1), true);
        assert!(cross.is_err(), "cross-project scene link must fail");
        assert_eq!(scene_link_count(&db, &event_p1), 0);

        // Self-loop relation: forbidden.
        assert!(agent_event_relation_mutate_impl(
            &db,
            relation_payload(&p1, &event_p1, &event_p1),
            true
        )
        .is_err());

        // Relation whose effect lives in another project: error, no edge.
        assert!(agent_event_relation_mutate_impl(
            &db,
            relation_payload(&p1, &event_p1, &event_p2),
            true
        )
        .is_err());
        assert_eq!(relation_count(&db, &event_p1, &event_p2), 0);
    }

    #[test]
    fn replay_related_event_ids_collect_both_relation_endpoints() {
        let snapshot = json!({
            "relations": {
                "asCause": [{
                    "causeEventId": "cause",
                    "effectEventId": "effect",
                }],
                "asEffect": [{
                    "causeEventId": "cause",
                    "effectEventId": "effect",
                }],
            },
        });
        assert_eq!(
            event_snapshot_related_ids(&snapshot),
            vec!["cause".to_string(), "effect".to_string()]
        );
    }
}
