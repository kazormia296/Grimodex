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
use crate::narrative_extraction::change_feed::{
    append_canonical_and_narrative_change_in_tx, append_narrative_change_transaction_in_tx,
    event_from_undo_journal_row, narrative_snapshot_digest, require_replay_lineage_in_project,
    transaction_id_for_undo_journal, AppendNarrativeChangeTransactionInput,
    NarrativeChangeCauseKind, NarrativeChangeEventInput, NarrativeChangeOrigin,
};
use crate::undo_journal::{insert_undo_journal_in_tx, UndoJournalInsert};
use crate::{BatchStatement, Database};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorshipSpanInput {
    pub from_pos: i64,
    pub to_pos: i64,
    pub source: String,
    pub model: Option<String>,
    #[serde(default)]
    pub timestamp: Option<String>,
    pub chat_msg_id: Option<String>,
    pub trace_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodexCreatePayload {
    /// Stable identity of the logical request. This is deliberately separate
    /// from `entry_id`, which remains the domain entity identity.
    #[serde(default)]
    pub request_id: Option<String>,
    /// Domain-owned identity for the created row. The Native entrypoints reject
    /// a missing request id even when this entity id is present.
    #[serde(default)]
    pub entry_id: Option<String>,
    pub project_id: String,
    pub session_id: String,
    /// undo_journal に記録する書き込み元の表面。省略時は in-app-agent（AI）。
    /// UI 手動作成 (legacy api.ts 経路) は "manual" を明示送信する。
    #[serde(default)]
    pub surface: Option<String>,
    pub type_slug: String,
    pub name: String,
    pub summary: Option<String>,
    pub content: Option<String>,
    pub aliases: Option<String>,
    #[serde(default)]
    pub excluded_aliases: Option<String>,
    #[serde(default)]
    pub readings: Option<String>,
    #[serde(default)]
    pub tags_cache: Option<String>,
    pub parent_id: Option<String>,
    pub source_chat_message_id: Option<String>,
    pub model: Option<String>,
    pub chat_message_id: Option<String>,
    pub trace_id: Option<String>,
    pub authorship_spans: Vec<AuthorshipSpanInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodexUpdatePayload {
    pub project_id: String,
    pub session_id: String,
    /// undo_journal に記録する書き込み元の表面。省略時は in-app-agent（AI）。
    #[serde(default)]
    pub surface: Option<String>,
    pub entry_id: String,
    /// Client-observed version before this write (optimistic lock).
    pub base_version: i64,
    /// Human 経路のみ更新する type。AI 経路は type を書き換えない。
    #[serde(default)]
    pub type_slug: Option<String>,
    pub name: Option<String>,
    pub summary: Option<String>,
    pub content: Option<String>,
    pub aliases: Option<String>,
    /// set-if-present。空文字は NULL（除外語なし）に正規化する。
    #[serde(default)]
    pub excluded_aliases: Option<String>,
    /// set-if-present。空文字は NULL（読み情報なし）に正規化する。
    #[serde(default)]
    pub readings: Option<String>,
    /// set-if-present。空文字は NULL（タグなし）に正規化する。
    #[serde(default)]
    pub tags_cache: Option<String>,
    /// set-if-present。空文字は NULL（親なし=ルート）に正規化する。
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub context_mode: Option<String>,
    /// set-if-present。空文字は NULL（アイコンなし）に正規化する。
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub children_budget: Option<String>,
    /// set-if-present。空文字は NULL（メモなし）に正規化する。
    #[serde(default)]
    pub notes: Option<String>,
    pub model: Option<String>,
    pub chat_message_id: Option<String>,
    pub trace_id: Option<String>,
    pub authorship_spans: Option<Vec<AuthorshipSpanInput>>,
    /// Per-span lane for partial updates: "summary" | "content".
    pub authorship_span_lanes: Option<Vec<Option<String>>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCodexDeletePayload {
    pub project_id: String,
    pub session_id: String,
    /// undo_journal に記録する書き込み元の表面。省略時は in-app-agent（AI）。
    #[serde(default)]
    pub surface: Option<String>,
    pub entry_id: String,
    /// Client-observed version before this write (optimistic lock).
    pub base_version: i64,
}

/// Renderer-only identity carried alongside the long-lived Agent Codex DTOs.
///
/// The domain payload structs stay source-compatible with standalone MCP
/// callers, while Electron/N-API must deserialize and pass this context to the
/// strict renderer entry points below.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererMutationProvenance {
    pub request_id: String,
    pub trace_id: String,
    #[serde(default)]
    pub chat_message_id: Option<String>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    #[serde(default)]
    pub execution_id: Option<String>,
    #[serde(default)]
    pub main_owned_provenance_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererCanonicalWriteContext {
    pub request_id: String,
    pub event_uid: String,
    /// Main-owned authority identity. This is deliberately separate from the
    /// domain payload's session_id, which remains the renderer writer/feed
    /// correlation identity.
    #[serde(default)]
    pub authority_session_id: Option<String>,
    pub origin: NarrativeChangeOrigin,
    pub authority_route: String,
    pub caller: String,
    pub controls: Vec<String>,
    #[serde(default)]
    pub provenance: Option<RendererMutationProvenance>,
    #[serde(default)]
    pub writes_authority_protected_field: bool,
    #[serde(default)]
    pub original_transaction_id: Option<String>,
    #[serde(default)]
    pub undo_journal_id: Option<String>,
    /// Renderer Codex create/restore fields that are not part of the historic
    /// MCP-compatible AgentCodexCreatePayload.
    #[serde(default)]
    pub context_mode: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub children_budget: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    /// Audit payload computed before the renderer crosses the Native boundary.
    /// Native commits it as the one canonical Change Event in the same DB tx.
    #[serde(default)]
    pub canonical_payload: Option<Value>,
}

#[derive(Clone, Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentWriteResult {
    entity_id: String,
    version: i64,
    change_event_uid: String,
    undo_journal_id: String,
}

const EVENT_AUTHORITY_FIELDS: &[&str] = &[
    "/title",
    "/note",
    "/detail",
    "/ordinal",
    "/primaryCodexId",
    "/laneGroup",
    "/locationCodexId",
    "/startTime",
    "/endTime",
    "/startMinute",
    "/endMinute",
    "/startGranularity",
    "/endGranularity",
    "/precision",
    "/kind",
    "/secret",
    "/revealSceneId",
    "/participants",
    "/sceneIds",
    "/relations",
];

fn narrative_origin_for_surface(surface: Option<&str>) -> NarrativeChangeOrigin {
    match surface {
        Some("manual") => NarrativeChangeOrigin::Human,
        Some("import") => NarrativeChangeOrigin::Import,
        _ => NarrativeChangeOrigin::AiApply,
    }
}

const HUMAN_DIRECT_CONTROLS: &[&str] = &[
    "runtime-policy",
    "actor-context",
    "typed-writer",
    "occ",
    "change-event",
    "change-feed",
];
const INTERACTIVE_AGENT_CONTROLS: &[&str] = &[
    "knowledge-write-policy",
    "stable-request-id",
    "agent-provenance",
    "field-authority",
    "typed-writer",
    "occ",
    "undo-journal",
    "change-event",
    "change-feed",
];
const INTERPRETER_PROJECTION_CONTROLS: &[&str] = &[
    "proposal-revision",
    "decision",
    "prepared-commit",
    "application-id",
    "source-basis-occ",
    "field-authority",
    "typed-writer",
];
const IMPORT_APPLY_CONTROLS: &[&str] = &[
    "import-policy",
    "source-package-evidence",
    "typed-writer",
    "occ",
    "change-event",
    "change-feed",
];
const HISTORY_REPLAY_CONTROLS: &[&str] = &[
    "original-transaction",
    "journal-lineage",
    "typed-writer",
    "occ",
    "change-event",
    "change-feed",
];
const RESTORE_OR_MIGRATION_CONTROLS: &[&str] = &[
    "exclusive-system-operation",
    "semantic-epoch-event",
    "full-rebuild-marker",
];
const KNOWN_MUTATION_CONTROLS: &[&str] = &[
    "runtime-policy",
    "actor-context",
    "knowledge-write-policy",
    "stable-request-id",
    "agent-provenance",
    "typed-writer",
    "occ",
    "source-basis-occ",
    "field-authority",
    "proposal-revision",
    "decision",
    "prepared-commit",
    "application-id",
    "undo-journal",
    "journal-lineage",
    "original-transaction",
    "change-event",
    "change-feed",
    "import-policy",
    "source-package-evidence",
    "exclusive-system-operation",
    "semantic-epoch-event",
    "full-rebuild-marker",
];

fn allowed_callers_for_route(route: &str) -> Option<&'static [&'static str]> {
    match route {
        "human-direct" => Some(&["human-ui", "manual-wrapper", "typed-domain-api"]),
        "interactive-agent-command" => Some(&[
            "chat-tool-executor",
            "manual-wrapper",
            "registered-agent-surface",
        ]),
        "interpreter-projection" => Some(&[
            "interpreter",
            "reconciler",
            "proposal-review",
            "prepared-commit-runner",
        ]),
        "import-apply" => Some(&["import-session", "import-review"]),
        "history-replay" => Some(&["history-controller", "undo-redo-command"]),
        "restore-or-migration" => {
            Some(&["restore-controller", "migration-runner", "integrity-repair"])
        }
        _ => None,
    }
}

fn required_controls_for_route(route: &str) -> Option<&'static [&'static str]> {
    match route {
        "human-direct" => Some(HUMAN_DIRECT_CONTROLS),
        "interactive-agent-command" => Some(INTERACTIVE_AGENT_CONTROLS),
        "interpreter-projection" => Some(INTERPRETER_PROJECTION_CONTROLS),
        "import-apply" => Some(IMPORT_APPLY_CONTROLS),
        "history-replay" => Some(HISTORY_REPLAY_CONTROLS),
        "restore-or-migration" => Some(RESTORE_OR_MIGRATION_CONTROLS),
        _ => None,
    }
}

fn origin_allowed_for_route(route: &str, origin: NarrativeChangeOrigin) -> bool {
    match route {
        "human-direct" => origin == NarrativeChangeOrigin::Human,
        "interactive-agent-command" | "interpreter-projection" => {
            origin == NarrativeChangeOrigin::AiApply
        }
        "import-apply" => origin == NarrativeChangeOrigin::Import,
        "history-replay" => matches!(
            origin,
            NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
        ),
        "restore-or-migration" => matches!(
            origin,
            NarrativeChangeOrigin::Restore | NarrativeChangeOrigin::Migration
        ),
        _ => false,
    }
}

/// Validate the runtime route before any renderer-originated Native writer is
/// allowed to append an audit event. The caller allowlist is deliberately
/// exact; a versioned or otherwise unknown background caller must not inherit
/// a route by merely avoiding a blacklist entry.
pub fn validate_renderer_authority_context(
    context: &RendererCanonicalWriteContext,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        !context.request_id.trim().is_empty(),
        "requestId must not be empty"
    );
    anyhow::ensure!(
        !context.event_uid.trim().is_empty(),
        "eventUid must not be empty"
    );
    let allowed_callers = allowed_callers_for_route(&context.authority_route)
        .ok_or_else(|| anyhow::anyhow!("Unknown mutation authority route"))?;
    anyhow::ensure!(
        allowed_callers.contains(&context.caller.as_str()),
        "Forbidden caller '{}' for authority route '{}'",
        context.caller,
        context.authority_route
    );
    anyhow::ensure!(
        origin_allowed_for_route(&context.authority_route, context.origin),
        "Origin '{}' is not valid for authority route '{}'",
        context.origin.as_str(),
        context.authority_route
    );
    let required = required_controls_for_route(&context.authority_route)
        .ok_or_else(|| anyhow::anyhow!("Unknown mutation authority route"))?;
    for control in &context.controls {
        anyhow::ensure!(
            KNOWN_MUTATION_CONTROLS.contains(&control.as_str()),
            "Unknown mutation authority control '{}'",
            control
        );
    }
    for control in required {
        anyhow::ensure!(
            context.controls.iter().any(|value| value == control),
            "Missing required control '{}' for authority route '{}'",
            control,
            context.authority_route
        );
    }
    if context.authority_route == "interactive-agent-command" {
        anyhow::ensure!(
            context
                .controls
                .iter()
                .any(|value| value == "field-authority"),
            "Interactive agent mutation requires field-authority control"
        );
    }
    if context.authority_route == "interactive-agent-command" {
        let provenance = context
            .provenance
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Interactive agent command requires provenance"))?;
        anyhow::ensure!(
            !provenance.request_id.trim().is_empty(),
            "provenance requestId is required"
        );
        anyhow::ensure!(
            !provenance.trace_id.trim().is_empty(),
            "provenance traceId is required"
        );
        if let Some(execution_id) = provenance.execution_id.as_deref() {
            anyhow::ensure!(
                !execution_id.trim().is_empty(),
                "provenance executionId must not be empty"
            );
        }
        if let Some(main_owned_id) = provenance.main_owned_provenance_id.as_deref() {
            anyhow::ensure!(
                !main_owned_id.trim().is_empty(),
                "provenance mainOwnedProvenanceId must not be empty"
            );
            anyhow::ensure!(
                provenance.execution_id.is_some(),
                "mainOwnedProvenanceId requires provenance executionId"
            );
        }
        anyhow::ensure!(
            provenance.request_id == context.request_id,
            "provenance requestId must match canonical requestId"
        );
    }
    let replay = matches!(
        context.origin,
        NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
    );
    let complete_lineage = context
        .original_transaction_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        && context
            .undo_journal_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    anyhow::ensure!(
        context.authority_route == "history-replay" && replay == complete_lineage
            || context.authority_route != "history-replay" && !replay && !complete_lineage,
        "history-replay requires undo/redo origin and complete transaction/journal lineage"
    );
    Ok(())
}

pub fn validate_renderer_authority_context_for_routes(
    context: &RendererCanonicalWriteContext,
    allowed_routes: &[&str],
) -> anyhow::Result<()> {
    validate_renderer_authority_context(context)?;
    anyhow::ensure!(
        allowed_routes.contains(&context.authority_route.as_str()),
        "Authority route '{}' is not allowed for this writer",
        context.authority_route
    );
    Ok(())
}

pub(crate) fn validate_agent_chronicle_renderer_context(
    request_id: &str,
    context: &RendererCanonicalWriteContext,
) -> anyhow::Result<()> {
    validate_renderer_authority_context_for_routes(
        context,
        &["interactive-agent-command"],
    )?;
    anyhow::ensure!(
        context.request_id == request_id,
        "agent Chronicle requestId does not match canonical authority context"
    );
    Ok(())
}

/// Validate the shared Chronicle writer for either explicit renderer aliases
/// or capability-bound Agent commands. The Electron command contract keeps
/// `agent_*` commands on `interactive-agent-command`; this Native helper only
/// accepts the canonical context selected by that entry boundary.
pub(crate) fn validate_renderer_chronicle_context(
    request_id: &str,
    context: &RendererCanonicalWriteContext,
) -> anyhow::Result<()> {
    if context.authority_route == "interactive-agent-command" {
        return validate_agent_chronicle_renderer_context(request_id, context);
    }
    validate_renderer_authority_context_for_routes(
        context,
        &[
            "human-direct",
            "interactive-agent-command",
            "import-apply",
            "history-replay",
            "restore-or-migration",
        ],
    )?;
    anyhow::ensure!(
        context.request_id == request_id,
        "Chronicle requestId does not match canonical authority context"
    );
    Ok(())
}

pub(crate) fn canonical_payload_with_authority_context(
    payload: &str,
    context: &RendererCanonicalWriteContext,
) -> String {
    canonical_payload_with_derived_authority_context(payload, context, &[])
}

pub(crate) fn canonical_payload_with_derived_authority_context(
    payload: &str,
    context: &RendererCanonicalWriteContext,
    affected_authority_paths: &[String],
) -> String {
    let parsed =
        serde_json::from_str::<Value>(payload).unwrap_or_else(|_| json!({ "rawPayload": payload }));
    let mut evidence = json!({
        "validated": true,
        "status": "validated",
        "authorityRoute": context.authority_route,
        "caller": context.caller,
        "origin": context.origin.as_str(),
        "callerAllowlisted": true,
        "originRouteMatched": true,
        "requiredControlsValidated": true,
        "fieldAuthorityValidated": context.authority_route != "interactive-agent-command"
            || context.controls.iter().any(|control| control == "field-authority"),
        "fieldAuthorityDecision": if affected_authority_paths.is_empty() {
            "not-required"
        } else {
            "validated"
        },
        "affectedAuthorityPaths": affected_authority_paths,
        "replayLineageValidated": context.authority_route == "history-replay",
        "controls": context.controls,
    });
    if let Some(authority_session_id) = context.authority_session_id.as_deref() {
        evidence["authoritySessionId"] = json!(authority_session_id);
    }
    if let Some(provenance) = &context.provenance {
        evidence["provenance"] = serde_json::to_value(provenance).unwrap_or(Value::Null);
    }
    if let Value::Object(mut object) = parsed {
        object.insert(
            "authorityRoute".to_string(),
            Value::String(context.authority_route.clone()),
        );
        object.insert(
            "authorityCaller".to_string(),
            Value::String(context.caller.clone()),
        );
        object.insert("authorityEvidence".to_string(), evidence);
        Value::Object(object).to_string()
    } else {
        json!({
            "authorityRoute": context.authority_route,
            "authorityCaller": context.caller,
            "authorityEvidence": evidence,
            "payload": parsed,
        })
        .to_string()
    }
}

fn all_authority_paths(entity_type: &str) -> &'static [&'static str] {
    match entity_type {
        "codex_entry" | "codex-entry" => &[
            "/type",
            "/name",
            "/summary",
            "/content",
            "/aliases",
            "/excludedAliases",
            "/readings",
            "/tagsCache",
            "/parentId",
            "/contextMode",
            "/icon",
            "/childrenBudget",
            "/notes",
        ],
        "snippet" => &["/title", "/content", "/sceneId"],
        "foreshadow" => &[
            "/title",
            "/intent",
            "/notes",
            "/loadBearing",
            "/payoffConfirmed",
            "/abandoned",
            "/secret",
        ],
        "event" | "chronicle-event" => EVENT_AUTHORITY_FIELDS,
        _ => &[],
    }
}

fn authority_path_for_field<'a>(
    entity_type: &str,
    field: &str,
    all_paths: &'a [&'a str],
) -> Option<&'a str> {
    let field = field.trim_start_matches('/');
    let alias = match (entity_type, field) {
        // The typed Codex writer calls the relation used to update the
        // denormalized cache `tags`; the authority surface owns the cache.
        ("codex_entry" | "codex-entry", "tags") => Some("/tagsCache"),
        // Association commands encode their affected collection in the
        // operation rather than in the `fields` array.
        ("event" | "chronicle-event", "codexEntryIds") => Some("/participants"),
        _ => None,
    };
    alias.or_else(|| {
        all_paths
            .iter()
            .copied()
            .find(|path| path.trim_start_matches('/') == field)
    })
}

fn paths_from_field_list(
    entity_type: &str,
    object: &serde_json::Map<String, Value>,
    all_paths: &[&str],
) -> Option<Vec<String>> {
    let fields = object.get("fields")?.as_array()?;
    if fields.is_empty() {
        return None;
    }
    let mut paths = Vec::with_capacity(fields.len());
    for field in fields {
        let field = field.as_str()?;
        let Some(path) = authority_path_for_field(entity_type, field, all_paths) else {
            // An unknown field must not silently turn Field Authority off. A
            // caller-controlled or future field is handled conservatively by
            // the all-path fallback in the caller.
            return None;
        };
        paths.push(path.to_string());
    }
    paths.sort();
    paths.dedup();
    Some(paths)
}

fn authority_paths_for_canonical_event(event: &AppendChangeEvent) -> Vec<String> {
    let Some(entity_type) = event.entity_type.as_deref() else {
        return Vec::new();
    };
    let all_paths = all_authority_paths(entity_type);
    if all_paths.is_empty() {
        return Vec::new();
    }

    // Association writes do not carry a `fields` list, but their operation is
    // itself the Native-owned statement of the affected aggregate path.
    let operation_paths: &[&str] = match event.op_type.as_str() {
        "event.participants" => &["/participants"],
        "event.stamp" | "event.unstamp" => &["/sceneIds"],
        "event.relation_add" | "event.relation_remove" => &["/relations"],
        _ => &[],
    };
    if !operation_paths.is_empty() {
        return operation_paths
            .iter()
            .map(|path| (*path).to_string())
            .collect();
    }

    let op_is_create = event.op_type.ends_with(".create")
        || event.op_type.ends_with(".restore")
        || event.op_type.ends_with(".delete");
    if op_is_create {
        return all_paths.iter().map(|path| (*path).to_string()).collect();
    }

    let parsed = serde_json::from_str::<Value>(&event.payload).ok();
    let Some(object) = parsed.as_ref().and_then(Value::as_object) else {
        return all_paths.iter().map(|path| (*path).to_string()).collect();
    };

    if let Some(paths) = paths_from_field_list(entity_type, object, all_paths) {
        return paths;
    }

    let mut paths = Vec::new();
    let mut unknown_field = false;
    for field in object.keys() {
        if matches!(
            field.as_str(),
            "requestHash" | "eventId" | "causeEventId" | "effectEventId"
        ) {
            continue;
        }
        if let Some(path) = authority_path_for_field(entity_type, field, all_paths) {
            paths.push(path.to_string());
        } else {
            unknown_field = true;
        }
    }
    if unknown_field || paths.is_empty() {
        return all_paths.iter().map(|path| (*path).to_string()).collect();
    }
    paths.sort();
    paths.dedup();
    paths
}

fn authority_entity_kind(entity_type: &str) -> &str {
    match entity_type {
        "codex_entry" => "codex-entry",
        "chronicle-event" => "event",
        other => other,
    }
}

pub(crate) fn validate_agent_field_authority_for_entity(
    conn: &rusqlite::Connection,
    project_id: &str,
    entity_kind: &str,
    entity_id: &str,
    paths: &[String],
    updated_at: &str,
) -> anyhow::Result<()> {
    validate_agent_field_authority_for_entity_with_legacy_check(
        conn,
        project_id,
        entity_kind,
        entity_id,
        paths,
        updated_at,
        true,
    )
}

pub(crate) fn record_agent_field_authority_for_entity(
    conn: &rusqlite::Connection,
    project_id: &str,
    entity_kind: &str,
    entity_id: &str,
    paths: &[String],
    updated_at: &str,
) -> anyhow::Result<()> {
    validate_or_record_agent_field_authority_for_entity(
        conn,
        project_id,
        entity_kind,
        entity_id,
        paths,
        updated_at,
        AgentFieldAuthorityAction::Record,
    )
}

fn validate_agent_field_authority_for_entity_with_legacy_check(
    conn: &rusqlite::Connection,
    project_id: &str,
    entity_kind: &str,
    entity_id: &str,
    paths: &[String],
    updated_at: &str,
    check_legacy_value: bool,
) -> anyhow::Result<()> {
    validate_or_record_agent_field_authority_for_entity(
        conn,
        project_id,
        entity_kind,
        entity_id,
        paths,
        updated_at,
        AgentFieldAuthorityAction::Validate { check_legacy_value },
    )
}

enum AgentFieldAuthorityAction {
    Validate { check_legacy_value: bool },
    Record,
}

fn validate_or_record_agent_field_authority_for_entity(
    conn: &rusqlite::Connection,
    project_id: &str,
    entity_kind: &str,
    entity_id: &str,
    paths: &[String],
    updated_at: &str,
    action: AgentFieldAuthorityAction,
) -> anyhow::Result<()> {
    let (check_legacy_value, record) = match action {
        AgentFieldAuthorityAction::Validate { check_legacy_value } => (check_legacy_value, false),
        AgentFieldAuthorityAction::Record => (false, true),
    };
    if paths.is_empty() {
        return Ok(());
    }
    for path in paths {
        anyhow::ensure!(
            path.starts_with('/') && !path.contains('*') && !path.ends_with('/'),
            "NEX_FIELD_AUTHORITY_PATH_INVALID: Native derived an invalid field path"
        );
        let owned: Option<(String, i64)> = conn
            .query_row(
                "SELECT owner_kind, explicit_lock
                   FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = ?2
                    AND entity_id = ?3 AND field_path = ?4",
                rusqlite::params![project_id, entity_kind, entity_id, path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let legacy_human = check_legacy_value
            && owned.is_none()
            && crate::narrative_extraction::legacy_value_present(
                conn,
                project_id,
                entity_kind,
                entity_id,
                path,
            )?;
        let denied = owned
            .as_ref()
            .is_some_and(|(owner, lock)| owner == "human" || *lock != 0)
            || legacy_human;
        anyhow::ensure!(
            !denied,
            "NEX_FIELD_AUTHORITY_DENIED: '{}' on {} '{}' is human-owned or locked",
            path,
            entity_kind,
            entity_id
        );
    }
    if !record {
        return Ok(());
    }
    for path in paths {
        conn.execute(
            "INSERT INTO narrative_field_authority
                (project_id, entity_kind, entity_id, field_path, owner_kind,
                 explicit_lock, version, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'ai', 0, 0, ?5)
             ON CONFLICT(project_id, entity_kind, entity_id, field_path)
             DO UPDATE SET owner_kind = CASE
                    WHEN narrative_field_authority.owner_kind = 'human'
                    THEN 'human' ELSE 'ai' END,
                 version = narrative_field_authority.version + 1,
                 updated_at = excluded.updated_at",
            rusqlite::params![project_id, entity_kind, entity_id, path, updated_at],
        )?;
    }
    Ok(())
}

fn preflight_agent_field_authority(
    conn: &rusqlite::Connection,
    project_id: &str,
    entity_kind: &str,
    entity_id: &str,
    paths: &[String],
    updated_at: &str,
    surface: Option<&str>,
    renderer_context: Option<&RendererCanonicalWriteContext>,
) -> anyhow::Result<()> {
    // Renderer writes carry the full canonical context. Standalone MCP has no
    // renderer context, but it is still an AI mutation surface and must run
    // the same field-authority preflight inside the writer transaction.
    let is_interactive_agent = renderer_context
        .is_some_and(|context| context.authority_route == "interactive-agent-command");
    let is_mcp = surface == Some("mcp");
    if is_interactive_agent || is_mcp {
        // An old non-empty value is treated as human until an explicit Field
        // Authority row exists. MCP has no renderer migration context, so it
        // must keep this fail-closed fallback as well as enforce explicit
        // human/lock rows. Successful MCP writes record AI ownership below;
        // a historical MCP journal is not sufficient evidence to promote an
        // arbitrary field because it may describe a different field or an
        // earlier human edit.
        validate_agent_field_authority_for_entity_with_legacy_check(
            conn,
            project_id,
            entity_kind,
            entity_id,
            paths,
            updated_at,
            true,
        )?;
    }
    Ok(())
}

fn record_agent_field_authority(
    conn: &rusqlite::Connection,
    project_id: &str,
    event: &AppendChangeEvent,
    paths: &[String],
) -> anyhow::Result<()> {
    let Some(entity_type) = event.entity_type.as_deref() else {
        anyhow::ensure!(
            paths.is_empty(),
            "Agent field authority requires an entity type"
        );
        return Ok(());
    };
    let Some(entity_id) = event.entity_id.as_deref() else {
        anyhow::ensure!(
            paths.is_empty(),
            "Agent field authority requires an entity id"
        );
        return Ok(());
    };
    let updated_at = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(event.timestamp)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339();
    record_agent_field_authority_for_entity(
        conn,
        project_id,
        authority_entity_kind(entity_type),
        entity_id,
        paths,
        &updated_at,
    )
}

fn validate_renderer_codex_identity(
    project_id: &str,
    session_id: &str,
    context: &RendererCanonicalWriteContext,
) -> anyhow::Result<()> {
    anyhow::ensure!(!project_id.trim().is_empty(), "projectId must not be empty");
    anyhow::ensure!(!session_id.trim().is_empty(), "sessionId must not be empty");
    anyhow::ensure!(
        !context.request_id.trim().is_empty(),
        "requestId must not be empty"
    );
    anyhow::ensure!(
        !context.event_uid.trim().is_empty(),
        "eventUid must not be empty"
    );
    validate_renderer_authority_context_for_routes(
        context,
        &[
            "human-direct",
            "interactive-agent-command",
            "import-apply",
            "history-replay",
            "restore-or-migration",
        ],
    )?;
    let replay = matches!(
        context.origin,
        NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
    );
    let complete_lineage = context
        .original_transaction_id
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
        && context
            .undo_journal_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    anyhow::ensure!(
        replay == complete_lineage
            && (replay
                || (context.original_transaction_id.is_none()
                    && context.undo_journal_id.is_none())),
        "undo/redo origin requires originalTransactionId and undoJournalId"
    );
    Ok(())
}

fn renderer_cause_kind(origin: NarrativeChangeOrigin) -> NarrativeChangeCauseKind {
    match origin {
        NarrativeChangeOrigin::Undo => NarrativeChangeCauseKind::Undo,
        NarrativeChangeOrigin::Redo => NarrativeChangeCauseKind::Redo,
        _ => NarrativeChangeCauseKind::Forward,
    }
}

fn is_renderer_replay(context: Option<&RendererCanonicalWriteContext>) -> bool {
    context.is_some_and(|context| {
        matches!(
            context.origin,
            NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
        )
    })
}

fn validate_renderer_replay_lineage_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    context: Option<&RendererCanonicalWriteContext>,
) -> anyhow::Result<()> {
    let Some(context) = context.filter(|context| {
        matches!(
            context.origin,
            NarrativeChangeOrigin::Undo | NarrativeChangeOrigin::Redo
        )
    }) else {
        return Ok(());
    };
    require_replay_lineage_in_project(
        conn,
        project_id,
        context
            .original_transaction_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("originalTransactionId is required"))?,
        context
            .undo_journal_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("undoJournalId is required"))?,
    )
}

fn change_occurred_at(timestamp: i64) -> anyhow::Result<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp)
        .map(|value| value.to_rfc3339())
        .ok_or_else(|| anyhow::anyhow!("canonical Change Event timestamp is out of range"))
}

// This bridge carries the full canonical and narrative write context across
// the single transaction; keeping the values explicit makes the authority
// boundary visible at each writer call site.
#[allow(clippy::too_many_arguments)]
fn append_agent_forward_change_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    session_id: &str,
    surface: Option<&str>,
    request_id: Option<&str>,
    undo_journal_id: &str,
    canonical_event: &AppendChangeEvent,
    narrative_events: Option<Vec<NarrativeChangeEventInput>>,
    renderer_context: Option<&RendererCanonicalWriteContext>,
) -> anyhow::Result<String> {
    let mut events = match narrative_events {
        Some(events) => events,
        None => {
            let row =
                grimodex_core::undo_journal::load_undo_journal(conn, project_id, undo_journal_id)?;
            vec![event_from_undo_journal_row(
                &row,
                renderer_context.map_or(NarrativeChangeCauseKind::Forward, |context| {
                    renderer_cause_kind(context.origin)
                }),
            )?]
        }
    };
    normalize_foreshadow_feed_events_in_tx(conn, project_id, &mut events)?;
    let canonical_event = if let Some(context) = renderer_context {
        validate_renderer_authority_context(context)?;
        let affected_authority_paths = authority_paths_for_canonical_event(canonical_event);
        if context.authority_route == "interactive-agent-command" {
            record_agent_field_authority(
                conn,
                project_id,
                canonical_event,
                &affected_authority_paths,
            )?;
        }
        let mut annotated = canonical_event.clone();
        annotated.payload = canonical_payload_with_derived_authority_context(
            &canonical_event.payload,
            context,
            &affected_authority_paths,
        );
        annotated
    } else if surface == Some("mcp") {
        // MCP is a standalone AI surface, so it cannot provide the renderer
        // capability context. It still participates in field ownership: the
        // preflight above protects human/locked fields and successful MCP
        // writes must establish AI ownership for their changed paths.
        let affected_authority_paths = authority_paths_for_canonical_event(canonical_event);
        record_agent_field_authority(conn, project_id, canonical_event, &affected_authority_paths)?;
        if matches!(
            canonical_event.op_type.as_str(),
            "event.relation_add" | "event.relation_remove"
        ) {
            let relation_payload = serde_json::from_str::<Value>(&canonical_event.payload)?;
            let effect_event_id = relation_payload
                .get("effectEventId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "MCP relation Change Event must carry a non-empty effectEventId"
                    )
                })?;
            let relation_paths = vec!["/relations".to_string()];
            record_agent_field_authority_for_entity(
                conn,
                project_id,
                "event",
                effect_event_id,
                &relation_paths,
                &change_occurred_at(canonical_event.timestamp)?,
            )?;
        }
        canonical_event.clone()
    } else {
        canonical_event.clone()
    };
    let append = append_canonical_and_narrative_change_in_tx(
        conn,
        project_id,
        session_id,
        &canonical_event,
        &AppendNarrativeChangeTransactionInput {
            project_id: project_id.to_string(),
            request_id: renderer_context
                .map(|context| context.request_id.as_str())
                .or(request_id)
                .unwrap_or(&canonical_event.event_uid)
                .to_string(),
            source_domain: canonical_event.op_type.clone(),
            source_change_event_uid: canonical_event.event_uid.clone(),
            cause_kind: renderer_context.map_or(NarrativeChangeCauseKind::Forward, |context| {
                renderer_cause_kind(context.origin)
            }),
            origin: renderer_context.map_or_else(
                || narrative_origin_for_surface(surface),
                |context| context.origin,
            ),
            original_transaction_id: renderer_context
                .and_then(|context| context.original_transaction_id.clone()),
            commit_id: None,
            journal_id: None,
            undo_journal_id: Some(
                renderer_context
                    .and_then(|context| context.undo_journal_id.as_deref())
                    .unwrap_or(undo_journal_id)
                    .to_string(),
            ),
            application_ids: vec![],
            occurred_at: change_occurred_at(canonical_event.timestamp)?,
            events,
        },
    )?;
    Ok(append.narrative.transaction_id)
}

fn normalize_foreshadow_feed_events_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    events: &mut [NarrativeChangeEventInput],
) -> anyhow::Result<()> {
    // The shared core Foreshadow writer deliberately stores a compact root row
    // in its Undo Journal.  The C1 Feed root, however, is the full aggregate
    // used by the manual Native writer (setups, payoffs, support edges, and
    // Codex links included).  Normalize the AI writer's event to that same
    // canonical snapshot before appending it, and use the existing Feed head
    // for the before state so a later delete/restore can chain without a
    // root-only/aggregate digest split.
    for event in events {
        if event.object_key.get("kind").and_then(Value::as_str) != Some("foreshadow") {
            continue;
        }
        let current = if event.mutation_kind == "delete" {
            None
        } else {
            crate::canonical_feed_snapshots::canonical_snapshot_for_object_key(
                conn,
                project_id,
                &event.object_key,
            )?
        };
        if let Some(snapshot) = current {
            if matches!(
                event.mutation_kind.as_str(),
                "create" | "update" | "restore"
            ) {
                event.after_version = snapshot_version(&snapshot);
                event.after_digest = Some(narrative_snapshot_digest(&snapshot)?);
            }
        }
        if matches!(event.mutation_kind.as_str(), "update" | "delete") {
            let identity = crate::canonical_feed_snapshots::object_key_identity(&event.object_key)?;
            if let Some((version, digest)) =
                crate::narrative_extraction::change_feed::previous_event_after_state(
                    conn, project_id, &identity,
                )?
            {
                event.before_version = version;
                event.before_digest = digest;
            }
        }
    }
    Ok(())
}

fn record_manual_event_fields(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_id: &str,
    surface: Option<&str>,
    fields: &[&str],
    updated_at: &str,
) -> anyhow::Result<()> {
    if surface != Some("manual") {
        return Ok(());
    }
    crate::narrative_extraction::record_human_field_write(
        conn, project_id, "event", event_id, fields, updated_at,
    )
}

const CODEX_ENTRY_AUTHORITY_FIELDS: &[&str] = &[
    "/type",
    "/name",
    "/summary",
    "/content",
    "/aliases",
    "/excludedAliases",
    "/readings",
    "/tagsCache",
    "/parentId",
    "/contextMode",
    "/icon",
    "/childrenBudget",
    "/notes",
];

fn record_manual_codex_entry_fields(
    conn: &rusqlite::Connection,
    project_id: &str,
    entry_id: &str,
    surface: Option<&str>,
    fields: &[&str],
    updated_at: &str,
) -> anyhow::Result<()> {
    if surface != Some("manual") {
        return Ok(());
    }
    crate::narrative_extraction::record_human_field_write(
        conn,
        project_id,
        "codex-entry",
        entry_id,
        fields,
        updated_at,
    )
}

fn manual_update_fields(payload: &AgentCodexUpdatePayload) -> Vec<&'static str> {
    [
        payload.type_slug.as_ref().map(|_| "/type"),
        payload.name.as_ref().map(|_| "/name"),
        payload.summary.as_ref().map(|_| "/summary"),
        payload.content.as_ref().map(|_| "/content"),
        payload.aliases.as_ref().map(|_| "/aliases"),
        payload
            .excluded_aliases
            .as_ref()
            .map(|_| "/excludedAliases"),
        payload.readings.as_ref().map(|_| "/readings"),
        payload.tags_cache.as_ref().map(|_| "/tagsCache"),
        payload.parent_id.as_ref().map(|_| "/parentId"),
        payload.context_mode.as_ref().map(|_| "/contextMode"),
        payload.icon.as_ref().map(|_| "/icon"),
        payload.children_budget.as_ref().map(|_| "/childrenBudget"),
        payload.notes.as_ref().map(|_| "/notes"),
    ]
    .into_iter()
    .flatten()
    .collect()
}

fn codex_patch_invalidates_linked_foreshadows(payload: &AgentCodexUpdatePayload) -> bool {
    payload.name.is_some()
        || payload.aliases.is_some()
        || payload.summary.is_some()
        || payload.content.is_some()
}

fn invalidate_linked_foreshadows_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    codex_entry_id: &str,
    now_millis: i64,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    let mut statement = conn.prepare(
        "SELECT json_object(
             'id', foreshadow.id,
             'projectId', foreshadow.project_id,
             'version', foreshadow.version,
             'codexLinkDirtyAt', foreshadow.codex_link_dirty_at,
             'updatedAt', foreshadow.updated_at
           )
           FROM foreshadows foreshadow
           JOIN foreshadow_codex_links link ON link.foreshadow_id = foreshadow.id
          WHERE foreshadow.project_id = ?1 AND link.codex_entry_id = ?2
          ORDER BY foreshadow.id",
    )?;
    let before = statement
        .query_map(rusqlite::params![project_id, codex_entry_id], |row| {
            row.get::<_, String>(0)
        })?
        .map(|row| {
            let raw = row?;
            serde_json::from_str::<Value>(&raw).map_err(Into::into)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    drop(statement);
    if before.is_empty() {
        return Ok(Vec::new());
    }
    let updated = conn.execute(
        "UPDATE foreshadows
            SET codex_link_dirty_at = ?1,
                version = version + 1,
                updated_at = ?1
          WHERE project_id = ?2
            AND id IN (
                SELECT foreshadow_id
                  FROM foreshadow_codex_links
                 WHERE codex_entry_id = ?3
            )",
        rusqlite::params![now_millis, project_id, codex_entry_id],
    )?;
    anyhow::ensure!(
        updated == before.len(),
        "linked Foreshadow invalidation changed an unexpected number of rows"
    );

    before
        .into_iter()
        .map(|before| {
            let foreshadow_id = before
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("Foreshadow invalidation snapshot has no id"))?;
            let after_raw: String = conn.query_row(
                "SELECT json_object(
                     'id', id,
                     'projectId', project_id,
                     'version', version,
                     'codexLinkDirtyAt', codex_link_dirty_at,
                     'updatedAt', updated_at
                   )
                   FROM foreshadows
                  WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![foreshadow_id, project_id],
                |row| row.get(0),
            )?;
            let after: Value = serde_json::from_str(&after_raw)?;
            let changed_paths = vec!["/codexLinkDirtyAt".to_string()];
            Ok(NarrativeChangeEventInput {
                object_key: json!({
                    "kind": "foreshadow",
                    "foreshadowId": foreshadow_id,
                }),
                change_kind: "metadata".to_string(),
                mutation_kind: "update".to_string(),
                before_version: snapshot_version(&before),
                before_digest: Some(narrative_snapshot_digest(&before)?),
                after_version: snapshot_version(&after),
                after_digest: Some(narrative_snapshot_digest(&after)?),
                changed_paths: changed_paths.clone(),
                text_impact: None,
                structural_impact: Some(json!({ "changedPaths": changed_paths })),
            })
        })
        .collect()
}

fn linked_foreshadow_rows(
    conn: &rusqlite::Connection,
    project_id: &str,
    codex_entry_id: &str,
) -> anyhow::Result<Vec<Value>> {
    let rows = Database::execute_with_conn(
        conn,
        "SELECT foreshadow.*
           FROM foreshadows foreshadow
           JOIN foreshadow_codex_links link ON link.foreshadow_id = foreshadow.id
          WHERE foreshadow.project_id = ?1 AND link.codex_entry_id = ?2
          ORDER BY foreshadow.id",
        &[
            Value::String(project_id.to_string()),
            Value::String(codex_entry_id.to_string()),
        ],
        "all",
    )?;
    Ok(rows.into_iter().map(Value::Object).collect())
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

fn normalize_tag_set(tags: &[String]) -> Vec<String> {
    let mut normalized = tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn require_agent_request_id(request_id: Option<&str>) -> anyhow::Result<&str> {
    let request_id = request_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("requestId is required"))?;
    Ok(request_id)
}

fn codex_create_request_hash(
    payload: &AgentCodexCreatePayload,
    tags: Option<&[String]>,
) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.request_id = None;
    normalized.entry_id = None;
    normalized.session_id.clear();
    normalized.summary = Some(normalized.summary.unwrap_or_default());
    normalized.content = Some(normalize_prosemirror_for_idempotency(
        normalized.content.as_deref().unwrap_or("{}"),
    ));
    match tags {
        Some(tags) => {
            idempotency_hash("agent_codex_create", &(normalized, normalize_tag_set(tags)))
        }
        None => idempotency_hash("agent_codex_create", &normalized),
    }
}

fn codex_update_request_hash(
    payload: &AgentCodexUpdatePayload,
    tags: Option<&[String]>,
) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.session_id.clear();
    normalized.surface = None;
    match tags {
        Some(tags) => {
            idempotency_hash("agent_codex_update", &(normalized, normalize_tag_set(tags)))
        }
        None => idempotency_hash("agent_codex_update", &normalized),
    }
}

fn renderer_codex_request_hash<T: Serialize>(
    domain: &str,
    payload: &T,
    context: &RendererCanonicalWriteContext,
    tags: Option<&[String]>,
) -> anyhow::Result<String> {
    let mut payload = serde_json::to_value(payload)?;
    if let Some(object) = payload.as_object_mut() {
        object.remove("requestId");
        object.remove("sessionId");
    }
    let mut context = serde_json::to_value(context)?;
    if let Some(object) = context.as_object_mut() {
        object.remove("requestId");
        object.remove("eventUid");
    }
    idempotency_hash(
        domain,
        &json!({
            "payload": payload,
            "context": context,
            "tags": tags.map(normalize_tag_set),
        }),
    )
}

fn attach_maintenance_transaction_id(
    conn: &rusqlite::Connection,
    project_id: &str,
    result: &AgentWriteResult,
) -> anyhow::Result<Value> {
    let transaction_id = crate::narrative_extraction::change_feed::transaction_id_for_source_event(
        conn,
        project_id,
        &result.change_event_uid,
    )?
    .ok_or_else(|| {
        anyhow::anyhow!(
            "Narrative Change Feed transaction missing for canonical event '{}'",
            result.change_event_uid
        )
    })?;
    let mut value = serde_json::to_value(result)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("Agent write receipt must serialize as an object"))?;
    object.insert(
        "maintenanceTransactionId".to_string(),
        Value::String(transaction_id),
    );
    Ok(value)
}

fn apply_renderer_codex_create_fields(
    conn: &rusqlite::Connection,
    project_id: &str,
    entry_id: &str,
    undo_journal_id: &str,
    context: &RendererCanonicalWriteContext,
) -> anyhow::Result<()> {
    let updated = conn.execute(
        "UPDATE codex_entries
            SET context_mode = COALESCE(?3, context_mode),
                icon = ?4,
                children_budget = COALESCE(?5, children_budget),
                notes = ?6
          WHERE id = ?1 AND project_id = ?2",
        rusqlite::params![
            entry_id,
            project_id,
            context.context_mode,
            context.icon,
            context.children_budget,
            context.notes,
        ],
    )?;
    anyhow::ensure!(
        updated == 1,
        "Codex entry '{}' escaped its project during renderer create",
        entry_id
    );
    if !is_renderer_replay(Some(context)) {
        let after_json = collect_codex_entry_snapshot(conn, entry_id)?.to_string();
        let journal_updated = conn.execute(
            "UPDATE undo_journal
                SET after_json = ?3
              WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![undo_journal_id, project_id, after_json],
        )?;
        anyhow::ensure!(
            journal_updated == 1,
            "Codex create Undo Journal '{}' is missing from its transaction",
            undo_journal_id
        );
    }
    Ok(())
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
    normalized.request_id.clear();
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

fn event_update_request_hash(payload: &AgentEventUpdatePayload) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.session_id.clear();
    normalized.surface = None;
    idempotency_hash("agent_event_update", &normalized)
}

fn event_delete_request_hash(payload: &AgentEventIdPayload) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.session_id.clear();
    normalized.surface = None;
    idempotency_hash("agent_event_delete", &normalized)
}

fn event_participants_request_hash(
    payload: &AgentEventParticipantsPayload,
) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.session_id.clear();
    normalized.surface = None;
    normalized.codex_entry_ids.sort();
    normalized.codex_entry_ids.dedup();
    idempotency_hash("agent_event_participants", &normalized)
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
    normalized.request_id.clear();
    normalized.foreshadow_id = None;
    normalized.session_id.clear();
    idempotency_hash("agent_foreshadow_create", &normalized)
}

fn scene_event_request_hash(
    payload: &AgentSceneEventPayload,
    link: bool,
) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.request_id.clear();
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

fn scene_event_link_batch_request_hash(
    payload: &AgentSceneEventLinkBatchPayload,
) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.request_id.clear();
    normalized.session_id.clear();
    normalized.surface = None;
    normalized.scene_ids.sort();
    normalized.scene_ids.dedup();
    idempotency_hash("agent_scene_event_link_batch", &normalized)
}

fn event_relation_request_hash(
    payload: &AgentEventRelationPayload,
    add: bool,
) -> anyhow::Result<String> {
    let mut normalized = payload.clone();
    normalized.request_id.clear();
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
                span.timestamp.as_deref().unwrap_or(&now),
            ],
        )?;
    }
    Ok(())
}

fn replace_codex_tags_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    entry_id: &str,
    tags: &[String],
) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM codex_entry_tags WHERE entry_id = ?1",
        rusqlite::params![entry_id],
    )?;
    let mut normalized = tags
        .iter()
        .map(|tag| tag.trim())
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    for tag_name in &normalized {
        let tag_id = conn
            .query_row(
                "SELECT id FROM codex_tags WHERE project_id = ?1 AND name = ?2",
                rusqlite::params![project_id, tag_name],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        conn.execute(
            "INSERT OR IGNORE INTO codex_tags (id, project_id, name) VALUES (?1, ?2, ?3)",
            rusqlite::params![tag_id, project_id, tag_name],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO codex_entry_tags (entry_id, tag_id) VALUES (?1, ?2)",
            rusqlite::params![entry_id, tag_id],
        )?;
    }
    let mut statement = conn.prepare(
        "SELECT tag.name, tag.color
           FROM codex_entry_tags link
           JOIN codex_tags tag ON tag.id = link.tag_id
          WHERE link.entry_id = ?1 AND tag.project_id = ?2
          ORDER BY tag.name, tag.id",
    )?;
    let cache = statement
        .query_map(rusqlite::params![entry_id, project_id], |row| {
            Ok(json!({
                "name": row.get::<_, String>(0)?,
                "color": row.get::<_, Option<String>>(1)?,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    conn.execute(
        "UPDATE codex_entries SET tags_cache = ?1 WHERE id = ?2 AND project_id = ?3",
        rusqlite::params![serde_json::to_string(&cache)?, entry_id, project_id],
    )?;
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct CodexEntryCreateTxInput<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub surface: Option<&'a str>,
    pub entry_id: &'a str,
    pub undo_id: &'a str,
    pub event_uid: &'a str,
    pub type_slug: &'a str,
    pub name: &'a str,
    pub summary: &'a str,
    pub content: &'a str,
    pub aliases: Option<&'a str>,
    pub excluded_aliases: Option<&'a str>,
    pub readings: Option<&'a str>,
    pub tags_cache: Option<&'a str>,
    pub tags: Option<&'a [String]>,
    pub parent_id: Option<&'a str>,
    pub source_chat_message_id: Option<&'a str>,
    pub authorship_spans: &'a [AuthorshipSpanInput],
    pub model: Option<&'a str>,
    pub chat_message_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
    pub request_hash: Option<&'a str>,
    pub now: &'a str,
    pub timestamp: i64,
    pub write_undo_journal: bool,
    pub write_change_event: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct CodexEntryCreateTxResult {
    pub entity_id: String,
    pub version: i64,
    pub change_event_uid: String,
    pub undo_journal_id: String,
    pub after_snapshot: Value,
    pub canonical_event: AppendChangeEvent,
}

fn normalize_codex_parent_id(parent_id: Option<&str>) -> Option<&str> {
    parent_id.filter(|value| !value.is_empty())
}

fn validate_codex_parent_in_project(
    conn: &rusqlite::Connection,
    project_id: &str,
    entry_id: &str,
    parent_id: Option<&str>,
) -> anyhow::Result<()> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    anyhow::ensure!(
        parent_id != entry_id,
        "codex entry '{entry_id}' cannot be its own parent"
    );
    let found: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        rusqlite::params![parent_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        found == 1,
        "codex parent '{parent_id}' is not found in project '{project_id}'"
    );
    Ok(())
}

/// Shared Codex entry create body that runs inside a caller-owned transaction.
pub(crate) fn apply_codex_entry_create_in_tx(
    conn: &rusqlite::Connection,
    input: CodexEntryCreateTxInput<'_>,
) -> anyhow::Result<CodexEntryCreateTxResult> {
    let parent_id = normalize_codex_parent_id(input.parent_id);
    validate_codex_parent_in_project(conn, input.project_id, input.entry_id, parent_id)?;
    conn.execute(
        "INSERT INTO codex_entries
         (id, project_id, type, name, aliases, excluded_aliases, readings,
          tags_cache, summary, content, parent_id,
          source_chat_message_id, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?13)",
        rusqlite::params![
            input.entry_id,
            input.project_id,
            input.type_slug,
            input.name,
            input.aliases,
            input.excluded_aliases,
            input.readings,
            input.tags_cache,
            input.summary,
            input.content,
            parent_id,
            input.source_chat_message_id,
            input.now,
        ],
    )?;

    merge_codex_authorship_spans(
        conn,
        input.entry_id,
        CodexSpanMerge {
            spans: input.authorship_spans,
            lanes: None,
            update_summary: true,
            update_content: true,
            model: input.model,
            chat_msg_id: input.chat_message_id.or(input.source_chat_message_id),
            trace_id: input.trace_id,
        },
    )?;
    if let Some(tags) = input.tags {
        replace_codex_tags_in_tx(conn, input.project_id, input.entry_id, tags)?;
    }

    let after_snapshot = collect_codex_entry_snapshot(conn, input.entry_id)?;
    let after_json = after_snapshot.to_string();

    if input.write_undo_journal {
        insert_undo_journal_in_tx(
            conn,
            UndoJournalInsert {
                id: input.undo_id,
                project_id: input.project_id,
                surface: input.surface.unwrap_or("in-app-agent"),
                entity_kind: "codex_entry",
                entity_id: input.entry_id,
                op_kind: "create",
                before_json: None,
                after_json: Some(&after_json),
                base_version: 0,
                result_version: 1,
                change_event_uid: Some(input.event_uid),
            },
        )?;
    }

    let mut change_payload = json!({
        "type": input.type_slug,
        "name": input.name,
        "parentId": parent_id,
    });
    if let Some(request_hash) = input.request_hash {
        change_payload["requestHash"] = Value::String(request_hash.to_string());
    }
    let canonical_event = AppendChangeEvent {
        event_uid: input.event_uid.to_string(),
        scene_id: None,
        domain: "codex".to_string(),
        op_type: "entry.create".to_string(),
        entity_type: Some("codex_entry".to_string()),
        entity_id: Some(input.entry_id.to_string()),
        payload: change_payload.to_string(),
        timestamp: input.timestamp,
    };
    if input.write_change_event {
        append_change_events_in_tx(
            conn,
            input.project_id,
            input.session_id,
            std::slice::from_ref(&canonical_event),
        )?;
    }

    Ok(CodexEntryCreateTxResult {
        entity_id: input.entry_id.to_string(),
        version: 1,
        change_event_uid: input.event_uid.to_string(),
        undo_journal_id: input.undo_id.to_string(),
        after_snapshot,
        canonical_event,
    })
}

/// set-if-present な nullable text 列の入力。TS 側は「未送信=変更なし」と
/// 「空文字送信=NULL に明示クリア」を区別するため、空文字を sentinel として
/// 使う (AgentEventUpdatePayload と同じ流儀)。
fn normalize_nullable_sentinel(value: Option<&str>) -> Option<Option<&str>> {
    value.map(|v| if v.is_empty() { None } else { Some(v) })
}

#[derive(Debug, Clone)]
pub(crate) struct CodexEntryPatchTxInput<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub surface: Option<&'a str>,
    pub entry_id: &'a str,
    pub undo_id: &'a str,
    pub event_uid: &'a str,
    pub base_version: i64,
    /// Human 経路のみ更新する type。AI 経路は None を渡し type を書き換えない。
    pub type_slug: Option<&'a str>,
    pub name: Option<&'a str>,
    pub summary: Option<&'a str>,
    /// When true, summary is applied only if the current summary is empty.
    pub summary_fill_if_empty: bool,
    pub content: Option<&'a str>,
    pub aliases: Option<&'a str>,
    /// set-if-present。空文字は NULL（除外語なし）に正規化する。
    pub excluded_aliases: Option<&'a str>,
    /// set-if-present。空文字は NULL（読み情報なし）に正規化する。
    pub readings: Option<&'a str>,
    /// set-if-present。空文字は NULL（タグなし）に正規化する。
    pub tags_cache: Option<&'a str>,
    pub tags: Option<&'a [String]>,
    /// set-if-present。空文字は NULL（親なし=ルート）に正規化する。
    pub parent_id: Option<&'a str>,
    pub context_mode: Option<&'a str>,
    /// set-if-present。空文字は NULL（アイコンなし）に正規化する。
    pub icon: Option<&'a str>,
    pub children_budget: Option<&'a str>,
    /// set-if-present。空文字は NULL（メモなし）に正規化する。
    pub notes: Option<&'a str>,
    pub authorship_spans: Option<&'a [AuthorshipSpanInput]>,
    pub authorship_span_lanes: Option<&'a [Option<String>]>,
    pub model: Option<&'a str>,
    pub chat_message_id: Option<&'a str>,
    pub trace_id: Option<&'a str>,
    pub now: &'a str,
    pub timestamp: i64,
    pub write_undo_journal: bool,
    pub write_change_event: bool,
    /// When true, reject name/content patches (narrative v1 scope).
    pub aliases_and_empty_summary_only: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct CodexEntryPatchTxResult {
    pub entity_id: String,
    pub version: i64,
    pub change_event_uid: String,
    pub undo_journal_id: String,
    pub before_snapshot: Value,
    pub after_snapshot: Value,
    pub canonical_event: AppendChangeEvent,
}

/// Shared Codex entry patch body (OCC on base_version) inside a caller-owned transaction.
pub(crate) fn apply_codex_entry_patch_in_tx(
    conn: &rusqlite::Connection,
    input: CodexEntryPatchTxInput<'_>,
) -> anyhow::Result<CodexEntryPatchTxResult> {
    if input.aliases_and_empty_summary_only {
        anyhow::ensure!(
            input.name.is_none() && input.content.is_none(),
            "NEX_CODEX_PATCH_SCOPE: narrative patch may only change aliases and empty summary"
        );
    }

    let (db_version, before_base): (i64, String) = conn.query_row(
        "SELECT version, json_object(
            'id', id, 'projectId', project_id, 'type', type, 'name', name,
            'summary', summary, 'content', content, 'aliases', aliases,
            'excludedAliases', excluded_aliases, 'readings', readings,
            'tagsCache', tags_cache, 'parentId', parent_id, 'icon', icon,
            'contextMode', context_mode, 'childrenBudget', children_budget,
            'sourceChatMessageId', source_chat_message_id, 'notes', notes,
            'createdAt', created_at, 'version', version
         ) FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        rusqlite::params![input.entry_id, input.project_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let before_json = grimodex_core::undo_journal::codex_update_before_snapshot(
        conn,
        input.entry_id,
        &before_base,
    )?;
    let before_snapshot: Value = serde_json::from_str(&before_json)?;
    if db_version != input.base_version {
        anyhow::bail!(
            "Codex entry '{}' version conflict: expected {} but database has {}",
            input.entry_id,
            input.base_version,
            db_version
        );
    }
    let current_parent_id = before_snapshot["parentId"].as_str();
    let effective_parent_id = match normalize_nullable_sentinel(input.parent_id) {
        Some(parent_id) => parent_id,
        None => current_parent_id,
    };
    validate_codex_parent_in_project(conn, input.project_id, input.entry_id, effective_parent_id)?;

    let current_summary: Option<String> = conn.query_row(
        "SELECT summary FROM codex_entries WHERE id = ?1 AND project_id = ?2",
        rusqlite::params![input.entry_id, input.project_id],
        |row| row.get(0),
    )?;

    let effective_summary = match input.summary {
        Some(value) if input.summary_fill_if_empty => {
            if current_summary.as_deref().unwrap_or("").trim().is_empty() {
                Some(value)
            } else {
                None
            }
        }
        other => other,
    };

    let mut sets = vec![
        "updated_at = ?1".to_string(),
        "version = version + 1".to_string(),
    ];
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(input.now.to_string())];
    let mut param_idx = 2;

    if let Some(type_slug) = input.type_slug {
        sets.push(format!("type = ?{param_idx}"));
        params.push(Box::new(type_slug.to_string()));
        param_idx += 1;
    }
    if let Some(name) = input.name {
        sets.push(format!("name = ?{param_idx}"));
        params.push(Box::new(name.to_string()));
        param_idx += 1;
    }
    if let Some(summary) = effective_summary {
        sets.push(format!("summary = ?{param_idx}"));
        params.push(Box::new(summary.to_string()));
        param_idx += 1;
    }
    if let Some(content) = input.content {
        sets.push(format!("content = ?{param_idx}"));
        params.push(Box::new(content.to_string()));
        param_idx += 1;
    }
    if let Some(aliases) = input.aliases {
        sets.push(format!("aliases = ?{param_idx}"));
        params.push(Box::new(aliases.to_string()));
        param_idx += 1;
    }
    if let Some(excluded_aliases) = normalize_nullable_sentinel(input.excluded_aliases) {
        sets.push(format!("excluded_aliases = ?{param_idx}"));
        params.push(Box::new(excluded_aliases.map(str::to_string)));
        param_idx += 1;
    }
    if let Some(readings) = normalize_nullable_sentinel(input.readings) {
        sets.push(format!("readings = ?{param_idx}"));
        params.push(Box::new(readings.map(str::to_string)));
        param_idx += 1;
    }
    if let Some(tags_cache) = normalize_nullable_sentinel(input.tags_cache) {
        sets.push(format!("tags_cache = ?{param_idx}"));
        params.push(Box::new(tags_cache.map(str::to_string)));
        param_idx += 1;
    }
    if let Some(parent_id) = normalize_nullable_sentinel(input.parent_id) {
        sets.push(format!("parent_id = ?{param_idx}"));
        params.push(Box::new(parent_id.map(str::to_string)));
        param_idx += 1;
    }
    if let Some(context_mode) = input.context_mode {
        sets.push(format!("context_mode = ?{param_idx}"));
        params.push(Box::new(context_mode.to_string()));
        param_idx += 1;
    }
    if let Some(icon) = normalize_nullable_sentinel(input.icon) {
        sets.push(format!("icon = ?{param_idx}"));
        params.push(Box::new(icon.map(str::to_string)));
        param_idx += 1;
    }
    if let Some(children_budget) = input.children_budget {
        sets.push(format!("children_budget = ?{param_idx}"));
        params.push(Box::new(children_budget.to_string()));
        param_idx += 1;
    }
    if let Some(notes) = normalize_nullable_sentinel(input.notes) {
        sets.push(format!("notes = ?{param_idx}"));
        params.push(Box::new(notes.map(str::to_string)));
        param_idx += 1;
    }

    let sql = format!(
        "UPDATE codex_entries SET {} WHERE id = ?{param_idx} AND project_id = ?{} AND version = ?{}",
        sets.join(", "),
        param_idx + 1,
        param_idx + 2
    );
    params.push(Box::new(input.entry_id.to_string()));
    params.push(Box::new(input.project_id.to_string()));
    params.push(Box::new(input.base_version));

    let updated = conn.execute(
        &sql,
        rusqlite::params_from_iter(params.iter().map(|p| p as &dyn rusqlite::types::ToSql)),
    )?;
    if updated == 0 {
        anyhow::bail!(
            "Codex entry '{}' version conflict or not found in project '{}'",
            input.entry_id,
            input.project_id
        );
    }

    let result_version = input.base_version + 1;

    if let Some(spans) = input.authorship_spans {
        merge_codex_authorship_spans(
            conn,
            input.entry_id,
            CodexSpanMerge {
                spans,
                lanes: input.authorship_span_lanes,
                update_summary: effective_summary.is_some(),
                update_content: input.content.is_some(),
                model: input.model,
                chat_msg_id: input.chat_message_id,
                trace_id: input.trace_id,
            },
        )?;
    }
    if let Some(tags) = input.tags {
        replace_codex_tags_in_tx(conn, input.project_id, input.entry_id, tags)?;
    }

    let after_snapshot = collect_codex_entry_snapshot(conn, input.entry_id)?;
    let after_json = after_snapshot.to_string();

    if input.write_undo_journal {
        insert_undo_journal_in_tx(
            conn,
            UndoJournalInsert {
                id: input.undo_id,
                project_id: input.project_id,
                surface: input.surface.unwrap_or("in-app-agent"),
                entity_kind: "codex_entry",
                entity_id: input.entry_id,
                op_kind: "update",
                before_json: Some(&before_json),
                after_json: Some(&after_json),
                base_version: input.base_version,
                result_version,
                change_event_uid: Some(input.event_uid),
            },
        )?;
    }

    let fields: Vec<&str> = [
        input.type_slug.map(|_| "type"),
        input.name.map(|_| "name"),
        effective_summary.map(|_| "summary"),
        input.content.map(|_| "content"),
        input.aliases.map(|_| "aliases"),
        input.excluded_aliases.map(|_| "excludedAliases"),
        input.readings.map(|_| "readings"),
        input.tags_cache.map(|_| "tagsCache"),
        input.tags.map(|_| "tags"),
        input.parent_id.map(|_| "parentId"),
        input.context_mode.map(|_| "contextMode"),
        input.icon.map(|_| "icon"),
        input.children_budget.map(|_| "childrenBudget"),
        input.notes.map(|_| "notes"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let canonical_event = AppendChangeEvent {
        event_uid: input.event_uid.to_string(),
        scene_id: None,
        domain: "codex".to_string(),
        op_type: "entry.update".to_string(),
        entity_type: Some("codex_entry".to_string()),
        entity_id: Some(input.entry_id.to_string()),
        payload: json!({ "fields": fields }).to_string(),
        timestamp: input.timestamp,
    };
    if input.write_change_event {
        append_change_events_in_tx(
            conn,
            input.project_id,
            input.session_id,
            std::slice::from_ref(&canonical_event),
        )?;
    }

    Ok(CodexEntryPatchTxResult {
        entity_id: input.entry_id.to_string(),
        version: result_version,
        change_event_uid: input.event_uid.to_string(),
        undo_journal_id: input.undo_id.to_string(),
        before_snapshot,
        after_snapshot,
        canonical_event,
    })
}

pub(crate) fn collect_codex_entry_snapshot(
    conn: &rusqlite::Connection,
    entry_id: &str,
) -> anyhow::Result<Value> {
    let project_id: String = conn.query_row(
        "SELECT project_id FROM codex_entries WHERE id = ?1",
        rusqlite::params![entry_id],
        |row| row.get(0),
    )?;
    crate::canonical_feed_snapshots::canonical_codex_entry_snapshot(conn, &project_id, entry_id)
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexDeleteCascadeSnapshot {
    relations: Vec<Value>,
    phases: Vec<Value>,
    details: Vec<Value>,
    tags: Vec<Value>,
    children: Vec<Value>,
}

fn codex_delete_journal_snapshot(entry: Value, cascade: CodexDeleteCascadeSnapshot) -> Value {
    json!({
        "entry": entry,
        "cascade": cascade,
    })
}

fn restore_deleted_codex_entry_from_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    entry_id: &str,
    journal_snapshot: &Value,
    replay_version: i64,
) -> anyhow::Result<()> {
    let entry = journal_snapshot
        .get("entry")
        .ok_or_else(|| anyhow::anyhow!("Codex delete journal snapshot has no entry"))?;
    anyhow::ensure!(
        entry.get("id").and_then(Value::as_str) == Some(entry_id)
            && entry.get("projectId").and_then(Value::as_str) == Some(project_id),
        "Codex delete journal snapshot escaped its project"
    );
    let cascade: CodexDeleteCascadeSnapshot = serde_json::from_value(
        journal_snapshot
            .get("cascade")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Codex delete journal snapshot has no cascade"))?,
    )?;
    let existing: i64 = conn.query_row(
        "SELECT COUNT(*) FROM codex_entries WHERE id = ?1",
        rusqlite::params![entry_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        existing == 0,
        "codex entry '{}' version conflict during journal restore",
        entry_id
    );
    let now = chrono::Utc::now().to_rfc3339();
    let inserted = conn.execute(
        "INSERT INTO codex_entries
         (id, project_id, type, name, aliases, excluded_aliases, readings, summary,
          content, parent_id, icon, tags_cache, context_mode, children_budget,
          source_chat_message_id, notes, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?17, coalesce(?18, ?19), ?19)",
        rusqlite::params![
            entry_id,
            project_id,
            entry.get("type").and_then(Value::as_str).unwrap_or("lore"),
            entry
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Untitled"),
            entry.get("aliases").and_then(Value::as_str),
            entry.get("excludedAliases").and_then(Value::as_str),
            entry.get("readings").and_then(Value::as_str),
            entry.get("summary").and_then(Value::as_str),
            entry.get("content").and_then(Value::as_str).unwrap_or("{}"),
            entry.get("parentId").and_then(Value::as_str),
            entry.get("icon").and_then(Value::as_str),
            entry.get("tagsCache").and_then(Value::as_str),
            entry
                .get("contextMode")
                .and_then(Value::as_str)
                .unwrap_or("mentioned"),
            entry
                .get("childrenBudget")
                .and_then(Value::as_str)
                .unwrap_or("compact"),
            entry.get("sourceChatMessageId").and_then(Value::as_str),
            entry.get("notes").and_then(Value::as_str),
            replay_version,
            entry.get("createdAt").and_then(Value::as_str),
            now,
        ],
    )?;
    anyhow::ensure!(
        inserted == 1,
        "Codex delete restore did not insert its root"
    );
    grimodex_core::snapshots::restore_codex_authorship_spans(conn, entry_id, entry)?;

    for child in &cascade.children {
        let child_id = child
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex child restore snapshot has no id"))?;
        anyhow::ensure!(
            child.get("projectId").and_then(Value::as_str) == Some(project_id),
            "Codex child restore snapshot escaped its project"
        );
        let updated = conn.execute(
            "UPDATE codex_entries
                SET parent_id = ?1, version = version + 1, updated_at = ?2
              WHERE id = ?3 AND project_id = ?4 AND parent_id IS NULL",
            rusqlite::params![entry_id, now, child_id, project_id],
        )?;
        anyhow::ensure!(
            updated == 1,
            "Codex child '{child_id}' changed before restore"
        );
    }
    for relation in &cascade.relations {
        anyhow::ensure!(
            relation.get("projectId").and_then(Value::as_str) == Some(project_id),
            "Codex relation restore snapshot escaped its project"
        );
        conn.execute(
            "INSERT INTO codex_relations
             (id, project_id, from_codex_id, to_codex_id, relation_type, label,
              directionality, inverse_label, semantic_key, depth_hint,
              source_map_edge_id, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                     coalesce(?13, datetime('now')),
                     coalesce(?14, datetime('now')))",
            rusqlite::params![
                relation.get("id").and_then(Value::as_str),
                project_id,
                relation.get("fromCodexId").and_then(Value::as_str),
                relation.get("toCodexId").and_then(Value::as_str),
                relation
                    .get("relationType")
                    .and_then(Value::as_str)
                    .unwrap_or("custom"),
                relation.get("label").and_then(Value::as_str),
                relation
                    .get("directionality")
                    .and_then(Value::as_str)
                    .unwrap_or("directed"),
                relation.get("inverseLabel").and_then(Value::as_str),
                relation
                    .get("semanticKey")
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                relation.get("depthHint").and_then(Value::as_i64),
                relation.get("sourceMapEdgeId").and_then(Value::as_str),
                relation.get("version").and_then(Value::as_i64).unwrap_or(1),
                relation.get("createdAt").and_then(Value::as_str),
                relation.get("updatedAt").and_then(Value::as_str),
            ],
        )?;
    }
    for phase in &cascade.phases {
        conn.execute(
            "INSERT INTO codex_entry_phases
             (id, entry_id, anchor_node_id, label, summary_override,
              content_override, context_mode_override, version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                phase.get("id").and_then(Value::as_str),
                entry_id,
                phase.get("anchorNodeId").and_then(Value::as_str),
                phase.get("label").and_then(Value::as_str).unwrap_or(""),
                phase.get("summaryOverride").and_then(Value::as_str),
                phase.get("contentOverride").and_then(Value::as_str),
                phase.get("contextModeOverride").and_then(Value::as_str),
                phase.get("version").and_then(Value::as_i64).unwrap_or(0),
            ],
        )?;
    }
    for detail in &cascade.details {
        conn.execute(
            "INSERT INTO codex_detail_values
             (id, entry_id, definition_id, value, version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5,
                     coalesce(?6, datetime('now')),
                     coalesce(?7, datetime('now')))",
            rusqlite::params![
                detail.get("id").and_then(Value::as_str),
                entry_id,
                detail.get("definitionId").and_then(Value::as_str),
                detail.get("value").and_then(Value::as_str),
                detail.get("version").and_then(Value::as_i64).unwrap_or(0),
                detail.get("createdAt").and_then(Value::as_str),
                detail.get("updatedAt").and_then(Value::as_str),
            ],
        )?;
    }
    for tag in &cascade.tags {
        anyhow::ensure!(
            tag.get("entryId").and_then(Value::as_str) == Some(entry_id),
            "Codex tag restore snapshot escaped its entry"
        );
        conn.execute(
            "INSERT INTO codex_entry_tags (entry_id, tag_id) VALUES (?1, ?2)",
            rusqlite::params![entry_id, tag.get("tagId").and_then(Value::as_str)],
        )?;
    }
    Ok(())
}

fn restored_cascade_event(
    object_key: Value,
    after: &Value,
    change_kind: &str,
    changed_paths: Vec<String>,
) -> anyhow::Result<NarrativeChangeEventInput> {
    Ok(NarrativeChangeEventInput {
        object_key,
        change_kind: change_kind.to_string(),
        mutation_kind: "restore".to_string(),
        before_version: None,
        before_digest: None,
        after_version: snapshot_version(after),
        after_digest: Some(narrative_snapshot_digest(after)?),
        changed_paths: changed_paths.clone(),
        text_impact: None,
        structural_impact: Some(json!({ "changedPaths": changed_paths })),
    })
}

fn codex_delete_cascade_restore_feed_events(
    conn: &rusqlite::Connection,
    project_id: &str,
    entry_id: &str,
    root_after: &Value,
    cascade: &CodexDeleteCascadeSnapshot,
    child_before: &[Value],
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    let mut events = vec![restored_cascade_event(
        json!({ "kind": "codex-entry", "entryId": entry_id }),
        root_after,
        "metadata",
        vec!["/".to_string()],
    )?];
    for relation in &cascade.relations {
        let id = relation
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex relation restore snapshot has no id"))?;
        let after = crate::canonical_feed_snapshots::canonical_codex_relation_snapshot(
            conn, project_id, id,
        )?;
        events.push(restored_cascade_event(
            json!({ "kind": "codex-relation", "relationId": id }),
            &after,
            "association",
            vec!["/".to_string()],
        )?);
    }
    for phase in &cascade.phases {
        let id = phase
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex phase restore snapshot has no id"))?;
        events.push(restored_cascade_event(
            json!({ "kind": "codex-phase", "phaseId": id }),
            phase,
            "metadata",
            vec!["/".to_string()],
        )?);
    }
    for detail in &cascade.details {
        let value_id = detail
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex detail restore snapshot has no id"))?;
        let after = crate::canonical_feed_snapshots::canonical_codex_detail_snapshot(
            conn,
            project_id,
            detail
                .get("entryId")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("Codex detail restore snapshot has no entryId"))?,
            detail
                .get("definitionId")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    anyhow::anyhow!("Codex detail restore snapshot has no definitionId")
                })?,
        )?;
        events.push(restored_cascade_event(
            json!({ "kind": "codex-detail-value", "valueId": value_id }),
            &after,
            "metadata",
            vec!["/".to_string()],
        )?);
    }
    anyhow::ensure!(
        child_before.len() == cascade.children.len(),
        "Codex child restore snapshot count changed"
    );
    for before in child_before {
        let child_id = before
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex child restore snapshot has no id"))?;
        let after = collect_codex_entry_snapshot(conn, child_id)?;
        let changed_paths = vec!["/parentId".to_string()];
        events.push(NarrativeChangeEventInput {
            object_key: json!({ "kind": "codex-entry", "entryId": child_id }),
            change_kind: "metadata".to_string(),
            mutation_kind: "update".to_string(),
            before_version: snapshot_version(before),
            before_digest: Some(narrative_snapshot_digest(before)?),
            after_version: snapshot_version(&after),
            after_digest: Some(narrative_snapshot_digest(&after)?),
            changed_paths: changed_paths.clone(),
            text_impact: None,
            structural_impact: Some(json!({ "changedPaths": changed_paths })),
        });
    }
    anyhow::ensure!(
        root_after.get("projectId").and_then(Value::as_str) == Some(project_id),
        "restored Codex root escaped its project"
    );
    Ok(events)
}

fn collect_json_rows<P: rusqlite::Params>(
    conn: &rusqlite::Connection,
    sql: &str,
    params: P,
) -> anyhow::Result<Vec<Value>> {
    let mut statement = conn.prepare(sql)?;
    let rows = statement.query_map(params, |row| row.get::<_, String>(0))?;
    rows.map(|row| {
        let raw = row?;
        serde_json::from_str(&raw).map_err(Into::into)
    })
    .collect()
}

fn collect_codex_delete_cascade_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    entry_id: &str,
) -> anyhow::Result<CodexDeleteCascadeSnapshot> {
    let relations = collect_json_rows(
        conn,
        "SELECT json_object(
             'id', relation.id,
             'projectId', relation.project_id,
             'fromCodexId', relation.from_codex_id,
             'toCodexId', relation.to_codex_id,
             'relationType', relation.relation_type,
             'label', relation.label,
             'directionality', relation.directionality,
             'inverseLabel', relation.inverse_label,
             'semanticKey', relation.semantic_key,
             'depthHint', relation.depth_hint,
             'sourceMapEdgeId', relation.source_map_edge_id,
             'version', relation.version,
             'createdAt', relation.created_at,
             'updatedAt', relation.updated_at
           )
           FROM codex_relations relation
          WHERE relation.project_id = ?1
            AND (relation.from_codex_id = ?2 OR relation.to_codex_id = ?2)
          ORDER BY relation.id",
        rusqlite::params![project_id, entry_id],
    )?;
    let phases = collect_json_rows(
        conn,
        "SELECT json_object(
             'id', phase.id,
             'entryId', phase.entry_id,
             'anchorNodeId', phase.anchor_node_id,
             'label', phase.label,
             'summaryOverride', phase.summary_override,
             'contentOverride', phase.content_override,
             'contextModeOverride', phase.context_mode_override,
             'version', phase.version
           )
           FROM codex_entry_phases phase
           JOIN codex_entries entry ON entry.id = phase.entry_id
          WHERE entry.project_id = ?1 AND phase.entry_id = ?2
          ORDER BY phase.id",
        rusqlite::params![project_id, entry_id],
    )?;
    let details = collect_json_rows(
        conn,
        "SELECT json_object(
             'id', value.id,
             'entryId', value.entry_id,
             'definitionId', value.definition_id,
             'value', value.value,
             'version', value.version,
             'createdAt', value.created_at,
             'updatedAt', value.updated_at
           )
           FROM codex_detail_values value
           JOIN codex_entries entry ON entry.id = value.entry_id
          WHERE entry.project_id = ?1 AND value.entry_id = ?2
          ORDER BY value.id",
        rusqlite::params![project_id, entry_id],
    )?;
    let tags = collect_json_rows(
        conn,
        "SELECT json_object('entryId', association.entry_id, 'tagId', association.tag_id)
           FROM codex_entry_tags association
           JOIN codex_entries entry ON entry.id = association.entry_id
           JOIN codex_tags tag ON tag.id = association.tag_id
          WHERE entry.project_id = ?1 AND tag.project_id = ?1
            AND association.entry_id = ?2
          ORDER BY association.tag_id",
        rusqlite::params![project_id, entry_id],
    )?;
    let mut child_ids = conn.prepare(
        "SELECT id FROM codex_entries
          WHERE project_id = ?1 AND parent_id = ?2
          ORDER BY id",
    )?;
    let children = child_ids
        .query_map(rusqlite::params![project_id, entry_id], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|child_id| collect_codex_entry_snapshot(conn, &child_id))
        .collect::<anyhow::Result<Vec<_>>>()?;
    Ok(CodexDeleteCascadeSnapshot {
        relations,
        phases,
        details,
        tags,
        children,
    })
}

fn snapshot_version(snapshot: &Value) -> Option<i64> {
    snapshot.get("version").and_then(Value::as_i64)
}

fn deleted_cascade_event(
    object_key: Value,
    before: &Value,
    change_kind: &str,
    changed_paths: Vec<String>,
) -> anyhow::Result<NarrativeChangeEventInput> {
    Ok(NarrativeChangeEventInput {
        object_key,
        change_kind: change_kind.to_string(),
        mutation_kind: "delete".to_string(),
        before_version: snapshot_version(before),
        before_digest: Some(narrative_snapshot_digest(before)?),
        after_version: None,
        after_digest: None,
        changed_paths: changed_paths.clone(),
        text_impact: None,
        structural_impact: Some(json!({ "changedPaths": changed_paths })),
    })
}

fn codex_delete_cascade_feed_events(
    conn: &rusqlite::Connection,
    snapshot: &CodexDeleteCascadeSnapshot,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    let mut events = Vec::new();
    for relation in &snapshot.relations {
        let id = relation
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex relation cascade snapshot has no id"))?;
        events.push(deleted_cascade_event(
            json!({ "kind": "codex-relation", "relationId": id }),
            relation,
            "association",
            vec!["/".to_string()],
        )?);
    }
    for phase in &snapshot.phases {
        let id = phase
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex phase cascade snapshot has no id"))?;
        events.push(deleted_cascade_event(
            json!({ "kind": "codex-phase", "phaseId": id }),
            phase,
            "metadata",
            vec!["/".to_string()],
        )?);
    }
    for detail in &snapshot.details {
        let value_id = detail
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex detail cascade snapshot has no id"))?;
        events.push(deleted_cascade_event(
            json!({ "kind": "codex-detail-value", "valueId": value_id }),
            detail,
            "metadata",
            vec!["/".to_string()],
        )?);
    }
    for child_before in &snapshot.children {
        let child_id = child_before
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("Codex child cascade snapshot has no id"))?;
        let child_after = collect_codex_entry_snapshot(conn, child_id)?;
        let changed_paths = vec!["/parentId".to_string()];
        events.push(NarrativeChangeEventInput {
            object_key: json!({ "kind": "codex-entry", "entryId": child_id }),
            change_kind: "metadata".to_string(),
            mutation_kind: "update".to_string(),
            before_version: snapshot_version(child_before),
            before_digest: Some(narrative_snapshot_digest(child_before)?),
            after_version: snapshot_version(&child_after),
            after_digest: Some(narrative_snapshot_digest(&child_after)?),
            changed_paths: changed_paths.clone(),
            text_impact: None,
            structural_impact: Some(json!({ "changedPaths": changed_paths })),
        });
    }
    Ok(events)
}

fn codex_delete_cascade_ids(snapshot: &CodexDeleteCascadeSnapshot) -> Value {
    let ids = |rows: &[Value]| {
        rows.iter()
            .filter_map(|row| row.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    json!({
        "relationIds": ids(&snapshot.relations),
        "phaseIds": ids(&snapshot.phases),
        "detailValueIds": ids(&snapshot.details),
        "tagIds": snapshot.tags.iter().filter_map(|row| row.get("tagId").and_then(Value::as_str)).map(str::to_string).collect::<Vec<_>>(),
        "childEntryIds": ids(&snapshot.children),
    })
}

pub(crate) fn delete_codex_entry_cascade(
    conn: &rusqlite::Connection,
    project_id: &str,
    entry_id: &str,
    expected_version: Option<i64>,
) -> anyhow::Result<()> {
    let deleted = match expected_version {
        Some(version) => conn.execute(
            "DELETE FROM codex_entries WHERE id = ?1 AND project_id = ?2 AND version = ?3",
            rusqlite::params![entry_id, project_id, version],
        )?,
        None => conn.execute(
            "DELETE FROM codex_entries WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![entry_id, project_id],
        )?,
    };
    if deleted == 0 {
        if let Some(version) = expected_version {
            anyhow::bail!(
                "codex entry '{}' version {} conflict during journal restore",
                entry_id,
                version
            );
        }
        anyhow::bail!(
            "codex entry '{entry_id}' not found in project '{project_id}' during restore"
        );
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn restore_renderer_codex_delete_cascade_in_tx(
    conn: &rusqlite::Connection,
    payload: &AgentCodexCreatePayload,
    context: &RendererCanonicalWriteContext,
    entry_id: &str,
    event_uid: &str,
    request_hash: &str,
    timestamp: i64,
) -> anyhow::Result<Option<AgentWriteResult>> {
    if context.origin != NarrativeChangeOrigin::Undo {
        return Ok(None);
    }
    let journal_id = context
        .undo_journal_id
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Codex restore requires undoJournalId"))?;
    let journal =
        grimodex_core::undo_journal::load_undo_journal(conn, &payload.project_id, journal_id)?;
    if journal.entity_kind != "codex_entry" || journal.op_kind != "delete" {
        return Ok(None);
    }
    anyhow::ensure!(
        journal.entity_id == entry_id,
        "Codex delete restore journal identifies another entry"
    );
    let raw = journal
        .before_json
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Codex delete restore journal has no before snapshot"))?;
    let journal_snapshot: Value = serde_json::from_str(raw)?;
    let Some(cascade_value) = journal_snapshot.get("cascade") else {
        // Legacy root-only delete journal. The normal create replay below
        // preserves backward compatibility for workspaces created pre-C1.
        return Ok(None);
    };
    let cascade: CodexDeleteCascadeSnapshot = serde_json::from_value(cascade_value.clone())?;
    let child_before = cascade
        .children
        .iter()
        .map(|child| {
            let child_id = child
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow::anyhow!("Codex child restore snapshot has no id"))?;
            collect_codex_entry_snapshot(conn, child_id)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let replay_version = journal
        .base_version
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("Codex delete restore version overflow"))?;
    restore_deleted_codex_entry_from_snapshot(
        conn,
        &payload.project_id,
        entry_id,
        &journal_snapshot,
        replay_version,
    )?;
    grimodex_core::undo_journal::advance_codex_journal_state_token(
        conn,
        &payload.project_id,
        entry_id,
        journal.base_version,
        replay_version,
    )?;
    let root_after = collect_codex_entry_snapshot(conn, entry_id)?;
    let narrative_events = codex_delete_cascade_restore_feed_events(
        conn,
        &payload.project_id,
        entry_id,
        &root_after,
        &cascade,
        &child_before,
    )?;
    let canonical_payload = context.canonical_payload.clone().unwrap_or_else(|| {
        json!({
            "name": root_after.get("name").cloned().unwrap_or(Value::Null),
            "type": root_after.get("type").cloned().unwrap_or(Value::Null),
            "cascade": codex_delete_cascade_ids(&cascade),
        })
    });
    let canonical_event = AppendChangeEvent {
        event_uid: event_uid.to_string(),
        scene_id: None,
        domain: "codex".to_string(),
        op_type: "entry.restore".to_string(),
        entity_type: Some("codex_entry".to_string()),
        entity_id: Some(entry_id.to_string()),
        payload: canonical_payload.to_string(),
        timestamp,
    };
    append_agent_forward_change_in_tx(
        conn,
        &payload.project_id,
        &payload.session_id,
        payload.surface.as_deref(),
        Some(&context.request_id),
        journal_id,
        &canonical_event,
        Some(narrative_events),
        Some(context),
    )?;
    // Ensure semantically-different retries cannot claim the restored result.
    let _ = request_hash;
    Ok(Some(AgentWriteResult {
        entity_id: entry_id.to_string(),
        version: root_after
            .get("version")
            .and_then(Value::as_i64)
            .unwrap_or(journal.base_version + 1),
        change_event_uid: event_uid.to_string(),
        undo_journal_id: journal_id.to_string(),
    }))
}

pub fn agent_codex_create_impl(
    db: &Database,
    payload: AgentCodexCreatePayload,
) -> anyhow::Result<Value> {
    require_agent_request_id(payload.request_id.as_deref())?;
    agent_codex_create_internal(db, payload, None, None)
}

pub fn agent_codex_create_with_tags_impl(
    db: &Database,
    payload: AgentCodexCreatePayload,
    tags: Option<&[String]>,
) -> anyhow::Result<Value> {
    require_agent_request_id(payload.request_id.as_deref())?;
    agent_codex_create_internal(db, payload, tags, None)
}

pub fn renderer_codex_create_impl(
    db: &Database,
    payload: AgentCodexCreatePayload,
    context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    validate_renderer_codex_identity(&payload.project_id, &payload.session_id, &context)?;
    agent_codex_create_internal(db, payload, None, Some(context))
}

fn agent_codex_create_internal(
    db: &Database,
    payload: AgentCodexCreatePayload,
    tags: Option<&[String]>,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    let request_hash = match renderer_context.as_ref() {
        Some(context) => {
            renderer_codex_request_hash("renderer_agent_codex_create", &payload, context, tags)?
        }
        None => codex_create_request_hash(&payload, tags)?,
    };
    let legacy_entity_request = payload.request_id.is_none() && payload.entry_id.is_some();
    let feed_request_id = renderer_context
        .as_ref()
        .map(|context| context.request_id.clone())
        .or_else(|| payload.request_id.clone());
    let request_id = renderer_context
        .as_ref()
        .map(|context| context.request_id.clone())
        .or_else(|| payload.request_id.clone())
        .or_else(|| payload.entry_id.clone());
    let renderer_request_hash = renderer_context
        .as_ref()
        .map(|context| {
            renderer_codex_request_hash("renderer_agent_codex_create", &payload, context, tags)
        })
        .transpose()?;
    let renderer_request =
        renderer_request_hash
            .as_deref()
            .map(|payload_hash| IdempotencyRequest {
                domain: "renderer_agent_codex_create",
                request_id: renderer_context
                    .as_ref()
                    .map(|context| context.request_id.as_str()),
                payload_hash,
                conflict_marker: "AGENT_CODEX_CREATE_IDEMPOTENCY_CONFLICT",
            });
    let entry_id = payload
        .entry_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let undo_id = renderer_context
        .as_ref()
        .and_then(|context| context.undo_journal_id.clone())
        .or_else(|| request_id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = renderer_context
        .as_ref()
        .map(|context| context.event_uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let restore_payload = payload.clone();
    let content = payload.content.unwrap_or_else(|| "{}".to_string());
    let summary = payload.summary.unwrap_or_default();
    let aliases = payload.aliases;
    let excluded_aliases = payload.excluded_aliases;
    let readings = payload.readings;
    let tags_cache = payload.tags_cache;
    let parent_id = payload.parent_id;
    let source_chat_message_id = payload.source_chat_message_id;
    let surface = payload.surface.clone();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            if let Some(request) = renderer_request.as_ref() {
                if let Some(existing) = load_idempotent_response(conn, request)? {
                    return serde_json::from_value(existing).map_err(Into::into);
                }
            }
            validate_renderer_replay_lineage_in_tx(
                conn,
                &payload.project_id,
                renderer_context.as_ref(),
            )?;
            if let Some(context) = renderer_context.as_ref() {
                if let Some(restored) = restore_renderer_codex_delete_cascade_in_tx(
                    conn,
                    &restore_payload,
                    context,
                    &entry_id,
                    &event_uid,
                    &request_hash,
                    timestamp,
                )? {
                    if let Some(request) = renderer_request.as_ref() {
                        insert_idempotent_response(
                            conn,
                            request,
                            &payload.project_id,
                            &serde_json::to_value(&restored)?,
                        )?;
                    }
                    return Ok(restored);
                }
            }
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
            let created = apply_codex_entry_create_in_tx(
                conn,
                CodexEntryCreateTxInput {
                    project_id: &payload.project_id,
                    session_id: &payload.session_id,
                    surface: surface.as_deref().or(Some("in-app-agent")),
                    entry_id: &entry_id,
                    undo_id: &undo_id,
                    event_uid: &event_uid,
                    type_slug: &payload.type_slug,
                    name: &payload.name,
                    summary: &summary,
                    content: &content,
                    aliases: aliases.as_deref(),
                    excluded_aliases: excluded_aliases.as_deref(),
                    readings: readings.as_deref(),
                    tags_cache: tags_cache.as_deref(),
                    tags,
                    parent_id: parent_id.as_deref(),
                    source_chat_message_id: source_chat_message_id.as_deref(),
                    authorship_spans: &payload.authorship_spans,
                    model: payload.model.as_deref(),
                    chat_message_id: payload.chat_message_id.as_deref(),
                    trace_id: payload.trace_id.as_deref(),
                    request_hash: request_id.as_ref().map(|_| request_hash.as_str()),
                    now: &now,
                    timestamp,
                    write_undo_journal: !is_renderer_replay(renderer_context.as_ref()),
                    write_change_event: false,
                },
            )?;
            if let Some(context) = renderer_context.as_ref() {
                apply_renderer_codex_create_fields(
                    conn,
                    &payload.project_id,
                    &created.entity_id,
                    &created.undo_journal_id,
                    context,
                )?;
            }
            let mut canonical_event = created.canonical_event.clone();
            if renderer_context
                .as_ref()
                .is_none_or(|context| context.authority_route != "interactive-agent-command")
            {
                if let Some(audit_payload) = renderer_context
                    .as_ref()
                    .and_then(|context| context.canonical_payload.as_ref())
                {
                    canonical_event.payload = audit_payload.to_string();
                }
            }
            append_agent_forward_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                surface.as_deref(),
                feed_request_id.as_deref(),
                &created.undo_journal_id,
                &canonical_event,
                None,
                renderer_context.as_ref(),
            )?;
            if renderer_context
                .as_ref()
                .is_none_or(|context| context.origin == NarrativeChangeOrigin::Human)
            {
                record_manual_codex_entry_fields(
                    conn,
                    &payload.project_id,
                    &created.entity_id,
                    surface.as_deref(),
                    CODEX_ENTRY_AUTHORITY_FIELDS,
                    &now,
                )?;
            }
            let response = AgentWriteResult {
                entity_id: created.entity_id,
                version: created.version,
                change_event_uid: created.change_event_uid,
                undo_journal_id: created.undo_journal_id,
            };
            if let Some(request) = renderer_request.as_ref() {
                insert_idempotent_response(
                    conn,
                    request,
                    &payload.project_id,
                    &serde_json::to_value(&response)?,
                )?;
            }
            Ok(response)
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                if renderer_context.is_some() {
                    attach_maintenance_transaction_id(conn, &payload.project_id, &res)
                } else {
                    Ok(serde_json::to_value(res)?)
                }
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
    agent_codex_update_internal(db, payload, None, None, None)
}

pub fn agent_codex_update_with_request_impl(
    db: &Database,
    payload: AgentCodexUpdatePayload,
    request_id: Option<&str>,
    tags: Option<&[String]>,
) -> anyhow::Result<Value> {
    agent_codex_update_internal(db, payload, request_id, tags, None)
}

pub fn renderer_codex_update_impl(
    db: &Database,
    payload: AgentCodexUpdatePayload,
    context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    validate_renderer_codex_identity(&payload.project_id, &payload.session_id, &context)?;
    agent_codex_update_internal(db, payload, None, None, Some(context))
}

fn agent_codex_update_internal(
    db: &Database,
    payload: AgentCodexUpdatePayload,
    legacy_request_id: Option<&str>,
    tags: Option<&[String]>,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    let request_id = renderer_context
        .as_ref()
        .map(|context| context.request_id.as_str())
        .or(legacy_request_id);
    let request_hash = match renderer_context.as_ref() {
        Some(context) => Some(renderer_codex_request_hash(
            "renderer_agent_codex_update",
            &payload,
            context,
            tags,
        )?),
        None => request_id
            .map(|_| codex_update_request_hash(&payload, tags))
            .transpose()?,
    };
    let request = request_hash
        .as_deref()
        .map(|payload_hash| IdempotencyRequest {
            domain: "agent_codex_update",
            request_id,
            payload_hash,
            conflict_marker: "AGENT_CODEX_UPDATE_IDEMPOTENCY_CONFLICT",
        });
    let undo_id = renderer_context
        .as_ref()
        .and_then(|context| context.undo_journal_id.clone())
        .or_else(|| request_id.map(str::to_string))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = renderer_context
        .as_ref()
        .map(|context| context.event_uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;

        let result = (|| -> anyhow::Result<AgentWriteResult> {
            if let Some(request) = request.as_ref() {
                if let Some(existing) = load_idempotent_response(conn, request)? {
                    return serde_json::from_value(existing).map_err(Into::into);
                }
            }
            validate_renderer_replay_lineage_in_tx(
                conn,
                &payload.project_id,
                renderer_context.as_ref(),
            )?;
            let manual_fields = manual_update_fields(&payload);
            let mut authority_paths = manual_fields
                .iter()
                .map(|path| (*path).to_string())
                .collect::<Vec<_>>();
            if tags.is_some() {
                authority_paths.push("/tagsCache".to_string());
            }
            if payload.surface.as_deref() == Some("mcp")
                && authority_paths.is_empty()
                && tags.is_none()
            {
                anyhow::bail!("MCP codex update must change at least one field or tag set");
            }
            preflight_agent_field_authority(
                conn,
                &payload.project_id,
                "codex-entry",
                &payload.entry_id,
                &authority_paths,
                &change_occurred_at(timestamp)?,
                payload.surface.as_deref(),
                renderer_context.as_ref(),
            )?;
            let patched = apply_codex_entry_patch_in_tx(
                conn,
                CodexEntryPatchTxInput {
                    project_id: &payload.project_id,
                    session_id: &payload.session_id,
                    surface: payload.surface.as_deref().or(Some("in-app-agent")),
                    entry_id: &payload.entry_id,
                    undo_id: &undo_id,
                    event_uid: &event_uid,
                    base_version: payload.base_version,
                    type_slug: payload.type_slug.as_deref(),
                    name: payload.name.as_deref(),
                    summary: payload.summary.as_deref(),
                    summary_fill_if_empty: false,
                    content: payload.content.as_deref(),
                    aliases: payload.aliases.as_deref(),
                    excluded_aliases: payload.excluded_aliases.as_deref(),
                    readings: payload.readings.as_deref(),
                    tags_cache: payload.tags_cache.as_deref(),
                    tags,
                    parent_id: payload.parent_id.as_deref(),
                    context_mode: payload.context_mode.as_deref(),
                    icon: payload.icon.as_deref(),
                    children_budget: payload.children_budget.as_deref(),
                    notes: payload.notes.as_deref(),
                    authorship_spans: payload.authorship_spans.as_deref(),
                    authorship_span_lanes: payload.authorship_span_lanes.as_deref(),
                    model: payload.model.as_deref(),
                    chat_message_id: payload.chat_message_id.as_deref(),
                    trace_id: payload.trace_id.as_deref(),
                    now: &now,
                    timestamp,
                    write_undo_journal: !is_renderer_replay(renderer_context.as_ref()),
                    write_change_event: false,
                    aliases_and_empty_summary_only: false,
                },
            )?;
            let mut canonical_event = patched.canonical_event.clone();
            if renderer_context
                .as_ref()
                .is_none_or(|context| context.authority_route != "interactive-agent-command")
            {
                if let Some(audit_payload) = renderer_context
                    .as_ref()
                    .and_then(|context| context.canonical_payload.as_ref())
                {
                    canonical_event.payload = audit_payload.to_string();
                }
            }
            let cause_kind = renderer_context
                .as_ref()
                .map_or(NarrativeChangeCauseKind::Forward, |context| {
                    renderer_cause_kind(context.origin)
                });
            let journal_row = grimodex_core::undo_journal::load_undo_journal(
                conn,
                &payload.project_id,
                &patched.undo_journal_id,
            )?;
            let mut narrative_events = vec![event_from_undo_journal_row(&journal_row, cause_kind)?];
            if codex_patch_invalidates_linked_foreshadows(&payload) {
                narrative_events.extend(invalidate_linked_foreshadows_in_tx(
                    conn,
                    &payload.project_id,
                    &patched.entity_id,
                    timestamp,
                )?);
            }
            append_agent_forward_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                payload.surface.as_deref(),
                request_id,
                &patched.undo_journal_id,
                &canonical_event,
                Some(narrative_events),
                renderer_context.as_ref(),
            )?;
            if renderer_context
                .as_ref()
                .is_none_or(|context| context.origin == NarrativeChangeOrigin::Human)
            {
                record_manual_codex_entry_fields(
                    conn,
                    &payload.project_id,
                    &patched.entity_id,
                    payload.surface.as_deref(),
                    &manual_fields,
                    &now,
                )?;
            }
            let response = AgentWriteResult {
                entity_id: patched.entity_id,
                version: patched.version,
                change_event_uid: patched.change_event_uid,
                undo_journal_id: patched.undo_journal_id,
            };
            if let Some(request) = request.as_ref() {
                insert_idempotent_response(
                    conn,
                    request,
                    &payload.project_id,
                    &serde_json::to_value(&response)?,
                )?;
            }
            Ok(response)
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                if renderer_context.is_some() {
                    let mut value =
                        attach_maintenance_transaction_id(conn, &payload.project_id, &res)?;
                    if codex_patch_invalidates_linked_foreshadows(&payload) {
                        value["relatedForeshadows"] = Value::Array(linked_foreshadow_rows(
                            conn,
                            &payload.project_id,
                            &payload.entry_id,
                        )?);
                    }
                    Ok(value)
                } else {
                    Ok(serde_json::to_value(res)?)
                }
            }
            Err(e) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    })
}

/// Codex entry deletion (OCC + Undo Journal + canonical/maintenance events).
/// Renderer deletes snapshot the authoritative Codex cascade before the FK
/// delete and restore that snapshot through the typed create/undo path.
pub fn agent_codex_delete_impl(
    db: &Database,
    payload: AgentCodexDeletePayload,
) -> anyhow::Result<Value> {
    agent_codex_delete_internal(db, payload, None)
}

pub fn renderer_codex_delete_impl(
    db: &Database,
    payload: AgentCodexDeletePayload,
    context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    validate_renderer_codex_identity(&payload.project_id, &payload.session_id, &context)?;
    agent_codex_delete_internal(db, payload, Some(context))
}

fn agent_codex_delete_internal(
    db: &Database,
    payload: AgentCodexDeletePayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    let request_hash = renderer_context
        .as_ref()
        .map(|context| {
            renderer_codex_request_hash("renderer_agent_codex_delete", &payload, context, None)
        })
        .transpose()?;
    let idempotency_request = request_hash
        .as_deref()
        .map(|payload_hash| IdempotencyRequest {
            domain: "renderer_agent_codex_delete",
            request_id: renderer_context
                .as_ref()
                .map(|context| context.request_id.as_str()),
            payload_hash,
            conflict_marker: "AGENT_CODEX_DELETE_IDEMPOTENCY_CONFLICT",
        });
    let undo_id = renderer_context
        .as_ref()
        .and_then(|context| context.undo_journal_id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = renderer_context
        .as_ref()
        .map(|context| context.event_uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            if let Some(request) = idempotency_request.as_ref() {
                if let Some(existing) = load_idempotent_response(conn, request)? {
                    return serde_json::from_value(existing).map_err(Into::into);
                }
            }
            validate_renderer_replay_lineage_in_tx(
                conn,
                &payload.project_id,
                renderer_context.as_ref(),
            )?;
            let db_version: i64 = conn.query_row(
                "SELECT version FROM codex_entries WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![payload.entry_id, payload.project_id],
                |row| row.get(0),
            )?;
            if db_version != payload.base_version {
                anyhow::bail!(
                    "Codex entry '{}' version conflict: expected {} but database has {}",
                    payload.entry_id,
                    payload.base_version,
                    db_version
                );
            }
            let before_snapshot = collect_codex_entry_snapshot(conn, &payload.entry_id)?;
            let cascade_snapshot = collect_codex_delete_cascade_snapshot(
                conn,
                &payload.project_id,
                &payload.entry_id,
            )?;
            let authority_paths = all_authority_paths("codex_entry")
                .iter()
                .map(|path| (*path).to_string())
                .collect::<Vec<_>>();
            preflight_agent_field_authority(
                conn,
                &payload.project_id,
                "codex-entry",
                &payload.entry_id,
                &authority_paths,
                &change_occurred_at(timestamp)?,
                payload.surface.as_deref(),
                renderer_context.as_ref(),
            )?;
            let before_json =
                codex_delete_journal_snapshot(before_snapshot.clone(), cascade_snapshot.clone())
                    .to_string();

            delete_codex_entry_cascade(
                conn,
                &payload.project_id,
                &payload.entry_id,
                Some(payload.base_version),
            )?;

            if !is_renderer_replay(renderer_context.as_ref()) {
                insert_undo_journal_in_tx(
                    conn,
                    UndoJournalInsert {
                        id: &undo_id,
                        project_id: &payload.project_id,
                        surface: payload.surface.as_deref().unwrap_or("in-app-agent"),
                        entity_kind: "codex_entry",
                        entity_id: &payload.entry_id,
                        op_kind: "delete",
                        before_json: Some(&before_json),
                        after_json: None,
                        base_version: payload.base_version,
                        result_version: payload.base_version,
                        change_event_uid: Some(&event_uid),
                    },
                )?;
            }

            let mut canonical_payload = renderer_context
                .as_ref()
                .and_then(|context| context.canonical_payload.clone())
                .unwrap_or_else(|| {
                    json!({
                        "name": before_snapshot.get("name").cloned().unwrap_or(Value::Null),
                        "type": before_snapshot.get("type").cloned().unwrap_or(Value::Null),
                    })
                });
            if let Some(payload_object) = canonical_payload.as_object_mut() {
                payload_object.insert(
                    "cascade".to_string(),
                    codex_delete_cascade_ids(&cascade_snapshot),
                );
            }
            let canonical_event = AppendChangeEvent {
                event_uid: event_uid.clone(),
                scene_id: None,
                domain: "codex".to_string(),
                op_type: "entry.delete".to_string(),
                entity_type: Some("codex_entry".to_string()),
                entity_id: Some(payload.entry_id.clone()),
                payload: canonical_payload.to_string(),
                timestamp,
            };
            let mut narrative_events = vec![deleted_cascade_event(
                json!({ "kind": "codex-entry", "entryId": payload.entry_id }),
                &before_snapshot,
                "metadata",
                vec!["/".to_string()],
            )?];
            narrative_events.extend(codex_delete_cascade_feed_events(conn, &cascade_snapshot)?);
            append_agent_forward_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                payload.surface.as_deref(),
                None,
                &undo_id,
                &canonical_event,
                Some(narrative_events),
                renderer_context.as_ref(),
            )?;

            if renderer_context
                .as_ref()
                .is_none_or(|context| context.origin == NarrativeChangeOrigin::Human)
            {
                record_manual_codex_entry_fields(
                    conn,
                    &payload.project_id,
                    &payload.entry_id,
                    payload.surface.as_deref(),
                    CODEX_ENTRY_AUTHORITY_FIELDS,
                    &chrono::Utc::now().to_rfc3339(),
                )?;
            }

            let response = AgentWriteResult {
                entity_id: payload.entry_id.clone(),
                version: payload.base_version,
                change_event_uid: event_uid.clone(),
                undo_journal_id: undo_id.clone(),
            };
            if let Some(request) = idempotency_request.as_ref() {
                insert_idempotent_response(
                    conn,
                    request,
                    &payload.project_id,
                    &serde_json::to_value(&response)?,
                )?;
            }
            Ok(response)
        })();

        match result {
            Ok(res) => {
                grimodex_core::commit_or_rollback(conn)?;
                if renderer_context.is_some() {
                    attach_maintenance_transaction_id(conn, &payload.project_id, &res)
                } else {
                    Ok(serde_json::to_value(res)?)
                }
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
    _db: &Database,
    _payload: AgentWriteBundlePayload,
) -> anyhow::Result<Value> {
    anyhow::bail!(
        "AGENT_WRITE_BUNDLE_TYPED_WRITER_REQUIRED: generic SQL domain mutations are disabled"
    )
}

pub fn renderer_agent_snippet_create_impl(
    db: &Database,
    payload: AgentSnippetCreatePayload,
    context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    let request_id = require_agent_request_id(payload.request_id.as_deref())?;
    validate_renderer_authority_context_for_routes(&context, &["interactive-agent-command"])?;
    anyhow::ensure!(
        request_id == context.request_id,
        "requestId must match canonical authority context"
    );
    agent_snippet_create_with_surface_and_renderer_context(
        db,
        payload,
        "in-app-agent",
        Some(&context),
    )
}

pub fn agent_snippet_create_impl(
    db: &Database,
    payload: AgentSnippetCreatePayload,
) -> anyhow::Result<Value> {
    agent_snippet_create_with_surface_impl(db, payload, "in-app-agent")
}

pub fn agent_snippet_create_with_surface_impl(
    db: &Database,
    payload: AgentSnippetCreatePayload,
    surface: &str,
) -> anyhow::Result<Value> {
    agent_snippet_create_with_surface_and_renderer_context(db, payload, surface, None)
}

fn agent_snippet_create_with_surface_and_renderer_context(
    db: &Database,
    payload: AgentSnippetCreatePayload,
    surface: &str,
    renderer_context: Option<&RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    require_agent_request_id(payload.request_id.as_deref())?;
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
    let event_uid = renderer_context
        .map(|context| context.event_uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
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
            if let Some(scene_id) = payload.scene_id.as_deref() {
                let owned_scene = conn
                    .query_row(
                        "SELECT 1 FROM tree_nodes
                          WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
                        rusqlite::params![scene_id, payload.project_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .is_some();
                anyhow::ensure!(
                    owned_scene,
                    "snippet scene is not in project '{}'",
                    payload.project_id
                );
            }
            if let Some(message_id) = payload.source_chat_message_id.as_deref() {
                let owned_message = conn
                    .query_row(
                        "SELECT 1
                           FROM chat_messages message
                           JOIN chat_sessions session ON session.id = message.session_id
                          WHERE message.id = ?1 AND session.project_id = ?2",
                        rusqlite::params![message_id, payload.project_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()?
                    .is_some();
                anyhow::ensure!(
                    owned_message,
                    "snippet source chat message is not in project '{}'",
                    payload.project_id
                );
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
                    surface,
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

            let canonical_event = AppendChangeEvent {
                event_uid: event_uid.clone(),
                scene_id: payload.scene_id.clone(),
                domain: "snippet".to_string(),
                op_type: "snippet.create".to_string(),
                entity_type: Some("snippet".to_string()),
                entity_id: Some(snippet_id.clone()),
                payload: change_payload.to_string(),
                timestamp,
            };
            append_agent_forward_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                Some(surface),
                request_id.as_deref(),
                &undo_id,
                &canonical_event,
                None,
                renderer_context,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProseStageIdPayload {
    #[serde(default)]
    pub request_id: Option<String>,
    pub project_id: String,
    pub session_id: String,
    pub staging_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
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
    if matches!(payload.request_id.as_deref(), Some(request_id) if request_id.trim().is_empty()) {
        anyhow::bail!("requestId must not be empty");
    }
    let request_id = payload
        .request_id
        .clone()
        .unwrap_or_else(|| format!("prose.accept:{}", payload.staging_id));
    let mut normalized = payload.clone();
    normalized.request_id = None;
    normalized.session_id.clear();
    let request_hash = idempotency_hash("agent_prose_accept", &normalized)?;
    let idempotency_request = IdempotencyRequest {
        domain: "agent_prose_accept",
        request_id: Some(&request_id),
        payload_hash: &request_hash,
        conflict_marker: "AGENT_PROSE_ACCEPT_IDEMPOTENCY_CONFLICT",
    };
    let event_uid = request_id.clone();
    let timestamp = chrono::Utc::now().timestamp_millis();
    let now = chrono::Utc::now().to_rfc3339();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<ProseStageResult> {
            if let Some(existing) = load_idempotent_response(conn, &idempotency_request)? {
                return serde_json::from_value(existing).map_err(Into::into);
            }
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
            let canonical_event = AppendChangeEvent {
                event_uid: event_uid.clone(),
                scene_id: Some(scene_id.clone()),
                domain: "prose".to_string(),
                op_type: "prose.accept".to_string(),
                entity_type: Some("prose_staging".to_string()),
                entity_id: Some(payload.staging_id.clone()),
                payload: change_payload.to_string(),
                timestamp,
            };
            append_change_events_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                std::slice::from_ref(&canonical_event),
            )?;

            let response = ProseStageResult {
                staging_id: payload.staging_id.clone(),
                scene_id,
                status: "accepted".to_string(),
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
    pub request_id: String,
    pub project_id: String,
    pub session_id: String,
    pub journal_id: String,
    /// "undo" | "redo"
    pub direction: String,
    pub authority_route: String,
    pub origin: String,
    pub caller: String,
    pub controls: Vec<String>,
}

fn validate_undo_journal_authority(payload: &AgentUndoJournalPayload) -> anyhow::Result<()> {
    anyhow::ensure!(
        payload.authority_route == "history-replay",
        "undo journal requires the history-replay authority route"
    );
    anyhow::ensure!(
        payload.direction == "undo" || payload.direction == "redo",
        "undo journal direction must be undo or redo"
    );
    anyhow::ensure!(
        payload.origin == payload.direction,
        "undo journal origin must match direction"
    );
    anyhow::ensure!(
        payload.caller == "undo-redo-command",
        "undo journal caller must be undo-redo-command"
    );
    for control in [
        "original-transaction",
        "journal-lineage",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
    ] {
        anyhow::ensure!(
            payload.controls.iter().any(|value| value == control),
            "undo journal authority is missing control '{control}'"
        );
    }
    Ok(())
}

fn legacy_journal_forward_origin(surface: &str) -> NarrativeChangeOrigin {
    match surface {
        "import" => NarrativeChangeOrigin::Import,
        "migration" | "legacy" => NarrativeChangeOrigin::Migration,
        "in-app-agent" | "mcp" | "narrative-extraction" => NarrativeChangeOrigin::AiApply,
        _ => NarrativeChangeOrigin::Human,
    }
}

/// Establish the missing C0 Feed root for a journal created before SCHEMA 21.
///
/// The canonical Change Event remains the audit authority: this only attaches
/// the typed freshness fact that the old writer could not have emitted. The
/// deterministic request identity makes concurrent/retried modernization
/// converge on the same root instead of creating a second history ledger.
fn ensure_legacy_journal_forward_transaction_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    session_id: &str,
    row: &grimodex_core::undo_journal::UndoJournalRow,
) -> anyhow::Result<String> {
    if let Some(transaction_id) = transaction_id_for_undo_journal(conn, project_id, &row.id)? {
        return Ok(transaction_id);
    }
    let request_id = format!("legacy-undo-root:{}", row.id);
    let mut events = if row.entity_kind == "chronicle_bulk" {
        crate::chronicle_bulk::narrative_feed_events_from_journal(
            row,
            NarrativeChangeCauseKind::Forward,
        )?
    } else {
        vec![event_from_undo_journal_row(
            row,
            NarrativeChangeCauseKind::Forward,
        )?]
    };
    // Pre-C1 journals did not carry a canonical Feed state (and many of them
    // omit the historical OCC version entirely).  Modernize the forward root
    // against the row that is actually present before replay.  This keeps the
    // first C1 event truthful and, importantly, gives the subsequent undo
    // event an exact before-state to chain from.
    if row.entity_kind != "chronicle_bulk" {
        for event in &mut events {
            let snapshot = if event.object_key.get("kind").and_then(Value::as_str)
                == Some("chronicle-event")
            {
                let event_id = event
                    .object_key
                    .get("eventId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow::anyhow!("legacy Chronicle object key has no eventId"))?;
                crate::agent_writes::collect_event_snapshot_optional(conn, project_id, event_id)?
            } else {
                crate::canonical_feed_snapshots::canonical_snapshot_for_object_key(
                    conn,
                    project_id,
                    &event.object_key,
                )
                .ok()
                .flatten()
            };
            let Some(snapshot) = snapshot else {
                continue;
            };
            event.after_version = snapshot.get("version").and_then(Value::as_i64).or_else(|| {
                snapshot
                    .get("eventData")
                    .and_then(|data| data.get("version"))
                    .and_then(Value::as_i64)
            });
            event.after_digest = Some(narrative_snapshot_digest(&snapshot)?);
            if event.mutation_kind == "delete" {
                // A deleted root is intentionally absent; only related
                // surviving event roots receive a live after state.
                event.after_version = None;
                event.after_digest = None;
            }
            if event.mutation_kind == "update" || event.mutation_kind == "delete" {
                let identity =
                    crate::canonical_feed_snapshots::object_key_identity(&event.object_key)?;
                if let Some((version, digest)) =
                    crate::narrative_extraction::change_feed::previous_event_after_state(
                        conn, project_id, &identity,
                    )?
                {
                    event.before_version = version;
                    event.before_digest = digest;
                }
            }
        }
    }
    if let Some(source_change_event_uid) = row.change_event_uid.as_deref() {
        let (source_domain, timestamp): (String, i64) = conn
            .query_row(
                "SELECT op_type, timestamp
                   FROM change_events
                  WHERE project_id = ?1 AND event_uid = ?2",
                rusqlite::params![project_id, source_change_event_uid],
                |event| Ok((event.get(0)?, event.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "legacy Undo journal '{}' canonical Change Event is not in project '{}'",
                    row.id,
                    project_id
                )
            })?;
        return Ok(append_narrative_change_transaction_in_tx(
            conn,
            &AppendNarrativeChangeTransactionInput {
                project_id: project_id.to_string(),
                request_id,
                source_domain,
                source_change_event_uid: source_change_event_uid.to_string(),
                cause_kind: NarrativeChangeCauseKind::Forward,
                origin: legacy_journal_forward_origin(&row.surface),
                original_transaction_id: None,
                commit_id: None,
                journal_id: None,
                undo_journal_id: Some(row.id.clone()),
                application_ids: vec![],
                occurred_at: change_occurred_at(timestamp)?,
                events,
            },
        )?
        .transaction_id);
    }

    // Some public-floor journals predate canonical event correlation itself.
    // Record an explicit migration/backfill event instead of pretending that
    // a historical audit event existed. This still keeps Change Event as the
    // sole audit authority and gives the replay a truthful root lineage.
    let timestamp = chrono::Utc::now().timestamp_millis();
    let canonical_event = AppendChangeEvent {
        event_uid: format!("legacy-undo-backfill:{}", row.id),
        scene_id: None,
        domain: "history".to_string(),
        op_type: "history.legacy-forward".to_string(),
        entity_type: Some(row.entity_kind.clone()),
        entity_id: Some(row.entity_id.clone()),
        payload: json!({
            "journalId": row.id,
            "opKind": row.op_kind,
            "surface": row.surface,
        })
        .to_string(),
        timestamp,
    };
    Ok(append_canonical_and_narrative_change_in_tx(
        conn,
        project_id,
        session_id,
        &canonical_event,
        &AppendNarrativeChangeTransactionInput {
            project_id: project_id.to_string(),
            request_id,
            source_domain: canonical_event.op_type.clone(),
            source_change_event_uid: canonical_event.event_uid.clone(),
            cause_kind: NarrativeChangeCauseKind::Forward,
            origin: NarrativeChangeOrigin::Migration,
            original_transaction_id: None,
            commit_id: None,
            journal_id: None,
            undo_journal_id: Some(row.id.clone()),
            application_ids: vec![],
            occurred_at: change_occurred_at(timestamp)?,
            events,
        },
    )?
    .narrative
    .transaction_id)
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
            } else if is_scene_event_link_batch_snapshot(&snap) {
                let linked = snap["linked"]
                    .as_bool()
                    .ok_or_else(|| anyhow::anyhow!("scene link batch snapshot missing linked"))?;
                if linked {
                    "event.stamp".to_string()
                } else {
                    "event.unstamp".to_string()
                }
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

fn event_journal_feed_ids(
    row: &grimodex_core::undo_journal::UndoJournalRow,
) -> anyhow::Result<Vec<String>> {
    anyhow::ensure!(
        row.entity_kind == "event",
        "event Feed identity requires an event Undo Journal"
    );
    let raw = row
        .before_json
        .as_deref()
        .or(row.after_json.as_deref())
        .ok_or_else(|| anyhow::anyhow!("event Undo Journal has no snapshot"))?;
    let snapshot: Value = serde_json::from_str(raw)?;
    let mut ids = if let (Some(cause), Some(effect)) = (
        snapshot["causeEventId"].as_str(),
        snapshot["effectEventId"].as_str(),
    ) {
        vec![cause.to_string(), effect.to_string()]
    } else {
        vec![row.entity_id.clone()]
    };
    if row.op_kind == "delete" && snapshot.get("eventData").is_some() {
        ids.extend(event_snapshot_related_ids(&snapshot));
    }
    ids.sort();
    ids.dedup();
    Ok(ids)
}

fn collect_event_feed_states(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_ids: &[String],
) -> anyhow::Result<std::collections::BTreeMap<String, Option<Value>>> {
    event_ids
        .iter()
        .map(|event_id| {
            collect_event_snapshot_optional(conn, project_id, event_id)
                .map(|snapshot| (event_id.clone(), snapshot))
        })
        .collect()
}

fn event_journal_feed_contract(
    row: &grimodex_core::undo_journal::UndoJournalRow,
    event_id: &str,
) -> anyhow::Result<(&'static str, Vec<String>)> {
    let raw = row
        .before_json
        .as_deref()
        .or(row.after_json.as_deref())
        .ok_or_else(|| anyhow::anyhow!("event Undo Journal has no snapshot"))?;
    let snapshot: Value = serde_json::from_str(raw)?;
    if snapshot.get("causeEventId").is_some() && snapshot.get("effectEventId").is_some() {
        return Ok(("association", vec!["/relations".to_string()]));
    }
    if is_scene_event_link_batch_snapshot(&snapshot)
        || (snapshot.get("sceneId").is_some() && snapshot.get("linked").is_some())
    {
        return Ok(("association", vec!["/sceneIds".to_string()]));
    }
    if snapshot.get("participants").is_some() && snapshot.get("eventData").is_none() {
        return Ok(("association", vec!["/participants".to_string()]));
    }
    if event_id != row.entity_id {
        return Ok(("association", vec!["/relations".to_string()]));
    }
    Ok(("metadata", vec!["/".to_string()]))
}

fn event_replay_feed_events(
    row: &grimodex_core::undo_journal::UndoJournalRow,
    before: &std::collections::BTreeMap<String, Option<Value>>,
    after: &std::collections::BTreeMap<String, Option<Value>>,
) -> anyhow::Result<Vec<NarrativeChangeEventInput>> {
    event_journal_feed_ids(row)?
        .into_iter()
        .map(|event_id| {
            let (change_kind, paths) = event_journal_feed_contract(row, &event_id)?;
            chronicle_event_transition_input(
                &event_id,
                before.get(&event_id).and_then(Option::as_ref),
                after.get(&event_id).and_then(Option::as_ref),
                change_kind,
                paths,
                true,
            )
        })
        .collect()
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
    if is_scene_event_link_batch_snapshot(&snap) {
        if let Some(scene_ids) = snap["sceneIds"].as_array() {
            object.insert("sceneIds".to_string(), Value::Array(scene_ids.clone()));
        }
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

/// Replay a C1 Codex delete journal whose snapshot owns the full FK cascade.
///
/// Older journals stored the root snapshot directly. Returning `None` keeps
/// those rows on grimodex-core's legacy-compatible replay path.
fn replay_codex_delete_cascade_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    row: &grimodex_core::undo_journal::UndoJournalRow,
    direction: &str,
) -> anyhow::Result<Option<Vec<NarrativeChangeEventInput>>> {
    let raw = row
        .before_json
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("Codex delete journal is missing before_json"))?;
    let journal_snapshot: Value = serde_json::from_str(raw)?;
    let Some(entry) = journal_snapshot.get("entry") else {
        return Ok(None);
    };
    anyhow::ensure!(
        entry.get("id").and_then(Value::as_str) == Some(row.entity_id.as_str())
            && entry.get("projectId").and_then(Value::as_str) == Some(project_id),
        "Codex delete journal snapshot escaped its project"
    );
    let cascade: CodexDeleteCascadeSnapshot = serde_json::from_value(
        journal_snapshot
            .get("cascade")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Codex delete journal snapshot has no cascade"))?,
    )?;

    let events = match direction {
        "undo" => {
            // Child rows survive the root delete with parent_id cleared. Keep
            // their current pre-restore state for truthful update digests.
            let child_before = cascade
                .children
                .iter()
                .map(|child| {
                    let child_id = child
                        .get("id")
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow::anyhow!("Codex child restore snapshot has no id"))?;
                    collect_codex_entry_snapshot(conn, child_id)
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            let replay_version = row
                .base_version
                .checked_add(1)
                .ok_or_else(|| anyhow::anyhow!("Codex delete restore version overflow"))?;
            restore_deleted_codex_entry_from_snapshot(
                conn,
                project_id,
                &row.entity_id,
                &journal_snapshot,
                replay_version,
            )?;
            grimodex_core::undo_journal::advance_codex_journal_state_token(
                conn,
                project_id,
                &row.entity_id,
                row.base_version,
                replay_version,
            )?;
            let root_after = collect_codex_entry_snapshot(conn, &row.entity_id)?;
            codex_delete_cascade_restore_feed_events(
                conn,
                project_id,
                &row.entity_id,
                &root_after,
                &cascade,
                &child_before,
            )?
        }
        "redo" => {
            let root_before = collect_codex_entry_snapshot(conn, &row.entity_id)?;
            anyhow::ensure!(
                root_before.get("projectId").and_then(Value::as_str) == Some(project_id),
                "codex entry '{}' version conflict during journal restore",
                row.entity_id
            );
            let cascade_before =
                collect_codex_delete_cascade_snapshot(conn, project_id, &row.entity_id)?;
            delete_codex_entry_cascade(conn, project_id, &row.entity_id, Some(row.result_version))?;
            let mut events = vec![deleted_cascade_event(
                json!({ "kind": "codex-entry", "entryId": row.entity_id }),
                &root_before,
                "metadata",
                vec!["/".to_string()],
            )?];
            events.extend(codex_delete_cascade_feed_events(conn, &cascade_before)?);
            events
        }
        other => anyhow::bail!("invalid undo direction: {other}"),
    };
    Ok(Some(events))
}

fn replay_foreshadow_delete_in_tx(
    conn: &rusqlite::Connection,
    project_id: &str,
    row: &grimodex_core::undo_journal::UndoJournalRow,
    direction: &str,
) -> anyhow::Result<()> {
    let raw = row
        .before_json
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("foreshadow delete journal is missing before_json"))?;
    let snapshot: Value = serde_json::from_str(raw)?;
    match direction {
        "undo" => {
            let now = chrono::Utc::now().to_rfc3339();
            let replay_version = crate::narrative_extraction::reapply_created_snapshot(
                conn,
                project_id,
                &row.entity_id,
                &snapshot,
                row.base_version,
                &now,
            )?;
            grimodex_core::undo_journal::advance_foreshadow_journal_state_token(
                conn,
                project_id,
                &row.entity_id,
                row.base_version,
                replay_version,
            )?;
        }
        "redo" => crate::narrative_extraction::delete_snapshot_at_version(
            conn,
            project_id,
            &row.entity_id,
            &snapshot,
            row.result_version,
        )?,
        other => anyhow::bail!("invalid undo direction: {other}"),
    }
    Ok(())
}

pub fn agent_undo_journal_impl(
    db: &Database,
    payload: AgentUndoJournalPayload,
) -> anyhow::Result<Value> {
    validate_undo_journal_authority(&payload)?;
    anyhow::ensure!(
        !payload.request_id.trim().is_empty(),
        "undo journal requestId must not be empty"
    );
    let request_hash = idempotency_hash(
        "agent_apply_undo_journal",
        &json!({
            "projectId": payload.project_id,
            "journalId": payload.journal_id,
            "direction": payload.direction,
        }),
    )?;
    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<Value> {
            let request = IdempotencyRequest {
                domain: "agent_apply_undo_journal",
                request_id: Some(&payload.request_id),
                payload_hash: &request_hash,
                conflict_marker: "UNDO_JOURNAL_IDEMPOTENCY_CONFLICT",
            };
            if let Some(existing) = load_idempotent_response(conn, &request)? {
                return Ok(existing);
            }
            let row = grimodex_core::undo_journal::load_undo_journal(
                conn,
                &payload.project_id,
                &payload.journal_id,
            )?;
            // Resolve or modernize the root before changing domain state. A
            // missing/foreign canonical event therefore fails closed without
            // applying an untracked Undo/Redo.
            let original_transaction_id = ensure_legacy_journal_forward_transaction_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &row,
            )?;
            let event_feed_ids = (row.entity_kind == "event")
                .then(|| event_journal_feed_ids(&row))
                .transpose()?;
            let event_feed_before = event_feed_ids
                .as_deref()
                .map(|event_ids| collect_event_feed_states(conn, &payload.project_id, event_ids))
                .transpose()?;
            let canonical_replay_before = match row.entity_kind.as_str() {
                "codex_entry" if row.op_kind != "delete" => {
                    crate::canonical_feed_snapshots::canonical_codex_entry_snapshot(
                        conn,
                        &payload.project_id,
                        &row.entity_id,
                    )
                    .ok()
                }
                "snippet" => crate::canonical_feed_snapshots::canonical_snippet_snapshot(
                    conn,
                    &payload.project_id,
                    &row.entity_id,
                )
                .ok(),
                _ => None,
            };
            let mut replay_narrative_events = None;
            // Chronicle events carry a composite snapshot (eventData +
            // participants + sceneLinks + relations) that the single-table
            // grimodex-core restorers don't understand, so they're handled by
            // the local event restorers; everything else delegates to core.
            if row.entity_kind == "codex_entry" && row.op_kind == "delete" {
                replay_narrative_events = replay_codex_delete_cascade_in_tx(
                    conn,
                    &payload.project_id,
                    &row,
                    &payload.direction,
                )?;
                if replay_narrative_events.is_none() {
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
            } else if row.entity_kind == "foreshadow" && row.op_kind == "delete" {
                replay_foreshadow_delete_in_tx(
                    conn,
                    &payload.project_id,
                    &row,
                    &payload.direction,
                )?;
            } else if row.entity_kind == "event" {
                match payload.direction.as_str() {
                    "undo" => revert_event_undo_in_tx(conn, &payload.project_id, &row)?,
                    "redo" => apply_event_redo_in_tx(conn, &payload.project_id, &row)?,
                    other => anyhow::bail!("invalid undo direction: {other}"),
                }
                let event_ids = event_feed_ids
                    .as_deref()
                    .ok_or_else(|| anyhow::anyhow!("event Feed identities disappeared"))?;
                let before = event_feed_before
                    .as_ref()
                    .ok_or_else(|| anyhow::anyhow!("event Feed before states disappeared"))?;
                let after = collect_event_feed_states(conn, &payload.project_id, event_ids)?;
                replay_narrative_events = Some(event_replay_feed_events(&row, before, &after)?);
            } else if row.entity_kind == "chronicle_bulk" {
                replay_narrative_events = Some(crate::chronicle_bulk::replay_chronicle_bulk_in_tx(
                    conn,
                    &payload.project_id,
                    &row,
                    &payload.direction,
                )?);
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
            let canonical_event = AppendChangeEvent {
                event_uid,
                scene_id: None,
                domain,
                op_type,
                entity_type: Some(entity_type),
                entity_id: Some(entity_id),
                payload: change_payload.to_string(),
                timestamp,
            };
            // Replay can allocate a fresh OCC generation and rewrite the
            // journal chain's state tokens. Reload after the domain mutation
            // so the Feed reports committed versions rather than stale tokens.
            let feed_row = grimodex_core::undo_journal::load_undo_journal(
                conn,
                &payload.project_id,
                &payload.journal_id,
            )?;
            let (cause_kind, origin) = match payload.direction.as_str() {
                "undo" => (NarrativeChangeCauseKind::Undo, NarrativeChangeOrigin::Undo),
                "redo" => (NarrativeChangeCauseKind::Redo, NarrativeChangeOrigin::Redo),
                other => anyhow::bail!("invalid undo direction: {other}"),
            };
            let mut narrative_events = if let Some(events) = replay_narrative_events {
                events
            } else if matches!(feed_row.entity_kind.as_str(), "codex_entry" | "snippet") {
                let canonical_after = match feed_row.entity_kind.as_str() {
                    "codex_entry" => {
                        crate::canonical_feed_snapshots::canonical_codex_entry_snapshot(
                            conn,
                            &payload.project_id,
                            &feed_row.entity_id,
                        )
                        .ok()
                    }
                    "snippet" => crate::canonical_feed_snapshots::canonical_snippet_snapshot(
                        conn,
                        &payload.project_id,
                        &feed_row.entity_id,
                    )
                    .ok(),
                    _ => unreachable!(),
                };
                let before_version = canonical_replay_before
                    .as_ref()
                    .and_then(snapshot_version);
                let after_version = canonical_after.as_ref().and_then(snapshot_version);
                vec![NarrativeChangeEventInput {
                    object_key: if feed_row.entity_kind == "codex_entry" {
                        json!({ "kind": "codex-entry", "entryId": feed_row.entity_id })
                    } else {
                        json!({ "kind": "component", "componentId": format!("snippet:{}", feed_row.entity_id) })
                    },
                    change_kind: "metadata".to_string(),
                    mutation_kind: match (
                        canonical_replay_before.is_some(),
                        canonical_after.is_some(),
                    ) {
                        (true, true) => "update",
                        (true, false) => "delete",
                        (false, true) => "restore",
                        (false, false) => anyhow::bail!("Undo replay has no before or after state"),
                    }
                    .to_string(),
                    before_version,
                    before_digest: canonical_replay_before
                        .as_ref()
                        .map(narrative_snapshot_digest)
                        .transpose()?,
                    after_version,
                    after_digest: canonical_after
                        .as_ref()
                        .map(narrative_snapshot_digest)
                        .transpose()?,
                    changed_paths: vec!["/".to_string()],
                    text_impact: None,
                    structural_impact: Some(json!({ "changedPaths": ["/"] })),
                }]
            } else if feed_row.entity_kind == "chronicle_bulk" {
                crate::chronicle_bulk::narrative_feed_events_from_journal(&feed_row, cause_kind)?
            } else {
                vec![event_from_undo_journal_row(&feed_row, cause_kind)?]
            };
            normalize_foreshadow_feed_events_in_tx(
                conn,
                &payload.project_id,
                &mut narrative_events,
            )?;
            let append = append_canonical_and_narrative_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                &canonical_event,
                &AppendNarrativeChangeTransactionInput {
                    project_id: payload.project_id.clone(),
                    request_id: payload.request_id.clone(),
                    source_domain: canonical_event.op_type.clone(),
                    source_change_event_uid: canonical_event.event_uid.clone(),
                    cause_kind,
                    origin,
                    original_transaction_id: Some(original_transaction_id),
                    commit_id: None,
                    journal_id: None,
                    undo_journal_id: Some(payload.journal_id.clone()),
                    application_ids: vec![],
                    occurred_at: change_occurred_at(canonical_event.timestamp)?,
                    events: narrative_events,
                },
            )?;
            let response = json!({
                "ok": true,
                "changeEventUid": canonical_event.event_uid,
                "maintenanceTransactionId": append.narrative.transaction_id,
                "undoJournalId": payload.journal_id,
            });
            insert_idempotent_response(conn, &request, &payload.project_id, &response)?;
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
    pub request_id: String,
    #[serde(default)]
    pub foreshadow_id: Option<String>,
    pub project_id: String,
    pub session_id: String,
    pub title: String,
    pub intent: Option<String>,
    pub notes: Option<String>,
    pub load_bearing: Option<String>,
    pub secret: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentForeshadowUpdatePayload {
    pub request_id: String,
    pub project_id: String,
    pub session_id: String,
    pub foreshadow_id: String,
    pub base_version: i64,
    pub title: Option<String>,
    pub intent: Option<String>,
    pub notes: Option<String>,
    pub load_bearing: Option<String>,
    pub payoff_confirmed: Option<bool>,
    pub abandoned: Option<bool>,
    pub secret: Option<bool>,
}

pub fn agent_write_result_json(res: grimodex_core::writes::WriteResult) -> anyhow::Result<Value> {
    Ok(serde_json::to_value(AgentWriteResult {
        entity_id: res.entity_id,
        version: res.version,
        change_event_uid: res.change_event_uid,
        undo_journal_id: res.undo_journal_id,
    })?)
}

fn db_change_event_from_core(
    event: &grimodex_core::change_events::AppendChangeEvent,
) -> AppendChangeEvent {
    AppendChangeEvent {
        event_uid: event.event_uid.clone(),
        scene_id: event.scene_id.clone(),
        domain: event.domain.clone(),
        op_type: event.op_type.clone(),
        entity_type: event.entity_type.clone(),
        entity_id: event.entity_id.clone(),
        payload: event.payload.clone(),
        timestamp: event.timestamp,
    }
}

pub fn agent_foreshadow_create_impl(
    db: &Database,
    payload: AgentForeshadowCreatePayload,
) -> anyhow::Result<Value> {
    agent_foreshadow_create_with_context_impl(db, payload, "in-app-agent", None)
}

pub fn renderer_agent_foreshadow_create_impl(
    db: &Database,
    payload: AgentForeshadowCreatePayload,
    context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !payload.project_id.trim().is_empty(),
        "projectId is required"
    );
    anyhow::ensure!(
        !payload.session_id.trim().is_empty(),
        "sessionId is required"
    );
    anyhow::ensure!(
        payload.request_id == context.request_id,
        "agent foreshadow requestId does not match canonical authority context"
    );
    validate_renderer_authority_context_for_routes(&context, &["interactive-agent-command"])?;
    agent_foreshadow_create_with_context_impl(db, payload, "in-app-agent", Some(context))
}

pub fn agent_foreshadow_create_with_surface_impl(
    db: &Database,
    payload: AgentForeshadowCreatePayload,
    surface: &str,
) -> anyhow::Result<Value> {
    agent_foreshadow_create_with_context_impl(db, payload, surface, None)
}

fn agent_foreshadow_create_with_context_impl(
    db: &Database,
    payload: AgentForeshadowCreatePayload,
    surface: &str,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !payload.request_id.trim().is_empty(),
        "requestId must not be empty"
    );
    let request_hash = foreshadow_create_request_hash(&payload)?;
    let foreshadow_id = payload
        .foreshadow_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    db.with_conn(|conn| {
        let res = grimodex_core::writes::foreshadow::tracked_foreshadow_create_with_in_tx_hook(
            conn,
            grimodex_core::writes::foreshadow::TrackedForeshadowCreateInput {
                project_id: &payload.project_id,
                session_id: &payload.session_id,
                surface,
                foreshadow_id: &foreshadow_id,
                title: &payload.title,
                intent: payload.intent.as_deref(),
                notes: payload.notes.as_deref(),
                load_bearing: payload.load_bearing.as_deref(),
                secret: payload.secret,
                request_id: Some(&payload.request_id),
                request_hash: Some(&request_hash),
                event_uid: renderer_context
                    .as_ref()
                    .map(|context| context.event_uid.as_str()),
            },
            |conn, event, undo_journal_id| {
                let canonical_event = db_change_event_from_core(event);
                append_agent_forward_change_in_tx(
                    conn,
                    &payload.project_id,
                    &payload.session_id,
                    Some(surface),
                    Some(&payload.request_id),
                    undo_journal_id,
                    &canonical_event,
                    None,
                    renderer_context.as_ref(),
                )
                .map(|_| ())
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
    let request_id = payload.request_id.clone();
    agent_foreshadow_update_with_context_impl(db, payload, &request_id, "in-app-agent", None)
}

pub fn renderer_agent_foreshadow_update_impl(
    db: &Database,
    payload: AgentForeshadowUpdatePayload,
    context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !payload.project_id.trim().is_empty(),
        "projectId is required"
    );
    anyhow::ensure!(
        !payload.session_id.trim().is_empty(),
        "sessionId is required"
    );
    anyhow::ensure!(
        payload.request_id == context.request_id,
        "agent foreshadow update requestId does not match canonical authority context"
    );
    validate_renderer_authority_context_for_routes(&context, &["interactive-agent-command"])?;
    let request_id = context.request_id.clone();
    agent_foreshadow_update_with_context_impl(
        db,
        payload,
        &request_id,
        "in-app-agent",
        Some(context),
    )
}

pub fn agent_foreshadow_update_with_request_impl(
    db: &Database,
    payload: AgentForeshadowUpdatePayload,
    request_id: &str,
    surface: &str,
) -> anyhow::Result<Value> {
    agent_foreshadow_update_with_context_impl(db, payload, request_id, surface, None)
}

fn agent_foreshadow_update_with_context_impl(
    db: &Database,
    payload: AgentForeshadowUpdatePayload,
    request_id: &str,
    surface: &str,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    anyhow::ensure!(!request_id.trim().is_empty(), "requestId must not be empty");
    anyhow::ensure!(
        payload.request_id == request_id,
        "agent foreshadow update requestId does not match the writer request"
    );
    let mut normalized = payload.clone();
    normalized.request_id.clear();
    normalized.session_id.clear();
    let request_hash = idempotency_hash("agent_foreshadow_update", &normalized)?;
    let authority_paths = [
        payload.title.as_ref().map(|_| "/title"),
        payload.intent.as_ref().map(|_| "/intent"),
        payload.notes.as_ref().map(|_| "/notes"),
        payload.load_bearing.as_ref().map(|_| "/loadBearing"),
        payload.payoff_confirmed.map(|_| "/payoffConfirmed"),
        payload.abandoned.map(|_| "/abandoned"),
        payload.secret.map(|_| "/secret"),
    ]
    .into_iter()
    .flatten()
    .map(str::to_string)
    .collect::<Vec<_>>();
    let authority_updated_at = chrono::Utc::now().to_rfc3339();
    db.with_conn(|conn| {
        let before_change = |conn: &rusqlite::Connection| {
            preflight_agent_field_authority(
                conn,
                &payload.project_id,
                "foreshadow",
                &payload.foreshadow_id,
                &authority_paths,
                &authority_updated_at,
                Some(surface),
                renderer_context.as_ref(),
            )
        };
        let append = |conn: &rusqlite::Connection,
                      event: &grimodex_core::change_events::AppendChangeEvent,
                      undo_journal_id: &str| {
            let canonical_event = db_change_event_from_core(event);
            append_agent_forward_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                Some(surface),
                Some(request_id),
                undo_journal_id,
                &canonical_event,
                None,
                renderer_context.as_ref(),
            )
            .map(|_| ())
        };
        let result =
            grimodex_core::writes::foreshadow::tracked_foreshadow_update_at_version_with_request_in_tx_hooks(
                conn,
                grimodex_core::writes::foreshadow::TrackedForeshadowUpdateInput {
                    project_id: &payload.project_id,
                    session_id: &payload.session_id,
                    surface,
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
                    event_uid: renderer_context
                        .as_ref()
                        .map(|context| context.event_uid.as_str()),
                },
                payload.base_version,
                request_id,
                &request_hash,
                before_change,
                append,
            )
            .map_err(|error| anyhow::anyhow!("agent_foreshadow_update: {error:#}"))?;
        result
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
    pub request_id: String,
    /// Domain-owned idempotency key for create retries.
    #[serde(default)]
    pub event_id: Option<String>,
    pub project_id: String,
    pub session_id: String,
    /// 書き込み元の表面: "in-app-agent"(AI) / "mcp" / "manual"(UI手動編集)。
    /// 省略時(既存JS経路)は in-app-agent 互換。undo_journal の provenance に使う。
    pub surface: Option<String>,
    pub title: Option<String>,
    pub note: Option<String>,
    /// 出来事の詳細（リッチテキスト = ProseMirror JSON 文字列）。
    pub detail: Option<String>,
    pub ordinal: Option<String>,
    pub primary_codex_id: Option<String>,
    /// 未割当の整理用サブレーン id。
    pub lane_group: Option<String>,
    pub location_codex_id: Option<String>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub start_minute: Option<i64>,
    pub end_minute: Option<i64>,
    pub start_granularity: Option<String>,
    pub end_granularity: Option<String>,
    pub precision: Option<String>,
    pub kind: Option<String>,
    /// AI 秘匿（reveal アンカー方式）。省略時 false=表示。
    pub secret: Option<bool>,
    /// 読む順の開示アンカー（明示上書き・空/None=自動導出 or 恒久秘匿）。
    pub reveal_scene_id: Option<String>,
    pub participant_codex_ids: Option<Vec<String>>,
    pub scene_ids: Option<Vec<String>>,
}

/// Patch-style update. Each field is set-if-present (a missing field is left
/// untouched). Clearing a nullable column to NULL is not expressible here —
/// matches the codex update contract.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventUpdatePayload {
    pub project_id: String,
    pub session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    pub surface: Option<String>,
    pub event_id: String,
    /// Version observed when the caller loaded this Event aggregate.
    pub base_version: i64,
    pub title: Option<String>,
    pub note: Option<String>,
    /// 出来事の詳細（リッチテキスト = ProseMirror JSON 文字列）。set-if-present。
    pub detail: Option<String>,
    pub ordinal: Option<String>,
    pub primary_codex_id: Option<String>,
    /// 未割当の整理用サブレーン id（空文字は NULL=既定の未割当レーンへ）。
    pub lane_group: Option<String>,
    pub location_codex_id: Option<String>,
    pub start_time: Option<i64>,
    pub end_time: Option<i64>,
    pub start_minute: Option<i64>,
    pub end_minute: Option<i64>,
    pub start_granularity: Option<String>,
    pub end_granularity: Option<String>,
    pub precision: Option<String>,
    pub kind: Option<String>,
    /// AI 秘匿（reveal アンカー方式）。set-if-present。
    pub secret: Option<bool>,
    /// 読む順の開示アンカー（set-if-present・空文字は NULL=自動導出へ戻す）。
    pub reveal_scene_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventIdPayload {
    pub project_id: String,
    pub session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    pub surface: Option<String>,
    pub event_id: String,
    /// Version observed when the caller loaded this Event aggregate.
    pub base_version: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventParticipantsPayload {
    pub project_id: String,
    pub session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    pub surface: Option<String>,
    pub event_id: String,
    /// Version observed when the caller loaded this Event aggregate.
    pub base_version: i64,
    pub codex_entry_ids: Vec<String>,
    /// Optional role values aligned with `codex_entry_ids`.  The legacy
    /// surface only supplied IDs; keeping this optional preserves that wire
    /// contract while allowing the canonical writer to update participant
    /// roles without a generic SQL escape hatch.
    #[serde(default)]
    pub participant_roles: Option<Vec<Option<String>>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSceneEventPayload {
    /// Request-owned idempotency key. The association has only a natural
    /// composite key, so this key also deduplicates journal/event side effects.
    pub request_id: String,
    pub project_id: String,
    pub session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    pub surface: Option<String>,
    pub scene_id: String,
    pub event_id: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSceneEventLinkBatchPayload {
    request_id: String,
    project_id: String,
    session_id: String,
    #[serde(default)]
    surface: Option<String>,
    event_id: String,
    scene_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventRelationPayload {
    pub request_id: String,
    pub project_id: String,
    pub session_id: String,
    /// 書き込み元の表面。省略時は in-app-agent 互換（[`AgentEventCreatePayload`] 参照）。
    pub surface: Option<String>,
    pub cause_event_id: String,
    pub effect_event_id: String,
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
        let mut stmt = conn.prepare(
            "SELECT scene_id, incarnation_token
               FROM scene_events WHERE event_id = ?1 ORDER BY scene_id",
        )?;
        let rows = stmt.query_map(rusqlite::params![event_id], |row| {
            Ok(json!({
                "sceneId": row.get::<_, String>(0)?,
                "incarnationToken": row.get::<_, String>(1)?,
            }))
        })?;
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

fn collect_event_snapshot_optional(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_id: &str,
) -> anyhow::Result<Option<Value>> {
    let owned = conn
        .query_row(
            "SELECT 1 FROM events WHERE id = ?1 AND project_id = ?2",
            rusqlite::params![event_id, project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some();
    owned
        .then(|| collect_event_snapshot(conn, event_id))
        .transpose()
}

pub(crate) fn chronicle_event_feed_input(
    event_id: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    mutation_kind: &str,
    change_kind: &str,
    changed_paths: Vec<String>,
) -> anyhow::Result<NarrativeChangeEventInput> {
    let snapshot_version = |snapshot: Option<&Value>| {
        snapshot.and_then(|value| value["eventData"]["version"].as_i64())
    };
    Ok(NarrativeChangeEventInput {
        object_key: json!({
            "kind": "chronicle-event",
            "eventId": event_id,
        }),
        change_kind: change_kind.to_string(),
        mutation_kind: mutation_kind.to_string(),
        before_version: snapshot_version(before),
        before_digest: before.map(narrative_snapshot_digest).transpose()?,
        after_version: snapshot_version(after),
        after_digest: after.map(narrative_snapshot_digest).transpose()?,
        changed_paths: changed_paths.clone(),
        text_impact: None,
        structural_impact: Some(json!({ "changedPaths": changed_paths })),
    })
}

pub(crate) fn chronicle_event_transition_input(
    event_id: &str,
    before: Option<&Value>,
    after: Option<&Value>,
    change_kind: &str,
    changed_paths: Vec<String>,
    restore_when_created: bool,
) -> anyhow::Result<NarrativeChangeEventInput> {
    let mutation_kind = match (before.is_some(), after.is_some()) {
        (true, true) => "update",
        (true, false) => "delete",
        (false, true) if restore_when_created => "restore",
        (false, true) => "create",
        (false, false) => anyhow::bail!(
            "chronicle event '{event_id}' has no state on either side of its Feed transition"
        ),
    };
    chronicle_event_feed_input(
        event_id,
        before,
        after,
        mutation_kind,
        change_kind,
        changed_paths,
    )
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

const SCENE_EVENT_LINK_BATCH_SNAPSHOT_KIND: &str = "sceneEventLinkBatch";

type SceneEventIncarnations = std::collections::BTreeMap<String, String>;

fn collect_event_scene_links(
    conn: &rusqlite::Connection,
    event_id: &str,
) -> anyhow::Result<SceneEventIncarnations> {
    let mut statement = conn.prepare(
        "SELECT scene_id, incarnation_token
           FROM scene_events WHERE event_id = ?1 ORDER BY scene_id",
    )?;
    let scene_links = statement
        .query_map(rusqlite::params![event_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<_, _>>()?;
    Ok(scene_links)
}

fn scene_event_link_batch_snapshot(
    event_id: &str,
    scene_ids: &[String],
    linked: bool,
    incarnation_tokens: Option<&SceneEventIncarnations>,
) -> Value {
    let mut snapshot = json!({
        "snapshotKind": SCENE_EVENT_LINK_BATCH_SNAPSHOT_KIND,
        "eventId": event_id,
        "sceneIds": scene_ids,
        "linked": linked,
    });
    if linked && !scene_ids.is_empty() {
        let tokens = scene_ids
            .iter()
            .filter_map(|scene_id| {
                incarnation_tokens
                    .and_then(|tokens| tokens.get(scene_id))
                    .map(|token| (scene_id.clone(), Value::from(token.clone())))
            })
            .collect::<serde_json::Map<_, _>>();
        snapshot["incarnationTokens"] = Value::Object(tokens);
    }
    snapshot
}

fn scene_event_link_snapshot(
    scene_id: &str,
    event_id: &str,
    linked: bool,
    incarnation_token: Option<&str>,
) -> Value {
    let mut snapshot = json!({
        "sceneId": scene_id,
        "eventId": event_id,
        "linked": linked,
    });
    if linked {
        snapshot["incarnationToken"] = Value::from(incarnation_token.unwrap_or_default());
    }
    snapshot
}

fn is_scene_event_link_batch_snapshot(snap: &Value) -> bool {
    snap["snapshotKind"].as_str() == Some(SCENE_EVENT_LINK_BATCH_SNAPSHOT_KIND)
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

/// Bulk-insert fresh scene-link incarnations for one event. Every successful
/// physical insertion receives a UUID distinct from any prior incarnation.
fn batch_insert_scene_events(
    conn: &rusqlite::Connection,
    event_id: &str,
    scene_ids: &[&str],
) -> anyhow::Result<SceneEventIncarnations> {
    let incarnations = scene_ids
        .iter()
        .map(|scene_id| ((*scene_id).to_string(), uuid::Uuid::new_v4().to_string()))
        .collect::<SceneEventIncarnations>();
    let rows = incarnations.iter().collect::<Vec<_>>();
    let mut inserted = 0usize;
    for chunk in rows.chunks(INSERT_CHUNK_ROWS) {
        let placeholders = vec!["(?, ?, ?)"; chunk.len()].join(", ");
        let sql = format!(
            "INSERT OR IGNORE INTO scene_events
             (scene_id, event_id, incarnation_token) VALUES {placeholders}"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 3);
        for (scene_id, token) in chunk {
            params.push(scene_id);
            params.push(&event_id);
            params.push(token);
        }
        inserted += conn.execute(&sql, params.as_slice())?;
    }
    anyhow::ensure!(
        inserted == incarnations.len(),
        "scene-event association changed before insertion"
    );
    Ok(incarnations)
}

/// Restore the exact logical generation captured by an aggregate snapshot.
/// A delete/restore round-trip represents the same association generation;
/// only a new unlink/relink operation allocates a fresh incarnation token.
fn batch_insert_scene_event_incarnations(
    conn: &rusqlite::Connection,
    event_id: &str,
    incarnations: &SceneEventIncarnations,
) -> anyhow::Result<()> {
    let rows = incarnations.iter().collect::<Vec<_>>();
    let mut inserted = 0usize;
    for chunk in rows.chunks(INSERT_CHUNK_ROWS) {
        let placeholders = vec!["(?, ?, ?)"; chunk.len()].join(", ");
        let sql = format!(
            "INSERT OR IGNORE INTO scene_events
             (scene_id, event_id, incarnation_token) VALUES {placeholders}"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 3);
        for (scene_id, token) in chunk {
            params.push(scene_id);
            params.push(&event_id);
            params.push(token);
        }
        inserted += conn.execute(&sql, params.as_slice())?;
    }
    anyhow::ensure!(
        inserted == incarnations.len(),
        "scene-event aggregate association changed before restore"
    );
    Ok(())
}

/// CAS-delete only the exact scene-link incarnations owned by one journal.
fn batch_delete_scene_event_incarnations(
    conn: &rusqlite::Connection,
    event_id: &str,
    incarnations: &SceneEventIncarnations,
) -> anyhow::Result<()> {
    let rows = incarnations.iter().collect::<Vec<_>>();
    let mut deleted = 0usize;
    for chunk in rows.chunks(INSERT_CHUNK_ROWS) {
        let placeholders = vec!["(?, ?)"; chunk.len()].join(", ");
        let sql = format!(
            "DELETE FROM scene_events
             WHERE event_id = ? AND (scene_id, incarnation_token) IN ({placeholders})"
        );
        let mut params: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() * 2 + 1);
        params.push(&event_id);
        for (scene_id, token) in chunk {
            params.push(scene_id);
            params.push(token);
        }
        deleted += conn.execute(&sql, params.as_slice())?;
    }
    anyhow::ensure!(
        deleted == incarnations.len(),
        "scene-event association incarnation conflict during journal replay"
    );
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
        let mut captured = SceneEventIncarnations::new();
        let mut legacy_scene_ids = Vec::new();
        for raw in arr {
            if let Some(scene_id) = raw.as_str() {
                legacy_scene_ids.push(scene_id);
                continue;
            }
            let scene_id = raw["sceneId"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("event snapshot scene link is missing sceneId"))?;
            let token = raw["incarnationToken"].as_str().ok_or_else(|| {
                anyhow::anyhow!("event snapshot scene link is missing incarnationToken")
            })?;
            anyhow::ensure!(
                captured
                    .insert(scene_id.to_string(), token.to_string())
                    .is_none(),
                "event snapshot contains duplicate scene links"
            );
        }
        if !captured.is_empty() {
            anyhow::ensure!(
                legacy_scene_ids.is_empty(),
                "event snapshot mixes legacy and incarnation-aware scene links"
            );
            batch_insert_scene_event_incarnations(conn, id, &captured)?;
        } else if !legacy_scene_ids.is_empty() {
            // Public-floor journals predate incarnation tokens. Replaying one
            // necessarily creates a fresh association generation.
            batch_insert_scene_events(conn, id, &legacy_scene_ids)?;
        }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SceneEventSnapshotShape {
    Single,
    Batch,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SceneEventAssociationSnapshot {
    shape: SceneEventSnapshotShape,
    event_id: String,
    scene_ids: Vec<String>,
    linked: bool,
    incarnations: SceneEventIncarnations,
}

fn parse_scene_event_association_snapshot(
    snap: &Value,
) -> anyhow::Result<SceneEventAssociationSnapshot> {
    let (shape, event_id, mut scene_ids) = if is_scene_event_link_batch_snapshot(snap) {
        let event_id = snap["eventId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("scene link batch snapshot missing eventId"))?;
        let raw_scene_ids = snap["sceneIds"]
            .as_array()
            .ok_or_else(|| anyhow::anyhow!("scene link batch snapshot missing sceneIds"))?;
        let scene_ids = raw_scene_ids
            .iter()
            .map(|raw| {
                raw.as_str()
                    .filter(|id| !id.is_empty())
                    .map(str::to_string)
                    .ok_or_else(|| {
                        anyhow::anyhow!("scene link batch snapshot contains an invalid scene id")
                    })
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        (SceneEventSnapshotShape::Batch, event_id, scene_ids)
    } else {
        let event_id = snap["eventId"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("scene snapshot missing eventId"))?;
        let scene_id = snap["sceneId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| anyhow::anyhow!("scene snapshot missing sceneId"))?;
        (
            SceneEventSnapshotShape::Single,
            event_id,
            vec![scene_id.to_string()],
        )
    };
    anyhow::ensure!(!event_id.is_empty(), "scene snapshot has an empty eventId");
    let unique = scene_ids.iter().collect::<std::collections::BTreeSet<_>>();
    anyhow::ensure!(
        unique.len() == scene_ids.len(),
        "scene snapshot contains duplicate scene ids"
    );
    scene_ids.sort();
    let linked = snap["linked"]
        .as_bool()
        .ok_or_else(|| anyhow::anyhow!("scene snapshot missing linked"))?;
    let mut incarnations = SceneEventIncarnations::new();
    if linked {
        match shape {
            SceneEventSnapshotShape::Single => {
                let token = snap
                    .get("incarnationToken")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                incarnations.insert(scene_ids[0].clone(), token.to_string());
            }
            SceneEventSnapshotShape::Batch => {
                if let Some(raw_tokens) = snap.get("incarnationTokens") {
                    let tokens = raw_tokens.as_object().ok_or_else(|| {
                        anyhow::anyhow!("scene link batch incarnationTokens must be an object")
                    })?;
                    anyhow::ensure!(
                        tokens.len() == scene_ids.len(),
                        "scene link batch incarnationTokens do not match sceneIds"
                    );
                    for scene_id in &scene_ids {
                        let token =
                            tokens
                                .get(scene_id)
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    anyhow::anyhow!(
                                        "scene link batch snapshot is missing an incarnation token"
                                    )
                                })?;
                        incarnations.insert(scene_id.clone(), token.to_string());
                    }
                } else {
                    incarnations.extend(
                        scene_ids
                            .iter()
                            .map(|scene_id| (scene_id.clone(), String::new())),
                    );
                }
            }
        }
    } else {
        anyhow::ensure!(
            snap.get("incarnationToken").is_none()
                && snap
                    .get("incarnationTokens")
                    .and_then(Value::as_object)
                    .is_none_or(serde_json::Map::is_empty),
            "unlinked scene snapshot must not carry incarnation tokens"
        );
    }
    Ok(SceneEventAssociationSnapshot {
        shape,
        event_id: event_id.to_string(),
        scene_ids,
        linked,
        incarnations,
    })
}

fn ensure_scene_event_association_scope(
    conn: &rusqlite::Connection,
    project_id: &str,
    snapshot: &SceneEventAssociationSnapshot,
) -> anyhow::Result<()> {
    let event_owned: i64 = conn.query_row(
        "SELECT COUNT(*) FROM events WHERE id = ?1 AND project_id = ?2",
        rusqlite::params![snapshot.event_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        event_owned == 1,
        "event '{}' not found in project '{}' during scene-link replay",
        snapshot.event_id,
        project_id
    );
    for scene_id in &snapshot.scene_ids {
        let scene_owned: i64 = conn.query_row(
            "SELECT COUNT(*) FROM tree_nodes
             WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
            rusqlite::params![scene_id, project_id],
            |row| row.get(0),
        )?;
        anyhow::ensure!(
            scene_owned == 1,
            "scene '{}' not found in project '{}' during scene-link replay",
            scene_id,
            project_id
        );
    }
    Ok(())
}

fn validate_scene_event_association_source(
    conn: &rusqlite::Connection,
    source: &SceneEventAssociationSnapshot,
) -> anyhow::Result<()> {
    let current = collect_event_scene_links(conn, &source.event_id)?;
    for scene_id in &source.scene_ids {
        let actual = current.get(scene_id);
        let valid = if source.linked {
            actual == source.incarnations.get(scene_id)
        } else {
            actual.is_none()
        };
        anyhow::ensure!(
            valid,
            "scene-event association '{}' incarnation conflict during journal replay",
            scene_id
        );
    }
    Ok(())
}

fn set_scene_event_snapshot_incarnations(
    snap: &mut Value,
    parsed: &SceneEventAssociationSnapshot,
    incarnations: &SceneEventIncarnations,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        parsed.linked,
        "cannot attach tokens to an unlinked snapshot"
    );
    match parsed.shape {
        SceneEventSnapshotShape::Single => {
            let token = incarnations
                .get(&parsed.scene_ids[0])
                .ok_or_else(|| anyhow::anyhow!("fresh scene-link token is missing"))?;
            snap["incarnationToken"] = Value::from(token.clone());
        }
        SceneEventSnapshotShape::Batch => {
            let tokens = parsed
                .scene_ids
                .iter()
                .map(|scene_id| {
                    incarnations
                        .get(scene_id)
                        .cloned()
                        .map(|token| (scene_id.clone(), Value::from(token)))
                        .ok_or_else(|| anyhow::anyhow!("fresh scene-link token is missing"))
                })
                .collect::<anyhow::Result<serde_json::Map<_, _>>>()?;
            snap["incarnationTokens"] = Value::Object(tokens);
        }
    }
    Ok(())
}

fn rewrite_scene_event_snapshot_incarnation(
    raw: &str,
    event_id: &str,
    scene_id: &str,
    previous_token: &str,
    replay_token: &str,
) -> anyhow::Result<Option<String>> {
    let mut snap: Value = serde_json::from_str(raw)?;
    if snap["eventId"].as_str() != Some(event_id) || snap["linked"].as_bool() != Some(true) {
        return Ok(None);
    }
    let changed = if is_scene_event_link_batch_snapshot(&snap) {
        let includes_scene = snap["sceneIds"]
            .as_array()
            .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(scene_id)));
        if !includes_scene {
            false
        } else if snap["incarnationTokens"][scene_id].as_str() == Some(previous_token) {
            snap["incarnationTokens"][scene_id] = Value::from(replay_token);
            true
        } else {
            false
        }
    } else if snap["sceneId"].as_str() == Some(scene_id)
        && snap["incarnationToken"].as_str() == Some(previous_token)
    {
        snap["incarnationToken"] = Value::from(replay_token);
        true
    } else {
        false
    };
    Ok(changed.then(|| snap.to_string()))
}

fn rewrite_scene_event_journal_incarnation_chain(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_id: &str,
    excluded_journal_id: &str,
    scene_id: &str,
    previous_token: &str,
    replay_token: &str,
) -> anyhow::Result<()> {
    if previous_token.is_empty() {
        return Ok(());
    }
    let rows = {
        let mut statement = conn.prepare(
            "SELECT id, before_json, after_json FROM undo_journal
              WHERE project_id = ?1 AND entity_kind = 'event'
                AND entity_id = ?2 AND op_kind = 'update' AND id <> ?3",
        )?;
        let rows = statement
            .query_map(
                rusqlite::params![project_id, event_id, excluded_journal_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (journal_id, before_json, after_json) in rows {
        let rewritten_before = before_json
            .as_deref()
            .map(|raw| {
                rewrite_scene_event_snapshot_incarnation(
                    raw,
                    event_id,
                    scene_id,
                    previous_token,
                    replay_token,
                )
            })
            .transpose()?
            .flatten();
        let rewritten_after = after_json
            .as_deref()
            .map(|raw| {
                rewrite_scene_event_snapshot_incarnation(
                    raw,
                    event_id,
                    scene_id,
                    previous_token,
                    replay_token,
                )
            })
            .transpose()?
            .flatten();
        if rewritten_before.is_some() || rewritten_after.is_some() {
            conn.execute(
                "UPDATE undo_journal
                    SET before_json = COALESCE(?1, before_json),
                        after_json = COALESCE(?2, after_json)
                  WHERE id = ?3 AND project_id = ?4",
                rusqlite::params![rewritten_before, rewritten_after, journal_id, project_id],
            )?;
        }
    }
    Ok(())
}

fn replay_event_scene_association_snapshot(
    conn: &rusqlite::Connection,
    project_id: &str,
    row: &grimodex_core::undo_journal::UndoJournalRow,
    direction: &str,
) -> anyhow::Result<()> {
    let (source_raw, target_raw, target_column) = match direction {
        "undo" => (
            row.after_json.as_deref(),
            row.before_json.as_deref(),
            "before_json",
        ),
        "redo" => (
            row.before_json.as_deref(),
            row.after_json.as_deref(),
            "after_json",
        ),
        other => anyhow::bail!("invalid event replay direction: {other}"),
    };
    let source_raw = source_raw
        .ok_or_else(|| anyhow::anyhow!("scene-event journal is missing its source snapshot"))?;
    let target_raw = target_raw
        .ok_or_else(|| anyhow::anyhow!("scene-event journal is missing its target snapshot"))?;
    let source_value: Value = serde_json::from_str(source_raw)?;
    let mut target_value: Value = serde_json::from_str(target_raw)?;
    let source = parse_scene_event_association_snapshot(&source_value)?;
    let target = parse_scene_event_association_snapshot(&target_value)?;
    anyhow::ensure!(
        source.shape == target.shape
            && source.event_id == target.event_id
            && source.scene_ids == target.scene_ids
            && source.event_id == row.entity_id,
        "scene-event journal snapshots have mismatched association identity"
    );
    if source.linked == target.linked {
        anyhow::ensure!(
            !source.linked || source.incarnations == target.incarnations,
            "scene-event no-op journal has mismatched incarnation tokens"
        );
    }
    ensure_scene_event_association_scope(conn, project_id, &source)?;
    validate_scene_event_association_source(conn, &source)?;

    if source.linked && !target.linked {
        batch_delete_scene_event_incarnations(conn, &source.event_id, &source.incarnations)?;
    } else if !source.linked && target.linked {
        let scene_ids = target
            .scene_ids
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let fresh = batch_insert_scene_events(conn, &target.event_id, &scene_ids)?;
        set_scene_event_snapshot_incarnations(&mut target_value, &target, &fresh)?;
        let updated = match target_column {
            "before_json" => conn.execute(
                "UPDATE undo_journal SET before_json = ?1 WHERE id = ?2 AND project_id = ?3",
                rusqlite::params![target_value.to_string(), row.id, project_id],
            )?,
            "after_json" => conn.execute(
                "UPDATE undo_journal SET after_json = ?1 WHERE id = ?2 AND project_id = ?3",
                rusqlite::params![target_value.to_string(), row.id, project_id],
            )?,
            _ => unreachable!(),
        };
        anyhow::ensure!(
            updated == 1,
            "scene-event journal disappeared during replay"
        );
        for scene_id in &target.scene_ids {
            let previous = target
                .incarnations
                .get(scene_id)
                .ok_or_else(|| anyhow::anyhow!("target incarnation token is missing"))?;
            let replay = fresh
                .get(scene_id)
                .ok_or_else(|| anyhow::anyhow!("fresh incarnation token is missing"))?;
            rewrite_scene_event_journal_incarnation_chain(
                conn,
                project_id,
                &target.event_id,
                &row.id,
                scene_id,
                previous,
                replay,
            )?;
        }
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
    if is_scene_event_link_batch_snapshot(snap)
        || (snap.get("sceneId").is_some() && snap.get("eventId").is_some())
    {
        return replay_event_scene_association_snapshot(conn, project_id, row, direction);
    }
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

/// MCP has no current-scene disclosure context. Its write-by-id tools must
/// therefore treat secret Chronicle events exactly like missing or
/// cross-project rows. Keep this check inside the Native transaction so a
/// concurrent disclosure-state change cannot race the tool-layer preflight.
fn ensure_event_writable_for_surface(
    conn: &rusqlite::Connection,
    project_id: &str,
    event_id: &str,
    surface: Option<&str>,
) -> anyhow::Result<()> {
    if surface != Some("mcp") {
        return Ok(());
    }
    let visible: i64 = conn.query_row(
        "SELECT COUNT(*) FROM events
          WHERE id = ?1 AND project_id = ?2 AND secret = 0",
        rusqlite::params![event_id, project_id],
        |row| row.get(0),
    )?;
    anyhow::ensure!(
        visible == 1,
        "event '{event_id}' not found in project '{project_id}'"
    );
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
    pub canonical_event: AppendChangeEvent,
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

    let mut change_payload = json!({ "title": input.title, "kind": input.kind });
    if let Some(request_hash) = input.request_hash {
        change_payload["requestHash"] = Value::String(request_hash.to_string());
    }
    let canonical_event = AppendChangeEvent {
        event_uid: input.event_uid.to_string(),
        scene_id: None,
        domain: "event".to_string(),
        op_type: "event.create".to_string(),
        entity_type: Some("event".to_string()),
        entity_id: Some(input.event_id.to_string()),
        payload: change_payload.to_string(),
        timestamp: input.timestamp,
    };
    if input.write_change_event {
        append_change_events_in_tx(
            conn,
            input.project_id,
            input.session_id,
            std::slice::from_ref(&canonical_event),
        )?;
    }

    Ok(EventCreateTxResult {
        entity_id: input.event_id.to_string(),
        version: 1,
        change_event_uid: input.event_uid.to_string(),
        undo_journal_id: input.undo_id.to_string(),
        after_snapshot,
        canonical_event,
    })
}

pub fn agent_event_create_impl(
    db: &Database,
    payload: AgentEventCreatePayload,
) -> anyhow::Result<Value> {
    agent_event_create_with_authority_impl(db, payload, None)
}

pub fn agent_event_create_with_authority_impl(
    db: &Database,
    payload: AgentEventCreatePayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !payload.request_id.trim().is_empty(),
        "requestId must not be empty"
    );
    if let Some(context) = renderer_context.as_ref() {
        validate_renderer_chronicle_context(&payload.request_id, context)?;
    }
    let request_hash = event_create_request_hash(&payload)?;
    let feed_request_id = payload.request_id.clone();
    let request_id = payload.request_id.clone();
    let event_id = payload
        .event_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let undo_id = request_id.clone();
    let event_uid = renderer_context
        .as_ref()
        .map(|context| context.event_uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    let title = payload.title.clone().unwrap_or_default();
    let ordinal = payload.ordinal.clone().unwrap_or_else(|| "a0".to_string());
    let precision = payload
        .precision
        .clone()
        .unwrap_or_else(|| "exact".to_string());
    let kind = payload
        .kind
        .clone()
        .unwrap_or_else(|| "generic".to_string());
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
    let reveal_scene_id = payload.reveal_scene_id.clone().filter(|s| !s.is_empty());

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            if let Some(existing) = existing_request_result(
                conn,
                &request_id,
                &request_hash,
                "AGENT_EVENT_CREATE_IDEMPOTENCY_CONFLICT",
            )? {
                return Ok(existing);
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
                    request_hash: Some(&request_hash),
                    now: &now,
                    timestamp,
                    write_undo_journal: true,
                    write_change_event: false,
                },
            )?;

            append_agent_forward_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                payload.surface.as_deref(),
                Some(&feed_request_id),
                &created.undo_journal_id,
                &created.canonical_event,
                None,
                renderer_context.as_ref(),
            )?;

            record_manual_event_fields(
                conn,
                &payload.project_id,
                &created.entity_id,
                payload.surface.as_deref(),
                EVENT_AUTHORITY_FIELDS,
                &now,
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
    agent_event_update_with_request_impl(db, payload, None)
}

pub fn agent_event_update_with_request_impl(
    db: &Database,
    payload: AgentEventUpdatePayload,
    request_id: Option<&str>,
) -> anyhow::Result<Value> {
    agent_event_update_with_request_and_authority_impl(db, payload, request_id, None)
}

pub fn agent_event_update_with_authority_impl(
    db: &Database,
    payload: AgentEventUpdatePayload,
    context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    let request_id = context.request_id.clone();
    agent_event_update_with_request_and_authority_impl(
        db,
        payload,
        Some(&request_id),
        Some(context),
    )
}

fn agent_event_update_with_request_and_authority_impl(
    db: &Database,
    payload: AgentEventUpdatePayload,
    request_id: Option<&str>,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    if let Some(context) = renderer_context.as_ref() {
        let request_id = request_id.ok_or_else(|| anyhow::anyhow!("requestId is required"))?;
        validate_renderer_chronicle_context(request_id, context)?;
    }
    struct CurrentChronicleRange {
        version: i64,
        start_time: Option<i64>,
        end_time: Option<i64>,
        start_minute: Option<i64>,
        end_minute: Option<i64>,
        start_granularity: String,
        end_granularity: String,
    }

    let request_hash = request_id
        .map(|_| event_update_request_hash(&payload))
        .transpose()?;
    let request = request_hash
        .as_deref()
        .map(|payload_hash| IdempotencyRequest {
            domain: "agent_event_update",
            request_id,
            payload_hash,
            conflict_marker: "AGENT_EVENT_UPDATE_IDEMPOTENCY_CONFLICT",
        });
    let undo_id = request_id
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = renderer_context
        .as_ref()
        .map(|context| context.event_uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        use rusqlite::OptionalExtension;

        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            if let Some(request) = request.as_ref() {
                if let Some(existing) = load_idempotent_response(conn, request)? {
                    return serde_json::from_value(existing).map_err(Into::into);
                }
            }
            ensure_event_writable_for_surface(
                conn,
                &payload.project_id,
                &payload.event_id,
                payload.surface.as_deref(),
            )?;
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

            let authority_paths = fields
                .iter()
                .map(|field| {
                    authority_path_for_field("event", field, EVENT_AUTHORITY_FIELDS)
                        .map(str::to_string)
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "event update derived an unknown authority field '{field}'"
                            )
                        })
                })
                .collect::<anyhow::Result<Vec<_>>>()?;
            preflight_agent_field_authority(
                conn,
                &payload.project_id,
                "event",
                &payload.event_id,
                &authority_paths,
                &now,
                payload.surface.as_deref(),
                renderer_context.as_ref(),
            )?;

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

            let canonical_event = AppendChangeEvent {
                event_uid: event_uid.clone(),
                scene_id: None,
                domain: "event".to_string(),
                op_type: "event.update".to_string(),
                entity_type: Some("event".to_string()),
                entity_id: Some(payload.event_id.clone()),
                payload: json!({ "fields": fields }).to_string(),
                timestamp,
            };
            append_agent_forward_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                payload.surface.as_deref(),
                request_id,
                &undo_id,
                &canonical_event,
                None,
                renderer_context.as_ref(),
            )?;

            record_manual_event_fields(
                conn,
                &payload.project_id,
                &payload.event_id,
                payload.surface.as_deref(),
                EVENT_AUTHORITY_FIELDS,
                &now,
            )?;

            let response = AgentWriteResult {
                entity_id: payload.event_id.clone(),
                version: result_version,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            };
            if let Some(request) = request.as_ref() {
                insert_idempotent_response(
                    conn,
                    request,
                    &payload.project_id,
                    &serde_json::to_value(&response)?,
                )?;
            }
            Ok(response)
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
    agent_event_delete_with_request_impl(db, payload, None)
}

pub fn agent_event_delete_with_request_impl(
    db: &Database,
    payload: AgentEventIdPayload,
    request_id: Option<&str>,
) -> anyhow::Result<Value> {
    agent_event_delete_with_request_and_authority_impl(db, payload, request_id, None)
}

pub fn agent_event_delete_with_authority_impl(
    db: &Database,
    payload: AgentEventIdPayload,
    context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    let request_id = context.request_id.clone();
    agent_event_delete_with_request_and_authority_impl(
        db,
        payload,
        Some(&request_id),
        Some(context),
    )
}

fn agent_event_delete_with_request_and_authority_impl(
    db: &Database,
    payload: AgentEventIdPayload,
    request_id: Option<&str>,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    if let Some(context) = renderer_context.as_ref() {
        let request_id = request_id.ok_or_else(|| anyhow::anyhow!("requestId is required"))?;
        validate_renderer_chronicle_context(request_id, context)?;
    }
    let request_hash = request_id
        .map(|_| event_delete_request_hash(&payload))
        .transpose()?;
    let request = request_hash
        .as_deref()
        .map(|payload_hash| IdempotencyRequest {
            domain: "agent_event_delete",
            request_id,
            payload_hash,
            conflict_marker: "AGENT_EVENT_DELETE_IDEMPOTENCY_CONFLICT",
        });
    let undo_id = request_id
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = renderer_context
        .as_ref()
        .map(|context| context.event_uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            if let Some(request) = request.as_ref() {
                if let Some(existing) = load_idempotent_response(conn, request)? {
                    return serde_json::from_value(existing).map_err(Into::into);
                }
            }
            ensure_event_writable_for_surface(
                conn,
                &payload.project_id,
                &payload.event_id,
                payload.surface.as_deref(),
            )?;
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
            let mut feed_event_ids = related_event_ids.clone();
            feed_event_ids.push(payload.event_id.clone());
            feed_event_ids.sort();
            feed_event_ids.dedup();
            let before_feed = feed_event_ids
                .iter()
                .map(|event_id| {
                    collect_event_snapshot(conn, event_id)
                        .map(|snapshot| (event_id.clone(), snapshot))
                })
                .collect::<anyhow::Result<std::collections::BTreeMap<_, _>>>()?;
            let before = before_value.to_string();

            let authority_paths = EVENT_AUTHORITY_FIELDS
                .iter()
                .map(|path| (*path).to_string())
                .collect::<Vec<_>>();
            preflight_agent_field_authority(
                conn,
                &payload.project_id,
                "event",
                &payload.event_id,
                &authority_paths,
                &now,
                payload.surface.as_deref(),
                renderer_context.as_ref(),
            )?;

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

            let after_feed = feed_event_ids
                .iter()
                .map(|event_id| {
                    collect_event_snapshot_optional(conn, &payload.project_id, event_id)
                        .map(|snapshot| (event_id.clone(), snapshot))
                })
                .collect::<anyhow::Result<std::collections::BTreeMap<_, _>>>()?;
            let narrative_events = feed_event_ids
                .iter()
                .map(|event_id| {
                    let is_deleted_root = event_id == &payload.event_id;
                    chronicle_event_transition_input(
                        event_id,
                        before_feed.get(event_id),
                        after_feed.get(event_id).and_then(Option::as_ref),
                        if is_deleted_root {
                            "metadata"
                        } else {
                            "association"
                        },
                        if is_deleted_root {
                            vec!["/".to_string()]
                        } else {
                            vec!["/relations".to_string()]
                        },
                        false,
                    )
                })
                .collect::<anyhow::Result<Vec<_>>>()?;

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

            let canonical_event = AppendChangeEvent {
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
            };
            append_agent_forward_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                payload.surface.as_deref(),
                request_id,
                &undo_id,
                &canonical_event,
                Some(narrative_events),
                renderer_context.as_ref(),
            )?;

            record_manual_event_fields(
                conn,
                &payload.project_id,
                &payload.event_id,
                payload.surface.as_deref(),
                EVENT_AUTHORITY_FIELDS,
                &now,
            )?;

            let response = AgentWriteResult {
                entity_id: payload.event_id.clone(),
                version: 0,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            };
            if let Some(request) = request.as_ref() {
                insert_idempotent_response(
                    conn,
                    request,
                    &payload.project_id,
                    &serde_json::to_value(&response)?,
                )?;
            }
            Ok(response)
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
    agent_event_set_participants_with_request_impl(db, payload, None)
}

pub fn agent_event_set_participants_with_request_impl(
    db: &Database,
    payload: AgentEventParticipantsPayload,
    request_id: Option<&str>,
) -> anyhow::Result<Value> {
    agent_event_set_participants_with_request_and_authority_impl(db, payload, request_id, None)
}

pub fn agent_event_set_participants_with_authority_impl(
    db: &Database,
    payload: AgentEventParticipantsPayload,
    context: RendererCanonicalWriteContext,
) -> anyhow::Result<Value> {
    let request_id = context.request_id.clone();
    agent_event_set_participants_with_request_and_authority_impl(
        db,
        payload,
        Some(&request_id),
        Some(context),
    )
}

fn agent_event_set_participants_with_request_and_authority_impl(
    db: &Database,
    payload: AgentEventParticipantsPayload,
    request_id: Option<&str>,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    if let Some(context) = renderer_context.as_ref() {
        let request_id = request_id.ok_or_else(|| anyhow::anyhow!("requestId is required"))?;
        validate_renderer_chronicle_context(request_id, context)?;
    }
    let request_hash = request_id
        .map(|_| event_participants_request_hash(&payload))
        .transpose()?;
    let request = request_hash
        .as_deref()
        .map(|payload_hash| IdempotencyRequest {
            domain: "agent_event_participants",
            request_id,
            payload_hash,
            conflict_marker: "AGENT_EVENT_PARTICIPANTS_IDEMPOTENCY_CONFLICT",
        });
    let undo_id = request_id
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let event_uid = renderer_context
        .as_ref()
        .map(|context| context.event_uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            use rusqlite::OptionalExtension;

            if let Some(request) = request.as_ref() {
                if let Some(existing) = load_idempotent_response(conn, request)? {
                    return serde_json::from_value(existing).map_err(Into::into);
                }
            }

            ensure_event_writable_for_surface(
                conn,
                &payload.project_id,
                &payload.event_id,
                payload.surface.as_deref(),
            )?;
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

            let authority_paths = vec!["/participants".to_string()];
            preflight_agent_field_authority(
                conn,
                &payload.project_id,
                "event",
                &payload.event_id,
                &authority_paths,
                &now,
                payload.surface.as_deref(),
                renderer_context.as_ref(),
            )?;

            let before_feed = collect_event_snapshot(conn, &payload.event_id)?;
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
            if let Some(roles) = payload.participant_roles.as_ref() {
                anyhow::ensure!(
                    roles.len() == payload.codex_entry_ids.len(),
                    "participantRoles must align with codexEntryIds"
                );
            }
            for codex_id in &payload.codex_entry_ids {
                // Scope guard: the event is already confirmed in this project
                // above, but each participant must be too — otherwise a P1 event
                // could be linked to a P2 codex entry. Bail rolls back the tx.
                ensure_codex_in_project(conn, &payload.project_id, codex_id)?;
            }
            let participant_rows: Vec<(&str, Option<&str>)> = payload
                .codex_entry_ids
                .iter()
                .enumerate()
                .map(|(index, codex_id)| {
                    (
                        codex_id.as_str(),
                        payload
                            .participant_roles
                            .as_ref()
                            .and_then(|roles| roles.get(index))
                            .and_then(Option::as_deref),
                    )
                })
                .collect();
            batch_insert_event_participants(conn, &payload.event_id, &participant_rows)?;

            let after = collect_participants_json(conn, &payload.event_id)?.to_string();
            let after_feed = collect_event_snapshot(conn, &payload.event_id)?;

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

            let canonical_event = AppendChangeEvent {
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
            };
            append_agent_forward_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                payload.surface.as_deref(),
                request_id,
                &undo_id,
                &canonical_event,
                Some(vec![chronicle_event_feed_input(
                    &payload.event_id,
                    Some(&before_feed),
                    Some(&after_feed),
                    "update",
                    "association",
                    vec!["/participants".to_string()],
                )?]),
                renderer_context.as_ref(),
            )?;

            record_manual_event_fields(
                conn,
                &payload.project_id,
                &payload.event_id,
                payload.surface.as_deref(),
                &["/participants"],
                &now,
            )?;

            let response = AgentWriteResult {
                entity_id: payload.event_id.clone(),
                version: result_version,
                change_event_uid: event_uid,
                undo_journal_id: undo_id,
            };
            if let Some(request) = request.as_ref() {
                insert_idempotent_response(
                    conn,
                    request,
                    &payload.project_id,
                    &serde_json::to_value(&response)?,
                )?;
            }
            Ok(response)
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
    agent_scene_event_mutate_with_authority_impl(db, payload, link, None)
}

pub fn agent_scene_event_mutate_with_authority_impl(
    db: &Database,
    payload: AgentSceneEventPayload,
    link: bool,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !payload.request_id.trim().is_empty(),
        "requestId must not be empty"
    );
    if let Some(context) = renderer_context.as_ref() {
        validate_renderer_chronicle_context(&payload.request_id, context)?;
    }
    let request_hash = scene_event_request_hash(&payload, link)?;
    let undo_id = payload.request_id.clone();
    let event_uid = renderer_context
        .as_ref()
        .map(|context| context.event_uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let existing_request = existing_request_result(
                conn,
                &payload.request_id,
                &request_hash,
                "AGENT_SCENE_EVENT_IDEMPOTENCY_CONFLICT",
            )?;
            if existing_request.is_none() {
                ensure_event_writable_for_surface(
                    conn,
                    &payload.project_id,
                    &payload.event_id,
                    payload.surface.as_deref(),
                )?;
            }
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

            let existing_token = conn
                .query_row(
                    "SELECT incarnation_token FROM scene_events
                     WHERE scene_id = ?1 AND event_id = ?2",
                    rusqlite::params![payload.scene_id, payload.event_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let before = scene_event_link_snapshot(
                &payload.scene_id,
                &payload.event_id,
                existing_token.is_some(),
                existing_token.as_deref(),
            )
            .to_string();
            if let Some(existing) = existing_request {
                let after_raw: String = conn.query_row(
                    "SELECT after_json FROM undo_journal WHERE id = ?1",
                    rusqlite::params![undo_id],
                    |row| row.get(0),
                )?;
                let after_value: Value = serde_json::from_str(&after_raw)?;
                let original_after = parse_scene_event_association_snapshot(&after_value)?;
                let state_matches = original_after.event_id == payload.event_id
                    && original_after.scene_ids == vec![payload.scene_id.clone()]
                    && original_after.linked == link
                    && if link {
                        existing_token.as_ref()
                            == original_after.incarnations.get(&payload.scene_id)
                    } else {
                        existing_token.is_none()
                    };
                if state_matches {
                    return Ok(existing);
                }
                anyhow::bail!(
                    "AGENT_SCENE_EVENT_IDEMPOTENCY_CONFLICT: association state changed after original request"
                );
            }

            let authority_paths = vec!["/sceneIds".to_string()];
            preflight_agent_field_authority(
                conn,
                &payload.project_id,
                "event",
                &payload.event_id,
                &authority_paths,
                &now,
                payload.surface.as_deref(),
                renderer_context.as_ref(),
            )?;
            let before_feed = collect_event_snapshot(conn, &payload.event_id)?;

            let after_token = if link {
                if let Some(token) = existing_token.as_ref() {
                    Some(token.clone())
                } else {
                    let token = uuid::Uuid::new_v4().to_string();
                    let inserted = conn.execute(
                        "INSERT INTO scene_events
                         (scene_id, event_id, incarnation_token) VALUES (?1, ?2, ?3)",
                        rusqlite::params![payload.scene_id, payload.event_id, token],
                    )?;
                    anyhow::ensure!(inserted == 1, "scene-event association was not inserted");
                    Some(token)
                }
            } else {
                if let Some(token) = existing_token.as_ref() {
                    let deleted = conn.execute(
                        "DELETE FROM scene_events
                         WHERE scene_id = ?1 AND event_id = ?2 AND incarnation_token = ?3",
                        rusqlite::params![payload.scene_id, payload.event_id, token],
                    )?;
                    anyhow::ensure!(
                        deleted == 1,
                        "scene-event association incarnation changed before unlink"
                    );
                }
                None
            };

            let after = scene_event_link_snapshot(
                &payload.scene_id,
                &payload.event_id,
                link,
                after_token.as_deref(),
            )
            .to_string();
            let after_feed = collect_event_snapshot(conn, &payload.event_id)?;

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

            let canonical_event = AppendChangeEvent {
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
            };
            append_agent_forward_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                payload.surface.as_deref(),
                Some(&payload.request_id),
                &undo_id,
                &canonical_event,
                Some(vec![chronicle_event_feed_input(
                    &payload.event_id,
                    Some(&before_feed),
                    Some(&after_feed),
                    "update",
                    "association",
                    vec!["/sceneIds".to_string()],
                )?]),
                renderer_context.as_ref(),
            )?;

            record_manual_event_fields(
                conn,
                &payload.project_id,
                &payload.event_id,
                payload.surface.as_deref(),
                &["/sceneIds"],
                &now,
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

pub fn agent_scene_event_link_batch_impl(
    db: &Database,
    payload: AgentSceneEventLinkBatchPayload,
) -> anyhow::Result<Value> {
    agent_scene_event_link_batch_with_authority_impl(db, payload, None)
}

pub fn agent_scene_event_link_batch_with_authority_impl(
    db: &Database,
    mut payload: AgentSceneEventLinkBatchPayload,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    for (value, field) in [
        (&payload.request_id, "requestId"),
        (&payload.project_id, "projectId"),
        (&payload.session_id, "sessionId"),
        (&payload.event_id, "eventId"),
    ] {
        if value.is_empty() {
            anyhow::bail!("agent scene event link batch {field} must not be empty");
        }
    }
    if let Some(context) = renderer_context.as_ref() {
        validate_renderer_chronicle_context(&payload.request_id, context)?;
    }
    if payload.scene_ids.is_empty() {
        anyhow::bail!("agent scene event link batch sceneIds must not be empty");
    }
    if payload.scene_ids.len() > 10_000 {
        anyhow::bail!("agent scene event link batch sceneIds must contain at most 10000 ids");
    }
    payload.scene_ids.sort();
    payload.scene_ids.dedup();
    if payload.scene_ids.iter().any(String::is_empty) {
        anyhow::bail!("agent scene event link batch sceneIds must not contain empty ids");
    }

    let request_hash = scene_event_link_batch_request_hash(&payload)?;
    let undo_id = payload.request_id.clone();
    let event_uid = renderer_context
        .as_ref()
        .map(|context| context.event_uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let existing_request = existing_request_result(
                conn,
                &payload.request_id,
                &request_hash,
                "AGENT_SCENE_EVENT_LINK_BATCH_IDEMPOTENCY_CONFLICT",
            )?;
            if existing_request.is_none() {
                ensure_event_writable_for_surface(
                    conn,
                    &payload.project_id,
                    &payload.event_id,
                    payload.surface.as_deref(),
                )?;
            }

            let event_version: i64 = conn
                .query_row(
                    "SELECT version FROM events WHERE id = ?1 AND project_id = ?2",
                    rusqlite::params![payload.event_id, payload.project_id],
                    |row| row.get(0),
                )
                .map_err(|_| {
                    anyhow::anyhow!(
                        "event '{}' not found in project '{}'",
                        payload.event_id,
                        payload.project_id
                    )
                })?;

            for scene_id in &payload.scene_ids {
                let scene_owned: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM tree_nodes
                     WHERE id = ?1 AND project_id = ?2 AND node_type = 'scene'",
                    rusqlite::params![scene_id, payload.project_id],
                    |row| row.get(0),
                )?;
                if scene_owned == 0 {
                    anyhow::bail!(
                        "scene '{}' not found in project '{}'",
                        scene_id,
                        payload.project_id
                    );
                }
            }

            let current_links = collect_event_scene_links(conn, &payload.event_id)?;
            if let Some(existing) = existing_request {
                let requested_links_present = payload
                    .scene_ids
                    .iter()
                    .all(|scene_id| current_links.contains_key(scene_id));
                let after_raw: String = conn.query_row(
                    "SELECT after_json FROM undo_journal WHERE id = ?1",
                    rusqlite::params![payload.request_id],
                    |row| row.get(0),
                )?;
                let after_value: Value = serde_json::from_str(&after_raw)?;
                let original_after = parse_scene_event_association_snapshot(&after_value)?;
                let owned_delta_matches = original_after.event_id == payload.event_id
                    && original_after.linked
                    && original_after.scene_ids.iter().all(|scene_id| {
                        current_links.get(scene_id) == original_after.incarnations.get(scene_id)
                    });
                if requested_links_present && owned_delta_matches {
                    return Ok(existing);
                }
                anyhow::bail!(
                    "AGENT_SCENE_EVENT_LINK_BATCH_IDEMPOTENCY_CONFLICT: association state changed after original request"
                );
            }

            let added_scene_ids: Vec<String> = payload
                .scene_ids
                .iter()
                .filter(|scene_id| !current_links.contains_key(*scene_id))
                .cloned()
                .collect();
            let authority_paths = vec!["/sceneIds".to_string()];
            preflight_agent_field_authority(
                conn,
                &payload.project_id,
                "event",
                &payload.event_id,
                &authority_paths,
                &now,
                payload.surface.as_deref(),
                renderer_context.as_ref(),
            )?;
            let before_feed = collect_event_snapshot(conn, &payload.event_id)?;
            let scene_id_refs: Vec<&str> =
                added_scene_ids.iter().map(String::as_str).collect();
            let added_incarnations =
                batch_insert_scene_events(conn, &payload.event_id, &scene_id_refs)?;
            let after_feed = collect_event_snapshot(conn, &payload.event_id)?;
            let before_snapshot = scene_event_link_batch_snapshot(
                &payload.event_id,
                &added_scene_ids,
                false,
                None,
            );
            let after_snapshot = scene_event_link_batch_snapshot(
                &payload.event_id,
                &added_scene_ids,
                true,
                Some(&added_incarnations),
            );
            let before = before_snapshot.to_string();
            let after = after_snapshot.to_string();

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

            let canonical_event = AppendChangeEvent {
                event_uid: event_uid.clone(),
                scene_id: None,
                domain: "event".to_string(),
                op_type: "event.stamp".to_string(),
                entity_type: Some("event".to_string()),
                entity_id: Some(payload.event_id.clone()),
                payload: json!({
                    "eventId": payload.event_id,
                    "sceneIds": added_scene_ids,
                    "requestHash": request_hash,
                })
                .to_string(),
                timestamp,
            };
            append_agent_forward_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                payload.surface.as_deref(),
                Some(&payload.request_id),
                &undo_id,
                &canonical_event,
                Some(vec![chronicle_event_feed_input(
                    &payload.event_id,
                    Some(&before_feed),
                    Some(&after_feed),
                    "update",
                    "association",
                    vec!["/sceneIds".to_string()],
                )?]),
                renderer_context.as_ref(),
            )?;

            record_manual_event_fields(
                conn,
                &payload.project_id,
                &payload.event_id,
                payload.surface.as_deref(),
                &["/sceneIds"],
                &now,
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
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    })
}

pub fn agent_event_relation_mutate_impl(
    db: &Database,
    payload: AgentEventRelationPayload,
    add: bool,
) -> anyhow::Result<Value> {
    agent_event_relation_mutate_with_authority_impl(db, payload, add, None)
}

pub fn agent_event_relation_mutate_with_authority_impl(
    db: &Database,
    payload: AgentEventRelationPayload,
    add: bool,
    renderer_context: Option<RendererCanonicalWriteContext>,
) -> anyhow::Result<Value> {
    anyhow::ensure!(
        !payload.request_id.trim().is_empty(),
        "requestId must not be empty"
    );
    if let Some(context) = renderer_context.as_ref() {
        validate_renderer_chronicle_context(&payload.request_id, context)?;
    }
    let request_hash = event_relation_request_hash(&payload, add)?;
    let undo_id = payload.request_id.clone();
    let event_uid = renderer_context
        .as_ref()
        .map(|context| context.event_uid.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = chrono::Utc::now().to_rfc3339();
    let timestamp = chrono::Utc::now().timestamp_millis();

    db.with_conn(|conn| {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| -> anyhow::Result<AgentWriteResult> {
            let existing_request = existing_request_result(
                conn,
                &payload.request_id,
                &request_hash,
                "AGENT_EVENT_RELATION_IDEMPOTENCY_CONFLICT",
            )?;
            if payload.cause_event_id == payload.effect_event_id {
                anyhow::bail!("self-loop event relation forbidden");
            }
            if existing_request.is_none() {
                ensure_event_writable_for_surface(
                    conn,
                    &payload.project_id,
                    &payload.cause_event_id,
                    payload.surface.as_deref(),
                )?;
                ensure_event_writable_for_surface(
                    conn,
                    &payload.project_id,
                    &payload.effect_event_id,
                    payload.surface.as_deref(),
                )?;
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

            let authority_paths = vec!["/relations".to_string()];
            preflight_agent_field_authority(
                conn,
                &payload.project_id,
                "event",
                &payload.cause_event_id,
                &authority_paths,
                &now,
                payload.surface.as_deref(),
                renderer_context.as_ref(),
            )?;
            preflight_agent_field_authority(
                conn,
                &payload.project_id,
                "event",
                &payload.effect_event_id,
                &authority_paths,
                &now,
                payload.surface.as_deref(),
                renderer_context.as_ref(),
            )?;

            let mut feed_event_ids = [
                payload.cause_event_id.clone(),
                payload.effect_event_id.clone(),
            ];
            feed_event_ids.sort();
            let before_feed = feed_event_ids
                .iter()
                .map(|event_id| {
                    collect_event_snapshot(conn, event_id)
                        .map(|snapshot| (event_id.clone(), snapshot))
                })
                .collect::<anyhow::Result<std::collections::BTreeMap<_, _>>>()?;

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
            let after_feed = feed_event_ids
                .iter()
                .map(|event_id| {
                    collect_event_snapshot(conn, event_id)
                        .map(|snapshot| (event_id.clone(), snapshot))
                })
                .collect::<anyhow::Result<std::collections::BTreeMap<_, _>>>()?;
            let narrative_events = feed_event_ids
                .iter()
                .map(|event_id| {
                    chronicle_event_feed_input(
                        event_id,
                        before_feed.get(event_id),
                        after_feed.get(event_id),
                        "update",
                        "association",
                        vec!["/relations".to_string()],
                    )
                })
                .collect::<anyhow::Result<Vec<_>>>()?;

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

            let canonical_event = AppendChangeEvent {
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
            };
            append_agent_forward_change_in_tx(
                conn,
                &payload.project_id,
                &payload.session_id,
                payload.surface.as_deref(),
                Some(&payload.request_id),
                &undo_id,
                &canonical_event,
                Some(narrative_events),
                renderer_context.as_ref(),
            )?;

            record_manual_event_fields(
                conn,
                &payload.project_id,
                &payload.cause_event_id,
                payload.surface.as_deref(),
                &["/relations"],
                &now,
            )?;
            record_manual_event_fields(
                conn,
                &payload.project_id,
                &payload.effect_event_id,
                payload.surface.as_deref(),
                &["/relations"],
                &now,
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

    fn renderer_authority_fields(route: &str, caller: &str) -> (String, String, Vec<String>) {
        (
            route.to_string(),
            caller.to_string(),
            required_controls_for_route(route)
                .expect("test route controls")
                .iter()
                .map(|control| (*control).to_string())
                .collect(),
        )
    }

    fn renderer_agent_context(request_id: &str, event_uid: &str) -> RendererCanonicalWriteContext {
        RendererCanonicalWriteContext {
            request_id: request_id.to_string(),
            event_uid: event_uid.to_string(),
            authority_session_id: None,
            origin: NarrativeChangeOrigin::AiApply,
            authority_route: "interactive-agent-command".to_string(),
            caller: "chat-tool-executor".to_string(),
            controls: renderer_authority_fields("interactive-agent-command", "chat-tool-executor")
                .2,
            provenance: Some(RendererMutationProvenance {
                request_id: request_id.to_string(),
                trace_id: format!("{request_id}:trace"),
                chat_message_id: Some(format!("{request_id}:message")),
                tool_call_id: Some(format!("{request_id}:tool")),
                execution_id: Some(format!("{request_id}:execution")),
                main_owned_provenance_id: Some(format!("{request_id}:main")),
            }),
            writes_authority_protected_field: false,
            original_transaction_id: None,
            undo_journal_id: None,
            context_mode: None,
            icon: None,
            children_budget: None,
            notes: None,
            canonical_payload: None,
        }
    }

    #[test]
    fn renderer_authority_rejects_versioned_background_callers() {
        let context = RendererCanonicalWriteContext {
            request_id: "request-1".to_string(),
            event_uid: "event-1".to_string(),
            authority_session_id: None,
            origin: NarrativeChangeOrigin::AiApply,
            authority_route: "interactive-agent-command".to_string(),
            caller: "background-maintenance-v2".to_string(),
            controls: renderer_authority_fields("interactive-agent-command", "chat-tool-executor")
                .2,
            provenance: Some(RendererMutationProvenance {
                request_id: "request-1".to_string(),
                trace_id: "trace-1".to_string(),
                chat_message_id: None,
                tool_call_id: None,
                execution_id: None,
                main_owned_provenance_id: None,
            }),
            writes_authority_protected_field: false,
            original_transaction_id: None,
            undo_journal_id: None,
            context_mode: None,
            icon: None,
            children_budget: None,
            notes: None,
            canonical_payload: None,
        };
        let error = validate_renderer_authority_context(&context)
            .expect_err("unknown background caller must fail closed");
        assert!(error.to_string().contains("Forbidden caller"));
    }

    #[test]
    fn renderer_authority_rejects_empty_controls() {
        let context = RendererCanonicalWriteContext {
            request_id: "request-1".to_string(),
            event_uid: "event-1".to_string(),
            authority_session_id: None,
            origin: NarrativeChangeOrigin::Human,
            authority_route: "human-direct".to_string(),
            caller: "human-ui".to_string(),
            controls: Vec::new(),
            provenance: None,
            writes_authority_protected_field: false,
            original_transaction_id: None,
            undo_journal_id: None,
            context_mode: None,
            icon: None,
            children_budget: None,
            notes: None,
            canonical_payload: None,
        };

        let error = validate_renderer_authority_context(&context)
            .expect_err("an explicit empty controls list must fail closed");
        assert!(error.to_string().contains("Missing required control"));
    }

    #[test]
    fn agent_field_authority_denies_human_paths_and_allows_new_ai_ownership() {
        let db = test_db();
        let project_id = insert_project(&db);
        tracked_codex_create(&db, &project_id, "authority-entry", "Human seed", 0);
        let paths = vec!["/name".to_string()];

        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'codex-entry'
                    AND entity_id = 'authority-entry'",
                rusqlite::params![project_id],
            )?;
            record_agent_field_authority_for_entity(
                conn,
                &project_id,
                "codex-entry",
                "authority-entry",
                &paths,
                "2026-08-15T00:00:00Z",
            )?;
            let owner: String = conn.query_row(
                "SELECT owner_kind FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'codex-entry'
                    AND entity_id = 'authority-entry' AND field_path = '/name'",
                rusqlite::params![project_id],
                |row| row.get(0),
            )?;
            assert_eq!(owner, "ai");

            conn.execute(
                "UPDATE narrative_field_authority SET owner_kind = 'human'
                  WHERE project_id = ?1 AND entity_kind = 'codex-entry'
                    AND entity_id = 'authority-entry' AND field_path = '/name'",
                rusqlite::params![project_id],
            )?;
            let error = validate_agent_field_authority_for_entity(
                conn,
                &project_id,
                "codex-entry",
                "authority-entry",
                &paths,
                "2026-08-15T00:00:01Z",
            )
            .expect_err("human-owned fields must be rejected");
            assert!(error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));
            Ok(())
        })
        .expect("field authority transaction");
    }

    #[test]
    fn renderer_codex_delete_preflights_legacy_fields_before_domain_delete() {
        let db = test_db();
        let project_id = insert_project(&db);
        tracked_codex_create(&db, &project_id, "legacy-delete-entry", "Legacy name", 0);
        let version: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT version FROM codex_entries WHERE id = 'legacy-delete-entry'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("read legacy Codex version");

        let error = renderer_codex_delete_impl(
            &db,
            AgentCodexDeletePayload {
                project_id: project_id.clone(),
                session_id: "legacy-delete-session".to_string(),
                surface: Some("in-app-agent".to_string()),
                entry_id: "legacy-delete-entry".to_string(),
                base_version: version,
            },
            renderer_agent_context("legacy-codex-delete", "legacy-codex-delete:event"),
        )
        .expect_err("legacy Codex fields without authority must deny AI delete");
        assert!(error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));
        assert_eq!(table_count(&db, "codex_entries"), 1);
    }

    #[test]
    fn renderer_event_delete_preflights_legacy_fields_before_domain_delete() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) =
            create_event(&db, &project_id, "Legacy chronicle title", vec![], vec![]);
        let version: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT version FROM events WHERE id = ?1",
                    rusqlite::params![event_id],
                    |row| row.get(0),
                )?)
            })
            .expect("read legacy event version");

        let error = agent_event_delete_with_authority_impl(
            &db,
            AgentEventIdPayload {
                project_id: project_id.clone(),
                session_id: "legacy-event-delete-session".to_string(),
                surface: Some("in-app-agent".to_string()),
                event_id: event_id.clone(),
                base_version: version,
            },
            renderer_agent_context("legacy-event-delete", "legacy-event-delete:event"),
        )
        .expect_err("legacy event fields without authority must deny AI delete");
        assert!(error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));
        assert_eq!(table_count(&db, "events"), 1);
    }

    #[test]
    fn renderer_foreshadow_delete_preflights_legacy_title_before_domain_delete() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow_row(&db, &project_id);

        let request_id = "legacy-foreshadow-delete";
        let event_uid = "legacy-foreshadow-delete:event";
        let error = crate::foreshadow::delete_with_renderer_authority(
            &db,
            crate::foreshadow::ForeshadowDeletePayload {
                id: foreshadow_id,
                project_id: project_id.clone(),
                base_version: 0,
                context: crate::foreshadow::RendererWriteContext {
                    request_id: request_id.to_string(),
                    session_id: "legacy-foreshadow-delete-session".to_string(),
                    event_uid: event_uid.to_string(),
                    origin: NarrativeChangeOrigin::AiApply,
                    original_transaction_id: None,
                    undo_journal_id: None,
                },
            },
            Some(renderer_agent_context(request_id, event_uid)),
        )
        .expect_err("legacy Foreshadow title without authority must deny AI delete");
        assert!(error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));
        assert_eq!(table_count(&db, "foreshadows"), 1);
    }

    #[test]
    fn renderer_codex_update_preflights_legacy_content_and_summary_before_patch() {
        let db = test_db();
        let project_id = insert_project(&db);
        tracked_codex_create(&db, &project_id, "legacy-update-entry", "Legacy name", 0);
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'codex-entry'
                    AND entity_id = 'legacy-update-entry'",
                rusqlite::params![project_id],
            )?;
            Ok(())
        })
        .expect("remove generated Codex authority rows");

        let version: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT version FROM codex_entries WHERE id = 'legacy-update-entry'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("read legacy Codex version");

        let content_error = renderer_codex_update_impl(
            &db,
            AgentCodexUpdatePayload {
                project_id: project_id.clone(),
                session_id: "legacy-update-session".to_string(),
                surface: Some("in-app-agent".to_string()),
                entry_id: "legacy-update-entry".to_string(),
                base_version: version,
                type_slug: None,
                name: None,
                summary: None,
                content: Some("tampered content".to_string()),
                aliases: None,
                excluded_aliases: None,
                readings: None,
                tags_cache: None,
                parent_id: None,
                context_mode: None,
                icon: None,
                children_budget: None,
                notes: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: None,
                authorship_span_lanes: None,
            },
            renderer_agent_context("legacy-codex-content-update", "legacy-codex-content:event"),
        )
        .expect_err("legacy Codex content must deny AI update before patch");
        assert!(content_error
            .to_string()
            .contains("NEX_FIELD_AUTHORITY_DENIED"));

        let summary_error = renderer_codex_update_impl(
            &db,
            AgentCodexUpdatePayload {
                project_id: project_id.clone(),
                session_id: "legacy-update-session".to_string(),
                surface: Some("in-app-agent".to_string()),
                entry_id: "legacy-update-entry".to_string(),
                base_version: version,
                type_slug: None,
                name: None,
                summary: Some(String::new()),
                content: None,
                aliases: None,
                excluded_aliases: None,
                readings: None,
                tags_cache: None,
                parent_id: None,
                context_mode: None,
                icon: None,
                children_budget: None,
                notes: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: None,
                authorship_span_lanes: None,
            },
            renderer_agent_context("legacy-codex-summary-clear", "legacy-codex-summary:event"),
        )
        .expect_err("legacy Codex summary must deny AI clear before patch");
        assert!(summary_error
            .to_string()
            .contains("NEX_FIELD_AUTHORITY_DENIED"));

        db.with_conn(|conn| {
            let state: (String, String, i64) = conn.query_row(
                "SELECT content, summary, version FROM codex_entries
                  WHERE id = 'legacy-update-entry'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(state.0, r#"{"name":"Legacy name"}"#);
            assert_eq!(state.1, "Legacy name summary");
            assert_eq!(state.2, version);
            Ok(())
        })
        .expect("inspect unchanged Codex after denied updates");
    }

    #[test]
    fn renderer_codex_update_records_field_authority_once_after_preflight() {
        let db = test_db();
        let project_id = insert_project(&db);
        tracked_codex_create(&db, &project_id, "authority-once-entry", "Before", 0);
        let version = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT version FROM codex_entries WHERE id = 'authority-once-entry'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .expect("read Codex version");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO narrative_field_authority
                    (project_id, entity_kind, entity_id, field_path, owner_kind,
                     explicit_lock, version, updated_at)
                 VALUES (?1, 'codex-entry', 'authority-once-entry', '/name', 'ai', 0, 0, 'fixture')",
                rusqlite::params![project_id],
            )?;
            Ok(())
        })
        .expect("seed AI ownership for the update");
        db.with_conn(|conn| {
            let owner: String = conn.query_row(
                "SELECT owner_kind FROM narrative_field_authority
                   WHERE project_id = ?1 AND entity_kind = 'codex-entry'
                     AND entity_id = 'authority-once-entry' AND field_path = '/name'",
                rusqlite::params![project_id],
                |row| row.get(0),
            )?;
            assert_eq!(owner, "ai");
            Ok(())
        })
        .expect("inspect seeded AI ownership");

        renderer_codex_update_impl(
            &db,
            AgentCodexUpdatePayload {
                project_id: project_id.clone(),
                session_id: "authority-once-session".to_string(),
                surface: Some("in-app-agent".to_string()),
                entry_id: "authority-once-entry".to_string(),
                base_version: version,
                type_slug: None,
                name: Some("After".to_string()),
                summary: None,
                content: None,
                aliases: None,
                excluded_aliases: None,
                readings: None,
                tags_cache: None,
                parent_id: None,
                context_mode: None,
                icon: None,
                children_budget: None,
                notes: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: None,
                authorship_span_lanes: None,
            },
            renderer_agent_context("authority-once-request", "authority-once:event"),
        )
        .expect("Codex update should succeed");

        db.with_conn(|conn| {
            let field_version: i64 = conn.query_row(
                "SELECT version FROM narrative_field_authority
                   WHERE project_id = ?1 AND entity_kind = 'codex-entry'
                     AND entity_id = 'authority-once-entry' AND field_path = '/name'",
                rusqlite::params![project_id],
                |row| row.get(0),
            )?;
            assert_eq!(field_version, 1, "preflight must not increment the version");
            Ok(())
        })
        .expect("inspect single field-authority revision");
    }

    #[test]
    fn mcp_codex_update_preflights_human_field_without_renderer_context() {
        let db = test_db();
        let project_id = insert_project(&db);
        tracked_codex_create(&db, &project_id, "mcp-authority-entry", "Human name", 0);
        let version = db
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_field_authority
                        SET owner_kind = 'human'
                      WHERE project_id = ?1 AND entity_kind = 'codex-entry'
                        AND entity_id = 'mcp-authority-entry' AND field_path = '/name'",
                    rusqlite::params![project_id],
                )?;
                Ok(conn.query_row(
                    "SELECT version FROM codex_entries WHERE id = 'mcp-authority-entry'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .expect("seed MCP authority fixture");

        let error = agent_codex_update_with_request_impl(
            &db,
            AgentCodexUpdatePayload {
                project_id: project_id.clone(),
                session_id: "mcp-authority-session".to_string(),
                surface: Some("mcp".to_string()),
                entry_id: "mcp-authority-entry".to_string(),
                base_version: version,
                type_slug: None,
                name: Some("MCP overwrite".to_string()),
                summary: None,
                content: None,
                aliases: None,
                excluded_aliases: None,
                readings: None,
                tags_cache: None,
                parent_id: None,
                context_mode: None,
                icon: None,
                children_budget: None,
                notes: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: None,
                authorship_span_lanes: None,
            },
            Some("mcp-authority-request"),
            None,
        )
        .expect_err("MCP must not overwrite a human-owned field");
        assert!(error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));

        db.with_conn(|conn| {
            let state: (String, i64) = conn.query_row(
                "SELECT name, version FROM codex_entries WHERE id = 'mcp-authority-entry'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(state, ("Human name".to_string(), version));
            Ok(())
        })
        .expect("inspect unchanged MCP Codex after denied update");
    }

    #[test]
    fn mcp_codex_tag_update_preflights_tags_cache_authority() {
        let db = test_db();
        let project_id = insert_project(&db);
        tracked_codex_create(&db, &project_id, "mcp-tags-entry", "Tagged", 0);
        let version = db
            .with_conn(|conn| {
                conn.execute(
                    "UPDATE narrative_field_authority
                        SET owner_kind = 'human'
                      WHERE project_id = ?1 AND entity_kind = 'codex-entry'
                        AND entity_id = 'mcp-tags-entry' AND field_path = '/tagsCache'",
                    rusqlite::params![project_id],
                )?;
                Ok(conn.query_row(
                    "SELECT version FROM codex_entries WHERE id = 'mcp-tags-entry'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?)
            })
            .expect("seed human tag authority");
        let tags = vec!["new-tag".to_string()];

        let error = agent_codex_update_with_request_impl(
            &db,
            AgentCodexUpdatePayload {
                project_id: project_id.clone(),
                session_id: "mcp-tags-session".to_string(),
                surface: Some("mcp".to_string()),
                entry_id: "mcp-tags-entry".to_string(),
                base_version: version,
                type_slug: None,
                name: None,
                summary: None,
                content: None,
                aliases: None,
                excluded_aliases: None,
                readings: None,
                tags_cache: None,
                parent_id: None,
                context_mode: None,
                icon: None,
                children_budget: None,
                notes: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: None,
                authorship_span_lanes: None,
            },
            Some("mcp-tags-request"),
            Some(&tags),
        )
        .expect_err("MCP tag updates must honor tagsCache field authority");
        assert!(error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));
    }

    #[test]
    fn mcp_codex_empty_update_is_rejected_without_promoting_legacy_fields() {
        let db = test_db();
        let project_id = insert_project(&db);
        let entry_id = insert_codex(&db, &project_id, "Legacy MCP entry");
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'codex-entry'
                    AND entity_id = ?2",
                rusqlite::params![project_id, entry_id],
            )?;
            Ok(())
        })
        .expect("remove authority rows from legacy fixture");

        let error = agent_codex_update_with_request_impl(
            &db,
            AgentCodexUpdatePayload {
                project_id,
                session_id: "mcp-empty-session".to_string(),
                surface: Some("mcp".to_string()),
                entry_id,
                base_version: 1,
                type_slug: None,
                name: None,
                summary: None,
                content: None,
                aliases: None,
                excluded_aliases: None,
                readings: None,
                tags_cache: None,
                parent_id: None,
                context_mode: None,
                icon: None,
                children_budget: None,
                notes: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: None,
                authorship_span_lanes: None,
            },
            Some("mcp-empty-request"),
            None,
        )
        .expect_err("MCP empty patches must not create an ownership claim");
        assert!(error.to_string().contains("must change at least one field"));
        assert_eq!(table_count(&db, "narrative_field_authority"), 0);
    }

    #[test]
    fn mcp_legacy_field_without_authority_remains_fail_closed() {
        let db = test_db();
        let project_id = insert_project(&db);
        tracked_codex_create(&db, &project_id, "legacy-mcp-entry", "Before", 0);
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE undo_journal SET surface = 'mcp'
                  WHERE project_id = ?1 AND entity_kind = 'codex_entry'
                    AND entity_id = 'legacy-mcp-entry'",
                rusqlite::params![project_id],
            )?;
            conn.execute(
                "DELETE FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'codex-entry'
                    AND entity_id = 'legacy-mcp-entry'",
                rusqlite::params![project_id],
            )?;
            Ok(())
        })
        .expect("seed legacy MCP provenance");

        let error = agent_codex_update_with_request_impl(
            &db,
            AgentCodexUpdatePayload {
                project_id: project_id.clone(),
                session_id: "legacy-mcp-session".to_string(),
                surface: Some("mcp".to_string()),
                entry_id: "legacy-mcp-entry".to_string(),
                base_version: 1,
                type_slug: None,
                name: Some("After".to_string()),
                summary: None,
                content: None,
                aliases: None,
                excluded_aliases: None,
                readings: None,
                tags_cache: None,
                parent_id: None,
                context_mode: None,
                icon: None,
                children_budget: None,
                notes: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: None,
                authorship_span_lanes: None,
            },
            Some("legacy-mcp-update"),
            None,
        )
        .expect_err("historical MCP provenance must not promote a legacy field");
        assert!(error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));

        db.with_conn(|conn| {
            let authority_rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'codex-entry'
                    AND entity_id = 'legacy-mcp-entry'",
                rusqlite::params![project_id],
                |row| row.get(0),
            )?;
            assert_eq!(authority_rows, 0);
            let name: String = conn.query_row(
                "SELECT name FROM codex_entries WHERE id = 'legacy-mcp-entry'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(name, "Before");
            Ok(())
        })
        .expect("inspect unchanged legacy MCP field");
    }

    #[test]
    fn renderer_codex_update_allows_first_ai_value_for_empty_legacy_summary() {
        let db = test_db();
        let project_id = insert_project(&db);
        insert_codex(&db, &project_id, "Legacy");
        db.with_conn(|conn| {
            conn.execute(
                "UPDATE codex_entries SET summary = NULL
                  WHERE project_id = ?1 AND name = 'Legacy'",
                rusqlite::params![project_id],
            )?;
            Ok(())
        })
        .expect("seed empty legacy summary");
        let entry_id: String = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT id FROM codex_entries
                      WHERE project_id = ?1 AND name = 'Legacy'",
                    rusqlite::params![project_id],
                    |row| row.get(0),
                )?)
            })
            .expect("read legacy Codex id");
        let version: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    "SELECT version FROM codex_entries WHERE id = ?1",
                    rusqlite::params![entry_id],
                    |row| row.get(0),
                )?)
            })
            .expect("read legacy Codex version");

        renderer_codex_update_impl(
            &db,
            AgentCodexUpdatePayload {
                project_id: project_id.clone(),
                session_id: "legacy-empty-summary-session".to_string(),
                surface: Some("in-app-agent".to_string()),
                entry_id: entry_id.clone(),
                base_version: version,
                type_slug: None,
                name: None,
                summary: Some("AI summary".to_string()),
                content: None,
                aliases: None,
                excluded_aliases: None,
                readings: None,
                tags_cache: None,
                parent_id: None,
                context_mode: None,
                icon: None,
                children_budget: None,
                notes: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: None,
                authorship_span_lanes: None,
            },
            renderer_agent_context("legacy-empty-summary-request", "legacy-empty-summary:event"),
        )
        .expect("first AI value must fill an empty legacy summary");

        db.with_conn(|conn| {
            let state: (Option<String>, String) = conn.query_row(
                "SELECT summary, owner_kind FROM codex_entries
                  JOIN narrative_field_authority
                    ON narrative_field_authority.project_id = codex_entries.project_id
                   AND narrative_field_authority.entity_kind = 'codex-entry'
                   AND narrative_field_authority.entity_id = codex_entries.id
                   AND narrative_field_authority.field_path = '/summary'
                 WHERE codex_entries.project_id = ?1
                   AND codex_entries.id = ?2",
                rusqlite::params![project_id, entry_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(state, (Some("AI summary".to_string()), "ai".to_string()));
            Ok(())
        })
        .expect("inspect filled legacy summary");
    }

    #[test]
    fn renderer_event_first_participant_scene_link_and_relation_are_allowed() {
        let db = test_db();
        let project_id = insert_project(&db);
        let participant = insert_codex(&db, &project_id, "AI participant");
        let scene = insert_scene(&db, &project_id);
        let (participant_event, _) =
            create_event(&db, &project_id, "Empty participant event", vec![], vec![]);
        let (stamp_event, _) = create_event(&db, &project_id, "Empty stamp event", vec![], vec![]);
        let (cause_event, _) = create_event(&db, &project_id, "Empty cause event", vec![], vec![]);
        let (effect_event, _) =
            create_event(&db, &project_id, "Empty effect event", vec![], vec![]);
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'event'",
                rusqlite::params![project_id],
            )?;
            Ok(())
        })
        .expect("seed legacy events without authority rows");

        let participant_request = "legacy-empty-participant";
        agent_event_set_participants_with_authority_impl(
            &db,
            AgentEventParticipantsPayload {
                project_id: project_id.clone(),
                session_id: "legacy-empty-participant-session".to_string(),
                surface: Some("in-app-agent".to_string()),
                event_id: participant_event.clone(),
                base_version: event_version(&db, &participant_event),
                codex_entry_ids: vec![participant.clone()],
                participant_roles: None,
            },
            renderer_agent_context(participant_request, "legacy-empty-participant:event"),
        )
        .expect("first AI participant must be allowed");
        assert!(participant_has(&db, &participant_event, &participant));

        let stamp_request = "legacy-empty-scene-link";
        let mut stamp = scene_payload(&project_id, &scene, &stamp_event);
        stamp.request_id = stamp_request.to_string();
        agent_scene_event_mutate_with_authority_impl(
            &db,
            stamp,
            true,
            Some(renderer_agent_context(
                stamp_request,
                "legacy-empty-scene-link:event",
            )),
        )
        .expect("first AI scene link must be allowed");
        assert!(scene_link_has(&db, &stamp_event, &scene));

        let relation_request = "legacy-empty-relation";
        let mut relation = relation_payload(&project_id, &cause_event, &effect_event);
        relation.request_id = relation_request.to_string();
        agent_event_relation_mutate_with_authority_impl(
            &db,
            relation,
            true,
            Some(renderer_agent_context(
                relation_request,
                "legacy-empty-relation:event",
            )),
        )
        .expect("first AI relation must be allowed");
        assert_eq!(relation_count(&db, &cause_event, &effect_event), 1);
    }

    #[test]
    fn renderer_foreshadow_update_allows_first_ai_value_for_empty_legacy_intent() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow_row(&db, &project_id);
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'foreshadow' AND entity_id = ?2",
                rusqlite::params![project_id, foreshadow_id],
            )?;
            Ok(())
        })
        .expect("seed empty legacy Foreshadow");

        let request_id = "legacy-empty-foreshadow-intent";
        renderer_agent_foreshadow_update_impl(
            &db,
            AgentForeshadowUpdatePayload {
                request_id: request_id.to_string(),
                project_id: project_id.clone(),
                session_id: "legacy-empty-foreshadow-session".to_string(),
                foreshadow_id: foreshadow_id.clone(),
                base_version: 0,
                title: None,
                intent: Some("AI intent".to_string()),
                notes: None,
                load_bearing: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
            },
            renderer_agent_context(request_id, "legacy-empty-foreshadow-intent:event"),
        )
        .expect("first AI value must fill an empty legacy Foreshadow intent");

        db.with_conn(|conn| {
            let state: (String, String) = conn.query_row(
                "SELECT intent, owner_kind FROM foreshadows
                   JOIN narrative_field_authority
                     ON narrative_field_authority.project_id = foreshadows.project_id
                    AND narrative_field_authority.entity_kind = 'foreshadow'
                    AND narrative_field_authority.entity_id = foreshadows.id
                    AND narrative_field_authority.field_path = '/intent'
                 WHERE foreshadows.project_id = ?1 AND foreshadows.id = ?2",
                rusqlite::params![project_id, foreshadow_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(state, ("AI intent".to_string(), "ai".to_string()));
            Ok(())
        })
        .expect("inspect filled legacy Foreshadow intent");
    }

    #[test]
    fn legacy_tree_node_presence_protects_title_move_and_empty_synopsis() {
        let db = test_db();
        let project_id = insert_project(&db);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO tree_nodes
                    (id, project_id, node_type, title, synopsis, sort_order)
                 VALUES ('legacy-tree-scene', ?1, 'scene', 'Legacy title', NULL, 'a0')",
                rusqlite::params![project_id],
            )?;
            Ok(())
        })
        .expect("seed legacy tree node");

        db.with_conn(|conn| {
            for path in ["/title", "/parentId", "/sortOrder", "/synopsis"] {
                let paths = vec![path.to_string()];
                let error = validate_agent_field_authority_for_entity(
                    conn,
                    &project_id,
                    "tree_node",
                    "legacy-tree-scene",
                    &paths,
                    "2026-08-15T00:00:00Z",
                )
                .expect_err("legacy tree node fields must fail closed");
                assert!(error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));
            }
            Ok(())
        })
        .expect("inspect legacy tree field authority");
    }

    #[test]
    fn renderer_event_participant_replace_preflights_legacy_association() {
        let db = test_db();
        let project_id = insert_project(&db);
        let participant_a = insert_codex(&db, &project_id, "Legacy participant");
        let participant_b = insert_codex(&db, &project_id, "Unauthorized participant");
        let (event_id, _) = create_event(
            &db,
            &project_id,
            "Legacy participant event",
            vec![participant_a.clone()],
            vec![],
        );
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'event' AND entity_id = ?2",
                rusqlite::params![project_id, event_id],
            )?;
            Ok(())
        })
        .expect("remove generated participant authority row");
        let version = event_version(&db, &event_id);
        let request_id = "legacy-event-participant-replace";
        let error = agent_event_set_participants_with_authority_impl(
            &db,
            AgentEventParticipantsPayload {
                project_id: project_id.clone(),
                session_id: "legacy-event-participant-session".to_string(),
                surface: Some("in-app-agent".to_string()),
                event_id: event_id.clone(),
                base_version: version,
                codex_entry_ids: vec![participant_b.clone()],
                participant_roles: None,
            },
            renderer_agent_context(request_id, "legacy-event-participant:event"),
        )
        .expect_err("legacy participants must deny AI replacement before delete");
        assert!(error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));
        assert!(participant_has(&db, &event_id, &participant_a));
        assert!(!participant_has(&db, &event_id, &participant_b));
        assert_eq!(event_version(&db, &event_id), version);
    }

    #[test]
    fn renderer_scene_stamp_and_unstamp_preflight_legacy_association() {
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_a = insert_scene(&db, &project_id);
        let scene_b = insert_scene(&db, &project_id);
        let (event_id, _) = create_event(
            &db,
            &project_id,
            "Legacy stamped event",
            vec![],
            vec![scene_a.clone()],
        );
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'event' AND entity_id = ?2",
                rusqlite::params![project_id, event_id],
            )?;
            Ok(())
        })
        .expect("remove generated scene authority row");

        let unstamp_request = "legacy-event-unstamp";
        let mut unstamp = scene_payload(&project_id, &scene_a, &event_id);
        unstamp.request_id = unstamp_request.to_string();
        let unstamp_error = agent_scene_event_mutate_with_authority_impl(
            &db,
            unstamp,
            false,
            Some(renderer_agent_context(
                unstamp_request,
                "legacy-event-unstamp:event",
            )),
        )
        .expect_err("legacy scene stamp must deny AI unstamp before delete");
        assert!(unstamp_error
            .to_string()
            .contains("NEX_FIELD_AUTHORITY_DENIED"));
        assert!(scene_link_has(&db, &event_id, &scene_a));

        let stamp_request = "legacy-event-stamp";
        let mut stamp = scene_payload(&project_id, &scene_b, &event_id);
        stamp.request_id = stamp_request.to_string();
        let stamp_error = agent_scene_event_mutate_with_authority_impl(
            &db,
            stamp,
            true,
            Some(renderer_agent_context(
                stamp_request,
                "legacy-event-stamp:event",
            )),
        )
        .expect_err("legacy scene association must deny AI stamp before insert");
        assert!(stamp_error
            .to_string()
            .contains("NEX_FIELD_AUTHORITY_DENIED"));
        assert!(!scene_link_has(&db, &event_id, &scene_b));
    }

    #[test]
    fn renderer_event_relation_add_and_remove_preflight_legacy_associations() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (cause_id, _) = create_event(&db, &project_id, "Cause", vec![], vec![]);
        let (effect_id, _) = create_event(&db, &project_id, "Effect", vec![], vec![]);
        let (new_effect_id, _) = create_event(&db, &project_id, "New effect", vec![], vec![]);
        let initial_relation = relation_payload(&project_id, &cause_id, &effect_id);
        agent_event_relation_mutate_impl(&db, initial_relation, true).expect("seed relation");
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'event'
                    AND entity_id IN (?2, ?3, ?4)",
                rusqlite::params![project_id, cause_id, effect_id, new_effect_id],
            )?;
            Ok(())
        })
        .expect("remove generated relation authority rows");

        let remove_request = "legacy-relation-remove";
        let mut remove = relation_payload(&project_id, &cause_id, &effect_id);
        remove.request_id = remove_request.to_string();
        let remove_error = agent_event_relation_mutate_with_authority_impl(
            &db,
            remove,
            false,
            Some(renderer_agent_context(
                remove_request,
                "legacy-relation-remove:event",
            )),
        )
        .expect_err("legacy relation must deny AI remove before delete");
        assert!(remove_error
            .to_string()
            .contains("NEX_FIELD_AUTHORITY_DENIED"));
        assert_eq!(relation_count(&db, &cause_id, &effect_id), 1);

        let add_request = "legacy-relation-add";
        let mut add = relation_payload(&project_id, &cause_id, &new_effect_id);
        add.request_id = add_request.to_string();
        let add_error = agent_event_relation_mutate_with_authority_impl(
            &db,
            add,
            true,
            Some(renderer_agent_context(
                add_request,
                "legacy-relation-add:event",
            )),
        )
        .expect_err("legacy relation must deny AI add before insert");
        assert!(add_error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));
        assert_eq!(relation_count(&db, &cause_id, &new_effect_id), 0);
    }

    #[test]
    fn mcp_relation_records_field_authority_for_both_endpoints() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (cause_id, _) = create_event(&db, &project_id, "MCP cause", vec![], vec![]);
        let (effect_id, _) = create_event(&db, &project_id, "MCP effect", vec![], vec![]);
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'event'
                    AND entity_id IN (?2, ?3)",
                rusqlite::params![project_id, cause_id, effect_id],
            )?;
            Ok(())
        })
        .expect("seed MCP events without authority rows");

        let mut add = relation_payload(&project_id, &cause_id, &effect_id);
        add.surface = Some("mcp".to_string());
        agent_event_relation_mutate_with_authority_impl(&db, add, true, None)
            .expect("MCP relation add must establish both endpoint authorities");
        assert_eq!(relation_count(&db, &cause_id, &effect_id), 1);

        db.with_conn(|conn| {
            for event_id in [&cause_id, &effect_id] {
                let owner: String = conn.query_row(
                    "SELECT owner_kind FROM narrative_field_authority
                      WHERE project_id = ?1 AND entity_kind = 'event'
                        AND entity_id = ?2 AND field_path = '/relations'",
                    rusqlite::params![project_id, event_id],
                    |row| row.get(0),
                )?;
                assert_eq!(owner, "ai");
            }
            Ok(())
        })
        .expect("inspect MCP relation authorities");

        let mut remove = relation_payload(&project_id, &cause_id, &effect_id);
        remove.surface = Some("mcp".to_string());
        agent_event_relation_mutate_with_authority_impl(&db, remove, false, None)
            .expect("MCP relation remove must validate both endpoint authorities");
        assert_eq!(relation_count(&db, &cause_id, &effect_id), 0);
    }

    #[test]
    fn renderer_foreshadow_update_preflights_legacy_intent_and_notes_before_patch() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow_row(&db, &project_id);
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'foreshadow' AND entity_id = ?2",
                rusqlite::params![project_id, foreshadow_id],
            )?;
            conn.execute(
                "UPDATE foreshadows SET intent = 'Human intent', notes = 'Human notes'
                  WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![foreshadow_id, project_id],
            )?;
            Ok(())
        })
        .expect("seed legacy Foreshadow fields");

        let request_id = "legacy-foreshadow-update";
        let error = renderer_agent_foreshadow_update_impl(
            &db,
            AgentForeshadowUpdatePayload {
                request_id: request_id.to_string(),
                project_id: project_id.clone(),
                session_id: "legacy-foreshadow-session".to_string(),
                foreshadow_id: foreshadow_id.clone(),
                base_version: 0,
                title: None,
                intent: Some(String::new()),
                notes: Some(String::new()),
                load_bearing: None,
                payoff_confirmed: None,
                abandoned: None,
                secret: None,
            },
            renderer_agent_context(request_id, "legacy-foreshadow-update:event"),
        )
        .expect_err("legacy Foreshadow fields must deny AI clear before patch");
        assert!(error.to_string().contains("NEX_FIELD_AUTHORITY_DENIED"));

        db.with_conn(|conn| {
            let state: (String, String, i64) = conn.query_row(
                "SELECT intent, notes, version FROM foreshadows WHERE id = ?1",
                rusqlite::params![foreshadow_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(
                state,
                ("Human intent".to_string(), "Human notes".to_string(), 0)
            );
            Ok(())
        })
        .expect("inspect unchanged Foreshadow after denied update");
    }

    #[test]
    fn native_field_authority_derives_update_and_association_paths() {
        let update = AppendChangeEvent {
            event_uid: "event-update".to_string(),
            scene_id: None,
            domain: "codex".to_string(),
            op_type: "entry.update".to_string(),
            entity_type: Some("codex_entry".to_string()),
            entity_id: Some("entry-1".to_string()),
            payload: json!({ "fields": ["name", "content"] }).to_string(),
            timestamp: 1,
        };
        assert_eq!(
            authority_paths_for_canonical_event(&update),
            vec!["/content".to_string(), "/name".to_string()]
        );

        let participants = AppendChangeEvent {
            event_uid: "event-participants".to_string(),
            scene_id: None,
            domain: "event".to_string(),
            op_type: "event.participants".to_string(),
            entity_type: Some("event".to_string()),
            entity_id: Some("event-1".to_string()),
            payload: json!({ "eventId": "event-1", "codexEntryIds": ["entry-1"] }).to_string(),
            timestamp: 1,
        };
        assert_eq!(
            authority_paths_for_canonical_event(&participants),
            vec!["/participants".to_string()]
        );

        let relation = AppendChangeEvent {
            event_uid: "event-relation".to_string(),
            scene_id: None,
            domain: "event".to_string(),
            op_type: "event.relation_add".to_string(),
            entity_type: Some("event".to_string()),
            entity_id: Some("event-1".to_string()),
            payload: json!({
                "causeEventId": "event-1",
                "effectEventId": "event-2"
            })
            .to_string(),
            timestamp: 1,
        };
        assert_eq!(
            authority_paths_for_canonical_event(&relation),
            vec!["/relations".to_string()]
        );
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
    fn agent_bundle_is_fail_closed_and_cannot_mutate_domain_or_feed_tables() {
        let db = test_db();
        let project_id = insert_project(&db);
        let feed_table = "narrative_change_cursors";
        let seed_sql = format!(
            "INSERT INTO \"{feed_table}\"
             (project_id, consumer_id, acknowledged_through_sequence, updated_at)
             VALUES (?1, 'native-consumer', 0, datetime('now'))"
        );
        db.execute(&seed_sql, &[Value::String(project_id.clone())], "run")
            .expect("trusted Native setup");

        let attempts = [
            (
                format!(
                    "WITH incoming(project_id, consumer_id, seq) AS (VALUES (?1, ?2, 0))
                     INSERT INTO \"{feed_table}\"
                     (project_id, consumer_id, acknowledged_through_sequence, updated_at)
                     SELECT project_id, consumer_id, seq, datetime('now') FROM incoming"
                ),
                vec![
                    Value::String(project_id.clone()),
                    Value::String("bundle-consumer".to_string()),
                ],
            ),
            (
                format!(
                    "WITH next(seq) AS (VALUES (999))
                     UPDATE \"{feed_table}\"
                     SET acknowledged_through_sequence = (SELECT seq FROM next)
                     WHERE project_id = ?1 AND consumer_id = 'native-consumer'"
                ),
                vec![Value::String(project_id.clone())],
            ),
            (
                format!(
                    "/* comments and quoted identifiers do not bypass SQLite authority */
                     DELETE FROM \"{feed_table}\"
                     WHERE project_id = ?1 AND consumer_id = 'native-consumer'"
                ),
                vec![Value::String(project_id.clone())],
            ),
            (
                format!("ALTER TABLE \"{feed_table}\" RENAME TO escaped_feed"),
                vec![],
            ),
            (format!("DROP TABLE \"{feed_table}\""), vec![]),
            ("COMMIT".to_string(), vec![]),
        ];

        for (index, (feed_sql, feed_params)) in attempts.into_iter().enumerate() {
            let entity_id = format!("bundle-snippet-{index}");
            let error = agent_write_bundle_impl(
                &db,
                AgentWriteBundlePayload {
                    project_id: project_id.clone(),
                    session_id: "bundle-session".to_string(),
                    surface: "test".to_string(),
                    statements: vec![
                        BatchStatement {
                            sql: "INSERT INTO snippets (id, project_id, title, content)
                                  VALUES (?1, ?2, 'Should roll back', '{}')"
                                .to_string(),
                            params: vec![
                                Value::String(entity_id.clone()),
                                Value::String(project_id.clone()),
                            ],
                            method: "run".to_string(),
                        },
                        BatchStatement {
                            sql: feed_sql,
                            params: feed_params,
                            method: "run".to_string(),
                        },
                    ],
                    undo_journal: UndoJournalPayload {
                        entity_kind: "snippet".to_string(),
                        entity_id,
                        op_kind: "create".to_string(),
                        before_json: None,
                        after_json: Some(r#"{"title":"Should roll back"}"#.to_string()),
                        base_version: 0,
                        result_version: 1,
                    },
                    change_event: ChangeEventPayload {
                        event_uid: format!("bundle-event-{index}"),
                        scene_id: None,
                        domain: "snippet".to_string(),
                        op_type: "create".to_string(),
                        entity_type: Some("snippet".to_string()),
                        entity_id: Some(format!("bundle-snippet-{index}")),
                        payload: "{}".to_string(),
                        timestamp: 1,
                    },
                },
            )
            .expect_err("generic SQL bundles must require a typed Native writer");
            assert!(
                error
                    .to_string()
                    .contains("AGENT_WRITE_BUNDLE_TYPED_WRITER_REQUIRED"),
                "unexpected denial: {error}"
            );
            assert_eq!(table_count(&db, "snippets"), 0);
            assert_eq!(table_count(&db, "undo_journal"), 0);
            assert_eq!(table_count(&db, "change_events"), 0);
            assert_eq!(table_count(&db, feed_table), 1);
            let (canonical_table, escaped_table): (i64, i64) = db
                .with_conn(|conn| {
                    Ok((
                        conn.query_row(
                            "SELECT COUNT(*) FROM sqlite_master
                              WHERE type = 'table' AND name = ?1",
                            [feed_table],
                            |row| row.get(0),
                        )?,
                        conn.query_row(
                            "SELECT COUNT(*) FROM sqlite_master
                              WHERE type = 'table' AND name = 'escaped_feed'",
                            [],
                            |row| row.get(0),
                        )?,
                    ))
                })
                .expect("inspect protected table identity");
            assert_eq!(canonical_table, 1, "protected table must retain its name");
            assert_eq!(escaped_table, 0, "rename attempt must roll back");

            // Fail-closed rejection must not leave any SQLite authorizer or
            // transaction state behind on the shared connection.
            let trusted_update = format!(
                "UPDATE \"{feed_table}\"
                 SET acknowledged_through_sequence = ?1
                 WHERE project_id = ?2 AND consumer_id = 'native-consumer'"
            );
            db.execute(
                &trusted_update,
                &[
                    Value::from((index + 1) as i64),
                    Value::String(project_id.clone()),
                ],
                "run",
            )
            .expect("scoped authorizer restored before Native mutation");
        }

        let acknowledged: i64 = db
            .with_conn(|conn| {
                Ok(conn.query_row(
                    &format!(
                        "SELECT acknowledged_through_sequence FROM \"{feed_table}\"
                         WHERE project_id = ?1 AND consumer_id = 'native-consumer'"
                    ),
                    rusqlite::params![project_id],
                    |row| row.get(0),
                )?)
            })
            .expect("read Native cursor");
        assert_eq!(acknowledged, 6);
    }

    #[test]
    fn codex_create_matches_parity_fixture_in_app() {
        let fixture: serde_json::Value = serde_json::from_str(CODEX_FIXTURE).unwrap();
        let db = test_db();
        let project_id = insert_project(&db);

        agent_codex_create_impl(
            &db,
            AgentCodexCreatePayload {
                request_id: Some("agent-tool:codex-parity".to_string()),
                entry_id: None,
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                type_slug: "character".to_string(),
                name: "Alice".to_string(),
                summary: Some("summary".to_string()),
                content: None,
                aliases: None,
                excluded_aliases: None,
                readings: None,
                tags_cache: None,
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
                    timestamp: None,
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
            let payload_keys = json_keys(&payload);
            let required_payload_keys = fixture_keys(&ce["payloadKeys"]);
            let audit_payload_keys = fixture_keys(&ce["auditPayloadKeys"]);
            for key in &required_payload_keys {
                assert!(
                    payload_keys.contains(key),
                    "in-app change_event payload is missing required parity key '{key}'"
                );
            }
            for key in &payload_keys {
                assert!(
                    required_payload_keys.contains(key) || audit_payload_keys.contains(key),
                    "in-app change_event payload key '{key}' is absent from the parity contract"
                );
            }
            assert!(
                payload["requestHash"]
                    .as_str()
                    .is_some_and(|hash| hash.len() == 64),
                "request-aware in-app create must record its idempotency audit hash"
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

            // Canonical create writers keep the caller's stable logical
            // request identity distinct from the generated audit event uid.
            let (feed_request_id, source_event_uid, origin): (String, String, String) = conn
                .query_row(
                    "SELECT request_id, source_change_event_uid, origin
                       FROM narrative_change_transactions",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )?;
            assert_eq!(feed_request_id, "agent-tool:codex-parity");
            assert_ne!(feed_request_id, source_event_uid);
            assert_eq!(origin, "ai-apply");
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn mcp_codex_create_records_ai_field_authority() {
        let db = test_db();
        let project_id = insert_project(&db);
        let result = agent_codex_create_with_tags_impl(
            &db,
            AgentCodexCreatePayload {
                request_id: Some("mcp-codex-create-authority".to_string()),
                entry_id: None,
                project_id: project_id.clone(),
                session_id: "mcp-session".to_string(),
                surface: Some("mcp".to_string()),
                type_slug: "character".to_string(),
                name: "MCP Character".to_string(),
                summary: Some("Created by MCP".to_string()),
                content: None,
                aliases: None,
                excluded_aliases: None,
                readings: None,
                tags_cache: None,
                parent_id: None,
                source_chat_message_id: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: Vec::new(),
            },
            None,
        )
        .expect("MCP Codex create must succeed");
        let entry_id = result["entityId"].as_str().expect("entity id");
        db.with_conn(|conn| {
            let authority_rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM narrative_field_authority
                  WHERE project_id = ?1 AND entity_kind = 'codex-entry'
                    AND entity_id = ?2 AND owner_kind = 'ai'",
                rusqlite::params![project_id, entry_id],
                |row| row.get(0),
            )?;
            assert_eq!(authority_rows, CODEX_ENTRY_AUTHORITY_FIELDS.len() as i64);
            Ok(())
        })
        .expect("inspect MCP Codex field authority");
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
            surface: None,
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
            excluded_aliases: None,
            readings: None,
            tags_cache: None,
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
        assert_eq!(table_count(&db, "narrative_change_transactions"), 1);
        assert_eq!(table_count(&db, "narrative_change_events"), 1);
        db.with_conn(|conn| {
            let (request_id, origin, undo_journal_id): (String, String, Option<String>) = conn
                .query_row(
                    "SELECT request_id, origin, undo_journal_id
                       FROM narrative_change_transactions",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )?;
            assert_eq!(request_id, "agent-tool:codex-request-1");
            assert_eq!(origin, "ai-apply");
            assert_eq!(
                undo_journal_id.as_deref(),
                Some("agent-tool:codex-request-1")
            );
            Ok(())
        })
        .unwrap();

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
    fn renderer_codex_create_retry_ignores_transport_session_and_event_identity() {
        let db = test_db();
        let project_id = insert_project(&db);
        let payload = AgentCodexCreatePayload {
            request_id: None,
            entry_id: Some("renderer-codex-entry".to_string()),
            project_id: project_id.clone(),
            session_id: "renderer-session".to_string(),
            surface: Some("manual".to_string()),
            type_slug: "character".to_string(),
            name: "Alice".to_string(),
            summary: None,
            content: None,
            aliases: None,
            excluded_aliases: None,
            readings: None,
            tags_cache: None,
            parent_id: None,
            source_chat_message_id: None,
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: vec![],
        };
        let mut context = renderer_agent_context(
            "renderer-create-request",
            "renderer-create-event",
        );
        context.context_mode = Some("always".to_string());
        context.icon = Some("star".to_string());
        context.children_budget = Some("standard".to_string());
        context.notes = Some("private".to_string());
        let first = renderer_codex_create_impl(&db, payload.clone(), context.clone())
            .expect("first renderer create");

        let mut retry_payload = payload;
        retry_payload.session_id = "renderer-session-after-restart".to_string();
        let mut retry_context = context;
        retry_context.event_uid = "renderer-event-after-restart".to_string();
        let retry = renderer_codex_create_impl(&db, retry_payload, retry_context)
            .expect("renderer durable request replay");

        assert_eq!(retry, first);
        assert_eq!(table_count(&db, "codex_entries"), 1);
        assert_eq!(table_count(&db, "undo_journal"), 1);
        assert_eq!(table_count(&db, "change_events"), 1);
        assert_eq!(table_count(&db, "narrative_change_transactions"), 1);
        assert_eq!(table_count(&db, "narrative_change_events"), 1);
        db.with_conn(|conn| {
            let row: (String, Option<String>, String, Option<String>) = conn.query_row(
                "SELECT context_mode, icon, children_budget, notes
                   FROM codex_entries WHERE id = 'renderer-codex-entry' AND project_id = ?1",
                [&project_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            assert_eq!(
                row,
                (
                    "always".to_string(),
                    Some("star".to_string()),
                    "standard".to_string(),
                    Some("private".to_string()),
                )
            );
            Ok(())
        })
        .expect("inspect renderer create fields");
    }

    #[test]
    fn renderer_codex_delete_emits_deterministic_cascade_facts_in_one_transaction() {
        let db = test_db();
        let project_id = insert_project(&db);
        tracked_codex_create(&db, &project_id, "cascade-root", "Root", 4);
        grant_agent_codex_authority(&db, &project_id, "cascade-root");
        let mut child = tracked_codex_create_payload(&project_id, "cascade-child", "Child", 5);
        child.parent_id = Some("cascade-root".to_string());
        agent_codex_create_impl(&db, child).expect("create cascade child");
        db.with_conn(|conn| {
            conn.execute_batch(&format!(
                "INSERT INTO codex_relations
                   (id, project_id, from_codex_id, to_codex_id, semantic_key)
                 VALUES ('cascade-relation', '{project_id}', 'cascade-root', 'cascade-child', 'cascade');
                 INSERT INTO codex_entry_phases (id, entry_id, label)
                 VALUES ('cascade-phase', 'cascade-root', 'Before');
                 INSERT INTO codex_detail_definitions
                   (id, project_id, type_slug, name)
                 VALUES ('cascade-definition', '{project_id}', 'character', 'Fact');
                 INSERT INTO codex_detail_values
                   (id, entry_id, definition_id, value)
                 VALUES ('cascade-detail', 'cascade-root', 'cascade-definition', 'value');
                 INSERT INTO codex_tags (id, project_id, name)
                 VALUES ('cascade-tag', '{project_id}', 'Tag');
                 INSERT INTO codex_entry_tags (entry_id, tag_id)
                 VALUES ('cascade-root', 'cascade-tag');"
            ))?;
            Ok(())
        })
        .expect("seed Codex cascade");

        let result = renderer_codex_delete_impl(
            &db,
            AgentCodexDeletePayload {
                project_id: project_id.clone(),
                session_id: "cascade-session".to_string(),
                surface: Some("manual".to_string()),
                entry_id: "cascade-root".to_string(),
                base_version: 1,
            },
            {
                let mut context = renderer_agent_context(
                    "cascade-delete-request",
                    "cascade-delete-event",
                );
                context.canonical_payload = Some(json!({ "name": "Root", "type": "character" }));
                context
            },
        )
        .expect("delete Codex cascade");

        let transaction_id = result["maintenanceTransactionId"]
            .as_str()
            .expect("maintenance transaction id");
        let delete_journal_id = result["undoJournalId"]
            .as_str()
            .expect("delete Undo Journal id")
            .to_string();
        db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT object_key_json, mutation_kind
                   FROM narrative_change_events
                  WHERE project_id = ?1 AND transaction_id = ?2
                  ORDER BY event_ordinal",
            )?;
            let rows = statement
                .query_map(rusqlite::params![project_id, transaction_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            let object_keys = rows
                .iter()
                .map(|(raw, _)| serde_json::from_str::<Value>(raw))
                .collect::<serde_json::Result<Vec<_>>>()?;
            assert_eq!(
                object_keys,
                vec![
                    json!({ "kind": "codex-entry", "entryId": "cascade-root" }),
                    json!({ "kind": "codex-relation", "relationId": "cascade-relation" }),
                    json!({ "kind": "codex-phase", "phaseId": "cascade-phase" }),
                    json!({ "kind": "codex-detail-value", "valueId": "cascade-detail" }),
                    json!({ "kind": "codex-entry", "entryId": "cascade-child" }),
                ]
            );
            assert_eq!(
                rows.iter()
                    .map(|(_, mutation)| mutation.as_str())
                    .collect::<Vec<_>>(),
                vec!["delete", "delete", "delete", "delete", "update"]
            );
            let canonical_payload: String = conn.query_row(
                "SELECT payload FROM change_events
                  WHERE project_id = ?1 AND event_uid = 'cascade-delete-event'",
                [&project_id],
                |row| row.get(0),
            )?;
            let canonical_payload: Value = serde_json::from_str(&canonical_payload)?;
            assert_eq!(
                canonical_payload["authorityRoute"],
                "interactive-agent-command"
            );
            assert_eq!(canonical_payload["authorityCaller"], "chat-tool-executor");
            assert_eq!(canonical_payload["authorityEvidence"]["validated"], true);
            assert_eq!(
                canonical_payload["cascade"]["relationIds"],
                json!(["cascade-relation"])
            );
            assert_eq!(
                canonical_payload["cascade"]["phaseIds"],
                json!(["cascade-phase"])
            );
            assert_eq!(
                canonical_payload["cascade"]["detailValueIds"],
                json!(["cascade-detail"])
            );
            assert_eq!(
                canonical_payload["cascade"]["tagIds"],
                json!(["cascade-tag"])
            );
            assert_eq!(
                canonical_payload["cascade"]["childEntryIds"],
                json!(["cascade-child"])
            );
            let child_parent: Option<String> = conn.query_row(
                "SELECT parent_id FROM codex_entries WHERE id = 'cascade-child'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(child_parent, None);
            Ok(())
        })
        .expect("inspect deterministic cascade facts");

        let mut restore_payload =
            tracked_codex_create_payload(&project_id, "cascade-root", "stale renderer copy", 1);
        restore_payload.request_id = None;
        restore_payload.session_id = "cascade-restore-session".to_string();
        restore_payload.surface = Some("manual".to_string());
        let restore_context = RendererCanonicalWriteContext {
            request_id: "cascade-restore-request".to_string(),
            event_uid: "cascade-restore-event".to_string(),
            authority_session_id: None,
            origin: NarrativeChangeOrigin::Undo,
            authority_route: "history-replay".to_string(),
            caller: "history-controller".to_string(),
            controls: renderer_authority_fields("history-replay", "history-controller").2,
            provenance: None,
            writes_authority_protected_field: false,
            original_transaction_id: Some(transaction_id.to_string()),
            undo_journal_id: Some(delete_journal_id.clone()),
            context_mode: None,
            icon: None,
            children_budget: None,
            notes: None,
            canonical_payload: None,
        };
        let restored =
            renderer_codex_create_impl(&db, restore_payload.clone(), restore_context.clone())
                .expect("restore complete Codex delete cascade");
        let restore_transaction_id = restored["maintenanceTransactionId"]
            .as_str()
            .expect("restore maintenance transaction id");
        db.with_conn(|conn| {
            let restored_counts: (i64, i64, i64, i64, i64) = conn.query_row(
                "SELECT
                   (SELECT COUNT(*) FROM codex_entries WHERE id = 'cascade-root'),
                   (SELECT COUNT(*) FROM codex_relations WHERE id = 'cascade-relation'),
                   (SELECT COUNT(*) FROM codex_entry_phases WHERE id = 'cascade-phase'),
                   (SELECT COUNT(*) FROM codex_detail_values WHERE id = 'cascade-detail'),
                   (SELECT COUNT(*) FROM codex_entry_tags
                     WHERE entry_id = 'cascade-root' AND tag_id = 'cascade-tag')",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
            assert_eq!(restored_counts, (1, 1, 1, 1, 1));
            let root: (String, i64) = conn.query_row(
                "SELECT name, version FROM codex_entries WHERE id = 'cascade-root'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(root, ("Root".to_string(), 2));
            let child: (Option<String>, i64) = conn.query_row(
                "SELECT parent_id, version FROM codex_entries WHERE id = 'cascade-child'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(child, (Some("cascade-root".to_string()), 2));
            let rows = conn
                .prepare(
                    "SELECT object_key_json, mutation_kind
                       FROM narrative_change_events
                      WHERE project_id = ?1 AND transaction_id = ?2
                      ORDER BY event_ordinal",
                )?
                .query_map(
                    rusqlite::params![project_id, restore_transaction_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(
                rows.iter().map(|row| row.1.as_str()).collect::<Vec<_>>(),
                vec!["restore", "restore", "restore", "restore", "update"]
            );
            Ok(())
        })
        .expect("inspect complete cascade restore");

        restore_payload.session_id = "cascade-restore-after-restart".to_string();
        let mut retry_context = restore_context.clone();
        retry_context.event_uid = "cascade-restore-event-after-restart".to_string();
        let retry = renderer_codex_create_impl(&db, restore_payload, retry_context)
            .expect("replay complete cascade restore");
        assert_eq!(retry, restored);

        renderer_codex_delete_impl(
            &db,
            AgentCodexDeletePayload {
                project_id: project_id.clone(),
                session_id: "cascade-redo-session".to_string(),
                surface: Some("manual".to_string()),
                entry_id: "cascade-root".to_string(),
                base_version: 2,
            },
            RendererCanonicalWriteContext {
                request_id: "cascade-redo-delete-request".to_string(),
                event_uid: "cascade-redo-delete-event".to_string(),
                authority_session_id: None,
                origin: NarrativeChangeOrigin::Redo,
                authority_route: "history-replay".to_string(),
                caller: "history-controller".to_string(),
                controls: renderer_authority_fields("history-replay", "history-controller").2,
                provenance: None,
                writes_authority_protected_field: false,
                original_transaction_id: Some(transaction_id.to_string()),
                undo_journal_id: Some(delete_journal_id.clone()),
                context_mode: None,
                icon: None,
                children_budget: None,
                notes: None,
                canonical_payload: None,
            },
        )
        .expect("redo cascade delete");
        let baseline_change_events = table_count(&db, "change_events");
        let baseline_transactions = table_count(&db, "narrative_change_transactions");
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_codex_cascade_restore_feed
                 BEFORE INSERT ON narrative_change_events
                 WHEN NEW.canonical_change_event_uid = 'cascade-restore-fail-event'
                 BEGIN
                   SELECT RAISE(ABORT, 'forced Codex cascade restore Feed failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("install cascade restore Feed failure trigger");
        let mut failed_restore_payload =
            tracked_codex_create_payload(&project_id, "cascade-root", "ignored", 1);
        failed_restore_payload.request_id = None;
        failed_restore_payload.session_id = "cascade-restore-fail-session".to_string();
        failed_restore_payload.surface = Some("manual".to_string());
        let error = renderer_codex_create_impl(
            &db,
            failed_restore_payload,
            RendererCanonicalWriteContext {
                request_id: "cascade-restore-fail-request".to_string(),
                event_uid: "cascade-restore-fail-event".to_string(),
                authority_session_id: None,
                origin: NarrativeChangeOrigin::Undo,
                authority_route: "history-replay".to_string(),
                caller: "history-controller".to_string(),
                controls: renderer_authority_fields("history-replay", "history-controller").2,
                provenance: None,
                writes_authority_protected_field: false,
                original_transaction_id: Some(transaction_id.to_string()),
                undo_journal_id: Some(delete_journal_id),
                context_mode: None,
                icon: None,
                children_budget: None,
                notes: None,
                canonical_payload: None,
            },
        )
        .expect_err("Feed failure must roll back the complete Codex restore");
        assert!(
            error
                .to_string()
                .contains("forced Codex cascade restore Feed failure"),
            "{error:#}"
        );
        db.with_conn(|conn| {
            let state: (i64, i64, i64, i64, i64, Option<String>) = conn.query_row(
                "SELECT
                   (SELECT COUNT(*) FROM codex_entries WHERE id = 'cascade-root'),
                   (SELECT COUNT(*) FROM codex_relations WHERE id = 'cascade-relation'),
                   (SELECT COUNT(*) FROM codex_entry_phases WHERE id = 'cascade-phase'),
                   (SELECT COUNT(*) FROM codex_detail_values WHERE id = 'cascade-detail'),
                   (SELECT COUNT(*) FROM codex_entry_tags
                     WHERE entry_id = 'cascade-root' AND tag_id = 'cascade-tag'),
                   (SELECT parent_id FROM codex_entries WHERE id = 'cascade-child')",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )?;
            assert_eq!(state, (0, 0, 0, 0, 0, None));
            let idempotency_rows: i64 = conn.query_row(
                "SELECT COUNT(*) FROM idempotency_requests
                  WHERE request_id = 'cascade-restore-fail-request'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(idempotency_rows, 0);
            Ok(())
        })
        .expect("inspect rolled back cascade restore");
        assert_eq!(table_count(&db, "change_events"), baseline_change_events);
        assert_eq!(
            table_count(&db, "narrative_change_transactions"),
            baseline_transactions
        );
    }

    fn link_foreshadow_fixture(
        db: &Database,
        project_id: &str,
        entry_id: &str,
        foreshadow_id: &str,
    ) {
        let now = chrono::Utc::now().timestamp_millis();
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO foreshadows
                   (id, project_id, title, payoff_confirmed, abandoned, secret,
                    version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 0, 0, 0, 0, ?4, ?4)",
                rusqlite::params![foreshadow_id, project_id, foreshadow_id, now],
            )?;
            conn.execute(
                "INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id)
                 VALUES (?1, ?2)",
                rusqlite::params![foreshadow_id, entry_id],
            )?;
            Ok(())
        })
        .expect("seed linked Foreshadow");
    }

    fn renderer_update_context(request_id: &str, event_uid: &str) -> RendererCanonicalWriteContext {
        let mut context = renderer_agent_context(request_id, event_uid);
        context.canonical_payload = Some(json!({
            "fields": ["name"],
            "before": { "name": "Before" },
            "after": { "name": "After" },
        }));
        context
    }

    #[test]
    fn renderer_codex_update_invalidates_linked_foreshadows_atomically_in_id_order() {
        let db = test_db();
        let project_id = insert_project(&db);
        tracked_codex_create(&db, &project_id, "linked-codex", "Before", 6);
        grant_agent_codex_authority(&db, &project_id, "linked-codex");
        link_foreshadow_fixture(&db, &project_id, "linked-codex", "foreshadow-z");
        link_foreshadow_fixture(&db, &project_id, "linked-codex", "foreshadow-a");
        let payload = AgentCodexUpdatePayload {
            project_id: project_id.clone(),
            session_id: "renderer-update-session".to_string(),
            surface: Some("manual".to_string()),
            entry_id: "linked-codex".to_string(),
            base_version: 1,
            type_slug: None,
            name: Some("After".to_string()),
            summary: None,
            content: None,
            aliases: None,
            excluded_aliases: None,
            readings: None,
            tags_cache: None,
            parent_id: None,
            context_mode: None,
            icon: None,
            children_budget: None,
            notes: None,
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: None,
            authorship_span_lanes: None,
        };
        let context = renderer_update_context("linked-update-request", "linked-update-event");
        let first = renderer_codex_update_impl(&db, payload.clone(), context.clone())
            .expect("update Codex and linked Foreshadows");
        let transaction_id = first["maintenanceTransactionId"]
            .as_str()
            .expect("maintenance transaction id");
        assert_eq!(
            first["relatedForeshadows"]
                .as_array()
                .expect("related Foreshadow rows")
                .iter()
                .map(|row| row["id"].as_str().expect("Foreshadow id"))
                .collect::<Vec<_>>(),
            vec!["foreshadow-a", "foreshadow-z"]
        );

        db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT object_key_json
                   FROM narrative_change_events
                  WHERE project_id = ?1 AND transaction_id = ?2
                  ORDER BY event_ordinal",
            )?;
            let keys = statement
                .query_map(rusqlite::params![project_id, transaction_id], |row| {
                    row.get::<_, String>(0)
                })?
                .map(|row| serde_json::from_str::<Value>(&row?).map_err(Into::into))
                .collect::<anyhow::Result<Vec<_>>>()?;
            assert_eq!(
                keys,
                vec![
                    json!({ "kind": "codex-entry", "entryId": "linked-codex" }),
                    json!({ "kind": "foreshadow", "foreshadowId": "foreshadow-a" }),
                    json!({ "kind": "foreshadow", "foreshadowId": "foreshadow-z" }),
                ]
            );
            let versions = conn
                .prepare(
                    "SELECT id, version, codex_link_dirty_at
                       FROM foreshadows
                      WHERE project_id = ?1 ORDER BY id",
                )?
                .query_map([&project_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(versions.len(), 2);
            assert!(versions
                .iter()
                .all(|(_, version, dirty)| *version == 1 && dirty.is_some()));
            Ok(())
        })
        .expect("inspect linked Foreshadow events");

        let mut retry_payload = payload;
        retry_payload.session_id = "renderer-update-after-restart".to_string();
        let mut retry_context = context;
        retry_context.event_uid = "linked-update-event-after-restart".to_string();
        let retry = renderer_codex_update_impl(&db, retry_payload, retry_context)
            .expect("durable linked invalidation replay");
        assert_eq!(retry, first);
        db.with_conn(|conn| {
            let max_version: i64 = conn.query_row(
                "SELECT MAX(version) FROM foreshadows WHERE project_id = ?1",
                [&project_id],
                |row| row.get(0),
            )?;
            assert_eq!(max_version, 1, "retry must not invalidate twice");
            Ok(())
        })
        .expect("inspect retry state");
    }

    #[test]
    fn linked_foreshadow_feed_failure_rolls_back_codex_and_dirty_markers() {
        let db = test_db();
        let project_id = insert_project(&db);
        tracked_codex_create(&db, &project_id, "rollback-codex", "Before", 6);
        grant_agent_codex_authority(&db, &project_id, "rollback-codex");
        link_foreshadow_fixture(&db, &project_id, "rollback-codex", "rollback-foreshadow");
        let baseline_journals = table_count(&db, "undo_journal");
        let baseline_change_events = table_count(&db, "change_events");
        let baseline_transactions = table_count(&db, "narrative_change_transactions");
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_linked_foreshadow_feed
                 BEFORE INSERT ON narrative_change_events
                 WHEN NEW.event_ordinal = 1
                 BEGIN
                   SELECT RAISE(ABORT, 'forced linked Foreshadow Feed failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("install Feed failure trigger");
        let payload = AgentCodexUpdatePayload {
            project_id: project_id.clone(),
            session_id: "rollback-session".to_string(),
            surface: Some("manual".to_string()),
            entry_id: "rollback-codex".to_string(),
            base_version: 1,
            type_slug: None,
            name: Some("After".to_string()),
            summary: None,
            content: None,
            aliases: None,
            excluded_aliases: None,
            readings: None,
            tags_cache: None,
            parent_id: None,
            context_mode: None,
            icon: None,
            children_budget: None,
            notes: None,
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: None,
            authorship_span_lanes: None,
        };
        let error = renderer_codex_update_impl(
            &db,
            payload,
            renderer_update_context("rollback-update-request", "rollback-update-event"),
        )
        .expect_err("linked Feed append must fail");
        assert!(
            error
                .to_string()
                .contains("forced linked Foreshadow Feed failure"),
            "{error:#}"
        );
        db.with_conn(|conn| {
            let codex: (String, i64) = conn.query_row(
                "SELECT name, version FROM codex_entries WHERE id = 'rollback-codex'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(codex, ("Before".to_string(), 1));
            let foreshadow: (i64, Option<i64>) = conn.query_row(
                "SELECT version, codex_link_dirty_at
                   FROM foreshadows WHERE id = 'rollback-foreshadow'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            assert_eq!(foreshadow, (0, None));
            Ok(())
        })
        .expect("inspect rolled back domain state");
        assert_eq!(table_count(&db, "undo_journal"), baseline_journals);
        assert_eq!(table_count(&db, "change_events"), baseline_change_events);
        assert_eq!(
            table_count(&db, "narrative_change_transactions"),
            baseline_transactions
        );
    }

    #[test]
    fn codex_create_feed_failure_rolls_back_domain_journal_and_canonical_event() {
        let db = test_db();
        let project_id = insert_project(&db);
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER force_agent_feed_failure
                 BEFORE INSERT ON narrative_change_transactions
                 BEGIN
                   SELECT RAISE(ABORT, 'forced agent Change Feed failure');
                 END;",
            )?;
            Ok(())
        })
        .unwrap();

        let error = agent_codex_create_impl(
            &db,
            tracked_codex_create_payload(&project_id, "codex-feed-rollback", "Must roll back", 8),
        )
        .expect_err("Feed append failure must abort the full tracked write");
        assert!(error
            .to_string()
            .contains("forced agent Change Feed failure"));
        assert_eq!(table_count(&db, "codex_entries"), 0);
        assert_eq!(table_count(&db, "authorship_spans"), 0);
        assert_eq!(table_count(&db, "undo_journal"), 0);
        assert_eq!(table_count(&db, "change_events"), 0);
        assert_eq!(table_count(&db, "narrative_change_transactions"), 0);
        assert_eq!(table_count(&db, "narrative_change_events"), 0);
    }

    fn tracked_codex_create_payload(
        project_id: &str,
        entry_id: &str,
        name: &str,
        span_to: i64,
    ) -> AgentCodexCreatePayload {
        AgentCodexCreatePayload {
            request_id: Some(format!("create:{entry_id}")),
            entry_id: Some(entry_id.to_string()),
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            surface: None,
            type_slug: "character".to_string(),
            name: name.to_string(),
            summary: Some(format!("{name} summary")),
            content: Some(format!(r#"{{"name":"{name}"}}"#)),
            aliases: Some(format!(r#"["{name}"]"#)),
            excluded_aliases: Some(format!(r#"["not-{name}"]"#)),
            readings: Some(format!(r#"["{name}-reading"]"#)),
            tags_cache: Some(format!(r#"[{{"name":"{name}-tag"}}]"#)),
            parent_id: None,
            source_chat_message_id: None,
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: vec![AuthorshipSpanInput {
                from_pos: 0,
                to_pos: span_to,
                source: "ai".to_string(),
                model: Some(grimodex_core::writes::LANE_CONTENT_MODEL.to_string()),
                timestamp: None,
                chat_msg_id: None,
                trace_id: None,
            }],
        }
    }

    #[test]
    fn codex_authorship_span_preserves_main_owned_timestamp() {
        let db = test_db();
        let project_id = insert_project(&db);
        let timestamp = "2026-08-15T06:00:00.000Z";
        let mut payload =
            tracked_codex_create_payload(&project_id, "codex-main-timestamp", "Main timestamp", 8);
        payload.authorship_spans[0].timestamp = Some(timestamp.to_string());

        agent_codex_create_impl(&db, payload).expect("create timestamped codex");
        db.with_conn(|conn| {
            let stored: String = conn.query_row(
                "SELECT timestamp FROM authorship_spans
                  WHERE codex_entry_id = 'codex-main-timestamp'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(stored, timestamp);
            Ok(())
        })
        .expect("read main-owned authorship timestamp");
    }

    fn tracked_codex_create(
        db: &Database,
        project_id: &str,
        entry_id: &str,
        name: &str,
        span_to: i64,
    ) -> Value {
        agent_codex_create_impl(
            db,
            tracked_codex_create_payload(project_id, entry_id, name, span_to),
        )
        .expect("tracked codex create")
    }

    fn grant_agent_codex_authority(db: &Database, project_id: &str, entry_id: &str) {
        let paths = all_authority_paths("codex_entry")
            .iter()
            .map(|path| (*path).to_string())
            .collect::<Vec<_>>();
        let updated_at = chrono::Utc::now().to_rfc3339();
        db.with_conn(|conn| {
            record_agent_field_authority_for_entity(
                conn,
                project_id,
                "codex-entry",
                entry_id,
                &paths,
                &updated_at,
            )
        })
        .expect("grant Agent Codex field authority");
    }

    #[test]
    fn codex_undo_and_redo_feed_transactions_keep_forward_lineage() {
        let db = test_db();
        let project_id = insert_project(&db);
        let created = tracked_codex_create(&db, &project_id, "codex-feed-lineage", "Lineage", 7);
        let journal_id = created["undoJournalId"]
            .as_str()
            .expect("create journal")
            .to_string();

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect("undo tracked create");
        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo"))
            .expect("redo tracked create");

        db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT id, cause_kind, origin, original_transaction_id, undo_journal_id
                   FROM narrative_change_transactions
                  WHERE project_id = ?1
                  ORDER BY source_change_event_sequence",
            )?;
            let rows = statement
                .query_map(rusqlite::params![project_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(rows.len(), 3);
            let forward_id = &rows[0].0;
            assert_eq!(
                (&rows[0].1, &rows[0].2),
                (&"forward".to_string(), &"ai-apply".to_string())
            );
            assert_eq!(
                (&rows[1].1, &rows[1].2),
                (&"undo".to_string(), &"undo".to_string())
            );
            assert_eq!(
                (&rows[2].1, &rows[2].2),
                (&"redo".to_string(), &"redo".to_string())
            );
            assert_eq!(rows[1].3.as_deref(), Some(forward_id.as_str()));
            assert_eq!(rows[2].3.as_deref(), Some(forward_id.as_str()));
            assert!(rows
                .iter()
                .all(|row| row.4.as_deref() == Some(journal_id.as_str())));

            let mutations = conn
                .prepare(
                    "SELECT mutation_kind, before_version, after_version
                       FROM narrative_change_events
                      WHERE project_id = ?1
                      ORDER BY canonical_sequence",
                )?
                .query_map(rusqlite::params![project_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(
                mutations,
                vec![
                    ("create".to_string(), None, Some(1)),
                    ("delete".to_string(), Some(1), None),
                    ("restore".to_string(), None, Some(2)),
                ]
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn undo_feed_failure_rolls_back_the_domain_replay_and_all_history() {
        let db = test_db();
        let project_id = insert_project(&db);
        let entry_id = "codex-undo-feed-rollback";
        let created = tracked_codex_create(&db, &project_id, entry_id, "Rollback", 8);
        let journal_id = created["undoJournalId"]
            .as_str()
            .expect("create journal")
            .to_string();
        let baseline = (
            table_count(&db, "codex_entries"),
            table_count(&db, "change_events"),
            table_count(&db, "narrative_change_transactions"),
            table_count(&db, "narrative_change_events"),
        );
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER force_agent_undo_feed_failure
                 BEFORE INSERT ON narrative_change_events
                 BEGIN
                   SELECT RAISE(ABORT, 'forced agent Undo Feed failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("install failure trigger");

        let error = agent_undo_journal_impl(
            &db,
            AgentUndoJournalPayload {
                request_id: "undo-feed-rollback".to_string(),
                project_id: project_id.clone(),
                session_id: "undo-session".to_string(),
                journal_id,
                direction: "undo".to_string(),
                authority_route: "history-replay".to_string(),
                origin: "undo".to_string(),
                caller: "undo-redo-command".to_string(),
                controls: history_replay_controls(),
            },
        )
        .expect_err("Feed failure must abort the Undo domain replay");
        assert!(
            error.to_string().contains("forced agent Undo Feed failure"),
            "{error:#}"
        );
        assert_eq!(
            (
                table_count(&db, "codex_entries"),
                table_count(&db, "change_events"),
                table_count(&db, "narrative_change_transactions"),
                table_count(&db, "narrative_change_events"),
            ),
            baseline
        );
        db.with_conn(|conn| {
            let version: i64 = conn.query_row(
                "SELECT version FROM codex_entries WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![entry_id, project_id],
                |row| row.get(0),
            )?;
            assert_eq!(version, 1);
            let receipt_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM idempotency_requests
                  WHERE domain = 'agent_apply_undo_journal'
                    AND request_id = 'undo-feed-rollback'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(receipt_count, 0);
            Ok(())
        })
        .expect("inspect rolled back Undo replay");
    }

    #[test]
    fn pre_feed_journal_reuses_its_existing_canonical_event_as_the_root() {
        let db = test_db();
        let project_id = insert_project(&db);
        let created =
            tracked_codex_create(&db, &project_id, "codex-pre-feed-journal", "Pre Feed", 8);
        let journal_id = created["undoJournalId"]
            .as_str()
            .expect("create journal")
            .to_string();
        let forward_event_uid = created["changeEventUid"]
            .as_str()
            .expect("forward canonical event")
            .to_string();
        db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM narrative_change_transactions
                  WHERE project_id = ?1 AND source_change_event_uid = ?2",
                rusqlite::params![project_id, forward_event_uid],
            )?;
            Ok(())
        })
        .expect("simulate a canonical pre-Feed journal");
        let canonical_before = table_count(&db, "change_events");

        agent_undo_journal_impl(
            &db,
            AgentUndoJournalPayload {
                request_id: "pre-feed-journal-undo".to_string(),
                project_id: project_id.clone(),
                session_id: "history-session".to_string(),
                journal_id: journal_id.clone(),
                direction: "undo".to_string(),
                authority_route: "history-replay".to_string(),
                origin: "undo".to_string(),
                caller: "undo-redo-command".to_string(),
                controls: history_replay_controls(),
            },
        )
        .expect("modernize and undo pre-Feed journal");

        db.with_conn(|conn| {
            let rows = conn
                .prepare(
                    "SELECT source_change_event_uid, cause_kind, origin,
                            original_transaction_id, undo_journal_id
                       FROM narrative_change_transactions
                      WHERE project_id = ?1
                      ORDER BY source_change_event_sequence",
                )?
                .query_map(rusqlite::params![project_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0].0, forward_event_uid);
            assert_eq!(
                (rows[0].1.as_str(), rows[0].2.as_str()),
                ("forward", "ai-apply")
            );
            assert_eq!((rows[1].1.as_str(), rows[1].2.as_str()), ("undo", "undo"));
            let root_id: String = conn.query_row(
                "SELECT id FROM narrative_change_transactions
                  WHERE project_id = ?1 AND source_change_event_uid = ?2",
                rusqlite::params![project_id, rows[0].0],
                |row| row.get(0),
            )?;
            assert_eq!(rows[1].3.as_deref(), Some(root_id.as_str()));
            assert!(rows
                .iter()
                .all(|row| row.4.as_deref() == Some(journal_id.as_str())));
            Ok(())
        })
        .expect("inspect canonical-root modernization");
        assert_eq!(table_count(&db, "change_events"), canonical_before + 1);
    }

    fn tracked_codex_update_payload(
        project_id: &str,
        entry_id: &str,
        base_version: i64,
        name: &str,
        span_to: i64,
    ) -> AgentCodexUpdatePayload {
        AgentCodexUpdatePayload {
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            surface: None,
            entry_id: entry_id.to_string(),
            base_version,
            type_slug: Some("location".to_string()),
            name: Some(name.to_string()),
            summary: Some(format!("{name} summary")),
            content: Some(format!(r#"{{"name":"{name}"}}"#)),
            aliases: Some(format!(r#"["{name}"]"#)),
            excluded_aliases: Some(format!(r#"["not-{name}"]"#)),
            readings: Some(format!(r#"["{name}-reading"]"#)),
            tags_cache: Some(format!(r#"[{{"name":"{name}-tag"}}]"#)),
            parent_id: None,
            context_mode: Some("always".to_string()),
            icon: Some(format!("icon:{name}")),
            children_budget: Some("generous".to_string()),
            notes: Some(format!("notes:{name}")),
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: Some(vec![AuthorshipSpanInput {
                from_pos: 1,
                to_pos: span_to,
                source: "human".to_string(),
                model: Some(grimodex_core::writes::LANE_CONTENT_MODEL.to_string()),
                timestamp: None,
                chat_msg_id: None,
                trace_id: None,
            }]),
            authorship_span_lanes: None,
        }
    }

    fn tracked_codex_update(
        db: &Database,
        project_id: &str,
        entry_id: &str,
        base_version: i64,
        name: &str,
        span_to: i64,
    ) -> Value {
        agent_codex_update_impl(
            db,
            tracked_codex_update_payload(project_id, entry_id, base_version, name, span_to),
        )
        .expect("tracked codex update")
    }

    fn codex_root_and_spans(db: &Database, entry_id: &str) -> Value {
        db.with_conn(|conn| collect_codex_entry_snapshot(conn, entry_id))
            .expect("codex snapshot")
    }

    fn codex_journal_tokens(db: &Database, entry_id: &str) -> Vec<(String, i64, i64)> {
        db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT op_kind, base_version, result_version
                   FROM undo_journal
                  WHERE entity_kind = 'codex_entry' AND entity_id = ?1
                  ORDER BY CASE op_kind
                    WHEN 'create' THEN 0 WHEN 'update' THEN 1 ELSE 2 END",
            )?;
            let rows = statement.query_map(rusqlite::params![entry_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?;
            Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
        })
        .expect("codex journal tokens")
    }

    #[test]
    fn codex_update_replay_uses_fresh_versions_and_restores_exact_snapshot() {
        let db = test_db();
        let project_id = insert_project(&db);
        let entry_id = "codex-replay-update";
        let created = tracked_codex_create(&db, &project_id, entry_id, "before", 6);
        let before = codex_root_and_spans(&db, entry_id);
        let updated = tracked_codex_update(&db, &project_id, entry_id, 1, "after", 12);
        let after = codex_root_and_spans(&db, entry_id);
        let update_journal = updated["undoJournalId"].as_str().expect("update journal");

        agent_undo_journal_impl(&db, undo_payload(&project_id, update_journal, "undo"))
            .expect("undo update");
        let restored_before = codex_root_and_spans(&db, entry_id);
        assert_eq!(restored_before["version"], 3);
        let mut expected_before = before.clone();
        expected_before["version"] = Value::from(3);
        assert_eq!(restored_before, expected_before);
        assert_eq!(
            codex_journal_tokens(&db, entry_id),
            vec![("create".to_string(), 0, 3), ("update".to_string(), 3, 2)]
        );
        let create_retry = agent_codex_create_impl(
            &db,
            tracked_codex_create_payload(&project_id, entry_id, "before", 6),
        )
        .expect("idempotent create retry after update undo");
        assert_eq!(create_retry["entityId"], created["entityId"]);
        assert_eq!(create_retry["undoJournalId"], created["undoJournalId"]);
        assert_eq!(create_retry["changeEventUid"], created["changeEventUid"]);
        assert_eq!(create_retry["version"], 3);

        let stale = agent_codex_update_impl(
            &db,
            AgentCodexUpdatePayload {
                project_id: project_id.clone(),
                session_id: "stale-window".to_string(),
                surface: None,
                entry_id: entry_id.to_string(),
                base_version: 1,
                type_slug: None,
                name: Some("stale".to_string()),
                summary: None,
                content: None,
                aliases: None,
                excluded_aliases: None,
                readings: None,
                tags_cache: None,
                parent_id: None,
                context_mode: None,
                icon: None,
                children_budget: None,
                notes: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: None,
                authorship_span_lanes: None,
            },
        )
        .expect_err("pre-replay editor token must stay stale");
        assert!(stale.to_string().contains("version conflict"));
        assert_eq!(codex_root_and_spans(&db, entry_id), expected_before);

        agent_undo_journal_impl(&db, undo_payload(&project_id, update_journal, "redo"))
            .expect("redo update");
        let restored_after = codex_root_and_spans(&db, entry_id);
        assert_eq!(restored_after["version"], 4);
        let mut expected_after = after;
        expected_after["version"] = Value::from(4);
        assert_eq!(restored_after, expected_after);
        assert_eq!(created["version"], 1);
    }

    #[test]
    fn stacked_codex_create_update_delete_replay_keeps_monotonic_chain() {
        let db = test_db();
        let project_id = insert_project(&db);
        let entry_id = "codex-replay-stack";
        let created = tracked_codex_create(&db, &project_id, entry_id, "before", 6);
        let updated = tracked_codex_update(&db, &project_id, entry_id, 1, "after", 12);
        let deleted = agent_codex_delete_impl(
            &db,
            AgentCodexDeletePayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                entry_id: entry_id.to_string(),
                base_version: 2,
            },
        )
        .expect("tracked codex delete");
        let create_journal = created["undoJournalId"].as_str().expect("create journal");
        let update_journal = updated["undoJournalId"].as_str().expect("update journal");
        let delete_journal = deleted["undoJournalId"].as_str().expect("delete journal");

        agent_undo_journal_impl(&db, undo_payload(&project_id, delete_journal, "undo"))
            .expect("undo delete");
        assert_eq!(codex_root_and_spans(&db, entry_id)["version"], 3);
        agent_undo_journal_impl(&db, undo_payload(&project_id, update_journal, "undo"))
            .expect("undo update");
        assert_eq!(codex_root_and_spans(&db, entry_id)["version"], 4);
        agent_undo_journal_impl(&db, undo_payload(&project_id, create_journal, "undo"))
            .expect("undo create");
        assert_eq!(table_count(&db, "codex_entries"), 0);

        agent_undo_journal_impl(&db, undo_payload(&project_id, create_journal, "redo"))
            .expect("redo create");
        assert_eq!(codex_root_and_spans(&db, entry_id)["version"], 5);
        let create_retry = agent_codex_create_impl(
            &db,
            tracked_codex_create_payload(&project_id, entry_id, "before", 6),
        )
        .expect("idempotent create retry after create replay");
        assert_eq!(create_retry["version"], 5);
        agent_undo_journal_impl(&db, undo_payload(&project_id, update_journal, "redo"))
            .expect("redo update");
        assert_eq!(codex_root_and_spans(&db, entry_id)["version"], 6);
        agent_undo_journal_impl(&db, undo_payload(&project_id, delete_journal, "redo"))
            .expect("redo delete");
        assert_eq!(table_count(&db, "codex_entries"), 0);

        agent_undo_journal_impl(&db, undo_payload(&project_id, delete_journal, "undo"))
            .expect("second undo delete");
        assert_eq!(codex_root_and_spans(&db, entry_id)["version"], 7);
        assert_eq!(
            codex_journal_tokens(&db, entry_id),
            vec![
                ("create".to_string(), 0, 5),
                ("update".to_string(), 5, 7),
                ("delete".to_string(), 7, 7),
            ]
        );
    }

    #[test]
    fn codex_replay_rejects_cross_project_id_reuse_and_rolls_back_side_effects() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreign_project_id = insert_project(&db);
        let entry_id = "codex-cross-project-replay";
        tracked_codex_create(&db, &project_id, entry_id, "local", 5);
        let deleted = agent_codex_delete_impl(
            &db,
            AgentCodexDeletePayload {
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: None,
                entry_id: entry_id.to_string(),
                base_version: 1,
            },
        )
        .expect("delete local codex");
        let journal_id = deleted["undoJournalId"].as_str().expect("delete journal");
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO codex_entries
                 (id, project_id, type, name, summary, content, version)
                 VALUES (?1, ?2, 'lore', 'foreign', '', '{}', 9)",
                rusqlite::params![entry_id, foreign_project_id],
            )?;
            Ok(())
        })
        .expect("reuse id in foreign project");
        let changes_before = table_count(&db, "change_events");
        let tokens_before = codex_journal_tokens(&db, entry_id);

        let error = agent_undo_journal_impl(&db, undo_payload(&project_id, journal_id, "undo"))
            .expect_err("cross-project id reuse must fail");
        assert!(error.to_string().contains("version conflict"), "{error:#}");
        let foreign = codex_root_and_spans(&db, entry_id);
        assert_eq!(foreign["projectId"], foreign_project_id);
        assert_eq!(foreign["name"], "foreign");
        assert_eq!(foreign["version"], 9);
        assert_eq!(codex_journal_tokens(&db, entry_id), tokens_before);
        assert_eq!(table_count(&db, "change_events"), changes_before);
    }

    #[test]
    fn versionless_legacy_codex_update_journal_replays_monotonically() {
        let db = test_db();
        let project_id = insert_project(&db);
        let entry_id = "legacy-codex-journal";
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO codex_entries
                 (id, project_id, type, name, summary, content, version)
                 VALUES (?1, ?2, 'character', 'after', 'after summary', '{}', 2)",
                rusqlite::params![entry_id, project_id],
            )?;
            let before = json!({
                "id": entry_id,
                "projectId": project_id,
                "type": "character",
                "name": "before",
                "summary": "before summary",
                "content": "{}",
                "authorshipSpans": [],
            });
            let after = json!({
                "id": entry_id,
                "projectId": project_id,
                "type": "character",
                "name": "after",
                "summary": "after summary",
                "content": "{}",
                "authorshipSpans": [],
            });
            conn.execute(
                "INSERT INTO undo_journal
                 (id, project_id, surface, entity_kind, entity_id, op_kind,
                  before_json, after_json, base_version, result_version)
                 VALUES ('legacy-codex-update', ?1, 'legacy', 'codex_entry', ?2,
                         'update', ?3, ?4, 1, 2)",
                rusqlite::params![project_id, entry_id, before.to_string(), after.to_string()],
            )?;
            Ok(())
        })
        .expect("insert legacy journal");

        agent_undo_journal_impl(
            &db,
            undo_payload(&project_id, "legacy-codex-update", "undo"),
        )
        .expect("undo legacy update");
        let undone = codex_root_and_spans(&db, entry_id);
        assert_eq!(undone["name"], "before");
        assert_eq!(undone["version"], 3);

        agent_undo_journal_impl(
            &db,
            undo_payload(&project_id, "legacy-codex-update", "redo"),
        )
        .expect("redo legacy update");
        let redone = codex_root_and_spans(&db, entry_id);
        assert_eq!(redone["name"], "after");
        assert_eq!(redone["version"], 4);
        db.with_conn(|conn| {
            let rows = conn
                .prepare(
                    "SELECT id, cause_kind, origin, original_transaction_id,
                            undo_journal_id
                       FROM narrative_change_transactions
                      WHERE project_id = ?1
                      ORDER BY source_change_event_sequence",
                )?
                .query_map(rusqlite::params![project_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(rows.len(), 3);
            assert_eq!(
                (rows[0].1.as_str(), rows[0].2.as_str()),
                ("forward", "migration")
            );
            assert_eq!((rows[1].1.as_str(), rows[1].2.as_str()), ("undo", "undo"));
            assert_eq!((rows[2].1.as_str(), rows[2].2.as_str()), ("redo", "redo"));
            assert_eq!(rows[1].3.as_deref(), Some(rows[0].0.as_str()));
            assert_eq!(rows[2].3.as_deref(), Some(rows[0].0.as_str()));
            assert!(rows
                .iter()
                .all(|row| row.4.as_deref() == Some("legacy-codex-update")));
            Ok(())
        })
        .expect("inspect modernized legacy lineage");
    }

    #[test]
    fn undo_payload_requires_request_identity() {
        let error = serde_json::from_value::<AgentUndoJournalPayload>(json!({
            "projectId": "project-1",
            "sessionId": "session-1",
            "journalId": "journal-1",
            "direction": "undo"
        }))
        .expect_err("Native Undo payload without requestId must be rejected");
        assert!(error.to_string().contains("requestId"), "{error}");
    }

    #[test]
    fn codex_create_parent_must_be_distinct_and_in_the_same_project() {
        for (case, expected) in [
            ("self", "cannot be its own parent"),
            ("missing", "not found in project"),
            ("foreign", "not found in project"),
        ] {
            let db = test_db();
            let project_id = insert_project(&db);
            let foreign_project_id = insert_project(&db);
            let foreign_parent = format!("foreign-parent:{case}");
            tracked_codex_create(
                &db,
                &foreign_project_id,
                &foreign_parent,
                "foreign parent",
                5,
            );
            let child_id = format!("child:{case}");
            let parent_id = match case {
                "self" => child_id.clone(),
                "missing" => format!("missing-parent:{case}"),
                "foreign" => foreign_parent,
                _ => unreachable!(),
            };
            let mut payload = tracked_codex_create_payload(&project_id, &child_id, "child", 5);
            payload.parent_id = Some(parent_id);
            let entries_before = table_count(&db, "codex_entries");
            let journals_before = table_count(&db, "undo_journal");
            let changes_before = table_count(&db, "change_events");

            let error = agent_codex_create_impl(&db, payload)
                .expect_err("invalid codex parent must be rejected");
            assert!(error.to_string().contains(expected), "{case}: {error:#}");
            assert_eq!(table_count(&db, "codex_entries"), entries_before);
            assert_eq!(table_count(&db, "undo_journal"), journals_before);
            assert_eq!(table_count(&db, "change_events"), changes_before);
        }

        let db = test_db();
        let project_id = insert_project(&db);
        tracked_codex_create(&db, &project_id, "local-parent", "parent", 5);
        let mut payload = tracked_codex_create_payload(&project_id, "local-child", "child", 5);
        payload.parent_id = Some("local-parent".to_string());
        agent_codex_create_impl(&db, payload).expect("same-project parent is valid");
        assert_eq!(
            codex_root_and_spans(&db, "local-child")["parentId"],
            "local-parent"
        );
    }

    #[test]
    fn codex_update_effective_parent_must_be_distinct_and_in_the_same_project() {
        for (case, expected) in [
            ("self", "cannot be its own parent"),
            ("missing", "not found in project"),
            ("foreign", "not found in project"),
        ] {
            let db = test_db();
            let project_id = insert_project(&db);
            let foreign_project_id = insert_project(&db);
            let target_id = format!("target:{case}");
            let foreign_parent = format!("foreign-parent:{case}");
            tracked_codex_create(&db, &project_id, &target_id, "target", 5);
            tracked_codex_create(
                &db,
                &foreign_project_id,
                &foreign_parent,
                "foreign parent",
                5,
            );
            let parent_id = match case {
                "self" => target_id.clone(),
                "missing" => format!("missing-parent:{case}"),
                "foreign" => foreign_parent,
                _ => unreachable!(),
            };
            let mut payload =
                tracked_codex_update_payload(&project_id, &target_id, 1, "changed", 9);
            payload.parent_id = Some(parent_id);
            let before = codex_root_and_spans(&db, &target_id);
            let journals_before = table_count(&db, "undo_journal");
            let changes_before = table_count(&db, "change_events");

            let error = agent_codex_update_impl(&db, payload)
                .expect_err("invalid effective codex parent must be rejected");
            assert!(error.to_string().contains(expected), "{case}: {error:#}");
            assert_eq!(codex_root_and_spans(&db, &target_id), before);
            assert_eq!(table_count(&db, "undo_journal"), journals_before);
            assert_eq!(table_count(&db, "change_events"), changes_before);
        }

        let db = test_db();
        let project_id = insert_project(&db);
        tracked_codex_create(&db, &project_id, "local-parent", "parent", 5);
        tracked_codex_create(&db, &project_id, "local-target", "target", 5);
        let mut payload =
            tracked_codex_update_payload(&project_id, "local-target", 1, "changed", 9);
        payload.parent_id = Some("local-parent".to_string());
        let updated = agent_codex_update_impl(&db, payload).expect("same-project parent is valid");
        assert_eq!(updated["version"], 2);
        assert_eq!(
            codex_root_and_spans(&db, "local-target")["parentId"],
            "local-parent"
        );
    }

    #[test]
    fn codex_legacy_null_summary_survives_name_update_undo_and_redo() {
        let db = test_db();
        let project_id = insert_project(&db);
        let entry_id = "legacy-null-summary";
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO codex_entries
                 (id, project_id, type, name, summary, content, version)
                 VALUES (?1, ?2, 'character', 'before', NULL, '{}', 1)",
                rusqlite::params![entry_id, project_id],
            )?;
            Ok(())
        })
        .expect("insert legacy NULL summary row");

        let mut payload = tracked_codex_update_payload(&project_id, entry_id, 1, "after", 9);
        payload.type_slug = None;
        payload.summary = None;
        payload.content = None;
        payload.aliases = None;
        payload.excluded_aliases = None;
        payload.readings = None;
        payload.tags_cache = None;
        payload.context_mode = None;
        payload.icon = None;
        payload.children_budget = None;
        payload.notes = None;
        payload.authorship_spans = None;
        let updated = agent_codex_update_impl(&db, payload).expect("name-only legacy update");
        let journal_id = updated["undoJournalId"].as_str().expect("update journal");
        let after = codex_root_and_spans(&db, entry_id);
        assert_eq!(after["name"], "after");
        assert!(after["summary"].is_null());
        assert_eq!(after["version"], 2);

        agent_undo_journal_impl(&db, undo_payload(&project_id, journal_id, "undo"))
            .expect("undo legacy NULL summary update");
        let undone = codex_root_and_spans(&db, entry_id);
        assert_eq!(undone["name"], "before");
        assert!(undone["summary"].is_null());
        assert_eq!(undone["version"], 3);

        agent_undo_journal_impl(&db, undo_payload(&project_id, journal_id, "redo"))
            .expect("redo legacy NULL summary update");
        let redone = codex_root_and_spans(&db, entry_id);
        assert_eq!(redone["name"], "after");
        assert!(redone["summary"].is_null());
        assert_eq!(redone["version"], 4);
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
        assert_eq!(table_count(&db, "narrative_change_transactions"), 1);
        assert_eq!(table_count(&db, "narrative_change_events"), 1);
        db.with_conn(|conn| {
            let transaction: (String, String, String) = conn.query_row(
                "SELECT request_id, source_domain, origin
                   FROM narrative_change_transactions",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(
                transaction,
                (
                    "agent-tool:snippet-request-1".to_string(),
                    "snippet.create".to_string(),
                    "ai-apply".to_string(),
                )
            );
            Ok(())
        })
        .expect("verify snippet Feed");

        let mut conflicting = payload;
        conflicting.title = "Changed".to_string();
        let error = agent_snippet_create_impl(&db, conflicting).expect_err("payload conflict");
        assert!(error
            .to_string()
            .contains("AGENT_SNIPPET_CREATE_IDEMPOTENCY_CONFLICT"));
        assert_eq!(table_count(&db, "snippets"), 1);
    }

    #[test]
    fn direct_agent_create_writers_reject_missing_request_identity() {
        let db = test_db();
        let project_id = insert_project(&db);
        let codex_error = agent_codex_create_impl(
            &db,
            AgentCodexCreatePayload {
                request_id: None,
                entry_id: Some("codex-without-request".to_string()),
                project_id: project_id.clone(),
                session_id: "session".to_string(),
                surface: None,
                type_slug: "character".to_string(),
                name: "No request".to_string(),
                summary: None,
                content: None,
                aliases: None,
                excluded_aliases: None,
                readings: None,
                tags_cache: None,
                parent_id: None,
                source_chat_message_id: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: vec![],
            },
        )
        .expect_err("Codex create must fail closed without requestId");
        assert!(codex_error.to_string().contains("requestId is required"));

        let snippet_error = agent_snippet_create_impl(
            &db,
            AgentSnippetCreatePayload {
                request_id: None,
                snippet_id: Some("snippet-without-request".to_string()),
                project_id,
                session_id: "session".to_string(),
                title: "No request".to_string(),
                content: None,
                scene_id: None,
                source_chat_message_id: None,
                model: None,
                chat_message_id: None,
                trace_id: None,
                authorship_spans: vec![],
            },
        )
        .expect_err("Snippet create must fail closed without requestId");
        assert!(snippet_error.to_string().contains("requestId is required"));
        assert_eq!(table_count(&db, "codex_entries"), 0);
        assert_eq!(table_count(&db, "snippets"), 0);
        assert_eq!(table_count(&db, "change_events"), 0);
        assert_eq!(table_count(&db, "narrative_change_transactions"), 0);
    }

    #[test]
    fn snippet_create_rejects_cross_project_scene_and_feed_failure_rolls_back() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreign_project_id = insert_project(&db);
        let foreign_scene_id = insert_scene(&db, &foreign_project_id);
        let base_payload = AgentSnippetCreatePayload {
            request_id: Some("snippet-xproj".to_string()),
            snippet_id: None,
            project_id: project_id.clone(),
            session_id: "snippet-session".to_string(),
            title: "Excerpt".to_string(),
            content: None,
            scene_id: Some(foreign_scene_id),
            source_chat_message_id: None,
            model: None,
            chat_message_id: None,
            trace_id: None,
            authorship_spans: vec![],
        };
        let error = agent_snippet_create_impl(&db, base_payload.clone())
            .expect_err("cross-project scene must be rejected");
        assert!(error
            .to_string()
            .contains("snippet scene is not in project"));
        assert_eq!(table_count(&db, "snippets"), 0);
        assert_eq!(table_count(&db, "undo_journal"), 0);
        assert_eq!(table_count(&db, "change_events"), 0);

        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_snippet_feed
                   BEFORE INSERT ON narrative_change_transactions
                   BEGIN SELECT RAISE(ABORT, 'forced snippet feed failure'); END;",
            )?;
            Ok(())
        })
        .expect("install Feed failure trigger");
        let mut rollback_payload = base_payload;
        rollback_payload.request_id = Some("snippet-feed-failure".to_string());
        rollback_payload.scene_id = None;
        let error = agent_snippet_create_impl(&db, rollback_payload)
            .expect_err("Feed failure must abort the snippet mutation");
        assert!(error.to_string().contains("forced snippet feed failure"));
        assert_eq!(table_count(&db, "snippets"), 0);
        assert_eq!(table_count(&db, "undo_journal"), 0);
        assert_eq!(table_count(&db, "change_events"), 0);
        assert_eq!(table_count(&db, "narrative_change_transactions"), 0);
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

    #[test]
    fn prose_accept_stays_out_of_the_feed_and_rolls_back_on_audit_failure() {
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_id = insert_scene(&db, &project_id);
        let proposed = agent_propose_scene_body_impl(
            &db,
            AgentProposeSceneBodyPayload {
                project_id: project_id.clone(),
                session_id: "prose-session".to_string(),
                scene_id: scene_id.clone(),
                proposed_content: "new prose".to_string(),
                mode: "append".to_string(),
                source_surface: "in-app-agent".to_string(),
                replace_from: None,
                replace_to: None,
            },
        )
        .expect("propose prose");
        let staging_id = proposed["stagingId"].as_str().expect("staging id");
        let payload = AgentProseStageIdPayload {
            request_id: Some("prose-accept-request".to_string()),
            project_id: project_id.clone(),
            session_id: "prose-session".to_string(),
            staging_id: staging_id.to_string(),
        };
        let accepted = agent_accept_prose_stage_impl(&db, payload.clone()).expect("accept prose");
        let mut retry = payload.clone();
        retry.session_id = "prose-session-after-restart".to_string();
        assert_eq!(
            agent_accept_prose_stage_impl(&db, retry).expect("idempotent accept retry"),
            accepted
        );
        db.with_conn(|conn| {
            let status: String = conn.query_row(
                "SELECT status FROM prose_staging WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![staging_id, project_id],
                |row| row.get(0),
            )?;
            assert_eq!(status, "accepted");
            let counts: (i64, i64, i64) = conn.query_row(
                "SELECT
                    (SELECT COUNT(*) FROM change_events WHERE op_type = 'prose.accept'),
                    (SELECT COUNT(*) FROM narrative_change_transactions),
                    (SELECT COUNT(*) FROM idempotency_requests
                      WHERE domain = 'agent_prose_accept')",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
            assert_eq!(counts, (1, 0, 1));
            Ok(())
        })
        .expect("verify accepted staging audit");

        let second_proposed = agent_propose_scene_body_impl(
            &db,
            AgentProposeSceneBodyPayload {
                project_id: project_id.clone(),
                session_id: "prose-session".to_string(),
                scene_id,
                proposed_content: "another".to_string(),
                mode: "append".to_string(),
                source_surface: "in-app-agent".to_string(),
                replace_from: None,
                replace_to: None,
            },
        )
        .expect("propose rollback fixture");
        let second_staging_id = second_proposed["stagingId"]
            .as_str()
            .expect("second staging id")
            .to_string();
        db.with_conn(|conn| {
            conn.execute_batch(
                "CREATE TRIGGER fail_prose_accept_audit
                   BEFORE INSERT ON change_events
                   BEGIN SELECT RAISE(ABORT, 'forced prose accept audit failure'); END;",
            )?;
            Ok(())
        })
        .expect("install audit failure trigger");
        let error = agent_accept_prose_stage_impl(
            &db,
            AgentProseStageIdPayload {
                request_id: Some("prose-accept-failure".to_string()),
                project_id: project_id.clone(),
                session_id: "prose-session".to_string(),
                staging_id: second_staging_id.clone(),
            },
        )
        .expect_err("audit failure must roll back staging acceptance");
        assert!(error
            .to_string()
            .contains("forced prose accept audit failure"));
        db.with_conn(|conn| {
            let status: String = conn.query_row(
                "SELECT status FROM prose_staging WHERE id = ?1 AND project_id = ?2",
                rusqlite::params![second_staging_id, project_id],
                |row| row.get(0),
            )?;
            assert_eq!(status, "proposed");
            Ok(())
        })
        .expect("verify staging rollback");
    }

    fn journal_row(
        entity_kind: &str,
        op_kind: &str,
    ) -> grimodex_core::undo_journal::UndoJournalRow {
        grimodex_core::undo_journal::UndoJournalRow {
            id: "j1".to_string(),
            project_id: "p1".to_string(),
            surface: "test".to_string(),
            entity_kind: entity_kind.to_string(),
            entity_id: "f1".to_string(),
            op_kind: op_kind.to_string(),
            before_json: None,
            after_json: None,
            base_version: 0,
            result_version: 1,
            change_event_uid: None,
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
                request_id: "foreshadow-create-roundtrip".to_string(),
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
            request_id: "agent-tool:foreshadow-request-1".to_string(),
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
        assert_eq!(table_count(&db, "narrative_change_transactions"), 1);
        assert_eq!(table_count(&db, "narrative_change_events"), 1);

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
    fn foreshadow_create_payload_requires_request_identity() {
        let error = serde_json::from_value::<AgentForeshadowCreatePayload>(serde_json::json!({
            "foreshadowId": "f1",
            "projectId": "p1",
            "sessionId": "session",
            "title": "Created",
            "secret": true
        }))
        .expect_err("Native payload without requestId must be rejected");
        assert!(error.to_string().contains("requestId"), "{error}");
    }

    #[test]
    fn foreshadow_update_in_app_patches_and_tracks() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow_row(&db, &project_id);

        let result = agent_foreshadow_update_impl(
            &db,
            AgentForeshadowUpdatePayload {
                request_id: "foreshadow-update-roundtrip".to_string(),
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                foreshadow_id: foreshadow_id.clone(),
                base_version: 0,
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
        assert_eq!(result["version"], 1);
        let journal_id = result["undoJournalId"]
            .as_str()
            .expect("undo journal id")
            .to_string();

        db.with_conn(|conn| {
            let (payoff, version): (i64, i64) = conn.query_row(
                "SELECT payoff_confirmed, version FROM foreshadows WHERE id = ?1",
                rusqlite::params![foreshadow_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!(payoff, 1);
            assert_eq!(version, 1);
            let (base_version, result_version): (i64, i64) = conn.query_row(
                "SELECT base_version, result_version FROM undo_journal",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!((base_version, result_version), (0, 1));
            let op_type: String =
                conn.query_row("SELECT op_type FROM change_events", [], |r| r.get(0))?;
            assert_eq!(op_type, "foreshadow.update");
            Ok(())
        })
        .unwrap();

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect("undo foreshadow update");
        db.with_conn(|conn| {
            let (payoff, version): (i64, i64) = conn.query_row(
                "SELECT payoff_confirmed, version FROM foreshadows WHERE id = ?1",
                rusqlite::params![foreshadow_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!((payoff, version), (0, 2));
            Ok(())
        })
        .unwrap();

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo"))
            .expect("redo foreshadow update");
        db.with_conn(|conn| {
            let (payoff, version): (i64, i64) = conn.query_row(
                "SELECT payoff_confirmed, version FROM foreshadows WHERE id = ?1",
                rusqlite::params![foreshadow_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            assert_eq!((payoff, version), (1, 3));
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
                request_id: "foreshadow-update-missing".to_string(),
                project_id,
                session_id: "sess".to_string(),
                foreshadow_id: "ghost".to_string(),
                base_version: 0,
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

    #[test]
    fn foreshadow_update_request_replays_exact_receipt_and_rejects_payload_conflict() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreshadow_id = insert_foreshadow_row(&db, &project_id);
        let payload = AgentForeshadowUpdatePayload {
            request_id: "foreshadow-update-retry".to_string(),
            project_id,
            session_id: "session-before-restart".to_string(),
            foreshadow_id,
            base_version: 0,
            title: Some("Updated once".to_string()),
            intent: None,
            notes: None,
            load_bearing: None,
            payoff_confirmed: None,
            abandoned: None,
            secret: None,
        };

        let first = agent_foreshadow_update_impl(&db, payload.clone()).expect("first update");
        let counts_after_first = (
            table_count(&db, "undo_journal"),
            table_count(&db, "change_events"),
            table_count(&db, "narrative_change_transactions"),
            table_count(&db, "narrative_change_events"),
        );

        let mut retry = payload.clone();
        retry.session_id = "session-after-restart".to_string();
        let replay = agent_foreshadow_update_impl(&db, retry).expect("exact retry replay");
        assert_eq!(replay, first);
        assert_eq!(
            (
                table_count(&db, "undo_journal"),
                table_count(&db, "change_events"),
                table_count(&db, "narrative_change_transactions"),
                table_count(&db, "narrative_change_events"),
            ),
            counts_after_first
        );

        let mut conflicting = payload;
        conflicting.title = Some("Different payload".to_string());
        let error = agent_foreshadow_update_impl(&db, conflicting)
            .expect_err("request id payload conflict");
        assert!(
            error
                .to_string()
                .contains("AGENT_FORESHADOW_UPDATE_IDEMPOTENCY_CONFLICT"),
            "{error:#}"
        );
        assert_eq!(
            (
                table_count(&db, "undo_journal"),
                table_count(&db, "change_events"),
                table_count(&db, "narrative_change_transactions"),
                table_count(&db, "narrative_change_events"),
            ),
            counts_after_first
        );
    }

    #[test]
    fn foreshadow_update_payload_requires_request_identity() {
        let error = serde_json::from_value::<AgentForeshadowUpdatePayload>(serde_json::json!({
            "projectId": "p1",
            "sessionId": "session",
            "foreshadowId": "f1",
            "baseVersion": 0,
            "title": "Updated"
        }))
        .expect_err("Native payload without requestId must be rejected");
        assert!(error.to_string().contains("requestId"), "{error}");
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
            request_id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            journal_id: journal_id.to_string(),
            direction: direction.to_string(),
            authority_route: "history-replay".to_string(),
            origin: direction.to_string(),
            caller: "undo-redo-command".to_string(),
            controls: history_replay_controls(),
        }
    }

    fn history_replay_controls() -> Vec<String> {
        [
            "original-transaction",
            "journal-lineage",
            "typed-writer",
            "occ",
            "change-event",
            "change-feed",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    }

    fn relation_payload(project_id: &str, cause: &str, effect: &str) -> AgentEventRelationPayload {
        AgentEventRelationPayload {
            request_id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            surface: None,
            cause_event_id: cause.to_string(),
            effect_event_id: effect.to_string(),
        }
    }

    fn scene_payload(project_id: &str, scene_id: &str, event_id: &str) -> AgentSceneEventPayload {
        AgentSceneEventPayload {
            request_id: uuid::Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            surface: None,
            scene_id: scene_id.to_string(),
            event_id: event_id.to_string(),
        }
    }

    fn batch_scene_payload(
        request_id: &str,
        project_id: &str,
        event_id: &str,
        scene_ids: Vec<String>,
    ) -> AgentSceneEventLinkBatchPayload {
        AgentSceneEventLinkBatchPayload {
            request_id: request_id.to_string(),
            project_id: project_id.to_string(),
            session_id: "sess".to_string(),
            surface: None,
            event_id: event_id.to_string(),
            scene_ids,
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
            request_id: uuid::Uuid::new_v4().to_string(),
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
                request_id: uuid::Uuid::new_v4().to_string(),
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
    fn event_and_association_payloads_require_request_identity() {
        assert!(serde_json::from_value::<AgentEventCreatePayload>(json!({
            "projectId": "project",
            "sessionId": "session"
        }))
        .is_err());
        assert!(serde_json::from_value::<AgentSceneEventPayload>(json!({
            "projectId": "project",
            "sessionId": "session",
            "sceneId": "scene",
            "eventId": "event"
        }))
        .is_err());
        assert!(serde_json::from_value::<AgentEventRelationPayload>(json!({
            "projectId": "project",
            "sessionId": "session",
            "causeEventId": "cause",
            "effectEventId": "effect"
        }))
        .is_err());

        let db = test_db();
        let project_id = insert_project(&db);
        let mut create = empty_create(&project_id, "missing request");
        create.request_id.clear();
        assert!(agent_event_create_impl(&db, create)
            .expect_err("empty create request id")
            .to_string()
            .contains("requestId"));

        let mut link = scene_payload(&project_id, "scene", "event");
        link.request_id.clear();
        assert!(agent_scene_event_mutate_impl(&db, link, true)
            .expect_err("empty scene link request id")
            .to_string()
            .contains("requestId"));

        let mut relation = relation_payload(&project_id, "cause", "effect");
        relation.request_id.clear();
        assert!(agent_event_relation_mutate_impl(&db, relation, true)
            .expect_err("empty relation request id")
            .to_string()
            .contains("requestId"));
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
        payload.request_id = "agent-tool:event-request-1".to_string();
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
        assert_eq!(table_count(&db, "narrative_change_transactions"), 1);
        assert_eq!(table_count(&db, "narrative_change_events"), 1);

        let mut conflicting = payload;
        conflicting.title = Some("Departure".to_string());
        let error = agent_event_create_impl(&db, conflicting).expect_err("payload conflict");
        assert!(error
            .to_string()
            .contains("AGENT_EVENT_CREATE_IDEMPOTENCY_CONFLICT"));
        assert_eq!(table_count(&db, "events"), 1);
    }

    #[test]
    fn mcp_event_writer_rechecks_secret_visibility_inside_native_transaction() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "secret", vec![], vec![]);
        db.execute(
            "UPDATE events SET secret = 1 WHERE id = ? AND project_id = ?",
            &[
                Value::String(event_id.clone()),
                Value::String(project_id.clone()),
            ],
            "run",
        )
        .expect("hide event");
        let change_count = table_count(&db, "change_events");
        let feed_count = table_count(&db, "narrative_change_transactions");
        let journal_count = table_count(&db, "undo_journal");

        let mut update = empty_update(&project_id, &event_id);
        update.surface = Some("mcp".to_string());
        update.title = Some("must not apply".to_string());
        let error =
            agent_event_update_with_request_impl(&db, update, Some("mcp-secret-event-update"))
                .expect_err("MCP cannot mutate a secret event");

        assert!(error.to_string().contains("not found in project"));
        assert_eq!(event_title(&db, &event_id).as_deref(), Some("secret"));
        assert_eq!(table_count(&db, "change_events"), change_count);
        assert_eq!(
            table_count(&db, "narrative_change_transactions"),
            feed_count
        );
        assert_eq!(table_count(&db, "undo_journal"), journal_count);
    }

    #[test]
    fn event_non_create_request_ids_replay_before_entity_and_occ_checks() {
        let db = test_db();
        let project_id = insert_project(&db);
        let participant = insert_codex(&db, &project_id, "Participant");
        let (update_event_id, _) = create_event(&db, &project_id, "Before", vec![], vec![]);
        let mut update = empty_update(&project_id, &update_event_id);
        update.title = Some("After".to_string());
        let first_update =
            agent_event_update_with_request_impl(&db, update.clone(), Some("event-update-retry"))
                .expect("update");
        let mut update_retry = update;
        update_retry.session_id = "session-after-restart".to_string();
        let replay_update =
            agent_event_update_with_request_impl(&db, update_retry, Some("event-update-retry"))
                .expect("stale update retry");
        assert_eq!(replay_update, first_update);

        let participants = AgentEventParticipantsPayload {
            project_id: project_id.clone(),
            session_id: "session-before-restart".to_string(),
            surface: None,
            event_id: update_event_id.clone(),
            base_version: 2,
            codex_entry_ids: vec![participant],
            participant_roles: None,
        };
        let first_participants = agent_event_set_participants_with_request_impl(
            &db,
            participants.clone(),
            Some("event-participants-retry"),
        )
        .expect("participants");
        let mut participants_retry = participants;
        participants_retry.session_id = "session-after-restart".to_string();
        let replay_participants = agent_event_set_participants_with_request_impl(
            &db,
            participants_retry,
            Some("event-participants-retry"),
        )
        .expect("stale participant retry");
        assert_eq!(replay_participants, first_participants);

        let (delete_event_id, _) = create_event(&db, &project_id, "Delete", vec![], vec![]);
        let delete = AgentEventIdPayload {
            project_id: project_id.clone(),
            session_id: "session-before-restart".to_string(),
            surface: None,
            event_id: delete_event_id,
            base_version: 1,
        };
        let first_delete =
            agent_event_delete_with_request_impl(&db, delete.clone(), Some("event-delete-retry"))
                .expect("delete");
        let mut delete_retry = delete;
        delete_retry.session_id = "session-after-restart".to_string();
        let replay_delete =
            agent_event_delete_with_request_impl(&db, delete_retry, Some("event-delete-retry"))
                .expect("retry after entity deletion");
        assert_eq!(replay_delete, first_delete);

        db.with_conn(|conn| {
            for (domain, request_id) in [
                ("agent_event_update", "event-update-retry"),
                ("agent_event_participants", "event-participants-retry"),
                ("agent_event_delete", "event-delete-retry"),
            ] {
                let count: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM idempotency_requests
                      WHERE domain = ?1 AND request_id = ?2",
                    rusqlite::params![domain, request_id],
                    |row| row.get(0),
                )?;
                assert_eq!(count, 1, "duplicate receipt for {domain}");
            }
            Ok(())
        })
        .expect("inspect event retry receipts");
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
        link.request_id = "scene-link-request-1".to_string();
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
        relation.request_id = "event-relation-request-1".to_string();
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

    #[test]
    fn scene_event_link_batch_is_idempotent_and_canonicalizes_scene_ids() {
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_a = insert_scene(&db, &project_id);
        let scene_b = insert_scene(&db, &project_id);
        let (event_id, _) = create_event(&db, &project_id, "Batch", vec![], vec![]);
        let event_version_before = event_version(&db, &event_id);
        let journals_before = table_count(&db, "undo_journal");
        let changes_before = table_count(&db, "change_events");

        let empty_error = agent_scene_event_link_batch_impl(
            &db,
            batch_scene_payload("scene-link-batch-empty", &project_id, &event_id, Vec::new()),
        )
        .expect_err("empty sceneIds must be rejected");
        assert!(empty_error
            .to_string()
            .contains("sceneIds must not be empty"));
        assert_eq!(table_count(&db, "undo_journal"), journals_before);
        assert_eq!(table_count(&db, "change_events"), changes_before);

        let oversized_error = agent_scene_event_link_batch_impl(
            &db,
            batch_scene_payload(
                "scene-link-batch-oversized",
                &project_id,
                &event_id,
                vec![scene_a.clone(); 10_001],
            ),
        )
        .expect_err("oversized sceneIds must be rejected before deduplication");
        assert!(oversized_error.to_string().contains("at most 10000"));
        assert_eq!(table_count(&db, "undo_journal"), journals_before);
        assert_eq!(table_count(&db, "change_events"), changes_before);

        let request_id = "scene-link-batch-idempotent";
        let first = agent_scene_event_link_batch_impl(
            &db,
            batch_scene_payload(
                request_id,
                &project_id,
                &event_id,
                vec![scene_b.clone(), scene_a.clone(), scene_a.clone()],
            ),
        )
        .expect("first batch link");
        let mut retry_payload = batch_scene_payload(
            request_id,
            &project_id,
            &event_id,
            vec![scene_a.clone(), scene_b.clone()],
        );
        retry_payload.session_id = "sess-after-restart".to_string();
        retry_payload.surface = Some("manual".to_string());
        let retry = agent_scene_event_link_batch_impl(&db, retry_payload).expect("batch retry");
        assert_eq!(retry, first);
        assert_eq!(first["version"], event_version_before);
        assert_eq!(event_version(&db, &event_id), event_version_before);
        assert_eq!(table_count(&db, "undo_journal"), journals_before + 1);
        assert_eq!(table_count(&db, "change_events"), changes_before + 1);

        let mut expected_scene_ids = vec![scene_a.clone(), scene_b.clone()];
        expected_scene_ids.sort();
        assert_eq!(scene_link_ids(&db, &event_id), expected_scene_ids);
        db.with_conn(|conn| {
            let event_uid = first["changeEventUid"].as_str().expect("changeEventUid");
            let (scene_id, domain, op_type, raw_payload): (Option<String>, String, String, String) =
                conn.query_row(
                    "SELECT scene_id, domain, op_type, payload
                 FROM change_events WHERE event_uid = ?1",
                    rusqlite::params![event_uid],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )?;
            assert_eq!(scene_id, None);
            assert_eq!(domain, "event");
            assert_eq!(op_type, "event.stamp");
            let change_payload: Value = serde_json::from_str(&raw_payload)?;
            assert_eq!(change_payload["sceneIds"], json!(expected_scene_ids));
            assert!(change_payload["requestHash"]
                .as_str()
                .is_some_and(|hash| hash.len() == 64));
            Ok(())
        })
        .expect("inspect batch change event");

        let conflict = agent_scene_event_link_batch_impl(
            &db,
            batch_scene_payload(request_id, &project_id, &event_id, vec![scene_a.clone()]),
        )
        .expect_err("requestId reuse with a different batch must conflict");
        assert!(conflict
            .to_string()
            .contains("AGENT_SCENE_EVENT_LINK_BATCH_IDEMPOTENCY_CONFLICT"));
        assert_eq!(scene_link_ids(&db, &event_id), expected_scene_ids);
        assert_eq!(table_count(&db, "undo_journal"), journals_before + 1);
        assert_eq!(table_count(&db, "change_events"), changes_before + 1);
    }

    #[test]
    fn scene_event_link_batch_undo_redo_replays_only_the_added_delta() {
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_existing = insert_scene(&db, &project_id);
        let scene_new = insert_scene(&db, &project_id);
        let (event_id, _) = create_event(&db, &project_id, "Mixed", vec![], vec![]);
        let mut seed_existing = scene_payload(&project_id, &scene_existing, &event_id);
        seed_existing.request_id = "scene-link-batch-mixed-existing".to_string();
        agent_scene_event_mutate_impl(&db, seed_existing, true).expect("seed existing scene link");
        let event_version_before = event_version(&db, &event_id);
        let journals_before = table_count(&db, "undo_journal");
        let changes_before = table_count(&db, "change_events");

        let result = agent_scene_event_link_batch_impl(
            &db,
            batch_scene_payload(
                "scene-link-batch-mixed",
                &project_id,
                &event_id,
                vec![scene_new.clone(), scene_existing.clone(), scene_new.clone()],
            ),
        )
        .expect("link mixed batch");
        let journal_id = result["undoJournalId"]
            .as_str()
            .expect("undoJournalId")
            .to_string();
        assert_eq!(journal_id, "scene-link-batch-mixed");
        assert_eq!(table_count(&db, "undo_journal"), journals_before + 1);
        assert_eq!(table_count(&db, "change_events"), changes_before + 1);
        assert_eq!(event_version(&db, &event_id), event_version_before);
        assert!(scene_link_has(&db, &event_id, &scene_existing));
        assert!(scene_link_has(&db, &event_id, &scene_new));
        let forward_change = latest_change_payload(&db, "event.stamp");
        assert_eq!(forward_change["sceneIds"], json!([scene_new.clone()]));

        db.with_conn(|conn| {
            let (before_json, after_json, base_version, result_version): (
                String,
                String,
                i64,
                i64,
            ) = conn.query_row(
                "SELECT before_json, after_json, base_version, result_version
                 FROM undo_journal WHERE id = ?1",
                rusqlite::params![journal_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            let before: Value = serde_json::from_str(&before_json)?;
            let after: Value = serde_json::from_str(&after_json)?;
            assert_eq!(before["snapshotKind"], SCENE_EVENT_LINK_BATCH_SNAPSHOT_KIND);
            assert_eq!(before["eventId"], event_id);
            assert_eq!(before["sceneIds"], json!([scene_new.clone()]));
            assert_eq!(before["linked"], false);
            assert_eq!(after["snapshotKind"], SCENE_EVENT_LINK_BATCH_SNAPSHOT_KIND);
            assert_eq!(after["eventId"], event_id);
            assert_eq!(after["sceneIds"], json!([scene_new.clone()]));
            assert_eq!(after["linked"], true);
            assert!(after["incarnationTokens"][scene_new.as_str()]
                .as_str()
                .is_some_and(|token| !token.is_empty()));
            assert_eq!(base_version, event_version_before);
            assert_eq!(result_version, event_version_before);
            Ok(())
        })
        .expect("inspect batch delta journal snapshots");

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect("undo batch scene links");
        assert!(scene_link_has(&db, &event_id, &scene_existing));
        assert!(!scene_link_has(&db, &event_id, &scene_new));
        assert_eq!(event_version(&db, &event_id), event_version_before);
        let undo_change = latest_change_payload(&db, "event.unstamp");
        assert_eq!(undo_change["direction"], "undo");
        assert_eq!(undo_change["sceneIds"], json!([scene_new.clone()]));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo"))
            .expect("redo batch scene links");
        assert!(scene_link_has(&db, &event_id, &scene_existing));
        assert!(scene_link_has(&db, &event_id, &scene_new));
        assert_eq!(event_version(&db, &event_id), event_version_before);
        assert_eq!(table_count(&db, "undo_journal"), journals_before + 1);
        let redo_change = latest_change_payload(&db, "event.stamp");
        assert_eq!(redo_change["direction"], "redo");
        assert_eq!(redo_change["sceneIds"], json!([scene_new]));
    }

    #[test]
    fn scene_event_link_batch_undo_redo_preserves_interleaved_link_changes() {
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_existing = insert_scene(&db, &project_id);
        let scene_batch = insert_scene(&db, &project_id);
        let scene_later = insert_scene(&db, &project_id);
        let (event_id, _) = create_event(&db, &project_id, "Interleaved", vec![], vec![]);
        let mut seed_existing = scene_payload(&project_id, &scene_existing, &event_id);
        seed_existing.request_id = "scene-link-batch-interleaved-existing".to_string();
        agent_scene_event_mutate_impl(&db, seed_existing, true).expect("seed existing scene link");

        let result = agent_scene_event_link_batch_impl(
            &db,
            batch_scene_payload(
                "scene-link-batch-interleaved",
                &project_id,
                &event_id,
                vec![scene_existing.clone(), scene_batch.clone()],
            ),
        )
        .expect("link batch delta");
        let journal_id = result["undoJournalId"]
            .as_str()
            .expect("undoJournalId")
            .to_string();

        let mut interleave_unlink = scene_payload(&project_id, &scene_existing, &event_id);
        interleave_unlink.request_id = "scene-link-batch-interleaved-unlink".to_string();
        agent_scene_event_mutate_impl(&db, interleave_unlink, false)
            .expect("interleave unrelated unlink");
        let mut interleave_link = scene_payload(&project_id, &scene_later, &event_id);
        interleave_link.request_id = "scene-link-batch-interleaved-later".to_string();
        agent_scene_event_mutate_impl(&db, interleave_link, true)
            .expect("interleave unrelated link");

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "undo"))
            .expect("undo batch delta");
        assert!(!scene_link_has(&db, &event_id, &scene_existing));
        assert!(!scene_link_has(&db, &event_id, &scene_batch));
        assert!(scene_link_has(&db, &event_id, &scene_later));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &journal_id, "redo"))
            .expect("redo batch delta");
        assert!(!scene_link_has(&db, &event_id, &scene_existing));
        assert!(scene_link_has(&db, &event_id, &scene_batch));
        assert!(scene_link_has(&db, &event_id, &scene_later));
    }

    #[test]
    fn scene_event_link_batch_stale_undo_rejects_aba_without_mutation() {
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_batch = insert_scene(&db, &project_id);
        let scene_unrelated = insert_scene(&db, &project_id);
        let (event_id, _) = create_event(&db, &project_id, "ABA", vec![], vec![]);

        let batch = agent_scene_event_link_batch_impl(
            &db,
            batch_scene_payload(
                "scene-link-batch-aba",
                &project_id,
                &event_id,
                vec![scene_batch.clone()],
            ),
        )
        .expect("link batch association");
        let batch_journal = batch["undoJournalId"]
            .as_str()
            .expect("undoJournalId")
            .to_string();
        let first_token =
            scene_link_token(&db, &event_id, &scene_batch).expect("batch link incarnation token");
        assert!(!first_token.is_empty());

        agent_scene_event_mutate_impl(
            &db,
            scene_payload(&project_id, &scene_batch, &event_id),
            false,
        )
        .expect("interleaved unlink");
        agent_scene_event_mutate_impl(
            &db,
            scene_payload(&project_id, &scene_batch, &event_id),
            true,
        )
        .expect("interleaved relink");
        agent_scene_event_mutate_impl(
            &db,
            scene_payload(&project_id, &scene_unrelated, &event_id),
            true,
        )
        .expect("unrelated interleaved link");

        let replacement_token =
            scene_link_token(&db, &event_id, &scene_batch).expect("replacement incarnation token");
        assert!(!replacement_token.is_empty());
        assert_ne!(replacement_token, first_token);
        let unrelated_token = scene_link_token(&db, &event_id, &scene_unrelated)
            .expect("unrelated incarnation token");
        let journals_before = table_count(&db, "undo_journal");
        let changes_before = table_count(&db, "change_events");

        let error = agent_undo_journal_impl(&db, undo_payload(&project_id, &batch_journal, "undo"))
            .expect_err("stale batch undo must reject an ABA relink");
        assert!(error.to_string().contains("incarnation"));
        assert_eq!(
            scene_link_token(&db, &event_id, &scene_batch),
            Some(replacement_token)
        );
        assert_eq!(
            scene_link_token(&db, &event_id, &scene_unrelated),
            Some(unrelated_token)
        );
        assert_eq!(table_count(&db, "undo_journal"), journals_before);
        assert_eq!(table_count(&db, "change_events"), changes_before);
    }

    #[test]
    fn scene_event_link_batch_rolls_back_all_chunks_on_insert_failure() {
        let db = test_db();
        let project_id = insert_project(&db);
        let (event_id, _) = create_event(&db, &project_id, "Atomic", vec![], vec![]);
        let scene_ids: Vec<String> = (0..=INSERT_CHUNK_ROWS)
            .map(|index| format!("atomic-scene-{index:03}"))
            .collect();
        db.with_conn(|conn| {
            for scene_id in &scene_ids {
                conn.execute(
                    "INSERT INTO tree_nodes
                     (id, project_id, node_type, title, content, sort_order)
                     VALUES (?1, ?2, 'scene', ?1, '{}', 'a0')",
                    rusqlite::params![scene_id, project_id],
                )?;
            }
            conn.execute_batch(
                "CREATE TRIGGER fail_last_batch_scene_link
                 BEFORE INSERT ON scene_events
                 WHEN NEW.scene_id = 'atomic-scene-100'
                 BEGIN
                   SELECT RAISE(ABORT, 'forced batch scene link failure');
                 END;",
            )?;
            Ok(())
        })
        .expect("seed atomic batch scenes and failure trigger");
        let event_version_before = event_version(&db, &event_id);
        let journals_before = table_count(&db, "undo_journal");
        let changes_before = table_count(&db, "change_events");

        let error = agent_scene_event_link_batch_impl(
            &db,
            batch_scene_payload("scene-link-batch-atomic", &project_id, &event_id, scene_ids),
        )
        .expect_err("second insert chunk must fail");
        assert!(error
            .to_string()
            .contains("forced batch scene link failure"));
        assert_eq!(scene_link_count(&db, &event_id), 0);
        assert_eq!(event_version(&db, &event_id), event_version_before);
        assert_eq!(table_count(&db, "undo_journal"), journals_before);
        assert_eq!(table_count(&db, "change_events"), changes_before);
    }

    #[test]
    fn scene_event_link_batch_rejects_cross_project_scene_before_writing() {
        let db = test_db();
        let project_id = insert_project(&db);
        let foreign_project_id = insert_project(&db);
        let local_scene = insert_scene(&db, &project_id);
        let foreign_scene = insert_scene(&db, &foreign_project_id);
        let (event_id, _) = create_event(&db, &project_id, "Scoped", vec![], vec![]);
        let event_version_before = event_version(&db, &event_id);
        let journals_before = table_count(&db, "undo_journal");
        let changes_before = table_count(&db, "change_events");

        let error = agent_scene_event_link_batch_impl(
            &db,
            batch_scene_payload(
                "scene-link-batch-cross-project",
                &project_id,
                &event_id,
                vec![local_scene.clone(), foreign_scene.clone()],
            ),
        )
        .expect_err("cross-project scene must reject the whole batch");
        assert!(error.to_string().contains(&foreign_scene));
        assert!(!scene_link_has(&db, &event_id, &local_scene));
        assert!(!scene_link_has(&db, &event_id, &foreign_scene));
        assert_eq!(event_version(&db, &event_id), event_version_before);
        assert_eq!(table_count(&db, "undo_journal"), journals_before);
        assert_eq!(table_count(&db, "change_events"), changes_before);
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

    #[test]
    fn legacy_scene_event_journal_only_matches_the_empty_migration_incarnation() {
        let db = test_db();
        let project_id = insert_project(&db);
        let legacy_scene = insert_scene(&db, &project_id);
        let modern_scene = insert_scene(&db, &project_id);
        let (event_id, _) = create_event(&db, &project_id, "legacy links", vec![], vec![]);
        db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO scene_events (scene_id, event_id) VALUES (?1, ?2)",
                rusqlite::params![legacy_scene, event_id],
            )?;
            conn.execute(
                "INSERT INTO scene_events (scene_id, event_id, incarnation_token)
                 VALUES (?1, ?2, 'modern-incarnation')",
                rusqlite::params![modern_scene, event_id],
            )?;
            Ok(())
        })
        .expect("seed migrated and modern associations");

        let unlinked =
            |scene_id: &str| json!({ "sceneId": scene_id, "eventId": event_id, "linked": false });
        let legacy_linked =
            |scene_id: &str| json!({ "sceneId": scene_id, "eventId": event_id, "linked": true });
        let legacy_journal = insert_legacy_event_journal(
            &db,
            &project_id,
            &event_id,
            "update",
            Some(&unlinked(&legacy_scene)),
            Some(&legacy_linked(&legacy_scene)),
        );
        agent_undo_journal_impl(&db, undo_payload(&project_id, &legacy_journal, "undo"))
            .expect("tokenless journal may consume the migrated empty incarnation");
        assert!(!scene_link_has(&db, &event_id, &legacy_scene));

        let stale_journal = insert_legacy_event_journal(
            &db,
            &project_id,
            &event_id,
            "update",
            Some(&unlinked(&modern_scene)),
            Some(&legacy_linked(&modern_scene)),
        );
        let changes_before = table_count(&db, "change_events");
        let error = agent_undo_journal_impl(&db, undo_payload(&project_id, &stale_journal, "undo"))
            .expect_err("tokenless journal must not consume a modern incarnation");
        assert!(error.to_string().contains("incarnation"));
        assert_eq!(
            scene_link_token(&db, &event_id, &modern_scene),
            Some("modern-incarnation".to_string())
        );
        assert_eq!(table_count(&db, "change_events"), changes_before);
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
                request_id: "event-manual-create".to_string(),
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

        let imported = agent_event_create_impl(
            &db,
            AgentEventCreatePayload {
                request_id: "event-import-create".to_string(),
                event_id: None,
                project_id: project_id.clone(),
                session_id: "sess".to_string(),
                surface: Some("import".to_string()),
                title: Some("Imported event".to_string()),
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
        .expect("create with import surface");
        let journal_import = imported["undoJournalId"].as_str().unwrap().to_string();
        assert_eq!(journal_surface(&db, &journal_import), "import");
        db.with_conn(|conn| {
            let origins = conn
                .prepare(
                    "SELECT origin FROM narrative_change_transactions
                      WHERE project_id = ?1
                      ORDER BY source_change_event_sequence",
                )?
                .query_map(rusqlite::params![project_id], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            assert_eq!(origins, vec!["ai-apply", "human", "import"]);
            Ok(())
        })
        .unwrap();
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

    fn scene_link_has(db: &Database, event_id: &str, scene_id: &str) -> bool {
        scalar_count(
            db,
            "SELECT COUNT(*) FROM scene_events WHERE event_id = ?1 AND scene_id = ?2",
            event_id,
            Some(scene_id),
        ) > 0
    }

    fn scene_link_ids(db: &Database, event_id: &str) -> Vec<String> {
        db.with_conn(|conn| {
            let mut statement = conn.prepare(
                "SELECT scene_id FROM scene_events WHERE event_id = ?1 ORDER BY scene_id",
            )?;
            let rows =
                statement.query_map(rusqlite::params![event_id], |row| row.get::<_, String>(0))?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        })
        .expect("scene_link_ids")
    }

    fn scene_link_token(db: &Database, event_id: &str, scene_id: &str) -> Option<String> {
        db.with_conn(|conn| {
            Ok(conn
                .query_row(
                    "SELECT incarnation_token FROM scene_events
                     WHERE event_id = ?1 AND scene_id = ?2",
                    rusqlite::params![event_id, scene_id],
                    |row| row.get(0),
                )
                .optional()?)
        })
        .expect("scene_link_token")
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
                participant_roles: None,
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
                participant_roles: None,
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
        let project_id: String = db
            .with_conn(|conn| {
                conn.query_row(
                    "SELECT project_id FROM events WHERE id = ?1",
                    rusqlite::params![event_id],
                    |row| row.get(0),
                )
                .map_err(Into::into)
            })
            .expect("event project");
        let base_version = event_version(db, event_id);
        agent_event_set_participants_impl(
            db,
            AgentEventParticipantsPayload {
                project_id,
                session_id: "role-test".to_string(),
                surface: None,
                event_id: event_id.to_string(),
                base_version,
                codex_entry_ids: vec![codex_id.to_string()],
                participant_roles: Some(vec![Some(role.to_string())]),
            },
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
                base_version: event_version(&db, &main_id),
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
                participant_roles: None,
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
        assert!(error.to_string().contains("another project"), "{error:#}");
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
                base_version: event_version(&db, &event_id),
                codex_entry_ids: vec![codex_b.clone(), codex_c.clone()],
                participant_roles: None,
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
                participant_roles: None,
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
                request_id: "event-xproj-participant".to_string(),
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
                request_id: "event-xproj-scene".to_string(),
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
                participant_roles: None,
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
    fn scene_event_stacked_link_unlink_replay_rewrites_incarnation_chain() {
        let db = test_db();
        let project_id = insert_project(&db);
        let scene_id = insert_scene(&db, &project_id);
        let (event_id, _) = create_event(&db, &project_id, "stacked", vec![], vec![]);

        let link = agent_scene_event_mutate_impl(
            &db,
            scene_payload(&project_id, &scene_id, &event_id),
            true,
        )
        .expect("link");
        let link_journal = link["undoJournalId"]
            .as_str()
            .expect("link journal")
            .to_string();
        let first_token = scene_link_token(&db, &event_id, &scene_id).expect("first token");

        let unlink = agent_scene_event_mutate_impl(
            &db,
            scene_payload(&project_id, &scene_id, &event_id),
            false,
        )
        .expect("unlink");
        let unlink_journal = unlink["undoJournalId"]
            .as_str()
            .expect("unlink journal")
            .to_string();

        agent_undo_journal_impl(&db, undo_payload(&project_id, &unlink_journal, "undo"))
            .expect("undo unlink with a fresh incarnation");
        let second_token = scene_link_token(&db, &event_id, &scene_id).expect("second token");
        assert_ne!(second_token, first_token);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &link_journal, "undo"))
            .expect("older link journal follows the rewritten incarnation chain");
        assert!(!scene_link_has(&db, &event_id, &scene_id));

        agent_undo_journal_impl(&db, undo_payload(&project_id, &link_journal, "redo"))
            .expect("redo link with another fresh incarnation");
        let third_token = scene_link_token(&db, &event_id, &scene_id).expect("third token");
        assert_ne!(third_token, second_token);

        agent_undo_journal_impl(&db, undo_payload(&project_id, &unlink_journal, "redo"))
            .expect("newer unlink journal follows the rewritten incarnation chain");
        assert!(!scene_link_has(&db, &event_id, &scene_id));
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
